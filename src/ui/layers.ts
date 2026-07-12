// src/ui/layers.ts - the layer/session controller. Panels render intent; THIS
// module does the manifest + engine work. It owns the layer registries, the
// load-on-demand paths, visibility persistence (the single saveProject write
// path - layer status only), the four-state disclosure, and the densification
// fallback. Logic carried over from the pre-frame main.ts; do not fork
// visibility or loading state anywhere else.

import { isOpenProjectError, type ProjectSession } from '../shared/ipc'
import type { PointCloudDataset, SurfaceModel } from '../core/contract'
import type { AssetRecord, ProjectManifest, SimulationLayer } from '../shared/workbench-types'
import { ViewerEngine } from '../viewer'
import { hasValidIndexForStreaming } from '../shared/pointcloud-index'
import { DEFAULT_SURFEL_CELL_SCALE } from '../shared/analytic-surfels'
import {
  DEFAULT_LAYER_APPEARANCE,
  applyLayerErrorStatus,
  applyLayerStatusUpdates,
  buildIndexDisclosureLine,
  buildPointCloudCards,
  buildPreviewDisclosureLine,
  compactCount,
  computeMasterToggleUpdates,
  findLayerAsset,
  isDerivedArtifactPath,
  removeAssetFromManifest,
  resolveLayerKind,
  type ColorMode,
  type LayerAppearance,
  type LayerVisibilityUpdate,
  type ProjectStatusLines,
} from './model'

export type { ProjectStatusLines }

export const OPEN_PROJECT_FAILURE_MESSAGE =
  'Project manifest is missing or corrupt. Manual restore is available from project.json.bak; auto-restore is not implemented yet.'

const TASK_FLASH_MS = 6000

interface PreviewLayerEntry {
  layerId: string
  assetId: string
  handle: string
  preview: {
    sampledPointCount: number
    totalPointCount: number
    warnings: string[]
    sourceAvailable: boolean
  }
}

interface IndexLayerEntry {
  layerId: string
  assetId: string
  sourceAssetId: string
  handle: string
}

interface DerivedSurfaceLayerEntry {
  layerId: string
  assetId: string
  handle: string
}

interface DerivedSurfelLayerEntry {
  layerId: string
  assetId: string
  handle: string
}

export interface WalkTargetOption {
  sourceAssetId: string
  label: string
  detail: string
  available: boolean
  buildIndexFirst: boolean
}

export interface LayerControllerEvents {
  onSessionChanged(session: ProjectSession | null): void
  onTask(label: string | null, pct?: number | null): void
  onViewStateLines(lines: string[]): void
  /** Called once when the lazy viewer engine is created, so the frame can wire callbacks. */
  onViewerCreated(viewer: ViewerEngine): void
}

function toSurfaceModel(serialized: {
  id: string
  name: string
  positions: number[]
  sourcePointIds: number[]
  indices: number[]
}): SurfaceModel {
  return {
    id: serialized.id,
    name: serialized.name,
    meta: {
      fileName: `${serialized.id}.json`,
      format: 'synthetic',
      units: { linear: 'usSurveyFoot', raw: 'USSurveyFoot' },
    },
    positions: Float64Array.from(serialized.positions),
    precisionHint: 3,
    sourcePointIds: Uint32Array.from(serialized.sourcePointIds),
    indices: Uint32Array.from(serialized.indices),
    faceVisibility: null,
    edges: null,
    breaklines: [],
    boundaries: [],
    report: {
      counts: { points: serialized.sourcePointIds.length, faces: Math.floor(serialized.indices.length / 3) },
      triangulationPreserved: true,
      warnings: [],
      infos: ['Derived placeholder surface loaded from artifact'],
      unknownElements: {},
    },
    provenance: 'source-explicit',
    dirty: false,
  }
}

export class LayerController {
  private session: ProjectSession | null = null
  private viewer: ViewerEngine | null = null
  private readonly viewerHost: HTMLElement
  private readonly events: LayerControllerEvents

  private selectedPointCloudSourceAssetId: string | null = null
  private pendingDensifyKey = ''
  private pendingDensify = false
  private streamingDisclosureTimer: number | null = null
  private taskFlashTimer: number | null = null

