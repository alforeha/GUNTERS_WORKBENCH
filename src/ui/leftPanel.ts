// src/ui/leftPanel.ts - the Display Manager: a pure display/data manager over
// project assets. Tabbed by asset type; asset-centered expandable cards
// (accordion). The master extension pill overrides whole-asset display while
// preserving per-layer sub-state. Toggling here means "show this raw data in
// the viewer" - it is NOT sim membership. All visibility routes through the
// layer controller's setLayerVisibility path; this module renders intent only.

import type { ProjectSession } from '../shared/ipc'
import type { ProjectManifest } from '../shared/workbench-types'
import {
  DETAIL_PRESETS,
  FIXED_RADIUS_PRESETS_FT,
  formatRadiusScale,
  type DetailPreset,
} from '../viewer/pointCloudAppearance'
import {
  buildPointCloudCards,
  buildSurfaceCards,
  escapeHtml,
  type ColorMode,
  type LayerAppearance,
  type PointCloudCardModel,
  type SurfaceCardModel,
  type ProjectStatusLines,
} from './model'

export type LeftPanelTabId = 'point-clouds' | 'surfaces' | 'drawings' | 'documents' | 'images' | 'gis'

export const LEFT_PANEL_TABS: { id: LeftPanelTabId; label: string }[] = [
  { id: 'point-clouds', label: 'Point Clouds' },
  { id: 'surfaces', label: 'Surfaces/TINs' },
  { id: 'drawings', label: 'Drawings' },
  { id: 'documents', label: 'Documents' },
  { id: 'images', label: 'Images' },
  { id: 'gis', label: 'GIS' },
]

const PLACEHOLDER_TAB_TEXT: Record<LeftPanelTabId, string> = {
  'point-clouds': 'No point cloud assets yet. Import a LAS/LAZ file to get started.',
  surfaces: 'No surface assets yet. Imported TINs and sim-exported surfaces will land here.',
  drawings: 'No drawing assets yet. DWG/DXF management lands here in a later phase.',
  documents: 'No document assets yet. PDF plansets land here in a later phase.',
  images: 'No image assets yet. GeoTIFF and field imagery land here in a later phase.',
  gis: 'GIS sources are on the roadmap. Nothing to manage yet.',
}

export interface LeftPanelViewState {
  activeTab: LeftPanelTabId
  expandedAssetId: string | null
  confirmRemoveAssetId: string | null
}

export interface LeftPanelRenderModel {
  hasProject: boolean
  status: ProjectStatusLines
  pointCloudCards: PointCloudCardModel[]
  surfaceCards: SurfaceCardModel[]
  appearance: (layerId: string) => LayerAppearance
  view: LeftPanelViewState
}

export interface LeftPanelDeps {
  getSession(): ProjectSession | null
  getStatus(): ProjectStatusLines
  getLayerAppearance(layerId: string): LayerAppearance
  setLayerVisibility(layerId: string, visible: boolean): Promise<void>
  toggleAssetMaster(assetId: string, on: boolean): Promise<void>
  removeAsset(assetId: string): Promise<void>
  setLayerColorMode(layerId: string, mode: ColorMode): void
  setLayerPointRadius(layerId: string, radius: 'auto' | number): void
  stepLayerRadiusScale(layerId: string, factor: number): void
  resetLayerRadiusAuto(layerId: string): void
  setLayerDetail(layerId: string, preset: DetailPreset): void
  setLayerSurfelScale(layerId: string, scale: number): void
  importPointCloud(): Promise<void>
  openAsset(assetId: string): void
}

export interface LeftPanelApi {
  render(): void
}

// ---------------------------------------------------------------------------
// Pure renderers (node-testable)
// ---------------------------------------------------------------------------

function renderColorModeSelect(layerId: string, look: LayerAppearance): string {
  const opt = (value: ColorMode, label: string): string =>
    `<option value="${value}"${look.colorMode === value ? ' selected' : ''}>${label}</option>`
  return `
    <label class="view-control">Color
      <select data-action="color-mode" data-layer-id="${escapeHtml(layerId)}">
        ${opt('rgb', 'RGB')}
        <option value="classification" disabled>Classification (planned)</option>
        ${opt('elevation', 'Elevation')}
        ${opt('intensity', 'Intensity')}
      </select>
    </label>
  `
}

