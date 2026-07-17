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
import { BuildingComponentController } from './ui/buildingController'
import type { BuildingFaceFeatureType, BuildingFaceKind } from './shared/building-catalog'
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
let pendingWalkStart:
  | { handle: string; label: string; eyeHeight: number }
  | null = null

function setWalkHint(text: string | null): void {
  walkHint.hidden = text === null
  walkHint.textContent = text ?? ''
}

function clearPendingWalkStart(): void {
  pendingWalkStart = null
}

function renderAll(session: ProjectSession | null): void {
  headerApi?.setProjectName(session ? projectDisplayName(session.projectFolder, session.manifest as ProjectManifest) : null)
  footerApi?.setUnits(projectUnitsLabel(session ? (session.manifest as ProjectManifest) : null))
  leftPanel?.render()
  rightPanel?.render()
  renderToolRail()
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
    renderToolRail()
  },
})

const buildingController = new BuildingComponentController({
  getSession: () => controller.getSession(),
  getViewer: () => controller.getViewer(),
  persistManifest: (manifest) => controller.persistManifest(manifest),
  isAuthoringBusy: () => featureController.isAuthoring(),
  onChanged() {
    rightPanel?.render()
  },
})

let activeObjectToolbarMenu: 'category' | 'type' | 'placement' | null = null

function renderToolRail(): void {
  const toolbar = featureController.getObjectCreationToolbar()
  if (!toolbar) {
    activeObjectToolbarMenu = null
    frame.toolRailMount.hidden = true
    frame.toolRailMount.innerHTML = ''
    return
  }
  const categoryCode = toolbarCategoryCode(toolbar.categoryId)
  const typeCode = toolbarTypeCode(toolbar.typeTemplateId)
  const placementCode = toolbar.placementMode === 'snap' ? 'SNAP' : 'FREE'
  const popoverHtml = renderObjectToolbarPopover(toolbar, activeObjectToolbarMenu)
  frame.toolRailMount.hidden = false
  frame.toolRailMount.innerHTML = `
    <div class="viewer-tool-strip object-creation-toolbar" role="toolbar" aria-label="Object creation toolbar">
      <span class="viewer-tool-chip viewer-tool-chip-static" title="Object creation mode">OBJ</span>
      <button class="viewer-tool-chip${activeObjectToolbarMenu === 'category' ? ' viewer-tool-chip-active' : ''}" data-action="object-toolbar-toggle-category" title="Object category">${categoryCode}</button>
      <button class="viewer-tool-chip${activeObjectToolbarMenu === 'type' ? ' viewer-tool-chip-active' : ''}" data-action="object-toolbar-toggle-type" title="Object type">${typeCode}</button>
      <button class="viewer-tool-chip${activeObjectToolbarMenu === 'placement' ? ' viewer-tool-chip-active' : ''}" data-action="object-toolbar-toggle-placement" title="Placement mode">${placementCode}</button>
      <button class="viewer-tool-chip viewer-tool-chip-close" data-action="object-toolbar-cancel" title="Cancel object creation">X</button>
    </div>
    ${popoverHtml}
  `
}