  private readonly previewLayers = new Map<string, PreviewLayerEntry>()
  private readonly previewLayerByHandle = new Map<string, string>()
  private readonly indexLayers = new Map<string, IndexLayerEntry>()
  private readonly derivedSurfaceLayers = new Map<string, DerivedSurfaceLayerEntry>()
  private readonly derivedSurfelLayers = new Map<string, DerivedSurfelLayerEntry>()
  private walkVisibilityRestore: (() => void) | null = null

  /** Session-only per-layer appearance (decision recorded: not persisted to the manifest). */
  private readonly appearance = new Map<string, LayerAppearance>()
  /** Master-pill memory: assetId -> remembered per-layer visibility (UI memory only). */
  private readonly masterMemory = new Map<string, Map<string, boolean>>()

  private edlEnabled = true
  private fogEnabled = false

  private status: ProjectStatusLines = { projectLine: 'No project loaded', recoveryLine: '' }

  constructor(viewerHost: HTMLElement, events: LayerControllerEvents) {
    this.viewerHost = viewerHost
    this.events = events

    window.workbench.onPointCloudPreviewProgress((progress) => {
      this.events.onTask(progress.label, progress.pct)
    })
    window.workbench.onPointCloudIndexProgress((progress) => {
      this.events.onTask(`Indexing: ${progress.label}`, progress.pct)
    })
    window.workbench.onAnalyticSurfelProgress((progress) => {
      this.events.onTask(`Surfels: ${progress.label}`, progress.pct)
    })
  }

  getSession(): ProjectSession | null {
    return this.session
  }

  getStatus(): ProjectStatusLines {
    return this.status
  }

  getViewer(): ViewerEngine | null {
    return this.viewer
  }

  getWalkTargets(): WalkTargetOption[] {
    if (!this.session) return []
    return this.session.manifest.assets
      .filter((asset) => asset.kind === 'point-cloud' && asset.pointCloud)
      .map((sourceAsset) => {
        const indexAsset = this.session?.manifest.assets.find((asset) => asset.pointCloudIndex?.sourceAssetId === sourceAsset.id)
        const available = hasValidIndexForStreaming(indexAsset)
        return {
          sourceAssetId: sourceAsset.id,
          label: sourceAsset.name,
          detail: available
            ? 'Indexed point cloud walk'
            : indexAsset
              ? 'Index is stale. Rebuild index first.'
              : 'No index yet. Build index first.',
          available,
          buildIndexFirst: !available,
        }
      })
  }

  async startIndexedPointCloudWalk(sourceAssetId: string): Promise<{ ok: true; handle: string; label: string } | { ok: false; reason: string }> {
    if (!this.session) return { ok: false, reason: 'Open a project before entering Walk mode.' }
    const sourceAsset = this.session.manifest.assets.find((asset) => asset.id === sourceAssetId)
    const indexAsset = this.session.manifest.assets.find((asset) => asset.pointCloudIndex?.sourceAssetId === sourceAssetId)
    if (!sourceAsset || sourceAsset.kind !== 'point-cloud') {
      return { ok: false, reason: 'That point cloud is no longer available for walking.' }
    }
    if (!indexAsset || !hasValidIndexForStreaming(indexAsset)) {
      return { ok: false, reason: 'Build index first to walk this point cloud.' }
    }
    const layer = this.session.manifest.simulationLayers.find((candidate) => candidate.assetId === indexAsset.id)
    if (!layer) {
      return { ok: false, reason: 'The point-cloud index layer is missing from the current simulation.' }
    }
    await this.ensureLayerLoaded(layer.id)
    const entry = this.indexLayers.get(layer.id)
    const viewer = this.getViewer()
    if (!entry || !viewer) {
      return { ok: false, reason: 'The indexed point cloud could not be loaded for walking.' }
    }
    this.endWalkTarget()
    if (layer.status === 'hidden') {
      const look = this.appearanceFor(layer.id)
      viewer.setPointCloudIndexDisplay(entry.handle, true, look.pointSize)
      this.walkVisibilityRestore = () => {
        this.viewer?.setPointCloudIndexDisplay(entry.handle, false, look.pointSize)
      }
    }
    return { ok: true, handle: entry.handle, label: sourceAsset.name }
  }

  endWalkTarget(): void {
    this.walkVisibilityRestore?.()
    this.walkVisibilityRestore = null
  }

