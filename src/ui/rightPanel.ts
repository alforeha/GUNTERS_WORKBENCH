// src/ui/rightPanel.ts - the right panel: controls, never a driver of viewer
// display. The Sim work surface is live for REGIONS (Create Sim IMP-3): the
// regions tab lists authored regions, drives the border/breakline authoring
// tool rail, and opens a feature detail with rename/delete. Every other
// family tab stays visibly staged until its own slice lands. Opening an
// asset from the Display Manager swaps in the asset work surface with a
// back-to-sim control; the viewer is untouched.

import type { ProjectSession } from '../shared/ipc'
import type { UtilitySystemId } from '../shared/utility-catalog'
import type { ProjectManifest } from '../shared/workbench-types'
import type { BuildingAuthoringView, IsolateLoadView, ObjectEditView, RegionAuthoringView, SimpleAuthoringView, SimpleFeatureFamily } from './features'
import type { BuildingFaceFitView } from './buildingController'
import { buildBuildingEditorModel, buildBuildingRowsModel, type BuildingEditorModel } from './buildingModel'
import { renderBuildingsListHtml, renderBuildingSectionsHtml } from './buildingsPanel'
import { createObjectPreview3d, type ObjectPreview3d } from './objectPreview'
import { renderUtilitiesTabHtml } from './utilitiesPanel'
import {
  buildUtilityAddModel,
  buildUtilityEditorModel,
  buildUtilityListModel,
  type UtilityAddModel,
  type UtilityEditorModel,
  type UtilityListItem,
} from './utilityModel'
import {
  buildFeatureDetailModel,
  buildLineListModel,
  buildMarkerListModel,
  buildObjectListModel,
  buildRegionListModel,
  buildSimPanelModel,
  buildWorkSurfaceModel,
  escapeHtml,
  type BuildingListItem,
  type DerivedStatusModel,
  type FeatureDetailModel,
  type LineListItem,
  type MarkerListItem,
  type ObjectListItem,
  type RegionListItem,
  type SimPanelModel,
  type WorkSurfaceModel,
} from './model'

/** Feature-authoring operations the panel drives (implemented in features.ts). */
export interface RightPanelFeatureOps {
  regionTemplates(): { id: string; displayName: string }[]
  buildingTemplates(): { id: string; displayName: string }[]
  objectTemplates(): { id: string; displayName: string }[]
  lineTemplates(): { id: string; displayName: string }[]
  markerTemplates(): { id: string; displayName: string }[]
  getAuthoring(): RegionAuthoringView | null
  getBuildingAuthoring(): BuildingAuthoringView | null
  getSimpleAuthoring(): SimpleAuthoringView | null
  startObjectCreation(): void
  startRegion(templateId: string): void
  startBuilding(templateId: string): void
  startObject(templateId: string): void
  startLine(templateId: string): void
  startMarker(templateId: string): void
  startUtility(templateId: string): void
  closeBorder(): void
  closeBuildingFootprint(): void
  reviewSimpleFeature(): void
  startBreakline(): void
  finishBreakline(): void
  finishRegion(): Promise<void>
  finishBuilding(): Promise<void>
  finishSimpleFeature(): Promise<void>
  cancel(): void
  rename(featureId: string, name: string): Promise<void>
  updateParam(featureId: string, paramName: string, value: string): Promise<void>
  updateObjectCategory(featureId: string, categoryId: string): Promise<void>
  updateObjectTemplate(featureId: string, templateId: string): Promise<void>
  updateUtilityTemplate(featureId: string, templateId: string): Promise<void>
  updatePlacement(featureId: string, axis: 'x' | 'y' | 'z', value: string): Promise<void>
  updateVisibility(featureId: string, visible: boolean): Promise<void>
  remove(featureId: string): Promise<void>
  /** Sim master toggle: show/hide all authored features as one group. */
  setSimVisible?(visible: boolean): void
  /** Object isolate-area + explicit-evidence editing (Object Refinement V1). */
  getObjectEdit(): ObjectEditView | null
  startIsolateBoundary(featureId: string): void
  finishIsolateBoundary(): Promise<void>
  clearIsolateBoundary(featureId: string): Promise<void>
  startEvidencePick(featureId: string): void
  stopEvidencePick(): void
  selectEvidenceWindow(): Promise<void>
  removeEvidenceRef(featureId: string, index: number): Promise<void>
  clearEvidenceRefs(featureId: string): Promise<void>
  cancelObjectEdit(): void
  /** Feature open in the detail panel; drives the viewer focus overlay. */
  setFocusedFeature(featureId: string | null): void
  /** Isolate load-all: full-density streaming of the boundary area, in sectors when over budget. */
  getIsolateLoad(): IsolateLoadView | null
  startIsolateLoadAll(featureId: string): void
  stepIsolateSector(delta: number): void
  stopIsolateLoadAll(): void
  /** Building components (beta envelope buildings): evidence-fitted faces + hosted features. */
  getBuildingFaceFit(): BuildingFaceFitView | null
  getBuildingFitNote(): string | null
  startBuildingFaceFit(featureId: string, kind: 'wall' | 'roof'): void
  acceptBuildingFaceFit(): Promise<void>
  cancelBuildingFaceFit(): void
  renameBuildingFace(featureId: string, faceId: string, name: string): Promise<void>
  setBuildingFaceVisibility(featureId: string, faceId: string, visible: boolean): Promise<void>
  removeBuildingFace(featureId: string, faceId: string): Promise<void>
  addBuildingFaceFeature(featureId: string, faceId: string, type: string): Promise<void>
  updateBuildingFeatureParam(featureId: string, componentId: string, param: string, value: string): Promise<void>
  updateBuildingFeatureType(featureId: string, componentId: string, type: string): Promise<void>
  setBuildingFeatureVisibility(featureId: string, componentId: string, visible: boolean): Promise<void>
  removeBuildingFaceFeature(featureId: string, componentId: string): Promise<void>
}

export interface RightPanelDeps {
  getSession(): ProjectSession | null
  buildIndex(assetId: string): Promise<void>
  generateSurfels(assetId: string): Promise<void>
  features: RightPanelFeatureOps
}

/** Everything the pure regions-tab renderer needs. */
export interface RegionsTabView {
  templates: { id: string; displayName: string }[]
  authoring: RegionAuthoringView | null
  list: RegionListItem[]
  detail: FeatureDetailModel | null
}

/** Everything the pure buildings-tab renderer needs. */
export interface BuildingsTabView {
  templates: { id: string; displayName: string }[]
  authoring: BuildingAuthoringView | null
  list: BuildingListItem[]
  detail: FeatureDetailModel | null
  /** Envelope-building detail extras (faces, features, fit rail), when open. */
  buildingEditor?: BuildingEditorModel | null
  /** In-flight isolate/evidence edit for the open building detail, if any. */
  objectEdit?: ObjectEditView | null
  /** Active isolate load-all state for the open building detail, if any. */
  isolateLoad?: IsolateLoadView | null
}

export interface SimpleTabView {
  family: SimpleFeatureFamily
  templates: { id: string; displayName: string }[]
  authoring: SimpleAuthoringView | null
  list: Array<ObjectListItem | LineListItem | MarkerListItem | UtilityListItem>
  detail: FeatureDetailModel | null
  /** In-flight isolate/evidence edit for the open object/utility detail, if any. */
  objectEdit?: ObjectEditView | null
  /** Active isolate load-all state for the open object/utility detail, if any. */
  isolateLoad?: IsolateLoadView | null
  /** Utilities tab only: system/class add-picker state. */
  utilityAdd?: UtilityAddModel
  /** Utilities tab only: detail editor extras for the open utility. */
  utilityEditor?: UtilityEditorModel | null
}

