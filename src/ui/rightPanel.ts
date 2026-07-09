// src/ui/rightPanel.ts - the right panel: controls, never a driver of viewer
// display. Default state is the Sim work surface (a SHELL this phase: the
// feature schema still only knows marker | polyline | measurement, so the
// taxonomy tabs, + Add buttons, DWG display mode, and sim-level actions are
// all visibly staged). Opening an asset from the Display Manager swaps in the
// asset work surface with a back-to-sim control; the viewer is untouched.

import type { ProjectSession } from '../shared/ipc'
import type { ProjectManifest } from '../shared/workbench-types'
import {
  buildSimPanelModel,
  buildWorkSurfaceModel,
  escapeHtml,
  type DerivedStatusModel,
  type SimPanelModel,
  type WorkSurfaceModel,
} from './model'

export interface RightPanelDeps {
  getSession(): ProjectSession | null
  buildIndex(assetId: string): Promise<void>
  generateSurfels(assetId: string): Promise<void>
}

export interface RightPanelApi {
  render(): void
  openAsset(assetId: string): void
  showSim(): void
}

export interface SimPanelViewState {
  activeTab: string
  simVisible: boolean
}

const SIM_TAB_PLACEHOLDER: Record<string, string> = {
  regions: 'No regions yet. Region authoring (border, then breaklines) arrives with the Create Sim phase.',
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

export function renderSimPanelHtml(model: SimPanelModel, state: SimPanelViewState): string {
  const tabsHtml = model.tabs
    .map((tab) => {
      const active = state.activeTab === tab.id ? ' tab-active' : ''
      const countHtml = tab.count > 0 ? ` (${tab.count})` : ''
      return `<button class="panel-tab${active}" data-action="sim-tab" data-tab-id="${tab.id}">${escapeHtml(tab.label)}${countHtml}</button>`
    })
    .join('')

  const activeTab = model.tabs.find((tab) => tab.id === state.activeTab) ?? model.tabs[0]
  const placeholder = SIM_TAB_PLACEHOLDER[activeTab.id] ?? 'Nothing here yet.'
  const legacyNote =
    activeTab.count > 0
      ? `<div class="tab-note">${activeTab.count} existing feature record(s) of the legacy schema; read-only this phase.</div>`
      : ''

  return `
    <div class="panel-header">
      <span>Reality Simulation</span>
      <button class="panel-detach planned-control" disabled title="Planned - detach this panel to float in-window; each panel detaches independently">Detach</button>
    </div>
    <div class="sim-controls">
      <label class="sim-master" title="Show/hide all authored features as a group (no authored features render yet)">
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
      ${legacyNote}
      <div class="tab-placeholder">${escapeHtml(placeholder)}</div>
      <button class="planned-control sim-add-button" disabled
        title="Planned - feature creation arrives with the Create Sim phase and summons its toolset into the viewer tool rail">${escapeHtml(activeTab.addLabel)} (planned)</button>
    </div>
  `
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
  const simState: SimPanelViewState = { activeTab: 'regions', simVisible: true }

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
    mount.innerHTML = renderSimPanelHtml(buildSimPanelModel(manifest), simState)
  }

  mount.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
    if (!target || !mount.contains(target)) return
    const action = target.dataset.action
    const assetId = target.dataset.assetId ?? null

    if (action === 'sim-tab') {
      simState.activeTab = target.dataset.tabId ?? 'regions'
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
  })

  mount.addEventListener('change', (event) => {
    const target = event.target as HTMLElement
    if (target.dataset.action === 'sim-visible' && target instanceof HTMLInputElement) {
      // UI-memory only: no authored features render yet, so this is honest state
      // for the future group toggle, not a hidden engine effect.
      simState.simVisible = target.checked
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
