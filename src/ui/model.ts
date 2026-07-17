// src/ui/model.ts - pure view-model builders and manifest transforms for the UI shell.
// No DOM, no three.js, no electron imports: everything here runs in a plain node
// environment so the UI tests can exercise it without a browser runtime.
//
// The manifest spine stays flat (assets + simulationLayers keyed by simulationId).
// This module is the single place that regroups those flat records into the
// asset-centered presentation the panels render. Truth lives on assets; layer
// lifecycle (active | hidden | error) is separate and never conflated here.

import type {
  AssetRecord,
  ProjectManifest,
  SimulationLayer,
  SimulationLayerKind,
  SimulationLayerStatus,
} from '../shared/workbench-types'
import { isStaleIndexWarning } from '../shared/pointcloud-index'
import {
  getTemplate,
  objectCategoryLabel,
  templatesForFamily,
  type ObjectCategoryId,
  type TemplateParamSpec,
} from '../shared/template-catalog'
import { readRegionMetadata } from '../shared/regionMetadata'
import { isolateBoundaryFromFeature } from '../viewer/generators'
import { DEFAULT_POINT_APPEARANCE, type DetailPreset, type PointAppearance } from '../viewer/pointCloudAppearance'

// ---------------------------------------------------------------------------
// Shared helpers (moved from main.ts so panels and tests share one copy)
// ---------------------------------------------------------------------------

export function resolveLayerKind(layer: SimulationLayer, asset: AssetRecord | null): SimulationLayerKind {
  if (layer.kind !== 'asset') return layer.kind
  if (asset?.kind === 'point-cloud-index') return 'point-cloud-index'
  if (asset?.kind === 'point-cloud') return 'point-cloud-preview'
  if (asset?.kind === 'analytic-surfel-render' && asset.truthStatus === 'derived') return 'derived-surfel'
  if (asset?.kind === 'surface' && asset.truthStatus === 'derived') return 'derived-surface'
  return 'asset'
}

export function findLayer(manifest: ProjectManifest, layerId: string): SimulationLayer | null {
  return manifest.simulationLayers.find((candidate) => candidate.id === layerId) ?? null
}

export function findLayerAsset(layer: SimulationLayer, manifest: ProjectManifest): AssetRecord | null {
  return layer.assetId ? manifest.assets.find((asset) => asset.id === layer.assetId) ?? null : null
}

export function isDerivedArtifactPath(managedPath: string | null): managedPath is string {
  return managedPath !== null && managedPath.replace(/\\/g, '/').startsWith('derived/')
}

export function compactCount(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '--'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) break
    value = value / 1024
    unit = next
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function unitsShortLabel(unitsLinear: string | null | undefined): string {
  if (unitsLinear === 'usSurveyFoot') return 'usft'
  if (unitsLinear === 'foot') return 'ft'
  if (unitsLinear === 'meter') return 'm'
  return '--'
}

/** Units label for the footer readout: first point-cloud asset wins, else '--'. */
export function projectUnitsLabel(manifest: ProjectManifest | null): string {
  if (!manifest) return '--'
  const withCloud = manifest.assets.find((asset) => asset.pointCloud !== undefined)
  if (withCloud?.pointCloud) return unitsShortLabel(withCloud.pointCloud.unitsLinear)
  return '--'
}

export function projectDisplayName(projectFolder: string, manifest: ProjectManifest): string {
  const infoName = manifest.info && typeof manifest.info['name'] === 'string' ? (manifest.info['name'] as string) : ''
  if (infoName.trim().length > 0) return infoName.trim()
  const parts = projectFolder.replace(/\\/g, '/').split('/').filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? projectFolder
}

export function headerTitle(projectName: string | null): string {
  return projectName ? `${projectName} Workbench` : "Gunter's Workbench"
}

/** Project/recovery status lines shown at the bottom of the Display Manager. */
export interface ProjectStatusLines {
  projectLine: string
  recoveryLine: string
}

// ---------------------------------------------------------------------------
// Disclosure line builders (the four-state disclosure moved to the banner)
// ---------------------------------------------------------------------------

export interface PreviewDisclosureInput {
  sampledPointCount: number
  totalPointCount: number
  warnings: string[]
  sourceAvailable: boolean
}

