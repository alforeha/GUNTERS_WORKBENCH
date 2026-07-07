import './style.css'
import { isOpenProjectError, type ProjectSession } from './shared/ipc'
import type { PointCloudDataset, SurfaceModel } from './core/contract'
import type { AssetRecord, ProjectManifest, SimulationLayer, SimulationLayerKind } from './shared/workbench-types'
import { ViewerEngine } from './viewer'
import { hasValidIndexForStreaming } from '../src/shared/pointcloud-index'
import { DEFAULT_SURFEL_CELL_SCALE } from './shared/analytic-surfels'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('App root missing')
}

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

let currentSession: ProjectSession | null = null
let viewer: ViewerEngine | null = null
let selectedPointCloudSourceAssetId: string | null = null
let pendingDensifyKey = ''
let pendingDensify = false
let streamingDisclosureTimer: number | null = null

const previewLayers = new Map<string, PreviewLayerEntry>()
const previewLayerByHandle = new Map<string, string>()
const indexLayers = new Map<string, IndexLayerEntry>()
const derivedSurfaceLayers = new Map<string, DerivedSurfaceLayerEntry>()
const derivedSurfelLayers = new Map<string, DerivedSurfelLayerEntry>()

app.innerHTML = `
  <main class="shell">
    <section class="toolbar">
      <button id="btn-new">New Project</button>
      <button id="btn-open">Open Project</button>
      <button id="btn-save">Save</button>
      <button id="btn-close">Close</button>
      <button id="btn-import-pointcloud">Import Point Cloud</button>
      <button id="btn-index-pointcloud">Build Index &amp; Stream</button>
      <button id="btn-warning">Record Unit Warning</button>
      <button id="btn-derived">Generate Surfel Layer</button>
    </section>
    <section class="status-panel">
      <h1>Gunters Workbench</h1>
      <div id="project-path">No project loaded</div>
      <div id="recovery"></div>
      <div id="pointcloud-progress" class="note"></div>
      <div id="pointcloud-disclosure" class="pointcloud-disclosure"></div>
      <label class="viewer-control viewer-control-inline">
        <input id="pointcloud-edl" type="checkbox" checked />
        Depth shading (EDL-like)
      </label>
      <label class="viewer-control viewer-control-inline">
        <input id="pointcloud-fog" type="checkbox" />
        Distance fog
      </label>
      <label class="viewer-control">
        Display mode
        <select id="pointcloud-mode">
          <option value="rgb">RGB</option>
          <option value="elevation">Elevation</option>
          <option value="intensity">Intensity</option>
        </select>
      </label>
      <label class="viewer-control">
        Point size
        <input id="pointcloud-size" type="range" min="1" max="5" value="2" />
      </label>
      <label class="viewer-control">
        Surfel size
        <input id="surfel-size" type="range" min="1" max="5" value="2" />
      </label>
      <h2>Layers</h2>
      <ul id="layer-list"></ul>
      <h2>Assets</h2>
      <ul id="asset-list"></ul>
    </section>
    <section class="viewer-wrap">
      <div id="viewer-host"></div>
    </section>
  </main>
`

const projectPathEl = document.querySelector<HTMLDivElement>('#project-path')
const recoveryEl = document.querySelector<HTMLDivElement>('#recovery')
const layerListEl = document.querySelector<HTMLUListElement>('#layer-list')
const assetListEl = document.querySelector<HTMLUListElement>('#asset-list')
const viewerHost = document.querySelector<HTMLDivElement>('#viewer-host')
const pointCloudProgressEl = document.querySelector<HTMLDivElement>('#pointcloud-progress')
const pointCloudDisclosureEl = document.querySelector<HTMLDivElement>('#pointcloud-disclosure')
const pointCloudModeEl = document.querySelector<HTMLSelectElement>('#pointcloud-mode')
const pointCloudSizeEl = document.querySelector<HTMLInputElement>('#pointcloud-size')
const surfelSizeEl = document.querySelector<HTMLInputElement>('#surfel-size')
const pointCloudEdlEl = document.querySelector<HTMLInputElement>('#pointcloud-edl')
const pointCloudFogEl = document.querySelector<HTMLInputElement>('#pointcloud-fog')