  ensureViewer(): ViewerEngine {
    if (!this.viewer) {
      this.viewer = new ViewerEngine(this.viewerHost)
      this.viewer.onPointCloudSettled(({ handle, nodeIds }) => {
        void this.requestNearCameraDensification(handle, nodeIds)
      })
      this.viewer.setPointCloudEdl(this.edlEnabled)
      this.viewer.setPointCloudFog(this.fogEnabled)
      this.events.onViewerCreated(this.viewer)
    }
    return this.viewer
  }

  // -------------------------------------------------------------------------
  // Global display controls (footer)
  // -------------------------------------------------------------------------

  setEdl(on: boolean): void {
    this.edlEnabled = on
    this.ensureViewer().setPointCloudEdl(on)
  }

  setFog(on: boolean): void {
    this.fogEnabled = on
    this.ensureViewer().setPointCloudFog(on)
  }

  isEdlEnabled(): boolean {
    return this.edlEnabled
  }

  isFogEnabled(): boolean {
    return this.fogEnabled
  }

  // -------------------------------------------------------------------------
  // Per-layer appearance (session-only)
  // -------------------------------------------------------------------------

  getLayerAppearance(layerId: string): LayerAppearance {
    return { ...(this.appearance.get(layerId) ?? DEFAULT_LAYER_APPEARANCE) }
  }

  private appearanceFor(layerId: string): LayerAppearance {
    let entry = this.appearance.get(layerId)
    if (!entry) {
      entry = { ...DEFAULT_LAYER_APPEARANCE }
      this.appearance.set(layerId, entry)
    }
    return entry
  }

  setLayerColorMode(layerId: string, mode: ColorMode): void {
    this.appearanceFor(layerId).colorMode = mode
    if (!this.viewer) return
    const previewEntry = this.previewLayers.get(layerId)
    if (previewEntry) this.viewer.setPointCloudDisplayMode(previewEntry.handle, mode)
    const indexEntry = this.indexLayers.get(layerId)
    if (indexEntry) this.viewer.setPointCloudIndexDisplayMode(indexEntry.handle, mode)
  }

  setLayerPointSize(layerId: string, size: number): void {
    this.appearanceFor(layerId).pointSize = size
    if (!this.viewer) return
    const active = this.findLayer(layerId)?.status === 'active'
    const previewEntry = this.previewLayers.get(layerId)
    if (previewEntry) this.viewer.setPointCloudDisplay(previewEntry.handle, active, size)
    const indexEntry = this.indexLayers.get(layerId)
    if (indexEntry) this.viewer.setPointCloudIndexDisplay(indexEntry.handle, active, size)
  }

  setLayerSurfelScale(layerId: string, scale: number): void {
    this.appearanceFor(layerId).surfelScale = scale
    if (!this.viewer) return
    const surfelEntry = this.derivedSurfelLayers.get(layerId)
    if (surfelEntry) {
      const active = this.findLayer(layerId)?.status === 'active'
      this.viewer.setAnalyticSurfelsDisplay(surfelEntry.handle, active, scale)
    }
  }

  // -------------------------------------------------------------------------
  // Disclosure (four-state; output goes to the banner view-state channel)
  // -------------------------------------------------------------------------

  private findLayer(layerId: string): SimulationLayer | null {
    return this.session?.manifest.simulationLayers.find((candidate) => candidate.id === layerId) ?? null
  }

  private syncDisclosureRefreshLoop(): void {
    if (this.indexLayers.size > 0 || this.derivedSurfelLayers.size > 0) {
      if (this.streamingDisclosureTimer !== null) return
      this.streamingDisclosureTimer = window.setInterval(() => {
        this.updatePointCloudDisclosure()
      }, 300)
      return
    }
    this.stopStreamingDisclosure()
  }

  private stopStreamingDisclosure(): void {
    if (this.streamingDisclosureTimer !== null) {
      window.clearInterval(this.streamingDisclosureTimer)
      this.streamingDisclosureTimer = null
    }
  }