export interface RightPanelApi {
  render(): void
  openAsset(assetId: string): void
  showSim(): void
}

export interface SimPanelViewState {
  activeTab: string
  simVisible: boolean
  selectedFeatureId: string | null
}

const SIM_TAB_PLACEHOLDER: Record<string, string> = {
  regions: 'No regions yet. Pick a subtype below and draw the first border in the viewer.',
  objects: 'No objects yet. Use + Add Object to open the placement toolbar in the viewer.',
  buildings: 'No buildings yet. Building massing arrives with the Create Sim phase.',
  utilities: 'No utilities yet. Pick a system and type below, then place it in the viewer.',
  lines: 'No lines or breaklines yet.',
  notes: 'No notes or flags yet.',
  measurements: 'No measurements yet.',
}

// ---------------------------------------------------------------------------
// Pure renderers (node-testable)
// ---------------------------------------------------------------------------

export function renderSimPanelHtml(
  model: SimPanelModel,
  state: SimPanelViewState,
  regions?: RegionsTabView | null,
  buildings?: BuildingsTabView | null,
  simpleTabs?: Partial<Record<SimpleFeatureFamily, SimpleTabView>>,
): string {
  const tabsHtml = model.tabs
    .map((tab) => {
      const active = state.activeTab === tab.id ? ' tab-active' : ''
      const countHtml = tab.count > 0 ? ` (${tab.count})` : ''
      return `<button class="panel-tab${active}" data-action="sim-tab" data-tab-id="${tab.id}">${escapeHtml(tab.label)}${countHtml}</button>`
    })
    .join('')

  const activeTab = model.tabs.find((tab) => tab.id === state.activeTab) ?? model.tabs[0]
  const contentHtml =
    activeTab.id === 'regions' && regions
      ? renderRegionsTabHtml(regions)
      : activeTab.id === 'buildings' && buildings
        ? renderBuildingsTabHtml(buildings)
        : activeTab.id === 'objects' && simpleTabs?.object
          ? renderObjectsTabHtml(simpleTabs.object)
          : activeTab.id === 'utilities' && simpleTabs?.utility
            ? renderUtilitiesTabContentHtml(simpleTabs.utility)
            : activeTab.id === 'lines' && simpleTabs?.line
              ? renderSimpleTabHtml(simpleTabs.line)
              : activeTab.id === 'notes' && simpleTabs?.marker
                ? renderSimpleTabHtml(simpleTabs.marker)
                : renderStagedTabHtml(activeTab.id, activeTab.count, activeTab.addLabel)

  return `
    <div class="panel-header">
      <span>Reality Simulation</span>
      <button class="panel-detach planned-control" disabled title="Planned - detach this panel to float in-window; each panel detaches independently">Detach</button>
    </div>
    <div class="sim-controls">
      <label class="sim-master" title="Show/hide all authored features as a group">
        <input type="checkbox" data-action="sim-visible"${state.simVisible ? ' checked' : ''} />
        Show sim <span class="sim-feature-count">(${model.featureCount} features authored)</span>
      </label>
      <div class="sim-display-switch" role="group" aria-label="Sim display mode">
        <button class="switch-option switch-active" title="Reality representation (current display mode)">Sim</button>
        <button class="switch-option planned-control" disabled
          title="Planned - the DWG display mode arrives with feature representations. One feature model, one scene; this is a display-mode selector, not a second render.">DWG</button>
      </div>
      <button class="sim-menu-button" data-action="sim-menu" title="Sim-level actions">...</button>
      <div class="sim-menu-dropdown" id="sim-menu-dropdown" hidden>
        <button class="menu-item planned-control" disabled title="Planned export - crystallize the whole sim state into assets">Export all (planned)</button>
        <button class="menu-item planned-control" disabled title="Planned export - independent per-asset maps from sim state">Export asset maps (planned)</button>
        <button class="menu-item planned-control" disabled title="Planned export - a web-viewer sim snapshot (custom .gsim JSON format, later)">Export sim for web viewer (.gsim) (planned)</button>
      </div>
    </div>
    <div class="ground-strip" title="Ground is a sim-level derived property - compiled from regions or fed by an imported TIN (later)">${escapeHtml(model.groundLabel)}</div>
    <div class="panel-tabs sim-tabs">${tabsHtml}</div>
    <div class="panel-content">
      ${contentHtml}
    </div>
  `
}

/** Staged (not yet live) family tabs keep the honest planned shell. */
function renderStagedTabHtml(tabId: string, count: number, addLabel: string): string {
  const placeholder = SIM_TAB_PLACEHOLDER[tabId] ?? 'Nothing here yet.'
  const legacyNote =
    count > 0
      ? `<div class="tab-note">${count} existing feature record(s) of the legacy schema; read-only this phase.</div>`
      : ''
  return `
      ${legacyNote}
      <div class="tab-placeholder">${escapeHtml(placeholder)}</div>
      <button class="planned-control sim-add-button" disabled
        title="Planned - feature creation arrives with the Create Sim phase and summons its toolset into the viewer tool rail">${escapeHtml(addLabel)} (planned)</button>
  `
}

export function renderRegionsTabHtml(view: RegionsTabView): string {
  if (view.detail) return renderFeatureDetailHtml(view.detail)
  if (view.authoring) return renderRegionAuthoringHtml(view.authoring)

  const listHtml =
    view.list.length === 0
      ? `<div class="tab-placeholder">${escapeHtml(SIM_TAB_PLACEHOLDER.regions!)}</div>`
      : view.list
          .map(
            (item) => `
      <button class="feature-row" data-action="feature-select" data-feature-id="${escapeHtml(item.id)}">
        <span class="feature-name">${escapeHtml(item.name)}</span>
        <span class="feature-sub">${escapeHtml(item.subtype)} - ${item.borderVertexCount} border vertices, ${item.breaklineCount} breakline(s)</span>
        <span class="evidence-badge" title="Evidence: snap-backed vs free-placed vertices">${item.snappedEvidenceCount} snapped / ${item.freeEvidenceCount} free</span>
      </button>`,
          )
          .join('')

  const optionsHtml = view.templates
    .map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.displayName)}</option>`)
    .join('')

  return `
      <div class="feature-list">${listHtml}</div>
      <div class="region-add-row">
        <select id="region-template-select" title="Region subtype (from the template catalog)">${optionsHtml}</select>
        <button class="sim-add-button" data-action="region-add">+ Add region</button>
      </div>
  `
}

export function renderBuildingsTabHtml(view: BuildingsTabView): string {
  if (view.detail) {
    return renderFeatureDetailHtml(view.detail, view.objectEdit, view.isolateLoad, undefined, view.buildingEditor)
  }
  if (view.authoring) return renderBuildingAuthoringHtml(view.authoring)
  return renderBuildingsListHtml(view.list, view.templates)
}

export function renderSimpleTabHtml(view: SimpleTabView): string {
  if (view.detail) return renderFeatureDetailHtml(view.detail, view.objectEdit, view.isolateLoad)
  if (view.authoring && view.authoring.family === view.family) return renderSimpleAuthoringHtml(view.authoring)

  const emptyText = view.family === 'object' ? SIM_TAB_PLACEHOLDER.objects! : view.family === 'line' ? SIM_TAB_PLACEHOLDER.lines! : SIM_TAB_PLACEHOLDER.notes!
  const listHtml =
    view.list.length === 0
      ? `<div class="tab-placeholder">${escapeHtml(emptyText)}</div>`
      : view.list.map((item) => renderSimpleRowHtml(view.family, item)).join('')
  const optionsHtml = view.templates
    .map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.displayName)}</option>`)
    .join('')
  const selectId = `${view.family}-template-select`
  const addLabel = view.family === 'object' ? '+ Add object' : view.family === 'line' ? '+ Add line' : '+ Add note'

  return `
      <div class="feature-list">${listHtml}</div>
      <div class="region-add-row">
        <select id="${selectId}" title="${escapeHtml(addLabel)} subtype">${optionsHtml}</select>
        <button class="sim-add-button" data-action="${view.family}-add">${escapeHtml(addLabel)}</button>
      </div>
  `
}

