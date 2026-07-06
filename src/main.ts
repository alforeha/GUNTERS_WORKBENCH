import './style.css'
import { isOpenProjectError, type ProjectSession } from './shared/ipc'
import type { PointCloudDataset, SurfaceModel } from './core/contract'
import type { ProjectManifest } from './shared/workbench-types'
import { ViewerEngine } from './viewer'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('App root missing')
}

let currentSession: ProjectSession | null = null
let viewer: ViewerEngine | null = null
let activePointCloudHandle: string | null = null
let activePointCloudAssetId: string | null = null
let activePointCloudPreview: {
  sampledPointCount: number
  totalPointCount: number
  warnings: string[]
  sourceAvailable: boolean
} | null = null
let pendingDensifyKey = ''
let pendingDensify = false
let activePointCloudIndexHandle: string | null = null
let streamingDisclosureTimer: number | null = null

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
      <button id="btn-derived">Generate Derived Layer</button>
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
const assetListEl = document.querySelector<HTMLUListElement>('#asset-list')
const viewerHost = document.querySelector<HTMLDivElement>('#viewer-host')
const pointCloudProgressEl = document.querySelector<HTMLDivElement>('#pointcloud-progress')
const pointCloudDisclosureEl = document.querySelector<HTMLDivElement>('#pointcloud-disclosure')
const pointCloudModeEl = document.querySelector<HTMLSelectElement>('#pointcloud-mode')
const pointCloudSizeEl = document.querySelector<HTMLInputElement>('#pointcloud-size')
const pointCloudEdlEl = document.querySelector<HTMLInputElement>('#pointcloud-edl')
const pointCloudFogEl = document.querySelector<HTMLInputElement>('#pointcloud-fog')

if (
  !projectPathEl ||
  !recoveryEl ||
  !assetListEl ||
  !viewerHost ||
  !pointCloudProgressEl ||
  !pointCloudDisclosureEl ||
  !pointCloudModeEl ||
  !pointCloudSizeEl ||
  !pointCloudEdlEl ||
  !pointCloudFogEl
) {
  throw new Error('UI initialization failed')
}

const safeProjectPathEl = projectPathEl
const safeRecoveryEl = recoveryEl
const safeAssetListEl = assetListEl
const safeViewerHost = viewerHost
const safePointCloudProgressEl = pointCloudProgressEl
const safePointCloudDisclosureEl = pointCloudDisclosureEl
const safePointCloudModeEl = pointCloudModeEl
const safePointCloudSizeEl = pointCloudSizeEl
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

function updatePointCloudDisclosure(): void {
  if (!activePointCloudPreview) {
    safePointCloudDisclosureEl.textContent = ''
    return
  }
  const densifiedCount =
    viewer && activePointCloudHandle ? viewer.getPointCloudDensifiedPointCount(activePointCloudHandle) : 0
  const mixed = densifiedCount > 0 && activePointCloudPreview.sourceAvailable
  const warningText = activePointCloudPreview.warnings.length > 0 ? ` WARNING: ${activePointCloudPreview.warnings.join(' | ')}` : ''
  const disclosure = mixed
    ? `Preview - sampled ${compactCount(activePointCloudPreview.sampledPointCount)} of ${compactCount(activePointCloudPreview.totalPointCount)} points · full density near camera`
    : `Preview - sampled ${compactCount(activePointCloudPreview.sampledPointCount)} of ${compactCount(activePointCloudPreview.totalPointCount)} points`
  safePointCloudDisclosureEl.textContent =
    `${disclosure} - truth preview-sampled; source asset remains source${warningText}`
}