frame.toolRailMount.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
  if (!target) return
  if (target.dataset.action === 'object-toolbar-toggle-category') {
    activeObjectToolbarMenu = activeObjectToolbarMenu === 'category' ? null : 'category'
    renderToolRail()
    return
  }
  if (target.dataset.action === 'object-toolbar-toggle-type') {
    activeObjectToolbarMenu = activeObjectToolbarMenu === 'type' ? null : 'type'
    renderToolRail()
    return
  }
  if (target.dataset.action === 'object-toolbar-toggle-placement') {
    activeObjectToolbarMenu = activeObjectToolbarMenu === 'placement' ? null : 'placement'
    renderToolRail()
    return
  }
  if (target.dataset.action === 'object-toolbar-set-category') {
    const category = target.dataset.value
    if (category === 'generic' || category === 'foliage' || category === 'site-fixture') {
      activeObjectToolbarMenu = null
      featureController.setObjectCreationCategory(category)
    }
    return
  }
  if (target.dataset.action === 'object-toolbar-set-type' && target.dataset.value) {
    activeObjectToolbarMenu = null
    featureController.setObjectCreationTemplate(target.dataset.value)
    return
  }
  if (target.dataset.action === 'object-toolbar-set-placement') {
    const mode = target.dataset.value
    if (mode === 'snap' || mode === 'manual') {
      activeObjectToolbarMenu = null
      featureController.setObjectPlacementMode(mode)
      renderToolRail()
    }
    return
  }
  if (target.dataset.action === 'object-toolbar-cancel') {
    activeObjectToolbarMenu = null
    featureController.cancel()
  }
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
  clearPendingWalkStart()
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
    clearPendingWalkStart()
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

  pendingWalkStart = {
    handle: walkTarget.handle,
    label: walkTarget.label,
    eyeHeight: footerApi?.getWalkEyeHeight() ?? DEFAULT_WALK_EYE_HEIGHT,
  }
  setWalkHint(`Click a start point on ${walkTarget.label}.`)
}

// Distinguish a click from an orbit drag before attempting Walk entry.
let pointerDownPos: { x: number; y: number } | null = null
const AUTHORING_CLICK_MAX_MOVEMENT_PX = 5
const WALK_START_PICK_TOLERANCE_PX = 24

function handleAuthoringPointerUp(clientX: number, clientY: number): void {
  if (!pointerDownPos) return
  const moved = Math.hypot(clientX - pointerDownPos.x, clientY - pointerDownPos.y)
  pointerDownPos = null
  if (moved > AUTHORING_CLICK_MAX_MOVEMENT_PX) return
  if (pendingWalkStart) {
    const viewer = controller.getViewer()
    const startPoint = viewer?.pickIndexedPointAtClient(
      pendingWalkStart.handle,
      clientX,
      clientY,
      WALK_START_PICK_TOLERANCE_PX,
    ) ?? null
    if (!viewer || !startPoint) {
      setWalkHint(`No indexed point found there. Click a visible point on ${pendingWalkStart.label}.`)
      return
    }
    if (viewer.enterHoverOnPointCloud(pendingWalkStart.handle, pendingWalkStart.eyeHeight, startPoint)) {
      setWalkHint(`Walking ${pendingWalkStart.label}. Use W/A/S/D to move, mouse to look, wheel for speed, X exits.`)
      clearPendingWalkStart()
      applyCameraModeUi('walk')
      return
    }
    controller.endWalkTarget()
    setWalkHint(`Unable to start Walk on ${pendingWalkStart.label}. Load or rebuild the index and try again.`)
    clearPendingWalkStart()
    applyCameraModeUi(modeBeforeWalk)
    return
  }
  if (featureController.isAuthoring()) {
    featureController.handleViewerClick()
  }
}