  updatePointCloudDisclosure(): void {
    if (!this.session) {
      this.events.onViewStateLines([])
      return
    }

    const lines: string[] = []

    for (const entry of this.previewLayers.values()) {
      const layer = this.findLayer(entry.layerId)
      if (!layer || layer.status !== 'active') continue
      const densifiedCount = this.viewer ? this.viewer.getPointCloudDensifiedPointCount(entry.handle) : 0
      lines.push(buildPreviewDisclosureLine(entry.preview, densifiedCount))
    }

    if (this.viewer) {
      for (const entry of this.indexLayers.values()) {
        const layer = this.findLayer(entry.layerId)
        if (!layer || layer.status !== 'active') continue
        const text = this.viewer.getPointCloudIndexDisclosure(entry.handle)
        if (text) lines.push(buildIndexDisclosureLine(text))
      }
      for (const entry of this.derivedSurfelLayers.values()) {
        const layer = this.findLayer(entry.layerId)
        if (!layer || layer.status !== 'active') continue
        const text = this.viewer.getAnalyticSurfelsDisclosure(entry.handle)
        if (text) lines.push(text)
      }
    }

    this.events.onViewStateLines(lines)
  }

  // -------------------------------------------------------------------------
  // Densification fallback (unchanged semantics: index-gated, disclosed)
  // -------------------------------------------------------------------------

  private async requestNearCameraDensification(handle: string, nodeIds: number[]): Promise<void> {
    if (!this.viewer || nodeIds.length === 0) return
    const layerId = this.previewLayerByHandle.get(handle)
    if (!layerId) return
    const previewEntry = this.previewLayers.get(layerId)
    if (!previewEntry) return
    const layer = this.findLayer(layerId)
    if (!layer || layer.status !== 'active') return

    if (this.session) {
      const indexAsset = this.session.manifest.assets.find(
        (a) => a.pointCloudIndex?.sourceAssetId === previewEntry.assetId,
      )
      if (hasValidIndexForStreaming(indexAsset)) return
    }

    const requestKey = `${previewEntry.assetId}:${nodeIds.join(',')}`
    if (this.pendingDensify && this.pendingDensifyKey === requestKey) return
    this.pendingDensify = true
    this.pendingDensifyKey = requestKey
    this.events.onTask('Loading near-camera densification (fallback)...')
    try {
      const result = await window.workbench.loadPointCloudDensifiedNodes({
        assetId: previewEntry.assetId,
        nodeIds,
      })
      if (!this.viewer || this.previewLayerByHandle.get(handle) !== layerId) return
      if (!result.sourceAvailable) {
        previewEntry.preview.sourceAvailable = false
        if (result.warning && !previewEntry.preview.warnings.includes(result.warning)) {
          previewEntry.preview.warnings = [...previewEntry.preview.warnings, result.warning]
        }
        this.updatePointCloudDisclosure()
        this.flashTask(result.warning ?? null)
        return
      }
      for (const node of result.nodes) {
        this.viewer.applyPointCloudDensifiedNode(handle, node.nodeId, node.payload)
      }
      this.updatePointCloudDisclosure()
      this.flashTask(result.nodes.length > 0 ? 'Full density ready near camera.' : null)
    } catch (error) {
      console.error(error)
      this.flashTask('Full-density load failed; showing cached preview.')
    } finally {
      this.pendingDensify = false
    }
  }

  /** Shows a completion/notice message on the task channel, then fades it. */
  private flashTask(label: string | null): void {
    if (this.taskFlashTimer !== null) {
      window.clearTimeout(this.taskFlashTimer)
      this.taskFlashTimer = null
    }
    this.events.onTask(label)
    if (label !== null) {
      this.taskFlashTimer = window.setTimeout(() => {
        this.events.onTask(null)
        this.taskFlashTimer = null
      }, TASK_FLASH_MS)
    }
  }

  // -------------------------------------------------------------------------
  // Load-on-demand layer paths (carried over intact)
  // -------------------------------------------------------------------------

  private async ensurePreviewLayerLoaded(layer: SimulationLayer, asset: AssetRecord): Promise<void> {
    const engine = this.ensureViewer()
    const look = this.appearanceFor(layer.id)
    const existing = this.previewLayers.get(layer.id)
    if (existing) {
      engine.setPointCloudDisplay(existing.handle, layer.status === 'active', look.pointSize)
      this.updatePointCloudDisclosure()
      return
    }

    this.events.onTask('Restoring preview from cache...')
    const result = await window.workbench.loadPointCloudPreview({ assetId: asset.id })
    const handle = engine.addPointCloud(result.dataset as PointCloudDataset)
    this.previewLayers.set(layer.id, {
      layerId: layer.id,
      assetId: asset.id,
      handle,
      preview: {
        sampledPointCount: result.preview.sampledPointCount,
        totalPointCount: result.preview.totalPointCount,
        warnings: [...result.preview.warnings],
        sourceAvailable: result.preview.sourceAvailable,
      },
    })
    this.previewLayerByHandle.set(handle, layer.id)
    this.selectedPointCloudSourceAssetId = asset.id
    engine.setPointCloudDisplay(handle, layer.status === 'active', look.pointSize)
    engine.setPointCloudDensifiedPointBudget(handle, 1_500_000)
    engine.setPointCloudDisplayMode(handle, look.colorMode)
    this.updatePointCloudDisclosure()
  }