/** Point radius select: Auto (renderer-derived) or a fixed real-world radius in feet. */
function renderPointRadiusControls(layerId: string, look: LayerAppearance): string {
  const appearance = look.pointAppearance
  const id = escapeHtml(layerId)
  const radiusOptions = [
    `<option value="auto"${appearance.radiusMode === 'auto' ? ' selected' : ''}>Auto</option>`,
    ...FIXED_RADIUS_PRESETS_FT.map(
      (radiusFt) =>
        `<option value="${radiusFt}"${
          appearance.radiusMode === 'fixed' && appearance.fixedRadiusFt === radiusFt ? ' selected' : ''
        }>${radiusFt} ft</option>`,
    ),
  ].join('')
  const scaleButton = (factor: number, label: string): string =>
    `<button data-action="radius-scale" data-layer-id="${id}" data-factor="${factor}" title="Scale the current point radius">${label}</button>`
  return `
    <label class="view-control">Point radius
      <select data-action="point-radius" data-layer-id="${id}">${radiusOptions}</select>
    </label>
    <div class="view-control radius-scale-row">
      ${scaleButton(0.1, '÷10')}
      ${scaleButton(0.5, '÷2')}
      <button data-action="radius-auto" data-layer-id="${id}" title="Back to auto radius at ×1">Auto</button>
      ${scaleButton(2, '×2')}
      ${scaleButton(10, '×10')}
      <span class="radius-scale-label" title="Current radius scale">${escapeHtml(formatRadiusScale(appearance.radiusScale))}</span>
    </div>
  `
}

function renderDetailSelect(layerId: string, look: LayerAppearance): string {
  const options = DETAIL_PRESETS.map(
    (preset) => `<option value="${preset.id}"${look.detail === preset.id ? ' selected' : ''}>${preset.label}</option>`,
  ).join('')
  return `
    <label class="view-control" title="Refinement preset: streaming detail vs load/render pressure">Detail
      <select data-action="detail-preset" data-layer-id="${escapeHtml(layerId)}">${options}</select>
    </label>
  `
}

function renderViewRowControls(view: PointCloudCardModel['views'][number], look: LayerAppearance): string {
  const parts: string[] = []
  if (view.supportsColorMode) parts.push(renderColorModeSelect(view.layerId, look))
  if (view.supportsPointSize) {
    parts.push(renderPointRadiusControls(view.layerId, look))
    if (view.viewKind === 'index') parts.push(renderDetailSelect(view.layerId, look))
  }
  if (view.supportsSurfelScale) {
    parts.push(`
      <label class="view-control">Surfel scale
        <input type="range" min="1" max="5" step="1" value="${look.surfelScale}"
          data-action="surfel-scale" data-layer-id="${escapeHtml(view.layerId)}" />
      </label>
    `)
  }
  parts.push(`
    <label class="view-control planned-control" title="Planned - the engine exposes no per-layer opacity hook yet">Opacity
      <input type="range" min="0" max="100" value="100" disabled />
    </label>
  `)
  return `<div class="view-row-controls">${parts.join('')}</div>`
}