if (
  !projectPathEl ||
  !recoveryEl ||
  !layerListEl ||
  !assetListEl ||
  !viewerHost ||
  !pointCloudProgressEl ||
  !pointCloudDisclosureEl ||
  !pointCloudModeEl ||
  !pointCloudSizeEl ||
  !surfelSizeEl ||
  !pointCloudEdlEl ||
  !pointCloudFogEl
) {
  throw new Error('UI initialization failed')
}

const safeProjectPathEl = projectPathEl
const safeRecoveryEl = recoveryEl
const safeLayerListEl = layerListEl
const safeAssetListEl = assetListEl
const safeViewerHost = viewerHost
const safePointCloudProgressEl = pointCloudProgressEl
const safePointCloudDisclosureEl = pointCloudDisclosureEl
const safePointCloudModeEl = pointCloudModeEl
const safePointCloudSizeEl = pointCloudSizeEl
const safeSurfelSizeEl = surfelSizeEl
const safePointCloudEdlEl = pointCloudEdlEl
const safePointCloudFogEl = pointCloudFogEl
const OPEN_PROJECT_FAILURE_MESSAGE =
  'Project manifest is missing or corrupt. Manual restore is available from project.json.bak; auto-restore is not implemented yet.'

function ensureViewer(): ViewerEngine {
  if (!viewer) {
    viewer = new ViewerEngine(safeViewerHost)
    viewer.onPointCloudSettled(({ handle, nodeIds }) => {
      void requestNearCameraDensification(handle, nodeIds)
    })
    viewer.setPointCloudEdl(safePointCloudEdlEl.checked)
    viewer.setPointCloudFog(safePointCloudFogEl.checked)
  }
  return viewer
}