/** Preview layer disclosure. densifiedCount > 0 with a live source = mixed display. */
export function buildPreviewDisclosureLine(preview: PreviewDisclosureInput, densifiedCount: number): string {
  const mixed = densifiedCount > 0 && preview.sourceAvailable
  const warningText = preview.warnings.length > 0 ? ` WARNING: ${preview.warnings.join(' | ')}` : ''
  const disclosure = mixed
    ? `Preview - sampled ${compactCount(preview.sampledPointCount)} of ${compactCount(preview.totalPointCount)} points - source densification fallback`
    : `Preview - sampled ${compactCount(preview.sampledPointCount)} of ${compactCount(preview.totalPointCount)} points`
  return `${disclosure} - truth preview-sampled; source asset remains source${warningText}`
}

/** Index layer disclosure wraps the engine's streaming text with the truth statement. */
export function buildIndexDisclosureLine(engineText: string): string {
  return `${engineText} - truth indexed-full; source asset remains source`
}

// ---------------------------------------------------------------------------
// Manifest transforms (pure; callers persist via the existing saveProject path)
// ---------------------------------------------------------------------------

export interface LayerVisibilityUpdate {
  layerId: string
  visible: boolean
}

/**
 * The ONLY manifest mutation the display UI performs: layer status writes.
 * Returns a clone; everything except status/modifiedAt on the targeted layers
 * is untouched (asserted by the no-manifest-drift test).
 */
export function applyLayerStatusUpdates(manifest: ProjectManifest, updates: LayerVisibilityUpdate[]): ProjectManifest {
  const next = structuredClone(manifest)
  const stamp = new Date().toISOString()
  for (const update of updates) {
    const layer = next.simulationLayers.find((candidate) => candidate.id === update.layerId)
    if (!layer) continue
    layer.status = update.visible ? 'active' : 'hidden'
    layer.modifiedAt = stamp
  }
  return next
}

/** Marks a single layer as errored (load failure); same write surface as status updates. */
export function applyLayerErrorStatus(manifest: ProjectManifest, layerId: string): ProjectManifest {
  const next = structuredClone(manifest)
  const layer = next.simulationLayers.find((candidate) => candidate.id === layerId)
  if (layer) {
    layer.status = 'error'
    layer.modifiedAt = new Date().toISOString()
  }
  return next
}

/** Source asset id + all derived assets that point back to it (index / surfels). */
export function collectAssetGroupIds(manifest: ProjectManifest, sourceAssetId: string): string[] {
  const ids = [sourceAssetId]
  for (const asset of manifest.assets) {
    if (asset.pointCloudIndex?.sourceAssetId === sourceAssetId) ids.push(asset.id)
    else if (asset.analyticSurfel?.sourceAssetId === sourceAssetId) ids.push(asset.id)
  }
  return ids
}

export interface RemoveAssetResult {
  manifest: ProjectManifest
  removedAssetIds: string[]
  removedLayerIds: string[]
}

/**
 * Removes an asset, its derived assets (index / surfel via sourceAssetId), and all
 * simulation layers referencing them. Files on disk are NOT touched - the confirm
 * dialog discloses that. No other manifest fields change.
 */
export function removeAssetFromManifest(manifest: ProjectManifest, assetId: string): RemoveAssetResult {
  const next = structuredClone(manifest)
  const removedAssetIds = collectAssetGroupIds(next, assetId)
  const removedSet = new Set(removedAssetIds)
  const removedLayerIds = next.simulationLayers
    .filter((layer) => layer.assetId !== null && removedSet.has(layer.assetId))
    .map((layer) => layer.id)
  next.assets = next.assets.filter((asset) => !removedSet.has(asset.id))
  next.simulationLayers = next.simulationLayers.filter(
    (layer) => layer.assetId === null || !removedSet.has(layer.assetId),
  )
  return { manifest: next, removedAssetIds, removedLayerIds }
}

// ---------------------------------------------------------------------------
// Left panel: asset-centered card view-models
// ---------------------------------------------------------------------------

export type ColorMode = 'rgb' | 'elevation' | 'intensity'

/** Session-only per-layer appearance (persistence decision: NOT written to the manifest). */
export interface LayerAppearance {
  colorMode: ColorMode
  /** Legacy 1-5 multiplier; still the auto-mode base size (no direct UI control anymore). */
  pointSize: number
  surfelScale: number
  /** Shared point appearance: radius mode/scale + range clip (viewer model). */
  pointAppearance: PointAppearance
  /** Indexed-cloud refinement preset. */
  detail: DetailPreset
}

export const DEFAULT_LAYER_APPEARANCE: LayerAppearance = {
  colorMode: 'rgb',
  pointSize: 2,
  surfelScale: 2,
  pointAppearance: DEFAULT_POINT_APPEARANCE,
  detail: 'balanced',
}