async function requestNearCameraDensification(handle: string, nodeIds: number[]): Promise<void> {
  if (!viewer || !activePointCloudHandle || !activePointCloudAssetId) return
  if (handle !== activePointCloudHandle || nodeIds.length === 0) return
  const requestKey = `${activePointCloudAssetId}:${nodeIds.join(',')}`
  if (pendingDensify && pendingDensifyKey === requestKey) return
  pendingDensify = true
  pendingDensifyKey = requestKey
  safePointCloudProgressEl.textContent = 'Loading full density near camera...'
  try {
    const result = await window.workbench.loadPointCloudDensifiedNodes({
      assetId: activePointCloudAssetId,
      nodeIds,
    })
    if (!viewer || handle !== activePointCloudHandle) return
    if (!result.sourceAvailable) {
      if (activePointCloudPreview) {
        activePointCloudPreview.sourceAvailable = false
        if (result.warning && !activePointCloudPreview.warnings.includes(result.warning)) {
          activePointCloudPreview.warnings = [...activePointCloudPreview.warnings, result.warning]
        }
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

function renderSession(session: ProjectSession): void {
  currentSession = session
  safeProjectPathEl.textContent = `Project: ${session.projectFolder}`
  safeRecoveryEl.textContent = session.recoveryDetected
    ? 'Recovery note: unclean shutdown detected from journal/temp.'
    : 'Recovery note: clean state.'

  safeAssetListEl.innerHTML = ''
  for (const asset of session.manifest.assets) {
    const layer = session.manifest.simulationLayers.find((candidate) => candidate.assetId === asset.id)
    const li = document.createElement('li')
    li.className = 'asset-row'
    const pointCloudMeta =
      asset.pointCloud !== undefined
        ? ` ${asset.pointCloud.lasVersion} PDRF ${asset.pointCloud.pointFormat} ${asset.pointCloud.pointCount.toLocaleString()} pts`
        : ''
    const warningText = asset.warnings.length > 0 ? ` warnings=${asset.warnings.join(' | ')}` : ''
    const layerText = layer ? ` layer=${layer.status}` : ''
    li.innerHTML = `<span>${asset.name}${pointCloudMeta}</span><span class="truth-badge truth-${asset.truthStatus}">${asset.truthStatus}</span><span class="warn-text">${layerText}${warningText}</span>`
    safeAssetListEl.appendChild(li)
  }
}

function renderProjectClosed(message = 'No project loaded', recovery = ''): void {
  currentSession = null
  activePointCloudHandle = null
  activePointCloudAssetId = null
  activePointCloudPreview = null
  activePointCloudIndexHandle = null
  pendingDensify = false
  pendingDensifyKey = ''
  stopStreamingDisclosure()
  safeProjectPathEl.textContent = message
  safeRecoveryEl.textContent = recovery
  safeAssetListEl.innerHTML = ''
  safePointCloudProgressEl.textContent = ''
  safePointCloudDisclosureEl.textContent = ''
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
  if (!currentSession) {
    return
  }
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
  stopStreamingDisclosure()
  streamingDisclosureTimer = window.setInterval(() => {
    if (!viewer || !activePointCloudIndexHandle) return
    const text = viewer.getPointCloudIndexDisclosure(activePointCloudIndexHandle)
    if (text) {
      safePointCloudDisclosureEl.textContent = `${text} - truth indexed-full; source asset remains source`
    }
  }, 300)
}

function clearViewerScene(): void {
  activePointCloudHandle = null
  activePointCloudAssetId = null
  activePointCloudPreview = null
  activePointCloudIndexHandle = null
  pendingDensify = false
  pendingDensifyKey = ''
  stopStreamingDisclosure()
  viewer?.clearSceneContents()
}

function isDerivedArtifactPath(managedPath: string | null): managedPath is string {
  return managedPath !== null && managedPath.replace(/\\/g, '/').startsWith('derived/')
}

async function loadDerivedLayerSurfaces(session: ProjectSession): Promise<void> {
  const derivedAssets = new Map(session.manifest.assets.map((asset) => [asset.id, asset]))
  const layersToLoad = session.manifest.simulationLayers
    .map((layer) => ({ layer, asset: layer.assetId ? derivedAssets.get(layer.assetId) ?? null : null }))
    .filter(
      (
        entry,
      ): entry is {
        layer: ProjectSession['manifest']['simulationLayers'][number]
        asset: ProjectSession['manifest']['assets'][number]
      } => entry.asset !== null && isDerivedArtifactPath(entry.asset.managedPath),
    )

  if (layersToLoad.length === 0) {
    return
  }

  const engine = ensureViewer()
  for (const { asset } of layersToLoad) {
    const managedPath = asset.managedPath
    if (!managedPath) {
      continue
    }
    const serialized = await window.workbench.readDerivedSurfaceArtifact(managedPath)
    engine.addSurface(toSurfaceModel(serialized))
  }
}

async function loadPointCloudLayers(session: ProjectSession): Promise<void> {
  const pointCloudAssets = new Map(
    session.manifest.assets.filter((asset) => asset.kind === 'point-cloud').map((asset) => [asset.id, asset]),
  )
  const layersToLoad = session.manifest.simulationLayers.filter(
    (layer) => layer.assetId && layer.status !== 'hidden' && pointCloudAssets.has(layer.assetId),
  )
  if (layersToLoad.length === 0) {
    return
  }

  for (const layer of layersToLoad) {
    try {
      safePointCloudProgressEl.textContent = 'Restoring preview from cache...'
      const result = await window.workbench.loadPointCloudPreview({ assetId: layer.assetId as string })
      const engine = ensureViewer()
      activePointCloudHandle = engine.addPointCloud(result.dataset as PointCloudDataset)
      activePointCloudAssetId = result.assetId
      activePointCloudPreview = {
        sampledPointCount: result.preview.sampledPointCount,
        totalPointCount: result.preview.totalPointCount,
        warnings: [...result.preview.warnings],
        sourceAvailable: result.preview.sourceAvailable,
      }
      engine.setPointCloudDisplay(activePointCloudHandle, true, Number(safePointCloudSizeEl.value))
      engine.setPointCloudDensifiedPointBudget(activePointCloudHandle, 1_500_000)
      engine.setPointCloudDisplayMode(activePointCloudHandle, safePointCloudModeEl.value as 'rgb' | 'elevation' | 'intensity')
      updatePointCloudDisclosure()
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

document.querySelector<HTMLButtonElement>('#btn-index-pointcloud')?.addEventListener('click', async () => {
  if (!activePointCloudAssetId) return
  const assetId = activePointCloudAssetId
  try {
    safePointCloudProgressEl.textContent = 'Building full index...'
    const result = await window.workbench.generatePointCloudIndex({ assetId })
    renderSession(result.session)
    const hierarchy = await window.workbench.loadPointCloudIndexHierarchy({ assetId })
    const engine = ensureViewer()
    if (activePointCloudIndexHandle) engine.removePointCloudIndex(activePointCloudIndexHandle)
    activePointCloudIndexHandle = engine.addPointCloudIndex(hierarchy, (keys) =>
      window.workbench.loadPointCloudIndexTiles({ assetId, keys }).then((response) => response.tiles),
    )
    // Indexed-full streaming becomes the on-screen truth; hide the preview-sampled display.
    if (activePointCloudHandle) {
      engine.setPointCloudDisplay(activePointCloudHandle, false, Number(safePointCloudSizeEl.value))
    }
    engine.setPointCloudIndexDisplay(activePointCloudIndexHandle, true, Number(safePointCloudSizeEl.value))
    engine.setPointCloudIndexDisplayMode(
      activePointCloudIndexHandle,
      safePointCloudModeEl.value as 'rgb' | 'elevation' | 'intensity',
    )
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
  const asset = session.manifest.assets[session.manifest.assets.length - 1]
  if (!asset) return
  const result = await window.workbench.loadPointCloudPreview({ assetId: asset.id })
  const engine = ensureViewer()
  activePointCloudHandle = engine.addPointCloud(result.dataset as PointCloudDataset)
  activePointCloudAssetId = result.assetId
  activePointCloudPreview = {
    sampledPointCount: result.preview.sampledPointCount,
    totalPointCount: result.preview.totalPointCount,
    warnings: [...result.preview.warnings],
    sourceAvailable: result.preview.sourceAvailable,
  }
  engine.setPointCloudDisplay(activePointCloudHandle, true, Number(safePointCloudSizeEl.value))
  engine.setPointCloudDensifiedPointBudget(activePointCloudHandle, 1_500_000)
  engine.setPointCloudDisplayMode(activePointCloudHandle, safePointCloudModeEl.value as 'rgb' | 'elevation' | 'intensity')
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
  const result = await window.workbench.generatePlaceholderDerivedLayer()
  renderSession(result.session)
  const engine = ensureViewer()
  const model = toSurfaceModel(result.surface)
  engine.addSurface(model)
})

safePointCloudModeEl.addEventListener('change', () => {
  if (!viewer) return
  const mode = safePointCloudModeEl.value as 'rgb' | 'elevation' | 'intensity'
  if (activePointCloudHandle) viewer.setPointCloudDisplayMode(activePointCloudHandle, mode)
  if (activePointCloudIndexHandle) viewer.setPointCloudIndexDisplayMode(activePointCloudIndexHandle, mode)
})

safePointCloudSizeEl.addEventListener('input', () => {
  if (!viewer) return
  const size = Number(safePointCloudSizeEl.value)
  if (activePointCloudHandle) viewer.setPointCloudDisplay(activePointCloudHandle, true, size)
  if (activePointCloudIndexHandle) viewer.setPointCloudIndexDisplay(activePointCloudIndexHandle, true, size)
})

safePointCloudEdlEl.addEventListener('change', () => {
  ensureViewer().setPointCloudEdl(safePointCloudEdlEl.checked)
})

safePointCloudFogEl.addEventListener('change', () => {
  ensureViewer().setPointCloudFog(safePointCloudFogEl.checked)
})
