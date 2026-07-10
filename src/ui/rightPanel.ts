// src/ui/rightPanel.ts - the right panel: controls, never a driver of viewer
// display. The Sim work surface is live for REGIONS (Create Sim IMP-3): the
// regions tab lists authored regions, drives the border/breakline authoring
// tool rail, and opens a feature detail with rename/delete. Every other
// family tab stays visibly staged until its own slice lands. Opening an
// asset from the Display Manager swaps in the asset work surface with a
// back-to-sim control; the viewer is untouched.

import type { ProjectSession } from '../shared/ipc'
import type { ProjectManifest } from '../shared/workbench-types'
import type { BuildingAuthoringView, RegionAuthoringView, SimpleAuthoringView, SimpleFeatureFamily } from './features'
import {
  buildBuildingListModel,
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
  startRegion(templateId: string): void
  startBuilding(templateId: string): void
  startObject(templateId: string): void
  startLine(templateId: string): void
  startMarker(templateId: string): void
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
  remove(featureId: string): Promise<void>
  /** Sim master toggle: show/hide all authored features as one group. */
  setSimVisible?(visible: boolean): void
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
}

export interface SimpleTabView {
  family: SimpleFeatureFamily
  templates: { id: string; displayName: string }[]
  authoring: SimpleAuthoringView | null
  list: Array<ObjectListItem | LineListItem | MarkerListItem>
  detail: FeatureDetailModel | null
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
  objects: 'No objects yet. Object placement from cloud evidence arrives with the Create Sim phase.',
  buildings: 'No buildings yet. Building massing arrives with the Create Sim phase.',
  utilities: 'No utilities yet. Utility features arrive with the Create Sim phase.',
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
          ? renderSimpleTabHtml(simpleTabs.object)
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
  if (view.detail) return renderFeatureDetailHtml(view.detail)
  if (view.authoring) return renderBuildingAuthoringHtml(view.authoring)

  const listHtml =
    view.list.length === 0
      ? `<div class="tab-placeholder">${escapeHtml(SIM_TAB_PLACEHOLDER.buildings!)}</div>`
      : view.list
          .map(
            (item) => `
      <button class="feature-row" data-action="feature-select" data-feature-id="${escapeHtml(item.id)}">
        <span class="feature-name">${escapeHtml(item.name)}</span>
        <span class="feature-sub">${escapeHtml(item.subtype)} roof - ${item.footprintVertexCount} footprint vertices</span>
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
        <select id="building-template-select" title="Building roof type (from the template catalog)">${optionsHtml}</select>
        <button class="sim-add-button" data-action="building-add">+ Add building</button>
      </div>
  `
}

export function renderSimpleTabHtml(view: SimpleTabView): string {
  if (view.detail) return renderFeatureDetailHtml(view.detail)
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
  if (authoring.phase === 'footprint') {
    return `
      <div class="authoring-rail" data-phase="footprint">
        <div class="authoring-hint">Building (${escapeHtml(authoring.subtype)}): click in the viewer to place footprint vertices. ${authoring.activeVertexCount} placed.</div>
        ${evidenceLine}
        <button data-action="building-close-footprint"${authoring.canCloseFootprint ? '' : ' disabled'}>Close footprint</button>
        ${cancelButton}
      </div>
    `
  }
  return `
      <div class="authoring-rail" data-phase="review">
        <div class="authoring-hint">Footprint closed (${authoring.footprintVertexCount} vertices). Finish to create massing and an exclusion zone.</div>
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

export function renderFeatureDetailHtml(detail: FeatureDetailModel): string {
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
        <div class="ws-section">
          <div class="ws-section-title">Parameters</div>
          ${paramsHtml}
        </div>
        ${cadHtml ? `<div class="ws-section"><div class="ws-section-title">CAD references (names only; export is a later phase)</div>${cadHtml}</div>` : ''}
        <div class="ws-section">
          <div class="ws-section-title">Evidence</div>
          ${badgesHtml ? `<div class="ws-detail">${badgesHtml}</div>` : ''}
          <div class="ws-detail">${detail.evidenceTotal} refs - ${detail.evidenceSnapped} snapped, ${detail.evidenceFree} free placed</div>
        </div>
        <button class="feature-delete" data-action="feature-delete" data-feature-id="${escapeHtml(detail.id)}">Delete feature</button>
      </div>
  `
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
    return {
      templates: deps.features.buildingTemplates(),
      authoring: deps.features.getBuildingAuthoring(),
      list: buildBuildingListModel(manifest),
      detail,
    }
  }

  function buildSimpleViews(manifest: ProjectManifest): Partial<Record<SimpleFeatureFamily, SimpleTabView>> {
    const detail = simState.selectedFeatureId ? buildFeatureDetailModel(manifest, simState.selectedFeatureId) : null
    if (simState.selectedFeatureId && !detail) simState.selectedFeatureId = null
    const authoring = deps.features.getSimpleAuthoring()
    return {
      object: {
        family: 'object',
        templates: deps.features.objectTemplates(),
        authoring,
        list: buildObjectListModel(manifest),
        detail: detail?.family === 'object' ? detail : null,
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
      return
    }
    const manifest = session.manifest as ProjectManifest
    if (mode === 'asset' && openedAssetId) {
      const model = buildWorkSurfaceModel(manifest, openedAssetId)
      if (model) {
        mount.innerHTML = renderWorkSurfaceHtml(model)
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
  }

  mount.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
    if (!target || !mount.contains(target)) return
    const action = target.dataset.action
    const assetId = target.dataset.assetId ?? null
    const featureId = target.dataset.featureId ?? null

    if (action === 'sim-tab') {
      simState.activeTab = target.dataset.tabId ?? 'regions'
      simState.selectedFeatureId = null
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
      const select = mount.querySelector<HTMLSelectElement>('#object-template-select')
      if (select?.value) deps.features.startObject(select.value)
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
      render()
      return
    }
    if (action === 'feature-back') {
      simState.selectedFeatureId = null
      render()
      return
    }
    if (action === 'feature-delete' && featureId) {
      simState.selectedFeatureId = null
      void deps.features.remove(featureId)
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