/** Copy with the nested pointAppearance cloned - never hand out shared mutable state. */
export function cloneLayerAppearance(look: LayerAppearance): LayerAppearance {
  return { ...look, pointAppearance: { ...look.pointAppearance } }
}

export type AssetViewKind = 'preview' | 'index' | 'surfel'

export interface AssetViewModel {
  layerId: string
  viewKind: AssetViewKind
  label: string
  truthLabel: string
  status: SimulationLayerStatus
  active: boolean
  warnings: string[]
  supportsColorMode: boolean
  supportsPointSize: boolean
  supportsSurfelScale: boolean
}

export interface MissingViewModel {
  viewKind: 'index' | 'surfel'
  label: string
  hint: string
}

export interface PointCloudCardModel {
  assetId: string
  name: string
  extLabel: string
  truthStatus: string
  detail: string
  warnings: string[]
  views: AssetViewModel[]
  missingViews: MissingViewModel[]
  masterOn: boolean
  groupAssetIds: string[]
  /** No asset metadata carries classification data today; kept for honest display. */
  hasClassification: boolean
}

function extLabelForAsset(asset: AssetRecord): string {
  const ext = asset.pointCloud?.extension ?? ''
  const cleaned = ext.replace(/^\./, '').toUpperCase()
  if (cleaned.length > 0) return cleaned
  const match = asset.name.match(/\.([A-Za-z0-9]+)$/)
  return match ? match[1].toUpperCase() : asset.kind.toUpperCase()
}

function pointCloudDetail(asset: AssetRecord): string {
  const meta = asset.pointCloud
  if (!meta) return asset.kind
  return `${compactCount(meta.pointCount)} pts - LAS ${meta.lasVersion} PDRF ${meta.pointFormat}`
}

function viewForLayer(layer: SimulationLayer, owningAsset: AssetRecord, kind: SimulationLayerKind): AssetViewModel | null {
  if (kind === 'point-cloud-preview') {
    return {
      layerId: layer.id,
      viewKind: 'preview',
      label: 'Preview points',
      truthLabel: 'preview-sampled',
      status: layer.status,
      active: layer.status === 'active',
      warnings: owningAsset.warnings,
      supportsColorMode: true,
      supportsPointSize: true,
      supportsSurfelScale: false,
    }
  }
  if (kind === 'point-cloud-index') {
    return {
      layerId: layer.id,
      viewKind: 'index',
      label: 'Indexed points (full)',
      truthLabel: 'indexed-full',
      status: layer.status,
      active: layer.status === 'active',
      warnings: owningAsset.warnings,
      supportsColorMode: true,
      supportsPointSize: true,
      supportsSurfelScale: false,
    }
  }
  if (kind === 'derived-surfel') {
    return {
      layerId: layer.id,
      viewKind: 'surfel',
      label: 'Surfels (derived)',
      truthLabel: 'derived',
      status: layer.status,
      active: layer.status === 'active',
      warnings: owningAsset.warnings,
      supportsColorMode: false,
      supportsPointSize: false,
      supportsSurfelScale: true,
    }
  }
  return null
}

/**
 * Groups the flat manifest into asset-centered point-cloud cards: the source asset
 * plus its derived index / surfel assets, with each asset-hosted view as one row.
 * Presentation-only regrouping - the manifest itself stays flat.
 */
export function buildPointCloudCards(manifest: ProjectManifest): PointCloudCardModel[] {
  const cards: PointCloudCardModel[] = []
  for (const source of manifest.assets) {
    if (source.kind !== 'point-cloud') continue
    const groupAssetIds = collectAssetGroupIds(manifest, source.id)
    const groupSet = new Set(groupAssetIds)
    const views: AssetViewModel[] = []
    for (const layer of manifest.simulationLayers) {
      if (layer.assetId === null || !groupSet.has(layer.assetId)) continue
      const owningAsset = manifest.assets.find((asset) => asset.id === layer.assetId) ?? null
      if (!owningAsset) continue
      const kind = resolveLayerKind(layer, owningAsset)
      const view = viewForLayer(layer, owningAsset, kind)
      if (view) views.push(view)
    }

    const order: Record<AssetViewKind, number> = { preview: 0, index: 1, surfel: 2 }
    views.sort((a, b) => order[a.viewKind] - order[b.viewKind])

    const missingViews: MissingViewModel[] = []
    if (!views.some((view) => view.viewKind === 'index')) {
      missingViews.push({
        viewKind: 'index',
        label: 'Indexed points - not built',
        hint: 'Open this asset to build the index',
      })
    }
    if (!views.some((view) => view.viewKind === 'surfel')) {
      missingViews.push({
        viewKind: 'surfel',
        label: 'Surfels - not generated',
        hint: 'Open this asset to generate surfels',
      })
    }

    cards.push({
      assetId: source.id,
      name: source.name,
      extLabel: extLabelForAsset(source),
      truthStatus: source.truthStatus,
      detail: pointCloudDetail(source),
      warnings: source.warnings,
      views,
      missingViews,
      masterOn: views.some((view) => view.active),
      groupAssetIds,
      hasClassification: false,
    })
  }
  return cards
}