function compactCount(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function resolveLayerKind(layer: SimulationLayer, asset: AssetRecord | null): SimulationLayerKind {
  if (layer.kind !== 'asset') return layer.kind
  if (asset?.kind === 'point-cloud-index') return 'point-cloud-index'
  if (asset?.kind === 'point-cloud') return 'point-cloud-preview'
  if (asset?.kind === 'analytic-surfel-render' && asset.truthStatus === 'derived') return 'derived-surfel'
  if (asset?.kind === 'surface' && asset.truthStatus === 'derived') return 'derived-surface'
  return 'asset'
}

function findLayer(layerId: string): SimulationLayer | null {
  return currentSession?.manifest.simulationLayers.find((candidate) => candidate.id === layerId) ?? null
}

function findLayerAsset(layer: SimulationLayer, manifest: ProjectManifest): AssetRecord | null {
  return layer.assetId ? manifest.assets.find((asset) => asset.id === layer.assetId) ?? null : null
}

function isDerivedArtifactPath(managedPath: string | null): managedPath is string {
  return managedPath !== null && managedPath.replace(/\\/g, '/').startsWith('derived/')
}

function syncDisclosureRefreshLoop(): void {
  if (indexLayers.size > 0 || derivedSurfelLayers.size > 0) {
    if (streamingDisclosureTimer !== null) return
    streamingDisclosureTimer = window.setInterval(() => {
      updatePointCloudDisclosure()
    }, 300)
    return
  }
  if (streamingDisclosureTimer !== null) {
    window.clearInterval(streamingDisclosureTimer)
    streamingDisclosureTimer = null
  }
}

function pointCloudSourceAssetIdForIndexAsset(asset: AssetRecord): string | null {
  return asset.pointCloudIndex?.sourceAssetId ?? null
}

function applyLoadedLayerVisibility(layerId: string, visible: boolean): void {
  if (!viewer) return
  const size = Number(safePointCloudSizeEl.value)
  const previewEntry = previewLayers.get(layerId)
  if (previewEntry) viewer.setPointCloudDisplay(previewEntry.handle, visible, size)
  const indexEntry = indexLayers.get(layerId)
  if (indexEntry) viewer.setPointCloudIndexDisplay(indexEntry.handle, visible, size)
  const surfaceEntry = derivedSurfaceLayers.get(layerId)
  if (surfaceEntry) viewer.setSurfaceVisible(surfaceEntry.handle, visible)
  const surfelEntry = derivedSurfelLayers.get(layerId)
  if (surfelEntry) viewer.setAnalyticSurfelsDisplay(surfelEntry.handle, visible, Number(safeSurfelSizeEl.value))
  updatePointCloudDisclosure()
}

function updatePointCloudDisclosure(): void {
  if (!currentSession) {
    safePointCloudDisclosureEl.textContent = ''
    return
  }

  const lines: string[] = []

  for (const entry of previewLayers.values()) {
    const layer = findLayer(entry.layerId)
    if (!layer || layer.status !== 'active') continue
    const densifiedCount = viewer ? viewer.getPointCloudDensifiedPointCount(entry.handle) : 0
    const mixed = densifiedCount > 0 && entry.preview.sourceAvailable
    const warningText = entry.preview.warnings.length > 0 ? ` WARNING: ${entry.preview.warnings.join(' | ')}` : ''
    const disclosure = mixed
      ? `Preview - sampled ${compactCount(entry.preview.sampledPointCount)} of ${compactCount(entry.preview.totalPointCount)} points · source densification fallback`
      : `Preview - sampled ${compactCount(entry.preview.sampledPointCount)} of ${compactCount(entry.preview.totalPointCount)} points`
    lines.push(`${disclosure} - truth preview-sampled; source asset remains source${warningText}`)
  }

  if (viewer) {
    for (const entry of indexLayers.values()) {
      const layer = findLayer(entry.layerId)
      if (!layer || layer.status !== 'active') continue
      const text = viewer.getPointCloudIndexDisclosure(entry.handle)
      if (text) lines.push(`${text} - truth indexed-full; source asset remains source`)
    }
    for (const entry of derivedSurfelLayers.values()) {
      const layer = findLayer(entry.layerId)
      if (!layer || layer.status !== 'active') continue
      const text = viewer.getAnalyticSurfelsDisclosure(entry.handle)
      if (text) lines.push(text)
    }
  }

  safePointCloudDisclosureEl.textContent = lines.join('\n')
}

async function requestNearCameraDensification(handle: string, nodeIds: number[]): Promise<void> {
  if (!viewer || nodeIds.length === 0) return
  const layerId = previewLayerByHandle.get(handle)
  if (!layerId) return
  const previewEntry = previewLayers.get(layerId)
  if (!previewEntry) return
  const layer = findLayer(layerId)
  if (!layer || layer.status !== 'active') return

  if (currentSession) {
    const indexAsset = currentSession.manifest.assets.find((a) => a.pointCloudIndex?.sourceAssetId === previewEntry.assetId)
    if (hasValidIndexForStreaming(indexAsset)) return
  }

  const requestKey = `${previewEntry.assetId}:${nodeIds.join(',')}`
  if (pendingDensify && pendingDensifyKey === requestKey) return
  pendingDensify = true
  pendingDensifyKey = requestKey
  safePointCloudProgressEl.textContent = 'Loading near-camera densification (fallback)...'
  try {
    const result = await window.workbench.loadPointCloudDensifiedNodes({
      assetId: previewEntry.assetId,
      nodeIds,
    })
    if (!viewer || previewLayerByHandle.get(handle) !== layerId) return
    if (!result.sourceAvailable) {
      previewEntry.preview.sourceAvailable = false
      if (result.warning && !previewEntry.preview.warnings.includes(result.warning)) {
        previewEntry.preview.warnings = [...previewEntry.preview.warnings, result.warning]
      }
      updatePointCloudDisclosure()
      safePointCloudProgressEl.textContent = result.warning ?? ''
      return
    }
    for (const node of result.nodes) {
      viewer.applyPointCloudDensifiedNode(handle, node.nodeId, node.payload)
    }
    updatePointCloudDisclosure()
    safePointCloudProgressEl.textContent = result.nodes.length > 0 ? 'Full density ready near camera.' : ''
  } catch (error) {
    console.error(error)
    safePointCloudProgressEl.textContent = 'Full-density load failed; showing cached preview.'
  } finally {
    pendingDensify = false
  }
}

function renderLayerList(session: ProjectSession): void {
  safeLayerListEl.innerHTML = ''
  for (const layer of session.manifest.simulationLayers) {
    const asset = findLayerAsset(layer, session.manifest)
    const kind = resolveLayerKind(layer, asset)
    const truthLabel = kind === 'point-cloud-preview' ? 'preview-sampled' : asset?.truthStatus ?? 'derived'
    const li = document.createElement('li')
    li.className = 'layer-row'

    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = layer.status === 'active'
    toggle.addEventListener('change', () => {
      void setLayerVisibility(layer.id, toggle.checked)
    })

    const title = document.createElement('div')
    title.className = 'layer-title'
    title.innerHTML = `<span>${layer.name}</span><span class="truth-badge truth-${truthLabel}">${truthLabel}</span>`

    const meta = document.createElement('div')
    meta.className = 'layer-meta'
    meta.textContent = `${kind} · ${layer.status}${asset?.warnings.length ? ` · ${asset.warnings.join(' | ')}` : ''}`

    li.append(toggle, title, meta)
    safeLayerListEl.appendChild(li)
  }
}

function renderSession(session: ProjectSession): void {
  currentSession = session
  safeProjectPathEl.textContent = `Project: ${session.projectFolder}`
  safeRecoveryEl.textContent = session.recoveryDetected
    ? 'Recovery note: unclean shutdown detected from journal/temp.'
    : 'Recovery note: clean state.'

  renderLayerList(session)

  safeAssetListEl.innerHTML = ''
  for (const asset of session.manifest.assets) {
    const layers = session.manifest.simulationLayers.filter((candidate) => candidate.assetId === asset.id)
    const li = document.createElement('li')
    li.className = 'asset-row'
    const pointCloudMeta =
      asset.pointCloud !== undefined
        ? ` ${asset.pointCloud.lasVersion} PDRF ${asset.pointCloud.pointFormat} ${asset.pointCloud.pointCount.toLocaleString()} pts`
        : ''
    const warningText = asset.warnings.length > 0 ? ` warnings=${asset.warnings.join(' | ')}` : ''
    const layerText =
      layers.length > 0
        ? ` layers=${layers.map((layer) => `${resolveLayerKind(layer, asset)}:${layer.status}`).join(', ')}`
        : ''
    li.innerHTML = `<span>${asset.name}${pointCloudMeta}</span><span class="truth-badge truth-${asset.truthStatus}">${asset.truthStatus}</span><span class="warn-text">${layerText}${warningText}</span>`
    safeAssetListEl.appendChild(li)
  }

  updatePointCloudDisclosure()
}

function renderProjectClosed(message = 'No project loaded', recovery = ''): void {
  currentSession = null
  selectedPointCloudSourceAssetId = null
  pendingDensify = false
  pendingDensifyKey = ''
  safeProjectPathEl.textContent = message
  safeRecoveryEl.textContent = recovery
  safeLayerListEl.innerHTML = ''
  safeAssetListEl.innerHTML = ''
  safePointCloudProgressEl.textContent = ''
  safePointCloudDisclosureEl.textContent = ''
  stopStreamingDisclosure()
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

async function saveCurrentManifest(): Promise<void> {
  if (!currentSession) return
  currentSession = await window.workbench.saveProject(currentSession.manifest as ProjectManifest)
  renderSession(currentSession)
}

function stopStreamingDisclosure(): void {
  if (streamingDisclosureTimer !== null) {
    window.clearInterval(streamingDisclosureTimer)
    streamingDisclosureTimer = null
  }
}

function startStreamingDisclosure(): void {
  syncDisclosureRefreshLoop()
}

function clearViewerScene(): void {
  selectedPointCloudSourceAssetId = null
  pendingDensify = false
  pendingDensifyKey = ''
  previewLayers.clear()
  previewLayerByHandle.clear()
  indexLayers.clear()
  derivedSurfaceLayers.clear()
  derivedSurfelLayers.clear()
  stopStreamingDisclosure()
  viewer?.clearSceneContents()
}

async function markLayerError(layerId: string): Promise<void> {
  if (!currentSession) return
  const manifest = structuredClone(currentSession.manifest as ProjectManifest)
  const layer = manifest.simulationLayers.find((candidate) => candidate.id === layerId)
  if (!layer) return
  layer.status = 'error'
  layer.modifiedAt = new Date().toISOString()
  currentSession = await window.workbench.saveProject(manifest)
  renderSession(currentSession)
}

async function ensurePreviewLayerLoaded(layer: SimulationLayer, asset: AssetRecord): Promise<void> {
  const engine = ensureViewer()
  const existing = previewLayers.get(layer.id)
  if (existing) {
    engine.setPointCloudDisplay(existing.handle, layer.status === 'active', Number(safePointCloudSizeEl.value))
    updatePointCloudDisclosure()
    return
  }

  safePointCloudProgressEl.textContent = 'Restoring preview from cache...'
  const result = await window.workbench.loadPointCloudPreview({ assetId: asset.id })
  const handle = engine.addPointCloud(result.dataset as PointCloudDataset)
  previewLayers.set(layer.id, {
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
  previewLayerByHandle.set(handle, layer.id)
  selectedPointCloudSourceAssetId = asset.id
  engine.setPointCloudDisplay(handle, layer.status === 'active', Number(safePointCloudSizeEl.value))
  engine.setPointCloudDensifiedPointBudget(handle, 1_500_000)
  engine.setPointCloudDisplayMode(handle, safePointCloudModeEl.value as 'rgb' | 'elevation' | 'intensity')
  updatePointCloudDisclosure()
}

async function ensureIndexLayerLoaded(layer: SimulationLayer, asset: AssetRecord, forceReload = false): Promise<void> {
  const sourceAssetId = pointCloudSourceAssetIdForIndexAsset(asset)
  if (!sourceAssetId) throw new Error(`Index layer ${layer.id} is missing a source asset reference.`)
  const engine = ensureViewer()
  const existing = indexLayers.get(layer.id)
  if (existing && forceReload) {
    engine.removePointCloudIndex(existing.handle)
    indexLayers.delete(layer.id)
  } else if (existing) {
    engine.setPointCloudIndexDisplay(existing.handle, layer.status === 'active', Number(safePointCloudSizeEl.value))
    updatePointCloudDisclosure()
    return
  }

  const hierarchy = await window.workbench.loadPointCloudIndexHierarchy({ assetId: sourceAssetId })
  const handle = engine.addPointCloudIndex(hierarchy, (keys) =>
    window.workbench.loadPointCloudIndexTiles({ assetId: sourceAssetId, keys }).then((response) => response.tiles),
  )
  indexLayers.set(layer.id, { layerId: layer.id, assetId: asset.id, sourceAssetId, handle })
  selectedPointCloudSourceAssetId = sourceAssetId
  engine.setPointCloudIndexDisplay(handle, layer.status === 'active', Number(safePointCloudSizeEl.value))
  engine.setPointCloudIndexDisplayMode(handle, safePointCloudModeEl.value as 'rgb' | 'elevation' | 'intensity')
  syncDisclosureRefreshLoop()
  updatePointCloudDisclosure()
}

async function ensureDerivedSurfaceLayerLoaded(layer: SimulationLayer, asset: AssetRecord): Promise<void> {
  if (!asset.managedPath) return
  const engine = ensureViewer()
  const existing = derivedSurfaceLayers.get(layer.id)
  if (existing) {
    engine.setSurfaceVisible(existing.handle, layer.status === 'active')
    return
  }

  const serialized = await window.workbench.readDerivedSurfaceArtifact(asset.managedPath)
  const handle = engine.addSurface(toSurfaceModel(serialized))
  derivedSurfaceLayers.set(layer.id, { layerId: layer.id, assetId: asset.id, handle })
  engine.setSurfaceVisible(handle, layer.status === 'active')
}

async function ensureDerivedSurfelLayerLoaded(layer: SimulationLayer, asset: AssetRecord, forceReload = false): Promise<void> {
  const engine = ensureViewer()
  const existing = derivedSurfelLayers.get(layer.id)
  if (existing && forceReload) {
    engine.removeAnalyticSurfels(existing.handle)
    derivedSurfelLayers.delete(layer.id)
  } else if (existing) {
    engine.setAnalyticSurfelsDisplay(existing.handle, layer.status === 'active', Number(safeSurfelSizeEl.value))
    updatePointCloudDisclosure()
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
    (keys) =>
    window.workbench.loadAnalyticSurfelTiles({ assetId: asset.id, keys }).then((response) => response.tiles),
  )
  derivedSurfelLayers.set(layer.id, { layerId: layer.id, assetId: asset.id, handle })
  engine.setAnalyticSurfelsDisplay(handle, layer.status === 'active', Number(safeSurfelSizeEl.value))
  syncDisclosureRefreshLoop()
  updatePointCloudDisclosure()
}

async function ensureLayerLoaded(layerId: string, forceReload = false): Promise<void> {
  if (!currentSession) return
  const layer = currentSession.manifest.simulationLayers.find((candidate) => candidate.id === layerId)
  if (!layer || !layer.assetId) return
  const asset = currentSession.manifest.assets.find((candidate) => candidate.id === layer.assetId) ?? null
  const kind = resolveLayerKind(layer, asset)
  if (!asset) return

  if (kind === 'point-cloud-preview') {
    await ensurePreviewLayerLoaded(layer, asset)
    return
  }
  if (kind === 'point-cloud-index') {
    await ensureIndexLayerLoaded(layer, asset, forceReload)
    return
  }
  if (kind === 'derived-surfel') {
    await ensureDerivedSurfelLayerLoaded(layer, asset, forceReload)
    return
  }
  if (kind === 'derived-surface' && asset.managedPath && isDerivedArtifactPath(asset.managedPath)) {
    await ensureDerivedSurfaceLayerLoaded(layer, asset)
  }
}

async function setLayerVisibility(layerId: string, visible: boolean): Promise<void> {
  if (!currentSession) return
  const manifest = structuredClone(currentSession.manifest as ProjectManifest)
  const layer = manifest.simulationLayers.find((candidate) => candidate.id === layerId)
  if (!layer) return
  layer.status = visible ? 'active' : 'hidden'
  layer.modifiedAt = new Date().toISOString()
  currentSession = await window.workbench.saveProject(manifest)
  renderSession(currentSession)

  if (!visible) {
    applyLoadedLayerVisibility(layerId, false)
    return
  }

  try {
    await ensureLayerLoaded(layerId)
  } catch (error) {
    console.error(error)
    await markLayerError(layerId)
  }
}

async function loadDerivedLayerSurfaces(session: ProjectSession): Promise<void> {
  for (const layer of session.manifest.simulationLayers.filter((candidate) => candidate.status !== 'hidden')) {
    const asset = findLayerAsset(layer, session.manifest)
    if (!asset || !asset.managedPath || !isDerivedArtifactPath(asset.managedPath)) continue
    const kind = resolveLayerKind(layer, asset)
    if (kind !== 'derived-surface' && kind !== 'derived-surfel') continue
    try {
      await ensureLayerLoaded(layer.id)
    } catch (error) {
      console.error(error)
    }
  }
}

async function loadPointCloudLayers(session: ProjectSession): Promise<void> {
  for (const layer of session.manifest.simulationLayers.filter((candidate) => candidate.status !== 'hidden')) {
    const asset = findLayerAsset(layer, session.manifest)
    const kind = resolveLayerKind(layer, asset)
    if (kind !== 'point-cloud-preview' && kind !== 'point-cloud-index') continue
    try {
      await ensureLayerLoaded(layer.id)
    } catch (error) {
      console.error(error)
    }
  }
}

window.workbench.onPointCloudPreviewProgress((progress) => {
  const pctText = progress.pct === null ? '' : ` ${progress.pct}%`
  safePointCloudProgressEl.textContent = `${progress.label}${pctText}`
})

window.workbench.onPointCloudIndexProgress((progress) => {
  const pctText = progress.pct === null ? '' : ` ${progress.pct}%`
  safePointCloudProgressEl.textContent = `Indexing: ${progress.label}${pctText}`
})

window.workbench.onAnalyticSurfelProgress((progress) => {
  const pctText = progress.pct === null ? '' : ` ${progress.pct}%`
  safePointCloudProgressEl.textContent = `Surfels: ${progress.label}${pctText}`
})

document.querySelector<HTMLButtonElement>('#btn-index-pointcloud')?.addEventListener('click', async () => {
  const assetId =
    selectedPointCloudSourceAssetId ?? currentSession?.manifest.assets.find((asset) => asset.kind === 'point-cloud')?.id ?? null
  if (!assetId) return
  try {
    safePointCloudProgressEl.textContent = 'Building full index...'
    const result = await window.workbench.generatePointCloudIndex({ assetId })
    renderSession(result.session)
    const indexLayer = result.session.manifest.simulationLayers.find((layer) => layer.assetId === result.indexAssetId)
    if (indexLayer) {
      await ensureLayerLoaded(indexLayer.id, true)
    }
    startStreamingDisclosure()
    safePointCloudProgressEl.textContent = `Index ready: ${result.metrics.tileCount.toLocaleString()} tiles, ${compactCount(result.metrics.pointCount)} points`
  } catch (error) {
    console.error(error)
    safePointCloudProgressEl.textContent = 'Index build failed; preview remains available.'
  }
})

document.querySelector<HTMLButtonElement>('#btn-new')?.addEventListener('click', async () => {
  const target = await window.workbench.pickNewProjectPath()
  if (!target) return
  clearViewerScene()
  const session = await window.workbench.createProject(target)
  renderSession(session)
})

document.querySelector<HTMLButtonElement>('#btn-open')?.addEventListener('click', async () => {
  const projectFolder = await window.workbench.pickProjectFolder()
  if (!projectFolder) return
  clearViewerScene()
  try {
    const session = await window.workbench.openProject({ projectFolder })
    renderSession(session)
    await loadDerivedLayerSurfaces(session)
    await loadPointCloudLayers(session)
    safePointCloudProgressEl.textContent = ''
  } catch (error) {
    renderProjectClosed('Open project failed', OPEN_PROJECT_FAILURE_MESSAGE)
    if (!isOpenProjectError(error)) {
      console.error(error)
    }
  }
})

document.querySelector<HTMLButtonElement>('#btn-save')?.addEventListener('click', async () => {
  await saveCurrentManifest()
})

document.querySelector<HTMLButtonElement>('#btn-close')?.addEventListener('click', async () => {
  await window.workbench.closeProject()
  clearViewerScene()
  renderProjectClosed()
})

document.querySelector<HTMLButtonElement>('#btn-import-pointcloud')?.addEventListener('click', async () => {
  if (!currentSession) return
  const chosen = await window.workbench.pickPointCloudImport()
  if (!chosen) return
  safePointCloudDisclosureEl.textContent = ''
  const session = await window.workbench.importPointCloud(chosen)
  renderSession(session)
  const previewLayersInSession = session.manifest.simulationLayers.filter((layer) => {
    const asset = findLayerAsset(layer, session.manifest)
    return resolveLayerKind(layer, asset) === 'point-cloud-preview'
  })
  const latestPreviewLayer = previewLayersInSession[previewLayersInSession.length - 1]
  if (latestPreviewLayer) await ensureLayerLoaded(latestPreviewLayer.id)
  updatePointCloudDisclosure()
  safePointCloudProgressEl.textContent = ''
})

document.querySelector<HTMLButtonElement>('#btn-warning')?.addEventListener('click', async () => {
  if (!currentSession || currentSession.manifest.assets.length === 0) return
  const firstAsset = currentSession.manifest.assets[0]
  const session = await window.workbench.addUnitMismatchWarning({
    assetId: firstAsset.id,
    warning: 'Unit mismatch: source units differ from project units.',
  })
  renderSession(session)
})

document.querySelector<HTMLButtonElement>('#btn-derived')?.addEventListener('click', async () => {
  const assetId =
    selectedPointCloudSourceAssetId ?? currentSession?.manifest.assets.find((asset) => asset.kind === 'point-cloud')?.id ?? null
  if (!assetId) {
    const result = await window.workbench.generatePlaceholderDerivedLayer()
    renderSession(result.session)
    const surfaceLayers = result.session.manifest.simulationLayers.filter((layer) => {
      const asset = findLayerAsset(layer, result.session.manifest)
      return resolveLayerKind(layer, asset) === 'derived-surface'
    })
    const latestSurfaceLayer = surfaceLayers[surfaceLayers.length - 1]
    if (latestSurfaceLayer) await ensureLayerLoaded(latestSurfaceLayer.id)
    return
  }
  const result = await window.workbench.generateAnalyticSurfels({ assetId, surfelCellScale: DEFAULT_SURFEL_CELL_SCALE })
  renderSession(result.session)
  const surfelLayer = result.session.manifest.simulationLayers.find((layer) => layer.assetId === result.surfelAssetId)
  if (surfelLayer) await ensureLayerLoaded(surfelLayer.id, true)
  safePointCloudProgressEl.textContent = `Surfels ready: ${compactCount(result.metrics.surfelCount)} surfels across ${result.metrics.nodeCount.toLocaleString()} nodes`
})

safePointCloudModeEl.addEventListener('change', () => {
  if (!viewer) return
  const mode = safePointCloudModeEl.value as 'rgb' | 'elevation' | 'intensity'
  for (const entry of previewLayers.values()) viewer.setPointCloudDisplayMode(entry.handle, mode)
  for (const entry of indexLayers.values()) viewer.setPointCloudIndexDisplayMode(entry.handle, mode)
})

safePointCloudSizeEl.addEventListener('input', () => {
  if (!viewer) return
  const size = Number(safePointCloudSizeEl.value)
  for (const entry of previewLayers.values()) {
    const layer = findLayer(entry.layerId)
    viewer.setPointCloudDisplay(entry.handle, layer?.status === 'active', size)
  }
  for (const entry of indexLayers.values()) {
    const layer = findLayer(entry.layerId)
    viewer.setPointCloudIndexDisplay(entry.handle, layer?.status === 'active', size)
  }
})

safeSurfelSizeEl.addEventListener('input', () => {
  if (!viewer) return
  const size = Number(safeSurfelSizeEl.value)
  for (const entry of derivedSurfelLayers.values()) {
    const layer = findLayer(entry.layerId)
    viewer.setAnalyticSurfelsDisplay(entry.handle, layer?.status === 'active', size)
  }
})

safePointCloudEdlEl.addEventListener('change', () => {
  ensureViewer().setPointCloudEdl(safePointCloudEdlEl.checked)
})

safePointCloudFogEl.addEventListener('change', () => {
  ensureViewer().setPointCloudFog(safePointCloudFogEl.checked)
})