frame.viewerHost.addEventListener('pointerdown', (event) => {
  pointerDownPos = { x: event.clientX, y: event.clientY }
})
frame.viewerHost.addEventListener('pointerup', (event) => {
  handleAuthoringPointerUp(event.clientX, event.clientY)
})
window.addEventListener('pointerup', (event) => {
  handleAuthoringPointerUp(event.clientX, event.clientY)
})
window.addEventListener('pointercancel', () => {
  pointerDownPos = null
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

function renderObjectToolbarPopover(
  toolbar: NonNullable<ReturnType<typeof featureController.getObjectCreationToolbar>>,
  activeMenu: 'category' | 'type' | 'placement' | null,
): string {
  if (!activeMenu) return ''
  if (activeMenu === 'category') {
    const items = toolbar.categories
      .map(
        (category) =>
          `<button class="viewer-tool-option${category.id === toolbar.categoryId ? ' viewer-tool-option-active' : ''}" data-action="object-toolbar-set-category" data-value="${category.id}">${toolbarCategoryCode(category.id)} <span>${category.label}</span></button>`,
      )
      .join('')
    return `<div class="viewer-tool-popover" role="menu" aria-label="Object category">${items}</div>`
  }
  if (activeMenu === 'type') {
    const items = toolbar.types
      .map(
        (type) =>
          `<button class="viewer-tool-option${type.templateId === toolbar.typeTemplateId ? ' viewer-tool-option-active' : ''}" data-action="object-toolbar-set-type" data-value="${type.templateId}">${toolbarTypeCode(type.templateId)} <span>${type.label}</span></button>`,
      )
      .join('')
    return `<div class="viewer-tool-popover" role="menu" aria-label="Object type">${items}</div>`
  }
  return `
    <div class="viewer-tool-popover" role="menu" aria-label="Placement options">
      <button class="viewer-tool-option${toolbar.placementMode === 'snap' ? ' viewer-tool-option-active' : ''}" data-action="object-toolbar-set-placement" data-value="snap">SNAP <span>Snap to data</span></button>
      <button class="viewer-tool-option${toolbar.placementMode === 'manual' ? ' viewer-tool-option-active' : ''}" data-action="object-toolbar-set-placement" data-value="manual">FREE <span>Manual / free place</span></button>
      <button class="viewer-tool-option planned-control" disabled title="Planned - isolate area arrives in a later pass">ISO <span>Isolate area (planned)</span></button>
    </div>
  `
}

function toolbarCategoryCode(categoryId: 'generic' | 'foliage' | 'site-fixture'): string {
  if (categoryId === 'generic') return 'GEN'
  if (categoryId === 'foliage') return 'FOL'
  return 'FIX'
}

function toolbarTypeCode(templateId: string): string {
  const codeByTemplate: Record<string, string> = {
    'object.box': 'BOX',
    'object.cylinder': 'CYL',
    'object.pine': 'PINE',
    'object.simple-tree': 'TREE',
    'object.shrub': 'SHRUB',
    'object.sign': 'SIGN',
    'object.post': 'POST',
  }
  return codeByTemplate[templateId] ?? 'TYPE'
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
    setShowWithin(distanceFt) {
      controller.setShowWithin(distanceFt)
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
    showWithinFt: controller.getShowWithin(),
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
    getRegionEdit: () => featureController.getRegionEdit(),
    getFocusedFeatureId: () => featureController.getFocusedFeatureId(),
    getBuildingAuthoring: () => featureController.getBuildingAuthoring(),
    getSimpleAuthoring: () => featureController.getSimpleAuthoring(),
    startObjectCreation: () => featureController.startObjectCreation(),
    startRegion: (templateId) => featureController.startRegion(templateId),
    startRegionSurfacePoint: (featureId) => featureController.startRegionSurfacePoint(featureId),
    startRegionBreakline: (featureId) => featureController.startRegionBreakline(featureId),
    finishRegionBreakline: () => featureController.finishRegionBreakline(),
    startRegionBoundaryRedraw: (featureId) => featureController.startRegionBoundaryRedraw(featureId),
    finishRegionBoundaryRedraw: () => featureController.finishRegionBoundaryRedraw(),
    cancelRegionEdit: () => featureController.cancelRegionEdit(),
    addRegionGridPoints: (featureId, spacing) => featureController.addRegionGridPoints(featureId, spacing),
    generateRegionSurface: (featureId) => featureController.generateRegionSurface(featureId),
    updateRegionVisibility: (featureId, key, visible) => featureController.updateRegionVisibility(featureId, key as never, visible),
    updateRegionTemplate: (featureId, templateId) => featureController.updateRegionTemplate(featureId, templateId),
    startBuilding: (templateId) => featureController.startBuilding(templateId),
    startObject: (templateId) => featureController.startObject(templateId),
    startLine: (templateId) => featureController.startLine(templateId),
    startMarker: (templateId) => featureController.startMarker(templateId),
    startUtility: (templateId) => featureController.startUtility(templateId),
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
    updateObjectCategory: (featureId, categoryId) => featureController.updateObjectCategory(featureId, categoryId as 'generic' | 'foliage' | 'site-fixture'),
    updateObjectTemplate: (featureId, templateId) => featureController.updateObjectTemplate(featureId, templateId),
    updateUtilityTemplate: (featureId, templateId) => featureController.updateUtilityTemplate(featureId, templateId),
    updatePlacement: (featureId, axis, value) => featureController.updateFeaturePlacement(featureId, axis, value),
    updateVisibility: (featureId, visible) => featureController.updateFeatureVisibility(featureId, visible),
    remove: (featureId) => featureController.deleteFeature(featureId),
    setSimVisible: (visible) => featureController.setSimVisible(visible),
    getObjectEdit: () => featureController.getObjectEdit(),
    startIsolateBoundary: (featureId) => featureController.startIsolateBoundary(featureId),
    finishIsolateBoundary: () => featureController.finishIsolateBoundary(),
    clearIsolateBoundary: (featureId) => featureController.clearIsolateBoundary(featureId),
    startEvidencePick: (featureId) => featureController.startEvidencePick(featureId),
    stopEvidencePick: () => featureController.stopEvidencePick(),
    selectEvidenceWindow: () => featureController.selectEvidenceWindow(),
    removeEvidenceRef: (featureId, index) => featureController.removeEvidenceRef(featureId, index),
    clearEvidenceRefs: (featureId) => featureController.clearEvidenceRefs(featureId),
    cancelObjectEdit: () => featureController.cancelObjectEdit(),
    setFocusedFeature: (featureId) => featureController.setFocusedFeature(featureId),
    getIsolateLoad: () => featureController.getIsolateLoad(),
    startIsolateLoadAll: (featureId) => featureController.startIsolateLoadAll(featureId),
    stepIsolateSector: (delta) => featureController.stepIsolateSector(delta),
    stopIsolateLoadAll: () => featureController.stopIsolateLoadAll(),
    getBuildingFaceFit: () => buildingController.getFaceFit(),
    getBuildingFitNote: () => buildingController.getFitNote(),
    startBuildingFaceFit: (featureId, kind) => buildingController.startFaceFit(featureId, kind as BuildingFaceKind),
    acceptBuildingFaceFit: () => buildingController.acceptFaceFit(),
    cancelBuildingFaceFit: () => buildingController.cancelFaceFit(),
    renameBuildingFace: (featureId, faceId, name) => buildingController.renameFace(featureId, faceId, name),
    setBuildingFaceVisibility: (featureId, faceId, visible) => buildingController.setFaceVisibility(featureId, faceId, visible),
    removeBuildingFace: (featureId, faceId) => buildingController.removeFace(featureId, faceId),
    addBuildingFaceFeature: (featureId, faceId, type) =>
      buildingController.addFaceFeature(featureId, faceId, type as BuildingFaceFeatureType),
    updateBuildingFeatureParam: (featureId, componentId, param, value) =>
      buildingController.updateFaceFeatureParam(featureId, componentId, param, value),
    updateBuildingFeatureType: (featureId, componentId, type) =>
      buildingController.updateFaceFeatureType(featureId, componentId, type),
    setBuildingFeatureVisibility: (featureId, componentId, visible) =>
      buildingController.setFaceFeatureVisibility(featureId, componentId, visible),
    removeBuildingFaceFeature: (featureId, componentId) => buildingController.removeFaceFeature(featureId, componentId),
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
  setLayerPointRadius: (layerId, radius) => controller.setLayerPointRadius(layerId, radius),
  stepLayerRadiusScale: (layerId, factor) => controller.stepLayerRadiusScale(layerId, factor),
  resetLayerRadiusAuto: (layerId) => controller.resetLayerRadiusAuto(layerId),
  setLayerDetail: (layerId, preset) => controller.setLayerDetail(layerId, preset),
  setLayerSurfelScale: (layerId, scale) => controller.setLayerSurfelScale(layerId, scale),
  importPointCloud: () => controller.importPointCloud(),
  openAsset(assetId) {
    rightPanel?.openAsset(assetId)
    frame.setRightPanelOpen(true)
  },
})

renderAll(null)