export function renderObjectsTabHtml(view: SimpleTabView): string {
  if (view.detail) return renderFeatureDetailHtml(view.detail, view.objectEdit, view.isolateLoad)

  const toolbarNote =
    view.authoring && view.authoring.family === 'object' && view.authoring.phase === 'placing'
      ? '<div class="tab-note">Object placement toolbar is active in the viewer.</div>'
      : ''
  const listHtml =
    view.list.length === 0
      ? `<div class="tab-placeholder">${escapeHtml(SIM_TAB_PLACEHOLDER.objects!)}</div>`
      : view.list.map((item) => renderObjectRowHtml(item as ObjectListItem)).join('')

  return `
      <div class="object-tab-topstrip">
        <span class="object-tab-total">Object total: ${view.list.length}</span>
        <button class="sim-add-button" data-action="object-add">+ Add Object</button>
      </div>
      ${toolbarNote}
      <div class="feature-list">${listHtml}</div>
  `
}

/** Utilities tab: shared detail machinery here, list + rail in utilitiesPanel.ts. */
export function renderUtilitiesTabContentHtml(view: SimpleTabView): string {
  if (view.detail) return renderFeatureDetailHtml(view.detail, view.objectEdit, view.isolateLoad, view.utilityEditor)
  return renderUtilitiesTabHtml({
    authoring: view.authoring,
    list: view.list as UtilityListItem[],
    add: view.utilityAdd ?? buildUtilityAddModel('generic'),
  })
}

function renderSimpleRowHtml(family: SimpleFeatureFamily, item: ObjectListItem | LineListItem | MarkerListItem): string {
  const evidence = `${item.snappedEvidenceCount} snapped / ${item.freeEvidenceCount} free`
  let sub = item.subtype
  if (family === 'line') {
    const line = item as LineListItem
    sub = `${line.subtype} - ${line.vertexCount} vertices${line.isBreakline ? ' - breakline' : ''}`
  }
  return `
      <button class="feature-row" data-action="feature-select" data-feature-id="${escapeHtml(item.id)}">
        <span class="feature-name">${escapeHtml(item.name)}</span>
        <span class="feature-sub">${escapeHtml(sub)}</span>
        <span class="evidence-badge" title="Evidence: snap-backed vs free-placed vertices">${evidence}</span>
      </button>`
}

function renderObjectRowHtml(item: ObjectListItem): string {
  const evidence = `${item.snappedEvidenceCount} snapped / ${item.freeEvidenceCount} free`
  return `
      <div class="feature-row feature-row-object">
        <span class="feature-row-object-main">
          <button class="feature-pill feature-pill-toggle${item.visible ? '' : ' feature-pill-off'}" data-action="feature-visibility" data-feature-id="${escapeHtml(item.id)}" data-visible="${item.visible ? 'true' : 'false'}" title="${item.visible ? 'Hide object' : 'Show object'}">${escapeHtml(item.category)} / ${escapeHtml(item.typeLabel)}</button>
          <button class="feature-row-object-copy" data-action="feature-select" data-feature-id="${escapeHtml(item.id)}">
            <span class="feature-name">${escapeHtml(item.name)}</span>
            <span class="feature-sub">${escapeHtml(item.summary)} · ${evidence}</span>
          </button>
        </span>
      </div>`
}

function renderRegionAuthoringHtml(authoring: RegionAuthoringView): string {
  const evidenceLine = `<div class="authoring-evidence">${authoring.snappedCount} snapped / ${authoring.freeCount} free placed</div>`
  const cancelButton = `<button data-action="region-cancel">Cancel</button>`
  if (authoring.phase === 'border') {
    return `
      <div class="authoring-rail" data-phase="border">
        <div class="authoring-hint">Region (${escapeHtml(authoring.subtype)}): click in the viewer to place border vertices. ${authoring.activeVertexCount} placed.</div>
        ${evidenceLine}
        <button data-action="region-close-border"${authoring.canCloseBorder ? '' : ' disabled'}>Close border</button>
        ${cancelButton}
      </div>
    `
  }
  if (authoring.phase === 'breakline') {
    return `
      <div class="authoring-rail" data-phase="breakline">
        <div class="authoring-hint">Breakline: click in the viewer to place vertices. ${authoring.activeVertexCount} placed.</div>
        ${evidenceLine}
        <button data-action="region-finish-breakline"${authoring.canFinishBreakline ? '' : ' disabled'}>Finish breakline</button>
        ${cancelButton}
      </div>
    `
  }
  return `
      <div class="authoring-rail" data-phase="review">
        <div class="authoring-hint">Border closed (${authoring.borderVertexCount} vertices, ${authoring.breaklineCount} breakline(s)). Add breaklines or finish.</div>
        ${evidenceLine}
        <button data-action="region-add-breakline">Add breakline</button>
        <button data-action="region-finish">Finish region</button>
        ${cancelButton}
      </div>
  `
}

function renderBuildingAuthoringHtml(authoring: BuildingAuthoringView): string {
  const evidenceLine = `<div class="authoring-evidence">${authoring.snappedCount} snapped / ${authoring.freeCount} free placed</div>`
  const cancelButton = `<button data-action="region-cancel">Cancel</button>`
  const envelope = authoring.subtype === 'envelope'
  if (authoring.phase === 'footprint') {
    const hint = envelope
      ? `Building envelope: click in the viewer to draw the envelope boundary. ${authoring.activeVertexCount} placed.`
      : `Building (${escapeHtml(authoring.subtype)}): click in the viewer to place footprint vertices. ${authoring.activeVertexCount} placed.`
    return `
      <div class="authoring-rail" data-phase="footprint">
        <div class="authoring-hint">${hint}</div>
        ${evidenceLine}
        <button data-action="building-close-footprint"${authoring.canCloseFootprint ? '' : ' disabled'}>${envelope ? 'Close envelope' : 'Close footprint'}</button>
        ${cancelButton}
      </div>
    `
  }
  const reviewHint = envelope
    ? `Envelope closed (${authoring.footprintVertexCount} vertices). Finish to create the building; its envelope becomes the focus area.`
    : `Footprint closed (${authoring.footprintVertexCount} vertices). Finish to create massing and an exclusion zone.`
  return `
      <div class="authoring-rail" data-phase="review">
        <div class="authoring-hint">${reviewHint}</div>
        ${evidenceLine}
        <button data-action="building-finish">Finish building</button>
        ${cancelButton}
      </div>
  `
}

