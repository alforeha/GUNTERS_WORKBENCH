import './style.css'
import { isOpenProjectError, type ProjectSession } from './shared/ipc'
import type { ProjectManifest } from './shared/workbench-types'
import { ViewerEngine } from './viewer'
import type { SurfaceModel } from './core/contract'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('App root missing')
}

let currentSession: ProjectSession | null = null
let viewer: ViewerEngine | null = null

app.innerHTML = `
  <main class="shell">
    <section class="toolbar">
      <button id="btn-new">New Project</button>
      <button id="btn-open">Open Project</button>
      <button id="btn-save">Save</button>
      <button id="btn-close">Close</button>
      <button id="btn-warning">Record Unit Warning</button>
      <button id="btn-derived">Generate Derived Layer</button>
    </section>
    <section class="status-panel">
      <h1>Gunters Workbench</h1>
      <div id="project-path">No project loaded</div>
      <div id="recovery"></div>
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

if (!projectPathEl || !recoveryEl || !assetListEl || !viewerHost) {
  throw new Error('UI initialization failed')
}

const safeProjectPathEl = projectPathEl
const safeRecoveryEl = recoveryEl
const safeAssetListEl = assetListEl
const safeViewerHost = viewerHost
const OPEN_PROJECT_FAILURE_MESSAGE =
  'Project manifest is missing or corrupt. Manual restore is available from project.json.bak; auto-restore is not implemented yet.'

function ensureViewer(): ViewerEngine {
  if (!viewer) {
    viewer = new ViewerEngine(safeViewerHost)
  }
  return viewer
}

function renderSession(session: ProjectSession): void {
  currentSession = session
  safeProjectPathEl.textContent = `Project: ${session.projectFolder}`
  safeRecoveryEl.textContent = session.recoveryDetected
    ? 'Recovery note: unclean shutdown detected from journal/temp.'
    : 'Recovery note: clean state.'

  safeAssetListEl.innerHTML = ''
  for (const asset of session.manifest.assets) {
    const li = document.createElement('li')
    li.className = 'asset-row'
    const warningText = asset.warnings.length > 0 ? ` warnings=${asset.warnings.join(' | ')}` : ''
    li.innerHTML = `<span>${asset.name}</span><span class="truth-badge truth-${asset.truthStatus}">${asset.truthStatus}</span><span class="warn-text">${warningText}</span>`
    safeAssetListEl.appendChild(li)
  }
}

function renderProjectClosed(message = 'No project loaded', recovery = ''): void {
  currentSession = null
  safeProjectPathEl.textContent = message
  safeRecoveryEl.textContent = recovery
  safeAssetListEl.innerHTML = ''
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

function clearViewerScene(): void {
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
