// src/main.ts - thin bootstrap. Mounts the frame (header / viewer cockpit /
// footer), creates the layer controller (all manifest + engine work), and
// wires the panels. No layer/visibility/disclosure logic lives here - see
// src/ui/layers.ts for the controller and src/ui/model.ts for the pure
// view-model builders.

import './style.css'
import './ui/panels.css'
import type { ProjectSession } from './shared/ipc'
import type { ProjectManifest } from './shared/workbench-types'
import type { ViewerEngine } from './viewer'
import { mountFrame } from './ui/frame'
import { createBanner } from './ui/banner'
import { mountHeader, type HeaderCameraMode, type HeaderMenuAction } from './ui/header'
import { mountFooter, DEFAULT_WALK_EYE_HEIGHT, DEFAULT_WALK_SPEED } from './ui/footer'
import { mountLeftPanel, type LeftPanelApi } from './ui/leftPanel'
import { mountRightPanel, type RightPanelApi } from './ui/rightPanel'
import { LayerController } from './ui/layers'
import { FeatureController } from './ui/features'
import { projectDisplayName, projectUnitsLabel } from './ui/model'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('App root missing')
}

const frame = mountFrame(app)
const banner = createBanner(frame.bannerMount)

// Walk-mode hint: its own small overlay so it never clobbers the task channel.
const walkHint = document.createElement('div')
walkHint.className = 'viewer-hint'
walkHint.hidden = true
frame.viewerHost.parentElement?.appendChild(walkHint)

let leftPanel: LeftPanelApi | null = null
let rightPanel: RightPanelApi | null = null
let headerApi: ReturnType<typeof mountHeader> | null = null
let footerApi: ReturnType<typeof mountFooter> | null = null

let walkArmed = false
let modeBeforeWalk: 'orbit' | 'top' = 'orbit'

function setWalkHint(text: string | null): void {
  walkHint.hidden = text === null
  walkHint.textContent = text ?? ''
}

function renderAll(session: ProjectSession | null): void {
  headerApi?.setProjectName(session ? projectDisplayName(session.projectFolder, session.manifest as ProjectManifest) : null)
  footerApi?.setUnits(projectUnitsLabel(session ? (session.manifest as ProjectManifest) : null))
  leftPanel?.render()
  rightPanel?.render()
}

const controller = new LayerController(frame.viewerHost, {
  onSessionChanged(session) {
    featureController?.refreshDisplays()
    renderAll(session)
  },
  onTask(label, pct) {
    banner.setTask(label, pct ?? null)
  },
  onViewStateLines(lines) {
    banner.setViewState(lines)
  },
  onViewerCreated(viewer) {
    wireViewerCallbacks(viewer)
    featureController?.refreshDisplays()
  },
})

const featureController: FeatureController = new FeatureController({
  getSession: () => controller.getSession(),
  getViewer: () => controller.getViewer(),
  ensureViewer: () => controller.ensureViewer(),
  persistManifest: (manifest) => controller.persistManifest(manifest),
  onAuthoringChanged() {
    rightPanel?.render()
  },
})

function wireViewerCallbacks(viewer: ViewerEngine): void {
  viewer.onCursorPosition((pos) => {
    footerApi?.setCursor(pos)
  })
  viewer.onHoverHeightChange((height) => {
    footerApi?.syncWalkEyeHeight(height)
  })
  viewer.onHoverSpeedChange((speed) => {
    footerApi?.syncWalkSpeed(speed)
  })
  viewer.onRequestExitHover(() => {
    exitWalk()
  })
}

function applyCameraModeUi(mode: HeaderCameraMode): void {
  headerApi?.setCameraMode(mode)
  footerApi?.setCameraMode(mode)
}

function exitWalk(): void {
  walkArmed = false
  setWalkHint(null)
  const viewer = controller.getViewer()
  viewer?.setCameraMode(modeBeforeWalk)
  applyCameraModeUi(modeBeforeWalk)
}

function requestCameraMode(mode: HeaderCameraMode): void {
  const viewer = controller.ensureViewer()
  if (mode === 'orbit' || mode === 'top') {
    walkArmed = false
    setWalkHint(null)
    modeBeforeWalk = mode
    viewer.setCameraMode(mode)
    applyCameraModeUi(mode)
    return
  }
  // Walk (basic): armed entry - the engine anchors Walk by raycasting a surface
  // under the pointer, so the user picks the start point with a click.
  walkArmed = true
  setWalkHint('Walk (basic): click a surface point in the viewer to start. X exits. Requires a surface; point clouds alone cannot anchor Walk yet.')
}

// Escape cancels an armed (not yet entered) Walk and reverts the mode UI.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && walkArmed) {
    walkArmed = false
    setWalkHint(null)
    applyCameraModeUi(modeBeforeWalk)
  }
})

// Distinguish a click from an orbit drag before attempting Walk entry.
let pointerDownPos: { x: number; y: number } | null = null
frame.viewerHost.addEventListener('pointerdown', (event) => {
  pointerDownPos = { x: event.clientX, y: event.clientY }
})
frame.viewerHost.addEventListener('pointerup', (event) => {
  if (!pointerDownPos) return
  const moved = Math.hypot(event.clientX - pointerDownPos.x, event.clientY - pointerDownPos.y)
  pointerDownPos = null
  if (moved > 5) return
  // Feature authoring owns viewer clicks while a draw is active.
  if (featureController.isAuthoring()) {
    featureController.handleViewerClick()
    return
  }
  if (!walkArmed) return
  const viewer = controller.getViewer()
  if (!viewer) return
  const eyeHeight = footerApi?.getWalkEyeHeight() ?? DEFAULT_WALK_EYE_HEIGHT
  if (viewer.enterHoverAtPointer(eyeHeight)) {
    walkArmed = false
    setWalkHint(null)
    applyCameraModeUi('walk')
  } else {
    setWalkHint('No surface under the cursor. Walk needs a surface to stand on - click a rendered surface, or press Esc/choose another view mode to cancel.')
  }
})