function renderSimpleAuthoringHtml(authoring: SimpleAuthoringView): string {
  const evidenceLine = `<div class="authoring-evidence">${authoring.snappedCount} snapped / ${authoring.freeCount} free placed</div>`
  const cancelButton = `<button data-action="region-cancel">Cancel</button>`
  const label = authoring.family === 'object' ? 'Object' : authoring.family === 'line' ? 'Line' : 'Marker'
  if (authoring.phase === 'placing') {
    const noun = authoring.family === 'line' ? 'vertices' : 'location'
    const action = authoring.family === 'line' ? 'simple-review' : 'simple-finish'
    const button = authoring.family === 'line' ? 'Review line' : `Finish ${label.toLowerCase()}`
    return `
      <div class="authoring-rail" data-phase="placing">
        <div class="authoring-hint">${label} (${escapeHtml(authoring.subtype)}): click in the viewer to place ${noun}. ${authoring.activeVertexCount} placed.</div>
        ${evidenceLine}
        <button data-action="${action}"${authoring.canReview ? '' : ' disabled'}>${button}</button>
        ${cancelButton}
      </div>
    `
  }
  return `
      <div class="authoring-rail" data-phase="review">
        <div class="authoring-hint">${label} ready (${authoring.vertexCount} ${authoring.family === 'line' ? 'vertices' : 'point'}). Finish to store params and evidence.</div>
        ${evidenceLine}
        <button data-action="simple-finish">Finish ${label.toLowerCase()}</button>
        ${cancelButton}
      </div>
  `
}

export function renderFeatureDetailHtml(
  detail: FeatureDetailModel,
  objectEdit?: ObjectEditView | null,
  isolateLoad?: IsolateLoadView | null,
  utilityEditor?: UtilityEditorModel | null,
  buildingEditor?: BuildingEditorModel | null,
): string {
  const activeEdit = objectEdit && objectEdit.featureId === detail.id ? objectEdit : null
  const activeLoad = isolateLoad && isolateLoad.featureId === detail.id ? isolateLoad : null
  // Objects, utilities and envelope buildings share the refinement machinery
  // (isolate area, explicit evidence); this is the one gate for those
  // sections. The 3D preview card stays object/utility-only.
  const refinePreview = detail.objectEditor ?? utilityEditor ?? null
  const refine = refinePreview ?? buildingEditor ?? null
  const objectSelectorsHtml = detail.objectEditor
    ? `
      <div class="ws-section">
        <div class="ws-section-title">Object</div>
        <label class="ws-meta-row"><span class="ws-meta-label">Category</span><span class="ws-meta-value"><select data-action="feature-object-category" data-feature-id="${escapeHtml(detail.id)}">${detail.objectEditor.categories
          .map(
            (category) =>
              `<option value="${escapeHtml(category.id)}"${category.id === detail.objectEditor!.categoryId ? ' selected' : ''}>${escapeHtml(category.label)}</option>`,
          )
          .join('')}</select></span></label>
        <label class="ws-meta-row"><span class="ws-meta-label">Type</span><span class="ws-meta-value"><select data-action="feature-object-type" data-feature-id="${escapeHtml(detail.id)}">${detail.objectEditor.types
          .map(
            (type) =>
              `<option value="${escapeHtml(type.templateId)}"${type.templateId === detail.objectEditor!.typeTemplateId ? ' selected' : ''}>${escapeHtml(type.label)}</option>`,
          )
          .join('')}</select></span></label>
        <div class="ws-detail">${escapeHtml(detail.objectEditor.summary)}</div>
      </div>`
    : ''
  const placementHtml = detail.objectEditor
    ? `
      <div class="ws-section">
        <div class="ws-section-title">Placement</div>
        <label class="ws-meta-row"><span class="ws-meta-label">X</span><span class="ws-meta-value"><input type="number" value="${escapeHtml(detail.objectEditor.placement.x)}" data-action="feature-placement" data-feature-id="${escapeHtml(detail.id)}" data-axis="x" /></span></label>
        <label class="ws-meta-row"><span class="ws-meta-label">Y</span><span class="ws-meta-value"><input type="number" value="${escapeHtml(detail.objectEditor.placement.y)}" data-action="feature-placement" data-feature-id="${escapeHtml(detail.id)}" data-axis="y" /></span></label>
        <label class="ws-meta-row"><span class="ws-meta-label">Z</span><span class="ws-meta-value"><input type="number" value="${escapeHtml(detail.objectEditor.placement.z)}" data-action="feature-placement" data-feature-id="${escapeHtml(detail.id)}" data-axis="z" /></span></label>
        <label class="ws-meta-row"><span class="ws-meta-label">Rotation</span><span class="ws-meta-value"><input type="number" value="${escapeHtml(detail.objectEditor.rotationYaw)}" data-action="feature-param" data-feature-id="${escapeHtml(detail.id)}" data-param-name="rotationYaw" /></span></label>
      </div>`
    : ''
  const previewLabel = detail.objectEditor
    ? `${detail.objectEditor.categoryId} / ${detail.objectEditor.typeLabel}`
    : utilityEditor
      ? `${utilityEditor.systemLabel} / ${utilityEditor.classLabel}`
      : ''
  const previewHtml = refinePreview
    ? `
      <div class="ws-section">
        <div class="ws-section-title">${detail.objectEditor ? 'Object Preview' : 'Utility Preview'}</div>
        <div class="object-preview-card">
          <div class="object-preview-label">${escapeHtml(previewLabel)}</div>
          <div class="object-preview-3d-mount object-preview-${escapeHtml(refinePreview.previewKind)}" data-preview-feature-id="${escapeHtml(detail.id)}"></div>
          <div class="object-preview-hint">Drag to rotate, wheel to zoom. Origin amber, evidence blue.</div>
          <div class="ws-detail">${escapeHtml(refinePreview.summary)}</div>
        </div>
      </div>`
    : ''
  const utilitySelectorsHtml = utilityEditor
    ? `
      <div class="ws-section">
        <div class="ws-section-title">Utility</div>
        <label class="ws-meta-row"><span class="ws-meta-label">Type</span><span class="ws-meta-value"><select data-action="feature-utility-type" data-feature-id="${escapeHtml(detail.id)}">${utilityEditor.typeOptions
          .map(
            (type) =>
              `<option value="${escapeHtml(type.templateId)}"${type.templateId === utilityEditor.typeTemplateId ? ' selected' : ''}>${escapeHtml(type.label)}</option>`,
          )
          .join('')}</select></span></label>
        <div class="ws-detail">${escapeHtml(utilityEditor.originLabel)}</div>
        <div class="ws-detail">${escapeHtml(utilityEditor.summary)}</div>
      </div>`
    : ''
  const utilityPlacementHtml = utilityEditor
    ? utilityEditor.placement
      ? `
      <div class="ws-section">
        <div class="ws-section-title">Placement</div>
        <label class="ws-meta-row"><span class="ws-meta-label">X</span><span class="ws-meta-value"><input type="number" value="${escapeHtml(utilityEditor.placement.x)}" data-action="feature-placement" data-feature-id="${escapeHtml(detail.id)}" data-axis="x" /></span></label>
        <label class="ws-meta-row"><span class="ws-meta-label">Y</span><span class="ws-meta-value"><input type="number" value="${escapeHtml(utilityEditor.placement.y)}" data-action="feature-placement" data-feature-id="${escapeHtml(detail.id)}" data-axis="y" /></span></label>
        <label class="ws-meta-row"><span class="ws-meta-label">Z</span><span class="ws-meta-value"><input type="number" value="${escapeHtml(utilityEditor.placement.z)}" data-action="feature-placement" data-feature-id="${escapeHtml(detail.id)}" data-axis="z" /></span></label>
      </div>`
      : `
      <div class="ws-section">
        <div class="ws-section-title">Alignment</div>
        <div class="ws-detail">${utilityEditor.vertexCount ?? 0} points - ${escapeHtml(utilityEditor.lengthLabel ?? '--')}</div>
        <div class="ws-detail">Alignment points are fixed after placement in beta; delete and re-place the run to change them.</div>
      </div>`
    : ''
  const isolateHtml = refine
    ? renderIsolateSectionHtml(
        detail,
        refine.isolateVertexCount,
        activeEdit,
        activeLoad,
        buildingEditor ? { override: buildingEditor.isolateOverride } : null,
      )
    : ''
  const buildingHtml = buildingEditor ? renderBuildingSectionsHtml(detail.id, buildingEditor) : ''
  const paramsHtml =
    detail.params.length === 0
      ? '<div class="ws-detail">No parameters.</div>'
      : detail.params.map((param) => renderParamControl(detail.id, param)).join('')
  const cadHtml = detail.cadRefs
    .map(
      (ref) =>
        `<div class="ws-meta-row"><span class="ws-meta-label">${escapeHtml(ref.name)}</span><span class="ws-meta-value">${escapeHtml(ref.value)}</span></div>`,
    )
    .join('')
  const badgesHtml = detail.evidenceBadges
    .map((badge) => `<span class="evidence-badge">${escapeHtml(badge)}</span>`)
    .join('')
  return `
      <div class="feature-detail">
        <button data-action="feature-back">&lt; Back</button>
        <div class="ws-title">
          <input class="feature-rename" data-action="feature-rename" data-feature-id="${escapeHtml(detail.id)}" value="${escapeHtml(detail.name)}" title="Rename (press Enter or click away to apply)" />
          <span class="authorship-badge authorship-${escapeHtml(detail.authorship)}">${escapeHtml(detail.authorship)}</span>
        </div>
        <div class="ws-meta">
          <div class="ws-meta-row"><span class="ws-meta-label">Family</span><span class="ws-meta-value">${escapeHtml(detail.family)}</span></div>
          <div class="ws-meta-row"><span class="ws-meta-label">Subtype</span><span class="ws-meta-value">${escapeHtml(detail.subtype)}</span></div>
          ${detail.templateId ? `<div class="ws-meta-row"><span class="ws-meta-label">Template</span><span class="ws-meta-value">${escapeHtml(detail.templateId)}</span></div>` : ''}
        </div>
        ${objectSelectorsHtml}
        ${utilitySelectorsHtml}
        ${previewHtml}
        ${placementHtml}
        ${utilityPlacementHtml}
        ${buildingHtml}
        ${isolateHtml}
        <div class="ws-section">
          <div class="ws-section-title">Parameters</div>
          ${paramsHtml}
        </div>
        ${cadHtml ? `<div class="ws-section"><div class="ws-section-title">CAD references (names only; export is a later phase)</div>${cadHtml}</div>` : ''}
        <div class="ws-section">
          <div class="ws-section-title">Evidence</div>
          ${badgesHtml ? `<div class="ws-detail">${badgesHtml}</div>` : ''}
          <div class="ws-detail">${detail.evidenceTotal} refs - ${detail.evidenceSnapped} snapped, ${detail.evidenceFree} free placed</div>
          ${refine ? renderEvidenceEditorHtml(detail, refine, activeEdit) : ''}
        </div>
        <button class="feature-delete" data-action="feature-delete" data-feature-id="${escapeHtml(detail.id)}">Delete feature</button>
      </div>
  `
}