/** Minimal surface cards so existing derived-surface layers keep their visibility toggle. */
export interface SurfaceCardModel {
  assetId: string
  name: string
  truthStatus: string
  layerId: string | null
  active: boolean
}

export function buildSurfaceCards(manifest: ProjectManifest): SurfaceCardModel[] {
  const cards: SurfaceCardModel[] = []
  for (const asset of manifest.assets) {
    if (asset.kind !== 'surface') continue
    const layer = manifest.simulationLayers.find((candidate) => candidate.assetId === asset.id) ?? null
    cards.push({
      assetId: asset.id,
      name: asset.name,
      truthStatus: asset.truthStatus,
      layerId: layer?.id ?? null,
      active: layer?.status === 'active',
    })
  }
  return cards
}

// ---------------------------------------------------------------------------
// Master pill: whole-asset display override that preserves per-layer sub-state
// ---------------------------------------------------------------------------

export interface MasterToggleResult {
  updates: LayerVisibilityUpdate[]
  /** Remembered per-layer visibility to hold in UI memory (null clears the memory). */
  remember: Map<string, boolean> | null
}

/**
 * Master pill semantics: turning the asset OFF remembers each view's current
 * visibility and hides the active ones; turning it back ON restores exactly the
 * remembered per-layer state (default: all non-error views on). The override is
 * held in UI memory - per-layer state in the manifest is only written through
 * the same status-update path every other toggle uses.
 */
export function computeMasterToggleUpdates(
  views: AssetViewModel[],
  remembered: Map<string, boolean> | null,
  targetOn: boolean,
): MasterToggleResult {
  if (!targetOn) {
    const remember = new Map<string, boolean>()
    const updates: LayerVisibilityUpdate[] = []
    for (const view of views) {
      remember.set(view.layerId, view.active)
      if (view.active) updates.push({ layerId: view.layerId, visible: false })
    }
    return { updates, remember }
  }

  const updates: LayerVisibilityUpdate[] = []
  for (const view of views) {
    const desired = remembered?.has(view.layerId) ? remembered.get(view.layerId) === true : view.status !== 'error'
    if (desired !== view.active) updates.push({ layerId: view.layerId, visible: desired })
  }
  return { updates, remember: null }
}

// ---------------------------------------------------------------------------
// Right panel: Sim shell view-model
// ---------------------------------------------------------------------------

export interface SimTabModel {
  id: string
  label: string
  count: number
  addLabel: string
}

export interface SimPanelModel {
  featureCount: number
  groundLabel: string
  tabs: SimTabModel[]
}

/**
 * Regions are live (Create Sim IMP-3): the regions tab counts family==='region'
 * records. The other taxonomy tabs stay staged; legacy records (no family)
 * still map onto their nearest future group by their legacy type, and records
 * that carry a family are excluded from that legacy mapping so a region's
 * type:'polyline' does not double-count as a line.
 */