  private async ensureIndexLayerLoaded(layer: SimulationLayer, asset: AssetRecord, forceReload = false): Promise<void> {
    const sourceAssetId = asset.pointCloudIndex?.sourceAssetId ?? null
    if (!sourceAssetId) throw new Error(`Index layer ${layer.id} is missing a source asset reference.`)
    const engine = this.ensureViewer()
    const look = this.appearanceFor(layer.id)
    const existing = this.indexLayers.get(layer.id)
    if (existing && forceReload) {
      engine.removePointCloudIndex(existing.handle)
      this.indexLayers.delete(layer.id)
    } else if (existing) {
      engine.setPointCloudIndexDisplay(existing.handle, layer.status === 'active', look.pointSize)
      this.updatePointCloudDisclosure()
      return
    }

    const hierarchy = await window.workbench.loadPointCloudIndexHierarchy({ assetId: sourceAssetId })
    const handle = engine.addPointCloudIndex(hierarchy, (keys) =>
      window.workbench.loadPointCloudIndexTiles({ assetId: sourceAssetId, keys }).then((response) => response.tiles),
    )
    this.indexLayers.set(layer.id, { layerId: layer.id, assetId: asset.id, sourceAssetId, handle })
    this.selectedPointCloudSourceAssetId = sourceAssetId
    engine.setPointCloudIndexDisplay(handle, layer.status === 'active', look.pointSize)
    engine.setPointCloudIndexDisplayMode(handle, look.colorMode)
    this.syncDisclosureRefreshLoop()
    this.updatePointCloudDisclosure()
  }

  private async ensureDerivedSurfaceLayerLoaded(layer: SimulationLayer, asset: AssetRecord): Promise<void> {
    if (!asset.managedPath) return
    const engine = this.ensureViewer()
    const existing = this.derivedSurfaceLayers.get(layer.id)
    if (existing) {
      engine.setSurfaceVisible(existing.handle, layer.status === 'active')
      return
    }

    const serialized = await window.workbench.readDerivedSurfaceArtifact(asset.managedPath)
    const handle = engine.addSurface(toSurfaceModel(serialized))
    this.derivedSurfaceLayers.set(layer.id, { layerId: layer.id, assetId: asset.id, handle })
    engine.setSurfaceVisible(handle, layer.status === 'active')
  }

  private async ensureDerivedSurfelLayerLoaded(
    layer: SimulationLayer,
    asset: AssetRecord,
    forceReload = false,
  ): Promise<void> {
    const engine = this.ensureViewer()
    const look = this.appearanceFor(layer.id)
    const existing = this.derivedSurfelLayers.get(layer.id)
    if (existing && forceReload) {
      engine.removeAnalyticSurfels(existing.handle)
      this.derivedSurfelLayers.delete(layer.id)
    } else if (existing) {
      engine.setAnalyticSurfelsDisplay(existing.handle, layer.status === 'active', look.surfelScale)
      this.updatePointCloudDisclosure()
      return
    }

    const hierarchy = await window.workbench.loadAnalyticSurfelHierarchy({ assetId: asset.id })
    const handle = engine.addAnalyticSurfels(
      {
        ...hierarchy,
        nodes: hierarchy.nodes.map((node) => ({
          key: node.key,
          level: node.level,
          bounds: node.bounds,
          pointCount: node.surfelCount,
          childKeys: node.childKeys,
        })),
      },
      (keys) => window.workbench.loadAnalyticSurfelTiles({ assetId: asset.id, keys }).then((response) => response.tiles),
    )
    this.derivedSurfelLayers.set(layer.id, { layerId: layer.id, assetId: asset.id, handle })
    engine.setAnalyticSurfelsDisplay(handle, layer.status === 'active', look.surfelScale)
    this.syncDisclosureRefreshLoop()
    this.updatePointCloudDisclosure()
  }