/** Isolate Area section: draw rail while active, status + actions otherwise. */
function renderIsolateSectionHtml(
  detail: FeatureDetailModel,
  vertexCount: number | null,
  activeEdit: ObjectEditView | null,
  activeLoad: IsolateLoadView | null,
  /** Buildings only: isolation is never optional - the envelope is the default boundary. */
  building?: { override: boolean } | null,
): string {
  const id = escapeHtml(detail.id)
  if (activeEdit?.kind === 'isolate') {
    return `
      <div class="ws-section">
        <div class="ws-section-title">Isolate Area</div>
        <div class="authoring-rail" data-phase="isolate">
          <div class="authoring-hint">Click in the viewer to place boundary vertices. ${activeEdit.activeVertexCount} placed.</div>
          <button data-action="feature-isolate-finish"${activeEdit.canFinish ? '' : ' disabled'}>Close boundary</button>
          <button data-action="feature-isolate-cancel">Cancel</button>
        </div>
      </div>`
  }
  const status = building
    ? `Isolate area: ${vertexCount ?? 0} vertices (${building.override ? 'custom boundary' : 'building envelope'}). Context only - points inside are not evidence.`
    : vertexCount === null
      ? 'No isolate area yet. Draw a boundary to scope viewer focus around this feature.'
      : `Isolate area: ${vertexCount} vertices. Context only - points inside are not evidence.`
  const loadHtml =
    vertexCount === null
      ? ''
      : activeLoad
        ? `
        <div class="ws-detail">${
          activeLoad.sectorCount > 1
            ? `Full survey data: sector ${activeLoad.activeSector + 1} of ${activeLoad.sectorCount} (area exceeds display budget; amber rect marks the active sector).`
            : 'Full survey data loaded for the whole area.'
        }</div>
        ${
          activeLoad.sectorCount > 1
            ? `<button data-action="feature-isolate-sector-prev">&lt; Prev sector</button>
        <button data-action="feature-isolate-sector-next">Next sector &gt;</button>`
            : ''
        }
        <button data-action="feature-isolate-load-stop">Stop full data</button>`
        : `<button data-action="feature-isolate-load" data-feature-id="${id}">Load all survey data in area</button>`
  const drawLabel = building
    ? building.override
      ? 'Redraw custom boundary'
      : 'Draw custom boundary'
    : vertexCount === null
      ? '+ Add isolate area'
      : 'Redraw isolate area'
  // Buildings can only reset the override back to the envelope; other
  // families clear the optional area entirely.
  const clearHtml = building
    ? building.override
      ? `<button data-action="feature-isolate-clear" data-feature-id="${id}">Reset to envelope</button>`
      : ''
    : vertexCount === null
      ? ''
      : `<button data-action="feature-isolate-clear" data-feature-id="${id}">Clear isolate area</button>`
  return `
      <div class="ws-section">
        <div class="ws-section-title">Isolate Area</div>
        <div class="ws-detail">${escapeHtml(status)}</div>
        <button data-action="feature-isolate-start" data-feature-id="${id}">${drawLabel}</button>
        ${clearHtml}
        ${loadHtml}
      </div>`
}