export function buildSimPanelModel(manifest: ProjectManifest | null): SimPanelModel {
  const features = manifest?.features ?? []
  const familyCount = (family: string): number => features.filter((feature) => feature.family === family).length
  const legacyCount = (type: string): number =>
    features.filter((feature) => feature.family === undefined && feature.type === type).length
  return {
    featureCount: features.length,
    groundLabel: 'Ground: not set',
    tabs: [
      { id: 'regions', label: 'Regions', count: familyCount('region'), addLabel: '+ Add region' },
      { id: 'objects', label: 'Objects', count: familyCount('object'), addLabel: '+ Add object' },
      { id: 'buildings', label: 'Buildings', count: familyCount('building'), addLabel: '+ Add building' },
      { id: 'utilities', label: 'Utilities', count: familyCount('utility'), addLabel: '+ Add utility' },
      { id: 'lines', label: 'Lines/Breaklines', count: familyCount('line') + legacyCount('polyline'), addLabel: '+ Add line' },
      { id: 'notes', label: 'Notes/Flags', count: familyCount('marker') + legacyCount('marker'), addLabel: '+ Add note' },
      {
        id: 'measurements',
        label: 'Measurements',
        count: familyCount('measurement') + legacyCount('measurement'),
        addLabel: '+ Add measurement',
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Right panel: authored-feature list + detail view-models (regions live first)
// ---------------------------------------------------------------------------

export interface RegionListItem {
  id: string
  name: string
  subtype: string
  borderVertexCount: number
  breaklineCount: number
  surfacePointCount: number
  edgeEvidenceCount: number
  interiorEvidenceCount: number
  visible: boolean
}

export interface BuildingListItem {
  id: string
  name: string
  subtype: string
  footprintVertexCount: number
  snappedEvidenceCount: number
  freeEvidenceCount: number
  /** Enriched by buildingModel.buildBuildingRowsModel; renderers fall back when absent. */
  typeLabel?: string
  summary?: string
  visible?: boolean
}

export interface ObjectListItem {
  id: string
  name: string
  category: string
  typeLabel: string
  subtype: string
  summary: string
  visible: boolean
  snappedEvidenceCount: number
  freeEvidenceCount: number
}

export interface LineListItem {
  id: string
  name: string
  subtype: string
  vertexCount: number
  isBreakline: boolean
  snappedEvidenceCount: number
  freeEvidenceCount: number
}

export interface MarkerListItem {
  id: string
  name: string
  subtype: string
  snappedEvidenceCount: number
  freeEvidenceCount: number
}

export function buildRegionListModel(manifest: ProjectManifest | null): RegionListItem[] {
  const features = manifest?.features ?? []
  return features
    .filter((feature) => feature.family === 'region')
    .map((feature) => {
      const geometry = feature.geometry as { border?: unknown; breaklines?: unknown }
      const border = Array.isArray(geometry.border) ? geometry.border : []
      const breaklines = Array.isArray(geometry.breaklines) ? geometry.breaklines : []
      const metadata = readRegionMetadata(feature)
      return {
        id: feature.id,
        name: feature.name,
        subtype: feature.subtype ?? 'unknown',
        borderVertexCount: border.length,
        breaklineCount: breaklines.length,
        surfacePointCount: metadata.surfacePoints.length,
        edgeEvidenceCount: metadata.edgeEvidence.length,
        interiorEvidenceCount: metadata.interiorEvidence.length,
        visible: feature.display?.visible !== false,
      }
    })
}

export function buildBuildingListModel(manifest: ProjectManifest | null): BuildingListItem[] {
  const features = manifest?.features ?? []
  return features
    .filter((feature) => feature.family === 'building')
    .map((feature) => {
      const geometry = feature.geometry as { footprint?: unknown }
      const footprint = Array.isArray(geometry.footprint) ? geometry.footprint : []
      const evidence = feature.evidenceRefs ?? []
      const snapped = evidence.filter((ref) => ref.kind !== 'picked-coordinate' && ref.kind !== 'manual-note').length
      return {
        id: feature.id,
        name: feature.name,
        subtype: feature.subtype ?? 'flat',
        footprintVertexCount: footprint.length,
        snappedEvidenceCount: snapped,
        freeEvidenceCount: evidence.length - snapped,
      }
    })
}

function evidenceSplit(feature: { evidenceRefs?: { kind: string }[] }): { snapped: number; free: number } {
  const evidence = feature.evidenceRefs ?? []
  const snapped = evidence.filter((ref) => ref.kind !== 'picked-coordinate' && ref.kind !== 'manual-note').length
  return { snapped, free: evidence.length - snapped }
}

export function buildObjectListModel(manifest: ProjectManifest | null): ObjectListItem[] {
  return (manifest?.features ?? [])
    .filter((feature) => feature.family === 'object')
    .map((feature) => {
      const evidence = evidenceSplit(feature)
      const template = feature.templateId ? getTemplate(feature.templateId) : null
      return {
        id: feature.id,
        name: feature.name,
        category: template?.objectCategory ? objectCategoryLabel(template.objectCategory) : 'Object',
        typeLabel: template?.displayName ?? feature.subtype ?? 'Object',
        subtype: feature.subtype ?? 'generic',
        summary: objectSummary(feature),
        visible: feature.display?.visible !== false,
        snappedEvidenceCount: evidence.snapped,
        freeEvidenceCount: evidence.free,
      }
    })
}

export function buildLineListModel(manifest: ProjectManifest | null): LineListItem[] {
  return (manifest?.features ?? [])
    .filter((feature) => feature.family === 'line')
    .map((feature) => {
      const geometry = feature.geometry as { vertices?: unknown }
      const vertices = Array.isArray(geometry.vertices) ? geometry.vertices : []
      const evidence = evidenceSplit(feature)
      return {
        id: feature.id,
        name: feature.name,
        subtype: feature.subtype ?? 'line',
        vertexCount: vertices.length,
        isBreakline: feature.parameters?.isBreakline !== false,
        snappedEvidenceCount: evidence.snapped,
        freeEvidenceCount: evidence.free,
      }
    })
}

export function buildMarkerListModel(manifest: ProjectManifest | null): MarkerListItem[] {
  return (manifest?.features ?? [])
    .filter((feature) => feature.family === 'marker')
    .map((feature) => {
      const evidence = evidenceSplit(feature)
      return {
        id: feature.id,
        name: feature.name,
        subtype: feature.subtype ?? 'generic',
        snappedEvidenceCount: evidence.snapped,
        freeEvidenceCount: evidence.free,
      }
    })
}

export interface FeatureDetailModel {
  id: string
  name: string
  family: string
  subtype: string
  templateId: string | null
  authorship: string
  params: {
    name: string
    label: string
    value: string
    type: TemplateParamSpec['type']
    options?: string[]
    editable: boolean
  }[]
  cadRefs: { name: string; value: string }[]
  evidenceTotal: number
  evidenceSnapped: number
  evidenceFree: number
  evidenceBadges: string[]
  createdAt: string
  modifiedAt: string
  objectEditor?: {
    categoryId: ObjectCategoryId
    typeTemplateId: string
    typeLabel: string
    categories: { id: ObjectCategoryId; label: string }[]
    types: { templateId: string; label: string }[]
    placement: { x: string; y: string; z: string }
    rotationYaw: string
    summary: string
    previewKind: string
    /** Vertex count of the stored isolate boundary; null when none is drawn. */
    isolateVertexCount: number | null
    /** First refs in stored order (window selections can add thousands); index keys removal. */
    evidenceItems: { index: number; kindLabel: string; coordLabel: string }[]
    /** Refs beyond the rendered rows; shown as a summary count. */
    evidenceOverflow: number
  }
}

/** DOM-safety cap for the scrollable detail evidence list; the rest is summarized as a count. */
export const EVIDENCE_DETAIL_ROWS = 200

export const EVIDENCE_KIND_LABEL: Record<string, string> = {
  'picked-coordinate': 'free pick',
  'asset-point': 'cloud point',
  'asset-vertex': 'feature vertex',
  'asset-edge': 'feature edge',
  'surface-hit': 'surface',
  'manual-note': 'note',
}

export function buildFeatureDetailModel(manifest: ProjectManifest | null, featureId: string): FeatureDetailModel | null {
  const feature = manifest?.features.find((candidate) => candidate.id === featureId)
  if (!feature) return null
  const evidence = feature.evidenceRefs ?? []
  const snapped = evidence.filter((ref) => ref.kind !== 'picked-coordinate' && ref.kind !== 'manual-note').length
  const cad = (feature.representations?.cad ?? {}) as Record<string, unknown>
  const template = feature.templateId ? getTemplate(feature.templateId) : null
  const objectEditor = buildObjectEditorModel(feature)
  const hiddenObjectParams = new Set(objectEditor ? ['rotationYaw'] : [])
  const params = template
    ? template.paramSchema.map((param) => {
        if (hiddenObjectParams.has(param.name)) return null
        const value = feature.parameters?.[param.name] ?? param.default
        return {
          name: param.name,
          label: param.label,
          value: String(value),
          type: param.type,
          ...(param.options ? { options: param.options } : {}),
          editable: true,
        }
      }).filter((param): param is NonNullable<typeof param> => param !== null)
    : Object.entries(feature.parameters ?? {}).map(([name, value]) => ({
        name,
        label: name,
        value: String(value),
        type: 'string' as const,
        editable: false,
      }))
  return {
    id: feature.id,
    name: feature.name,
    family: feature.family ?? 'legacy',
    subtype: feature.subtype ?? '-',
    templateId: feature.templateId ?? null,
    authorship: feature.authorship ?? 'authored',
    params,
    cadRefs: Object.entries(cad)
      .filter(([, value]) => typeof value === 'string')
      .map(([name, value]) => ({ name, value: String(value) })),
    evidenceTotal: evidence.length,
    evidenceSnapped: snapped,
    evidenceFree: evidence.length - snapped,
    evidenceBadges: buildEvidenceBadges(feature),
    createdAt: feature.createdAt,
    modifiedAt: feature.modifiedAt,
    ...(objectEditor ? { objectEditor } : {}),
  }
}

function buildEvidenceBadges(feature: ProjectManifest['features'][number]): string[] {
  const evidence = feature.evidenceRefs ?? []
  const badges = new Set<string>()
  if (feature.authorship) badges.add(feature.authorship)
  if (evidence.some((ref) => ref.kind === 'asset-point')) badges.add('snapped-to-cloud')
  if (evidence.some((ref) => ref.kind === 'asset-vertex' || ref.kind === 'asset-edge')) badges.add('snapped-to-feature')
  if (evidence.some((ref) => ref.kind === 'picked-coordinate')) badges.add('free-placement')
  if (evidence.some((ref) => ref.kind === 'manual-note')) badges.add('manual')
  return [...badges]
}

function buildObjectEditorModel(feature: ProjectManifest['features'][number]): FeatureDetailModel['objectEditor'] | null {
  if (feature.family !== 'object' || !feature.templateId) return null
  const template = getTemplate(feature.templateId)
  if (!template?.objectCategory) return null
  const geometry = feature.geometry as { point?: unknown }
  const point = Array.isArray(geometry.point) && geometry.point.length === 3 ? geometry.point : [0, 0, 0]
  const isolate = isolateBoundaryFromFeature(feature)
  return {
    categoryId: template.objectCategory,
    typeTemplateId: template.id,
    typeLabel: template.displayName,
    categories: objectCategories(),
    types: templatesForFamily('object')
      .filter((candidate) => candidate.objectCategory === template.objectCategory)
      .map((candidate) => ({ templateId: candidate.id, label: candidate.displayName })),
    placement: { x: String(point[0]), y: String(point[1]), z: String(point[2]) },
    rotationYaw: String(feature.parameters?.rotationYaw ?? 0),
    summary: objectSummary(feature),
    previewKind: template.subtype,
    isolateVertexCount: isolate ? isolate.length : null,
    evidenceItems: (feature.evidenceRefs ?? []).slice(0, EVIDENCE_DETAIL_ROWS).map((ref, index) => ({
      index,
      kindLabel: EVIDENCE_KIND_LABEL[ref.kind] ?? ref.kind,
      coordLabel: ref.coordinate.map((axis) => axis.toFixed(1)).join(', '),
    })),
    evidenceOverflow: Math.max((feature.evidenceRefs ?? []).length - EVIDENCE_DETAIL_ROWS, 0),
  }
}

function objectCategories(): { id: ObjectCategoryId; label: string }[] {
  const ids = new Set<ObjectCategoryId>()
  for (const template of templatesForFamily('object')) {
    if (template.objectCategory) ids.add(template.objectCategory)
  }
  return [...ids].map((id) => ({ id, label: objectCategoryLabel(id) }))
}

function objectSummary(feature: ProjectManifest['features'][number]): string {
  const template = feature.templateId ? getTemplate(feature.templateId) : null
  const value = (name: string, fallback: number): number => {
    const raw = feature.parameters?.[name]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
  }
  const evidence = evidenceSplit(feature)
  const evidenceState = evidence.snapped > 0 ? 'snapped evidence' : evidence.free > 0 ? 'manual placement' : 'no evidence'
  switch (template?.subtype) {
    case 'box':
      return `${formatMeasure(value('width', 0))}w x ${formatMeasure(value('depth', 0))}d x ${formatMeasure(value('height', 0))}h - ${evidenceState}`
    case 'cylinder':
      return `dia ${formatMeasure(value('diameter', 0))} x ${formatMeasure(value('height', 0))}h - ${evidenceState}`
    case 'pine':
    case 'simple-tree':
    case 'post':
      return `${formatMeasure(value('height', 0))}h - ${evidenceState}`
    case 'shrub':
      return `${formatMeasure(value('width', 0))}w x ${formatMeasure(value('depth', 0))}d x ${formatMeasure(value('height', 0))}h - ${evidenceState}`
    case 'sign':
      return `${formatMeasure(value('signWidth', 0))}w x ${formatMeasure(value('signHeight', 0))}h face - ${evidenceState}`
    default:
      return evidenceState
  }
}

function formatMeasure(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '')
}

// ---------------------------------------------------------------------------
// Right panel: opened-asset work surface view-model
// ---------------------------------------------------------------------------

export interface DerivedStatusModel {
  present: boolean
  summary: string
  generatedAt: string | null
  stale: boolean
  staleNote: string | null
  actionLabel: string
}

export interface WorkSurfaceModel {
  assetId: string
  name: string
  kindLabel: string
  truthStatus: string
  importPolicy: 'copy' | 'reference'
  sourcePath: string | null
  managedPath: string | null
  unitsLabel: string
  pointSummary: string | null
  boundsSummary: string | null
  warnings: string[]
  index: DerivedStatusModel
  surfels: DerivedStatusModel
}

function boundsSummary(asset: AssetRecord): string | null {
  const bounds = asset.pointCloud?.bounds
  if (!bounds) return null
  const f = (v: number): string => v.toFixed(2)
  return `E ${f(bounds.minX)} to ${f(bounds.maxX)} | N ${f(bounds.minY)} to ${f(bounds.maxY)} | Z ${f(bounds.minZ)} to ${f(bounds.maxZ)}`
}

export function buildWorkSurfaceModel(manifest: ProjectManifest, assetId: string): WorkSurfaceModel | null {
  const asset = manifest.assets.find((candidate) => candidate.id === assetId)
  if (!asset || asset.kind !== 'point-cloud') return null

  const indexAsset = manifest.assets.find((candidate) => candidate.pointCloudIndex?.sourceAssetId === assetId)
  const surfelAsset = manifest.assets.find((candidate) => candidate.analyticSurfel?.sourceAssetId === assetId)

  const indexStale = indexAsset !== undefined && indexAsset.warnings.some((warning) => isStaleIndexWarning(warning))
  const index: DerivedStatusModel = indexAsset?.pointCloudIndex
    ? {
        present: true,
        summary: `${compactCount(indexAsset.pointCloudIndex.pointCount)} points indexed (WPI v${indexAsset.pointCloudIndex.indexVersion})`,
        generatedAt: indexAsset.pointCloudIndex.generatedAt,
        stale: indexStale,
        staleNote: indexStale
          ? 'The source file changed after this index was built. Rebuild to match the current source.'
          : null,
        actionLabel: 'Rebuild index',
      }
    : {
        present: false,
        summary: 'No index yet. Build one for reliable full-detail streaming.',
        generatedAt: null,
        stale: false,
        staleNote: null,
        actionLabel: 'Build index',
      }

  const surfelStale =
    surfelAsset?.analyticSurfel !== undefined &&
    asset.pointCloud !== undefined &&
    surfelAsset.analyticSurfel.source.headerSha256 !== asset.pointCloud.headerSha256
  const surfels: DerivedStatusModel = surfelAsset?.analyticSurfel
    ? {
        present: true,
        summary: `${compactCount(surfelAsset.analyticSurfel.surfelCount)} surfels (v${surfelAsset.analyticSurfel.surfelVersion})`,
        generatedAt: surfelAsset.analyticSurfel.generatedAt,
        stale: surfelStale,
        staleNote: surfelStale
          ? 'The source file changed after these surfels were generated. Regenerate to match the current source.'
          : null,
        actionLabel: 'Regenerate surfels',
      }
    : {
        present: false,
        summary: 'No surfel layer yet. Generate one for a surface-like impression of the cloud.',
        generatedAt: null,
        stale: false,
        staleNote: null,
        actionLabel: 'Generate surfels',
      }

  const meta = asset.pointCloud
  return {
    assetId: asset.id,
    name: asset.name,
    kindLabel: 'Point cloud',
    truthStatus: asset.truthStatus,
    importPolicy: asset.importPolicy,
    sourcePath: asset.sourcePath,
    managedPath: asset.managedPath,
    unitsLabel: meta ? unitsShortLabel(meta.unitsLinear) : unitsShortLabel(asset.units),
    pointSummary: meta
      ? `${meta.pointCount.toLocaleString('en-US')} points - LAS ${meta.lasVersion} PDRF ${meta.pointFormat} - ${formatBytes(meta.fileSize)}`
      : null,
    boundsSummary: boundsSummary(asset),
    warnings: asset.warnings,
    index,
    surfels,
  }
}
