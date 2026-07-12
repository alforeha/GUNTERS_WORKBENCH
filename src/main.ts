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
import { LayerController, type WalkTargetOption } from './ui/layers'
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
  setWalkHint(null)
  closeWalkTargetPicker()
  controller.endWalkTarget()
  const viewer = controller.getViewer()
  viewer?.setCameraMode(modeBeforeWalk)
  applyCameraModeUi(modeBeforeWalk)
}

type WalkTargetSelection = { kind: 'select'; sourceAssetId: string } | { kind: 'build'; sourceAssetId: string }

let walkTargetOverlay: HTMLDivElement | null = null

function closeWalkTargetPicker(): void {
  walkTargetOverlay?.remove()
  walkTargetOverlay = null
}

function promptWalkTarget(options: WalkTargetOption[]): Promise<WalkTargetSelection | null> {
  closeWalkTargetPicker()
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    walkTargetOverlay = overlay
    overlay.className = 'about-overlay walk-target-overlay'
    overlay.innerHTML = `
      <div class="about-dialog walk-target-dialog">
        <h2>Walk what?</h2>
        <p class="about-note">Indexed point clouds are the walkable cloud layer in this pass.</p>
        <div class="walk-target-list">
          ${options.length > 0 ? options
            .map((option) => `
              <div class="walk-target-row ${option.available ? 'walk-target-row-ready' : 'walk-target-row-disabled'}">
                <button class="walk-target-option" data-source-asset-id="${option.sourceAssetId}" ${option.available ? '' : 'disabled'}>
                  <span class="walk-target-label">${option.label}</span>
                  <span class="walk-target-detail">${option.detail}</span>
                </button>
                ${option.buildIndexFirst ? `<button class="walk-target-build" data-build-asset-id="${option.sourceAssetId}">Build index</button>` : ''}
              </div>
            `)
            .join('') : '<p class="about-note">No point clouds are available in this project yet.</p>'}
        </div>
        <button class="about-close walk-target-cancel">Cancel</button>
      </div>
    `

    const cleanup = (selection: WalkTargetSelection | null) => {
      if (walkTargetOverlay === overlay) walkTargetOverlay = null
      document.removeEventListener('keydown', onKeyDown)
      overlay.remove()
      resolve(selection)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cleanup(null)
    }

    document.addEventListener('keydown', onKeyDown)
    overlay.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      if (target === overlay || target.classList.contains('walk-target-cancel')) cleanup(null)
      const selectButton = target.closest<HTMLButtonElement>('.walk-target-option')
      if (selectButton?.dataset.sourceAssetId) {
        cleanup({ kind: 'select', sourceAssetId: selectButton.dataset.sourceAssetId })
        return
      }
      const buildButton = target.closest<HTMLButtonElement>('.walk-target-build')
      if (buildButton?.dataset.buildAssetId) {
        cleanup({ kind: 'build', sourceAssetId: buildButton.dataset.buildAssetId })
      }
    })

    document.body.appendChild(overlay)
  })
}

async function requestCameraMode(mode: HeaderCameraMode): Promise<void> {
  const viewer = controller.ensureViewer()
  if (mode === 'orbit' || mode === 'top') {
    closeWalkTargetPicker()
    setWalkHint(null)
    controller.endWalkTarget()
    modeBeforeWalk = mode
    viewer.setCameraMode(mode)
    applyCameraModeUi(mode)
    return
  }

  const selection = await promptWalkTarget(controller.getWalkTargets())
  if (!selection) {
    applyCameraModeUi(modeBeforeWalk)
    return
  }

  if (selection.kind === 'build') {
    await controller.buildIndex(selection.sourceAssetId)
    applyCameraModeUi(modeBeforeWalk)
    await requestCameraMode('walk')
    return
  }

  const walkTarget = await controller.startIndexedPointCloudWalk(selection.sourceAssetId)
  if (!walkTarget.ok) {
    setWalkHint(walkTarget.reason)
    applyCameraModeUi(modeBeforeWalk)
    return
  }

  const eyeHeight = footerApi?.getWalkEyeHeight() ?? DEFAULT_WALK_EYE_HEIGHT
  if (viewer.enterHoverOnPointCloud(walkTarget.handle, eyeHeight)) {
    setWalkHint(`Walking ${walkTarget.label}. Use W/A/S/D to move, mouse to look, wheel for speed, X exits.`)
    applyCameraModeUi('walk')
  } else {
    controller.endWalkTarget()
    setWalkHint(`Unable to start Walk on ${walkTarget.label}. Load or rebuild the index and try again.`)
    applyCameraModeUi(modeBeforeWalk)
  }
}

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
  if (featureController.isAuthoring()) {
    featureController.handleViewerClick()
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