/** Explicit evidence list + add/remove controls (objects and utilities). */
function renderEvidenceEditorHtml(
  detail: FeatureDetailModel,
  refine: { evidenceItems: { index: number; kindLabel: string; coordLabel: string }[]; evidenceOverflow: number },
  activeEdit: ObjectEditView | null,
): string {
  const id = escapeHtml(detail.id)
  const items = refine.evidenceItems
  const overflow = refine.evidenceOverflow
  const overflowHtml =
    overflow > 0
      ? `<div class="ws-detail">+ ${overflow} more refs (window selections)</div>`
      : ''
  const clearAllHtml =
    items.length > 0
      ? `<button data-action="feature-evidence-clear" data-feature-id="${id}">Remove all evidence</button>`
      : ''
  const listHtml =
    items.length === 0
      ? '<div class="ws-detail">No explicit evidence refs yet.</div>'
      : `<div class="evidence-list">${items
          .map(
            (item) => `
          <div class="evidence-item">
            <span class="evidence-item-label">${escapeHtml(item.kindLabel)} @ ${escapeHtml(item.coordLabel)}</span>
            <button class="evidence-remove" data-action="feature-evidence-remove" data-feature-id="${id}" data-evidence-index="${item.index}" title="Remove this evidence ref">&times;</button>
          </div>`,
          )
          .join('')}</div>${overflowHtml}${clearAllHtml}`
  const controlHtml =
    activeEdit?.kind === 'evidence'
      ? `
        <div class="authoring-hint">Click snapped cloud/feature points in the viewer to add evidence, or drag a selection window. Free clicks are ignored; isolated-out points never select.</div>
        ${activeEdit.note ? `<div class="ws-detail">${escapeHtml(activeEdit.note)}</div>` : ''}
        <button data-action="feature-evidence-window">Select by window</button>
        <button data-action="feature-evidence-stop">Done adding evidence</button>`
      : `<button data-action="feature-evidence-start" data-feature-id="${id}">+ Add evidence point</button>`
  return `${listHtml}${controlHtml}`
}

function renderParamControl(detailId: string, param: FeatureDetailModel['params'][number]): string {
  const data = `data-action="feature-param" data-feature-id="${escapeHtml(detailId)}" data-param-name="${escapeHtml(param.name)}"`
  const disabled = param.editable ? '' : ' disabled'
  let control = ''
  if (param.type === 'boolean') {
    control = `<input type="checkbox" ${data}${param.value === 'true' ? ' checked' : ''}${disabled} />`
  } else if (param.type === 'enum') {
    const options = (param.options ?? [])
      .map((option) => `<option value="${escapeHtml(option)}"${option === param.value ? ' selected' : ''}>${escapeHtml(option)}</option>`)
      .join('')
    control = `<select ${data}${disabled}>${options}</select>`
  } else if (param.type === 'number') {
    control = `<input type="number" value="${escapeHtml(param.value)}" ${data}${disabled} />`
  } else {
    control = `<input type="text" value="${escapeHtml(param.value)}" ${data}${disabled} />`
  }
  return `<label class="ws-meta-row"><span class="ws-meta-label">${escapeHtml(param.label)}</span><span class="ws-meta-value">${control}</span></label>`
}

function renderDerivedStatus(title: string, status: DerivedStatusModel, action: string, assetId: string): string {
  const generated = status.generatedAt ? `<div class="ws-detail">Generated: ${escapeHtml(status.generatedAt)}</div>` : ''
  const stale = status.staleNote
    ? `<div class="ws-stale">${escapeHtml(status.staleNote)}</div>`
    : ''
  return `
    <div class="ws-section">
      <div class="ws-section-title">${escapeHtml(title)}${status.stale ? ' <span class="ws-stale-badge">stale</span>' : ''}</div>
      <div class="ws-detail">${escapeHtml(status.summary)}</div>
      ${generated}
      ${stale}
      <button data-action="${action}" data-asset-id="${escapeHtml(assetId)}">${escapeHtml(status.actionLabel)}</button>
    </div>
  `
}

export function renderWorkSurfaceHtml(model: WorkSurfaceModel): string {
  const metaRow = (label: string, value: string | null): string =>
    value === null || value.length === 0
      ? ''
      : `<div class="ws-meta-row"><span class="ws-meta-label">${escapeHtml(label)}</span><span class="ws-meta-value">${escapeHtml(value)}</span></div>`

  const warnings =
    model.warnings.length > 0
      ? `<div class="ws-section"><div class="ws-section-title">Warnings</div>${model.warnings
          .map((warning) => `<div class="warn-text">${escapeHtml(warning)}</div>`)
          .join('')}</div>`
      : ''

  return `
    <div class="panel-header">
      <button data-action="back-to-sim" title="Back to the Sim work surface">&lt; Sim</button>
      <span>Asset</span>
      <button class="panel-detach planned-control" disabled title="Planned - detach this panel to float in-window; each panel detaches independently">Detach</button>
    </div>
    <div class="panel-content">
      <div class="ws-title">
        <span class="ws-name">${escapeHtml(model.name)}</span>
        <span class="truth-badge truth-${escapeHtml(model.truthStatus)}">${escapeHtml(model.truthStatus)}</span>
      </div>
      <div class="ws-meta">
        ${metaRow('Type', model.kindLabel)}
        ${metaRow('Import', model.importPolicy === 'copy' ? 'Copied into project' : 'Referenced in place')}
        ${metaRow('Source', model.sourcePath)}
        ${metaRow('Managed', model.managedPath)}
        ${metaRow('Units', model.unitsLabel)}
        ${metaRow('Points', model.pointSummary)}
        ${metaRow('Bounds', model.boundsSummary)}
      </div>
      ${warnings}
      ${renderDerivedStatus('Index (WPI)', model.index, 'build-index', model.assetId)}
      ${renderDerivedStatus('Surfels', model.surfels, 'generate-surfels', model.assetId)}
      <div class="ws-section ws-later">
        <div class="ws-section-title">Later</div>
        <button class="planned-control" disabled title="Planned - classification editing is a later phase">Classify points (later)</button>
        <button class="planned-control" disabled title="Planned - registration is a later phase">Register to control points (later)</button>
        <button class="planned-control" disabled title="Planned - extraction automation is a later phase">Extract features (later)</button>
      </div>
    </div>
  `
}