  async ensureLayerLoaded(layerId: string, forceReload = false): Promise<void> {
    if (!this.session) return
    const layer = this.session.manifest.simulationLayers.find((candidate) => candidate.id === layerId)
    if (!layer || !layer.assetId) return
    const asset = this.session.manifest.assets.find((candidate) => candidate.id === layer.assetId) ?? null
    if (!asset) return
    const kind = resolveLayerKind(layer, asset)

    if (kind === 'point-cloud-preview') {
      await this.ensurePreviewLayerLoaded(layer, asset)
      return
    }
    if (kind === 'point-cloud-index') {
      await this.ensureIndexLayerLoaded(layer, asset, forceReload)
      return
    }
    if (kind === 'derived-surfel') {
      await this.ensureDerivedSurfelLayerLoaded(layer, asset, forceReload)
      return
    }
    if (kind === 'derived-surface' && asset.managedPath && isDerivedArtifactPath(asset.managedPath)) {
      await this.ensureDerivedSurfaceLayerLoaded(layer, asset)
    }
  }

  private applyLoadedLayerVisibility(layerId: string, visible: boolean): void {
    if (!this.viewer) return
    const look = this.appearanceFor(layerId)
    const previewEntry = this.previewLayers.get(layerId)
    if (previewEntry) this.viewer.setPointCloudDisplay(previewEntry.handle, visible, look.pointSize)
    const indexEntry = this.indexLayers.get(layerId)
    if (indexEntry) this.viewer.setPointCloudIndexDisplay(indexEntry.handle, visible, look.pointSize)
    const surfaceEntry = this.derivedSurfaceLayers.get(layerId)
    if (surfaceEntry) this.viewer.setSurfaceVisible(surfaceEntry.handle, visible)
    const surfelEntry = this.derivedSurfelLayers.get(layerId)
    if (surfelEntry) this.viewer.setAnalyticSurfelsDisplay(surfelEntry.handle, visible, look.surfelScale)
    this.updatePointCloudDisclosure()
  }

  // -------------------------------------------------------------------------
  // Visibility persistence - ALL panel toggles route through here
  // -------------------------------------------------------------------------

  async setLayerVisibility(layerId: string, visible: boolean): Promise<void> {
    await this.setLayersVisibility([{ layerId, visible }])
  }

  async setLayersVisibility(updates: LayerVisibilityUpdate[]): Promise<void> {
    if (!this.session || updates.length === 0) return
    const manifest = applyLayerStatusUpdates(this.session.manifest as ProjectManifest, updates)
    this.adoptSession(await window.workbench.saveProject(manifest))

    for (const update of updates) {
      if (!update.visible) {
        this.applyLoadedLayerVisibility(update.layerId, false)
        continue
      }
      try {
        await this.ensureLayerLoaded(update.layerId)
      } catch (error) {
        console.error(error)
        await this.markLayerError(update.layerId)
      }
    }
  }

  private async markLayerError(layerId: string): Promise<void> {
    if (!this.session) return
    const manifest = applyLayerErrorStatus(this.session.manifest as ProjectManifest, layerId)
    this.adoptSession(await window.workbench.saveProject(manifest))
  }

  /** Master pill: overrides whole-asset display, preserves per-layer sub-state in UI memory. */
  async toggleAssetMaster(sourceAssetId: string, targetOn: boolean): Promise<void> {
    if (!this.session) return
    const card = buildPointCloudCards(this.session.manifest as ProjectManifest).find(
      (candidate) => candidate.assetId === sourceAssetId,
    )
    if (!card) return
    const result = computeMasterToggleUpdates(card.views, this.masterMemory.get(sourceAssetId) ?? null, targetOn)
    if (result.remember) this.masterMemory.set(sourceAssetId, result.remember)
    else this.masterMemory.delete(sourceAssetId)
    await this.setLayersVisibility(result.updates)
  }