function renderPointCloudCard(
  card: PointCloudCardModel,
  view: LeftPanelViewState,
  appearance: (layerId: string) => LayerAppearance,
): string {
  const expanded = view.expandedAssetId === card.assetId
  const off = !card.masterOn

  const viewRows = card.views
    .map((row) => {
      const errorBadge = row.status === 'error' ? '<span class="layer-error-badge">load error</span>' : ''
      const controls = expanded ? renderViewRowControls(row, appearance(row.layerId)) : ''
      return `
        <div class="view-row" data-layer-id="${escapeHtml(row.layerId)}">
          <label class="view-row-main">
            <input type="checkbox" data-action="layer-visible" data-layer-id="${escapeHtml(row.layerId)}"${row.active ? ' checked' : ''} />
            <span class="view-row-label">${escapeHtml(row.label)}</span>
            <span class="truth-badge truth-${escapeHtml(row.truthLabel)}">${escapeHtml(row.truthLabel)}</span>
            ${errorBadge}
          </label>
          ${controls}
        </div>
      `
    })
    .join('')

  const missingRows = card.missingViews
    .map(
      (row) => `
        <div class="view-row view-row-disabled">
          <span class="view-row-label">${escapeHtml(row.label)}</span>
          <span class="view-hint">${escapeHtml(row.hint)}</span>
        </div>
      `,
    )
    .join('')

  const classificationRow = `
    <div class="view-row view-row-disabled" title="Classification display is planned; editing is a later phase">
      <span class="view-row-label">Classification - none detected in this asset (display planned)</span>
    </div>
  `

  const warnings =
    card.warnings.length > 0
      ? `<div class="card-warnings">${card.warnings.map((w) => `<div class="warn-text">${escapeHtml(w)}</div>`).join('')}</div>`
      : ''

  const confirmRemove =
    view.confirmRemoveAssetId === card.assetId
      ? `
        <div class="remove-confirm">
          <span>Remove this asset and its derived layers from the project? Files on disk are not deleted.</span>
          <button data-action="confirm-remove" data-asset-id="${escapeHtml(card.assetId)}">Remove</button>
          <button data-action="cancel-remove">Cancel</button>
        </div>
      `
      : ''

  const body = expanded
    ? `
      <div class="asset-card-body">
        ${viewRows}
        ${missingRows}
        ${classificationRow}
        ${warnings}
        <div class="asset-card-footer">
          <button data-action="open-asset" data-asset-id="${escapeHtml(card.assetId)}" title="Open the asset work surface in the right panel (viewer display is unchanged)">Open</button>
          <button data-action="remove-asset" data-asset-id="${escapeHtml(card.assetId)}">Remove</button>
        </div>
        ${confirmRemove}
      </div>
    `
    : ''

  return `
    <div class="asset-card${off ? ' asset-card-off' : ''}${expanded ? ' asset-card-expanded' : ''}" data-asset-id="${escapeHtml(card.assetId)}">
      <div class="asset-card-header" data-action="expand-card" data-asset-id="${escapeHtml(card.assetId)}">
        <button class="ext-pill${off ? ' ext-pill-off' : ''}" data-action="master-toggle" data-asset-id="${escapeHtml(card.assetId)}"
          title="Show/hide whole asset (preserves per-layer state)">${escapeHtml(card.extLabel)}</button>
        <div class="asset-card-title">
          <div class="asset-card-name">${escapeHtml(card.name)}</div>
          <div class="asset-card-detail">${escapeHtml(card.detail)}</div>
        </div>
        <span class="truth-badge truth-${escapeHtml(card.truthStatus)}">${escapeHtml(card.truthStatus)}</span>
      </div>
      ${body}
    </div>
  `
}

function renderSurfaceCard(card: SurfaceCardModel): string {
  const toggle =
    card.layerId !== null
      ? `<input type="checkbox" data-action="layer-visible" data-layer-id="${escapeHtml(card.layerId)}"${card.active ? ' checked' : ''} />`
      : ''
  return `
    <div class="asset-card asset-card-simple" data-asset-id="${escapeHtml(card.assetId)}">
      <div class="asset-card-header">
        ${toggle}
        <div class="asset-card-name">${escapeHtml(card.name)}</div>
        <span class="truth-badge truth-${escapeHtml(card.truthStatus)}">${escapeHtml(card.truthStatus)}</span>
      </div>
    </div>
  `
}

export function renderLeftPanelHtml(model: LeftPanelRenderModel): string {
  const tabsHtml = LEFT_PANEL_TABS.map((tab) => {
    const count =
      tab.id === 'point-clouds'
        ? model.pointCloudCards.length
        : tab.id === 'surfaces'
          ? model.surfaceCards.length
          : 0
    const countHtml = count > 0 ? ` (${count})` : ''
    const active = model.view.activeTab === tab.id ? ' tab-active' : ''
    return `<button class="panel-tab${active}" data-action="select-tab" data-tab-id="${tab.id}">${escapeHtml(tab.label)}${countHtml}</button>`
  }).join('')

  let content: string
  if (model.view.activeTab === 'point-clouds') {
    const importButton = `<button data-action="import-pointcloud"${model.hasProject ? '' : ' disabled title="Open or create a project first"'}>Import Point Cloud</button>`
    const cards =
      model.pointCloudCards.length > 0
        ? model.pointCloudCards.map((card) => renderPointCloudCard(card, model.view, model.appearance)).join('')
        : `<div class="tab-placeholder">${escapeHtml(PLACEHOLDER_TAB_TEXT['point-clouds'])}</div>`
    content = `<div class="tab-actions">${importButton}</div>${cards}`
  } else if (model.view.activeTab === 'surfaces') {
    content =
      model.surfaceCards.length > 0
        ? model.surfaceCards.map((card) => renderSurfaceCard(card)).join('')
        : `<div class="tab-placeholder">${escapeHtml(PLACEHOLDER_TAB_TEXT.surfaces)}</div>`
  } else {
    content = `<div class="tab-placeholder">${escapeHtml(PLACEHOLDER_TAB_TEXT[model.view.activeTab])}</div>`
  }

  return `
    <div class="panel-header">
      <span>Display Manager</span>
      <button class="panel-detach planned-control" disabled title="Planned - detach this panel to float in-window; each panel detaches independently">Detach</button>
    </div>
    <div class="panel-tabs">${tabsHtml}</div>
    <div class="panel-content">${content}</div>
    <div class="panel-status">
      <div class="panel-status-line" id="left-project-line">${escapeHtml(model.status.projectLine)}</div>
      <div class="panel-status-line" id="left-recovery-line">${escapeHtml(model.status.recoveryLine)}</div>
    </div>
  `
}