export function renderNoProjectHtml(): string {
  return `
    <div class="panel-header">
      <span>Reality Simulation</span>
      <button class="panel-detach planned-control" disabled title="Planned - detach this panel to float in-window; each panel detaches independently">Detach</button>
    </div>
    <div class="panel-content">
      <div class="tab-placeholder">No project loaded. Create or open a project to work on its sim.</div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Mount + event wiring
// ---------------------------------------------------------------------------

export function mountRightPanel(mount: HTMLElement, deps: RightPanelDeps): RightPanelApi {
  let mode: 'sim' | 'asset' = 'sim'
  let openedAssetId: string | null = null
  const simState: SimPanelViewState = { activeTab: 'regions', simVisible: true, selectedFeatureId: null }
  // Utilities add-picker: the system select filters the class select (session-only UI state).
  let utilityAddSystem: UtilitySystemId = 'generic'
  // One persistent 3D preview widget: innerHTML re-renders replace the mount
  // placeholder, so the canvas is re-parented (not recreated) to keep the
  // WebGL context and the user's orbit pose alive across panel updates.
  let objectPreview: ObjectPreview3d | null = null
  let objectPreviewFeatureId: string | null = null

  function syncObjectPreview(): void {
    const previewMount = mount.querySelector<HTMLElement>('.object-preview-3d-mount')
    const featureId = previewMount?.dataset.previewFeatureId ?? null
    const manifest = deps.getSession()?.manifest as ProjectManifest | undefined
    const feature = featureId ? manifest?.features.find((candidate) => candidate.id === featureId) ?? null : null
    if (!previewMount || !feature) {
      objectPreview?.dispose()
      objectPreview = null
      objectPreviewFeatureId = null
      return
    }
    if (objectPreview && objectPreviewFeatureId !== featureId) {
      // A different object gets a fresh framing rather than a stale orbit pose.
      objectPreview.dispose()
      objectPreview = null
    }
    if (!objectPreview) objectPreview = createObjectPreview3d()
    objectPreviewFeatureId = featureId
    previewMount.appendChild(objectPreview.element)
    objectPreview.update(feature)
  }

  function closeFeatureDetail(): void {
    simState.selectedFeatureId = null
    deps.features.cancelObjectEdit()
    deps.features.cancelBuildingFaceFit()
    deps.features.setFocusedFeature(null)
  }

  function buildRegionsView(manifest: ProjectManifest): RegionsTabView {
    const detail = simState.selectedFeatureId ? buildFeatureDetailModel(manifest, simState.selectedFeatureId) : null
    if (simState.selectedFeatureId && !detail) simState.selectedFeatureId = null // deleted elsewhere
    return {
      templates: deps.features.regionTemplates(),
      authoring: deps.features.getAuthoring(),
      list: buildRegionListModel(manifest),
      detail,
    }
  }

  function buildBuildingsView(manifest: ProjectManifest): BuildingsTabView {
    const detail = simState.selectedFeatureId ? buildFeatureDetailModel(manifest, simState.selectedFeatureId) : null
    if (simState.selectedFeatureId && !detail) simState.selectedFeatureId = null // deleted elsewhere
    const buildingFeature =
      detail?.family === 'building' ? manifest.features.find((candidate) => candidate.id === detail.id) ?? null : null
    return {
      templates: deps.features.buildingTemplates(),
      authoring: deps.features.getBuildingAuthoring(),
      list: buildBuildingRowsModel(manifest),
      detail,
      buildingEditor: buildingFeature
        ? buildBuildingEditorModel(buildingFeature, deps.features.getBuildingFaceFit(), deps.features.getBuildingFitNote())
        : null,
      objectEdit: deps.features.getObjectEdit(),
      isolateLoad: deps.features.getIsolateLoad(),
    }
  }

  function buildSimpleViews(manifest: ProjectManifest): Partial<Record<SimpleFeatureFamily, SimpleTabView>> {
    const detail = simState.selectedFeatureId ? buildFeatureDetailModel(manifest, simState.selectedFeatureId) : null
    if (simState.selectedFeatureId && !detail) simState.selectedFeatureId = null
    const authoring = deps.features.getSimpleAuthoring()
    const utilityFeature =
      detail?.family === 'utility' ? manifest.features.find((candidate) => candidate.id === detail.id) ?? null : null
    return {
      object: {
        family: 'object',
        templates: deps.features.objectTemplates(),
        authoring,
        list: buildObjectListModel(manifest),
        detail: detail?.family === 'object' ? detail : null,
        objectEdit: deps.features.getObjectEdit(),
        isolateLoad: deps.features.getIsolateLoad(),
      },
      utility: {
        family: 'utility',
        templates: [],
        authoring,
        list: buildUtilityListModel(manifest),
        detail: detail?.family === 'utility' ? detail : null,
        objectEdit: deps.features.getObjectEdit(),
        isolateLoad: deps.features.getIsolateLoad(),
        utilityAdd: buildUtilityAddModel(utilityAddSystem),
        utilityEditor: utilityFeature ? buildUtilityEditorModel(utilityFeature) : null,
      },
      line: {
        family: 'line',
        templates: deps.features.lineTemplates(),
        authoring,
        list: buildLineListModel(manifest),
        detail: detail?.family === 'line' ? detail : null,
      },
      marker: {
        family: 'marker',
        templates: deps.features.markerTemplates(),
        authoring,
        list: buildMarkerListModel(manifest),
        detail: detail?.family === 'marker' ? detail : null,
      },
    }
  }

  function render(): void {
    const session = deps.getSession()
    if (!session) {
      mode = 'sim'
      openedAssetId = null
      mount.innerHTML = renderNoProjectHtml()
      syncObjectPreview()
      return
    }
    const manifest = session.manifest as ProjectManifest
    if (mode === 'asset' && openedAssetId) {
      const model = buildWorkSurfaceModel(manifest, openedAssetId)
      if (model) {
        mount.innerHTML = renderWorkSurfaceHtml(model)
        syncObjectPreview()
        return
      }
      // Asset vanished (e.g. removed) - fall back to the sim surface.
      mode = 'sim'
      openedAssetId = null
    }
    mount.innerHTML = renderSimPanelHtml(
      buildSimPanelModel(manifest),
      simState,
      buildRegionsView(manifest),
      buildBuildingsView(manifest),
      buildSimpleViews(manifest),
    )
    syncObjectPreview()
  }

  mount.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
    if (!target || !mount.contains(target)) return
    const action = target.dataset.action
    const assetId = target.dataset.assetId ?? null
    const featureId = target.dataset.featureId ?? null

    if (action === 'sim-tab') {
      simState.activeTab = target.dataset.tabId ?? 'regions'
      closeFeatureDetail()
      render()
      return
    }
    if (action === 'sim-menu') {
      const dropdown = mount.querySelector<HTMLDivElement>('#sim-menu-dropdown')
      if (dropdown) dropdown.hidden = !dropdown.hidden
      return
    }
    if (action === 'back-to-sim') {
      mode = 'sim'
      openedAssetId = null
      render()
      return
    }
    if (action === 'build-index' && assetId) {
      void deps.buildIndex(assetId)
      return
    }
    if (action === 'generate-surfels' && assetId) {
      void deps.generateSurfels(assetId)
      return
    }
    if (action === 'region-add') {
      const select = mount.querySelector<HTMLSelectElement>('#region-template-select')
      if (select?.value) deps.features.startRegion(select.value)
      return
    }
    if (action === 'building-add') {
      const select = mount.querySelector<HTMLSelectElement>('#building-template-select')
      if (select?.value) deps.features.startBuilding(select.value)
      return
    }
    if (action === 'object-add') {
      deps.features.startObjectCreation()
      return
    }
    if (action === 'line-add') {
      const select = mount.querySelector<HTMLSelectElement>('#line-template-select')
      if (select?.value) deps.features.startLine(select.value)
      return
    }
    if (action === 'marker-add') {
      const select = mount.querySelector<HTMLSelectElement>('#marker-template-select')
      if (select?.value) deps.features.startMarker(select.value)
      return
    }
    if (action === 'utility-add') {
      const select = mount.querySelector<HTMLSelectElement>('#utility-class-select')
      if (select?.value) deps.features.startUtility(select.value)
      return
    }
    if (action === 'region-close-border') {
      deps.features.closeBorder()
      return
    }
    if (action === 'building-close-footprint') {
      deps.features.closeBuildingFootprint()
      return
    }
    if (action === 'simple-review') {
      deps.features.reviewSimpleFeature()
      return
    }
    if (action === 'region-add-breakline') {
      deps.features.startBreakline()
      return
    }
    if (action === 'region-finish-breakline') {
      deps.features.finishBreakline()
      return
    }
    if (action === 'region-finish') {
      void deps.features.finishRegion()
      return
    }
    if (action === 'building-finish') {
      void deps.features.finishBuilding()
      return
    }
    if (action === 'simple-finish') {
      void deps.features.finishSimpleFeature()
      return
    }
    if (action === 'region-cancel') {
      deps.features.cancel()
      return
    }
    if (action === 'feature-select' && featureId) {
      simState.selectedFeatureId = featureId
      deps.features.setFocusedFeature(featureId)
      render()
      return
    }
    if (action === 'feature-back') {
      closeFeatureDetail()
      render()
      return
    }
    if (action === 'feature-delete' && featureId) {
      closeFeatureDetail()
      void deps.features.remove(featureId)
      return
    }
    if (action === 'feature-visibility' && featureId) {
      event.stopPropagation()
      const visible = target.dataset.visible === 'true'
      void deps.features.updateVisibility(featureId, !visible)
      return
    }
    if (action === 'feature-isolate-start' && featureId) {
      deps.features.startIsolateBoundary(featureId)
      return
    }
    if (action === 'feature-isolate-finish') {
      void deps.features.finishIsolateBoundary()
      return
    }
    if (action === 'feature-isolate-cancel') {
      deps.features.cancelObjectEdit()
      return
    }
    if (action === 'feature-isolate-clear' && featureId) {
      void deps.features.clearIsolateBoundary(featureId)
      return
    }
    if (action === 'feature-isolate-load' && featureId) {
      deps.features.startIsolateLoadAll(featureId)
      return
    }
    if (action === 'feature-isolate-load-stop') {
      deps.features.stopIsolateLoadAll()
      return
    }
    if (action === 'feature-isolate-sector-prev') {
      deps.features.stepIsolateSector(-1)
      return
    }
    if (action === 'feature-isolate-sector-next') {
      deps.features.stepIsolateSector(1)
      return
    }
    if (action === 'feature-evidence-start' && featureId) {
      deps.features.startEvidencePick(featureId)
      return
    }
    if (action === 'feature-evidence-window') {
      void deps.features.selectEvidenceWindow()
      return
    }
    if (action === 'feature-evidence-stop') {
      deps.features.stopEvidencePick()
      return
    }
    if (action === 'feature-evidence-remove' && featureId) {
      const index = Number(target.dataset.evidenceIndex)
      if (Number.isInteger(index)) void deps.features.removeEvidenceRef(featureId, index)
      return
    }
    if (action === 'feature-evidence-clear' && featureId) {
      void deps.features.clearEvidenceRefs(featureId)
      return
    }
    if (action === 'building-face-fit' && featureId) {
      const kind = target.dataset.faceKind
      if (kind === 'wall' || kind === 'roof') deps.features.startBuildingFaceFit(featureId, kind)
      return
    }
    if (action === 'building-face-accept') {
      void deps.features.acceptBuildingFaceFit()
      return
    }
    if (action === 'building-face-cancel') {
      deps.features.cancelBuildingFaceFit()
      return
    }
    if (action === 'building-face-visibility' && featureId && target.dataset.faceId) {
      event.stopPropagation()
      const visible = target.dataset.visible === 'true'
      void deps.features.setBuildingFaceVisibility(featureId, target.dataset.faceId, !visible)
      return
    }
    if (action === 'building-face-remove' && featureId && target.dataset.faceId) {
      void deps.features.removeBuildingFace(featureId, target.dataset.faceId)
      return
    }
    if (action === 'building-feature-add' && featureId) {
      const faceSelect = mount.querySelector<HTMLSelectElement>('#building-feature-face-select')
      const typeSelect = mount.querySelector<HTMLSelectElement>('#building-feature-type-select')
      if (faceSelect?.value && typeSelect?.value) {
        void deps.features.addBuildingFaceFeature(featureId, faceSelect.value, typeSelect.value)
      }
      return
    }
    if (action === 'building-feature-visibility' && featureId && target.dataset.componentId) {
      event.stopPropagation()
      const visible = target.dataset.visible === 'true'
      void deps.features.setBuildingFeatureVisibility(featureId, target.dataset.componentId, !visible)
      return
    }
    if (action === 'building-feature-remove' && featureId && target.dataset.componentId) {
      void deps.features.removeBuildingFaceFeature(featureId, target.dataset.componentId)
      return
    }
  })

  mount.addEventListener('change', (event) => {
    const target = event.target as HTMLElement
    if (target.dataset.action === 'sim-visible' && target instanceof HTMLInputElement) {
      simState.simVisible = target.checked
      deps.features.setSimVisible?.(target.checked)
      return
    }
    if (target.dataset.action === 'feature-rename' && target instanceof HTMLInputElement && target.dataset.featureId) {
      void deps.features.rename(target.dataset.featureId, target.value)
      return
    }
    if (target.dataset.action === 'feature-param' && target.dataset.featureId && target.dataset.paramName) {
      const value = target instanceof HTMLInputElement && target.type === 'checkbox' ? String(target.checked) : (target as HTMLInputElement | HTMLSelectElement).value
      void deps.features.updateParam(target.dataset.featureId, target.dataset.paramName, value)
      return
    }
    if (target.dataset.action === 'feature-object-type' && target.dataset.featureId && target instanceof HTMLSelectElement) {
      void deps.features.updateObjectTemplate(target.dataset.featureId, target.value)
      return
    }
    if (target.dataset.action === 'feature-object-category' && target.dataset.featureId && target instanceof HTMLSelectElement) {
      void deps.features.updateObjectCategory(target.dataset.featureId, target.value)
      return
    }
    if (target.dataset.action === 'feature-utility-type' && target.dataset.featureId && target instanceof HTMLSelectElement) {
      void deps.features.updateUtilityTemplate(target.dataset.featureId, target.value)
      return
    }
    if (target.dataset.action === 'utility-add-system' && target instanceof HTMLSelectElement) {
      if (target.value === 'generic' || target.value === 'storm') {
        utilityAddSystem = target.value
        render()
      }
      return
    }
    if (target.dataset.action === 'feature-placement' && target.dataset.featureId && target.dataset.axis) {
      const axis = target.dataset.axis
      if (axis === 'x' || axis === 'y' || axis === 'z') {
        void deps.features.updatePlacement(target.dataset.featureId, axis, (target as HTMLInputElement).value)
      }
      return
    }
    if (target.dataset.action === 'building-face-rename' && target.dataset.featureId && target.dataset.faceId && target instanceof HTMLInputElement) {
      void deps.features.renameBuildingFace(target.dataset.featureId, target.dataset.faceId, target.value)
      return
    }
    if (
      target.dataset.action === 'building-feature-param' &&
      target.dataset.featureId &&
      target.dataset.componentId &&
      target.dataset.paramName &&
      target instanceof HTMLInputElement
    ) {
      void deps.features.updateBuildingFeatureParam(target.dataset.featureId, target.dataset.componentId, target.dataset.paramName, target.value)
      return
    }
    if (target.dataset.action === 'building-feature-type' && target.dataset.featureId && target.dataset.componentId && target instanceof HTMLSelectElement) {
      void deps.features.updateBuildingFeatureType(target.dataset.featureId, target.dataset.componentId, target.value)
      return
    }
  })

  render()

  return {
    render,
    openAsset(assetId) {
      mode = 'asset'
      openedAssetId = assetId
      render()
    },
    showSim() {
      mode = 'sim'
      openedAssetId = null
      render()
    },
  }
}