function showAboutDialog(): void {
  const existing = document.querySelector('.about-overlay')
  if (existing) {
    existing.remove()
    return
  }
  const overlay = document.createElement('div')
  overlay.className = 'about-overlay'
  overlay.innerHTML = `
    <div class="about-dialog">
      <h2>Gunter's Workbench</h2>
      <p>Survey reality workbench (development build).</p>
      <p class="about-note">Point-cloud-first: preview, WPI index streaming, analytic surfels.</p>
      <button class="about-close">Close</button>
    </div>
  `
  overlay.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target === overlay || target.classList.contains('about-close')) overlay.remove()
  })
  document.body.appendChild(overlay)
}

function handleMenuAction(action: HeaderMenuAction): void {
  if (action === 'new-project') void controller.newProject()
  else if (action === 'open-project') void controller.openProject()
  else if (action === 'save-project') void controller.saveProject()
  else if (action === 'close-project') {
    void controller.closeProject().then(() => {
      rightPanel?.showSim()
    })
  } else if (action === 'import-pointcloud') void controller.importPointCloud()
  else if (action === 'record-unit-warning') void controller.recordUnitWarning()
  else if (action === 'placeholder-derived-surface') void controller.generatePlaceholderSurface()
  else if (action === 'about') showAboutDialog()
}

headerApi = mountHeader(frame.headerMount, {
  onMenuAction: handleMenuAction,
  onCameraModeRequested: requestCameraMode,
  onResetView() {
    controller.getViewer()?.resetView()
  },
})

footerApi = mountFooter(
  frame.footerMount,
  {
    setEdl(on) {
      controller.setEdl(on)
    },
    setFog(on) {
      controller.setFog(on)
    },
    setVerticalExaggeration(k) {
      controller.ensureViewer().setVerticalExaggeration(k)
    },
    setWalkSpeed(value) {
      controller.getViewer()?.setHoverSpeed(value)
    },
    setWalkEyeHeight(value) {
      controller.getViewer()?.setHoverHeight(value)
    },
  },
  {
    edl: controller.isEdlEnabled(),
    fog: controller.isFogEnabled(),
    verticalExaggeration: 1,
    walkSpeed: DEFAULT_WALK_SPEED,
    walkEyeHeight: DEFAULT_WALK_EYE_HEIGHT,
  },
)

rightPanel = mountRightPanel(frame.rightPanelMount, {
  getSession: () => controller.getSession(),
  buildIndex: (assetId) => controller.buildIndex(assetId),
  generateSurfels: (assetId) => controller.generateSurfels(assetId),
  features: {
    regionTemplates: () => featureController.regionTemplates(),
    buildingTemplates: () => featureController.buildingTemplates(),
    objectTemplates: () => featureController.objectTemplates(),
    lineTemplates: () => featureController.lineTemplates(),
    markerTemplates: () => featureController.markerTemplates(),
    getAuthoring: () => featureController.getAuthoring(),
    getBuildingAuthoring: () => featureController.getBuildingAuthoring(),
    getSimpleAuthoring: () => featureController.getSimpleAuthoring(),
    startRegion: (templateId) => featureController.startRegion(templateId),
    startBuilding: (templateId) => featureController.startBuilding(templateId),
    startObject: (templateId) => featureController.startObject(templateId),
    startLine: (templateId) => featureController.startLine(templateId),
    startMarker: (templateId) => featureController.startMarker(templateId),
    closeBorder: () => featureController.closeBorder(),
    closeBuildingFootprint: () => featureController.closeBuildingFootprint(),
    reviewSimpleFeature: () => featureController.reviewSimpleFeature(),
    startBreakline: () => featureController.startBreakline(),
    finishBreakline: () => featureController.finishBreakline(),
    finishRegion: () => featureController.finishRegion(),
    finishBuilding: () => featureController.finishBuilding(),
    finishSimpleFeature: () => featureController.finishSimpleFeature(),
    cancel: () => featureController.cancel(),
    rename: (featureId, name) => featureController.renameFeature(featureId, name),
    updateParam: (featureId, paramName, value) => featureController.updateFeatureParameter(featureId, paramName, value),
    remove: (featureId) => featureController.deleteFeature(featureId),
    setSimVisible: (visible) => featureController.setSimVisible(visible),
  },
})

leftPanel = mountLeftPanel(frame.leftPanelMount, {
  getSession: () => controller.getSession(),
  getStatus: () => controller.getStatus(),
  getLayerAppearance: (layerId) => controller.getLayerAppearance(layerId),
  setLayerVisibility: (layerId, visible) => controller.setLayerVisibility(layerId, visible),
  toggleAssetMaster: (assetId, on) => controller.toggleAssetMaster(assetId, on),
  removeAsset: (assetId) => controller.removeAsset(assetId),
  setLayerColorMode: (layerId, mode) => controller.setLayerColorMode(layerId, mode),
  setLayerPointSize: (layerId, size) => controller.setLayerPointSize(layerId, size),
  setLayerSurfelScale: (layerId, scale) => controller.setLayerSurfelScale(layerId, scale),
  importPointCloud: () => controller.importPointCloud(),
  openAsset(assetId) {
    rightPanel?.openAsset(assetId)
    frame.setRightPanelOpen(true)
  },
})

renderAll(null)