  /** Removes the asset + derived assets + their layers from the manifest (files untouched). */
  async removeAsset(sourceAssetId: string): Promise<void> {
    if (!this.session) return
    const result = removeAssetFromManifest(this.session.manifest as ProjectManifest, sourceAssetId)

    for (const layerId of result.removedLayerIds) {
      const previewEntry = this.previewLayers.get(layerId)
      if (previewEntry && this.viewer) {
        this.viewer.removePointCloud(previewEntry.handle)
        this.previewLayerByHandle.delete(previewEntry.handle)
      }
      this.previewLayers.delete(layerId)
      const indexEntry = this.indexLayers.get(layerId)
      if (indexEntry && this.viewer) this.viewer.removePointCloudIndex(indexEntry.handle)
      this.indexLayers.delete(layerId)
      const surfelEntry = this.derivedSurfelLayers.get(layerId)
      if (surfelEntry && this.viewer) this.viewer.removeAnalyticSurfels(surfelEntry.handle)
      this.derivedSurfelLayers.delete(layerId)
      const surfaceEntry = this.derivedSurfaceLayers.get(layerId)
      if (surfaceEntry && this.viewer) this.viewer.removeSurface(surfaceEntry.handle)
      this.derivedSurfaceLayers.delete(layerId)
      this.appearance.delete(layerId)
    }
    this.masterMemory.delete(sourceAssetId)
    if (this.selectedPointCloudSourceAssetId !== null && result.removedAssetIds.includes(this.selectedPointCloudSourceAssetId)) {
      this.selectedPointCloudSourceAssetId = null
    }
    this.syncDisclosureRefreshLoop()

    this.adoptSession(await window.workbench.saveProject(result.manifest))
    this.updatePointCloudDisclosure()
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  private adoptSession(session: ProjectSession): void {
    this.session = session
    this.status = {
      projectLine: `Project: ${session.projectFolder}`,
      recoveryLine: session.recoveryDetected
        ? 'Recovery note: unclean shutdown detected from journal/temp.'
        : 'Recovery note: clean state.',
    }
    this.events.onSessionChanged(session)
    this.updatePointCloudDisclosure()
  }

  private setClosed(projectLine = 'No project loaded', recoveryLine = ''): void {
    this.session = null
    this.status = { projectLine, recoveryLine }
    this.events.onSessionChanged(null)
    this.events.onViewStateLines([])
    this.events.onTask(null)
  }

  private clearViewerScene(): void {
    this.selectedPointCloudSourceAssetId = null
    this.pendingDensify = false
    this.pendingDensifyKey = ''
    this.previewLayers.clear()
    this.previewLayerByHandle.clear()
    this.indexLayers.clear()
    this.derivedSurfaceLayers.clear()
    this.derivedSurfelLayers.clear()
    this.appearance.clear()
    this.masterMemory.clear()
    this.stopStreamingDisclosure()
    this.viewer?.clearSceneContents()
  }

  private async loadInitialLayers(session: ProjectSession): Promise<void> {
    for (const layer of session.manifest.simulationLayers.filter((candidate) => candidate.status !== 'hidden')) {
      const asset = findLayerAsset(layer, session.manifest as ProjectManifest)
      if (!asset || !asset.managedPath || !isDerivedArtifactPath(asset.managedPath)) continue
      const kind = resolveLayerKind(layer, asset)
      if (kind !== 'derived-surface' && kind !== 'derived-surfel') continue
      try {
        await this.ensureLayerLoaded(layer.id)
      } catch (error) {
        console.error(error)
      }
    }
    for (const layer of session.manifest.simulationLayers.filter((candidate) => candidate.status !== 'hidden')) {
      const asset = findLayerAsset(layer, session.manifest as ProjectManifest)
      const kind = resolveLayerKind(layer, asset)
      if (kind !== 'point-cloud-preview' && kind !== 'point-cloud-index') continue
      try {
        await this.ensureLayerLoaded(layer.id)
      } catch (error) {
        console.error(error)
      }
    }
  }

  async newProject(): Promise<void> {
    const target = await window.workbench.pickNewProjectPath()
    if (!target) return
    this.clearViewerScene()
    this.adoptSession(await window.workbench.createProject(target))
  }

  async openProject(): Promise<void> {
    const projectFolder = await window.workbench.pickProjectFolder()
    if (!projectFolder) return
    this.clearViewerScene()
    try {
      const session = await window.workbench.openProject({ projectFolder })
      this.adoptSession(session)
      await this.loadInitialLayers(session)
      this.events.onTask(null)
      this.updatePointCloudDisclosure()
    } catch (error) {
      this.setClosed('Open project failed', OPEN_PROJECT_FAILURE_MESSAGE)
      if (!isOpenProjectError(error)) {
        console.error(error)
      }
    }
  }

  async saveProject(): Promise<void> {
    if (!this.session) return
    this.adoptSession(await window.workbench.saveProject(this.session.manifest as ProjectManifest))
  }

  /** Persists a UI-transformed manifest (feature authoring, rename/delete) through the single saveProject write path. */
  async persistManifest(manifest: ProjectManifest): Promise<void> {
    if (!this.session) return
    this.adoptSession(await window.workbench.saveProject(manifest))
  }

  async closeProject(): Promise<void> {
    await window.workbench.closeProject()
    this.clearViewerScene()
    this.setClosed()
  }

  async importPointCloud(): Promise<void> {
    if (!this.session) return
    const chosen = await window.workbench.pickPointCloudImport()
    if (!chosen) return
    const session = await window.workbench.importPointCloud(chosen)
    this.adoptSession(session)
    const previewLayersInSession = session.manifest.simulationLayers.filter((layer) => {
      const asset = findLayerAsset(layer, session.manifest as ProjectManifest)
      return resolveLayerKind(layer, asset) === 'point-cloud-preview'
    })
    const latestPreviewLayer = previewLayersInSession[previewLayersInSession.length - 1]
    if (latestPreviewLayer) await this.ensureLayerLoaded(latestPreviewLayer.id)
    this.updatePointCloudDisclosure()
    this.events.onTask(null)
  }

  private defaultPointCloudAssetId(): string | null {
    return (
      this.selectedPointCloudSourceAssetId ??
      this.session?.manifest.assets.find((asset) => asset.kind === 'point-cloud')?.id ??
      null
    )
  }

  async buildIndex(assetId?: string): Promise<void> {
    const target = assetId ?? this.defaultPointCloudAssetId()
    if (!target) return
    try {
      this.events.onTask('Building full index...')
      const result = await window.workbench.generatePointCloudIndex({ assetId: target })
      this.adoptSession(result.session)
      const indexLayer = result.session.manifest.simulationLayers.find((layer) => layer.assetId === result.indexAssetId)
      if (indexLayer) {
        await this.ensureLayerLoaded(indexLayer.id, true)
      }
      this.syncDisclosureRefreshLoop()
      this.flashTask(
        `Index ready: ${result.metrics.tileCount.toLocaleString()} tiles, ${compactCount(result.metrics.pointCount)} points`,
      )
    } catch (error) {
      console.error(error)
      this.flashTask('Index build failed; preview remains available.')
    }
  }

  async generateSurfels(assetId?: string): Promise<void> {
    const target = assetId ?? this.defaultPointCloudAssetId()
    if (!target) return
    try {
      this.events.onTask('Generating surfel layer...')
      const result = await window.workbench.generateAnalyticSurfels({
        assetId: target,
        surfelCellScale: DEFAULT_SURFEL_CELL_SCALE,
      })
      this.adoptSession(result.session)
      const surfelLayer = result.session.manifest.simulationLayers.find((layer) => layer.assetId === result.surfelAssetId)
      if (surfelLayer) await this.ensureLayerLoaded(surfelLayer.id, true)
      this.flashTask(
        `Surfels ready: ${compactCount(result.metrics.surfelCount)} surfels across ${result.metrics.nodeCount.toLocaleString()} nodes`,
      )
    } catch (error) {
      console.error(error)
      this.flashTask('Surfel generation failed; existing layers remain available.')
    }
  }

  async generatePlaceholderSurface(): Promise<void> {
    const result = await window.workbench.generatePlaceholderDerivedLayer()
    this.adoptSession(result.session)
    const surfaceLayers = result.session.manifest.simulationLayers.filter((layer) => {
      const asset = findLayerAsset(layer, result.session.manifest as ProjectManifest)
      return resolveLayerKind(layer, asset) === 'derived-surface'
    })
    const latestSurfaceLayer = surfaceLayers[surfaceLayers.length - 1]
    if (latestSurfaceLayer) await this.ensureLayerLoaded(latestSurfaceLayer.id)
  }

  async recordUnitWarning(): Promise<void> {
    if (!this.session || this.session.manifest.assets.length === 0) return
    const firstAsset = this.session.manifest.assets[0]
    const session = await window.workbench.addUnitMismatchWarning({
      assetId: firstAsset.id,
      warning: 'Unit mismatch: source units differ from project units.',
    })
    this.adoptSession(session)
  }
}