export function buildLeftPanelModel(
  session: ProjectSession | null,
  status: ProjectStatusLines,
  view: LeftPanelViewState,
  appearance: (layerId: string) => LayerAppearance,
): LeftPanelRenderModel {
  const manifest = session ? (session.manifest as ProjectManifest) : null
  return {
    hasProject: session !== null,
    status,
    pointCloudCards: manifest ? buildPointCloudCards(manifest) : [],
    surfaceCards: manifest ? buildSurfaceCards(manifest) : [],
    appearance,
    view,
  }
}

// ---------------------------------------------------------------------------
// Mount + event wiring
// ---------------------------------------------------------------------------

export function mountLeftPanel(mount: HTMLElement, deps: LeftPanelDeps): LeftPanelApi {
  const view: LeftPanelViewState = {
    activeTab: 'point-clouds',
    expandedAssetId: null,
    confirmRemoveAssetId: null,
  }

  function render(): void {
    const model = buildLeftPanelModel(deps.getSession(), deps.getStatus(), view, (layerId) =>
      deps.getLayerAppearance(layerId),
    )
    mount.innerHTML = renderLeftPanelHtml(model)
  }

  mount.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
    if (!target || !mount.contains(target)) return
    const action = target.dataset.action
    const assetId = target.dataset.assetId ?? null

    if (action === 'select-tab') {
      view.activeTab = (target.dataset.tabId as LeftPanelTabId) ?? 'point-clouds'
      view.confirmRemoveAssetId = null
      render()
      return
    }
    if (action === 'master-toggle' && assetId) {
      event.stopPropagation()
      const session = deps.getSession()
      const card = session
        ? buildPointCloudCards(session.manifest as ProjectManifest).find((c) => c.assetId === assetId)
        : undefined
      if (card) void deps.toggleAssetMaster(assetId, !card.masterOn)
      return
    }
    if (action === 'expand-card' && assetId) {
      view.expandedAssetId = view.expandedAssetId === assetId ? null : assetId
      view.confirmRemoveAssetId = null
      render()
      return
    }
    if (action === 'open-asset' && assetId) {
      deps.openAsset(assetId)
      return
    }
    if (action === 'remove-asset' && assetId) {
      view.confirmRemoveAssetId = assetId
      render()
      return
    }
    if (action === 'confirm-remove' && assetId) {
      view.confirmRemoveAssetId = null
      void deps.removeAsset(assetId)
      return
    }
    if (action === 'cancel-remove') {
      view.confirmRemoveAssetId = null
      render()
      return
    }
    if (action === 'import-pointcloud') {
      void deps.importPointCloud()
      return
    }
    const layerId = target.dataset.layerId ?? null
    if (action === 'radius-scale' && layerId) {
      const factor = Number(target.dataset.factor)
      if (Number.isFinite(factor) && factor > 0) deps.stepLayerRadiusScale(layerId, factor)
      render() // reflect the new scale label
      return
    }
    if (action === 'radius-auto' && layerId) {
      deps.resetLayerRadiusAuto(layerId)
      render()
      return
    }
  })

  mount.addEventListener('change', (event) => {
    const target = event.target as HTMLElement
    const action = target.dataset.action
    const layerId = target.dataset.layerId
    if (!action || !layerId) return
    if (action === 'layer-visible' && target instanceof HTMLInputElement) {
      void deps.setLayerVisibility(layerId, target.checked)
    } else if (action === 'color-mode' && target instanceof HTMLSelectElement) {
      deps.setLayerColorMode(layerId, target.value as ColorMode)
    } else if (action === 'point-radius' && target instanceof HTMLSelectElement) {
      deps.setLayerPointRadius(layerId, target.value === 'auto' ? 'auto' : Number(target.value))
      render()
    } else if (action === 'detail-preset' && target instanceof HTMLSelectElement) {
      deps.setLayerDetail(layerId, target.value as DetailPreset)
    }
  })

  mount.addEventListener('input', (event) => {
    const target = event.target as HTMLElement
    const action = target.dataset.action
    const layerId = target.dataset.layerId
    if (!action || !layerId || !(target instanceof HTMLInputElement)) return
    if (action === 'surfel-scale') deps.setLayerSurfelScale(layerId, Number(target.value))
  })

  render()
  return { render }
}
