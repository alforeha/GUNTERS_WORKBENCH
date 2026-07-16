import type { RegionAuthoringView, RegionEditView } from './features'
import type { RegionListItem } from './model'
import type { RegionEditorModel } from './regionModel'

export interface RegionDetailView {
  id: string
  name: string
  family: string
  subtype: string
  templateId: string | null
  authorship: string
  editor: RegionEditorModel
}

export interface RegionsTabView {
  templates: { id: string; displayName: string }[]
  authoring: RegionAuthoringView | null
  list: RegionListItem[]
  detail: RegionDetailView | null
  edit: RegionEditView | null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const EMPTY_TEXT = 'No regions yet. Pick a type below and draw the first region boundary in the viewer.'

export function renderRegionsTabHtml(view: RegionsTabView): string {
  if (view.detail) return renderRegionDetailHtml(view.detail, view.edit)
  if (view.authoring) return renderRegionAuthoringHtml(view.authoring)

  const listHtml =
    view.list.length === 0
      ? `<div class="tab-placeholder">${escapeHtml(EMPTY_TEXT)}</div>`
      : view.list
          .map(
            (item) => `
      <div class="feature-row feature-row-object">
        <span class="feature-row-object-main">
          <button class="feature-pill feature-pill-toggle${item.visible ? '' : ' feature-pill-off'}" data-action="feature-visibility" data-feature-id="${escapeHtml(item.id)}" data-visible="${item.visible ? 'true' : 'false'}" title="${item.visible ? 'Hide region' : 'Show region'}">${escapeHtml(item.subtype)}</button>
          <button class="feature-row-object-copy" data-action="feature-select" data-feature-id="${escapeHtml(item.id)}">
            <span class="feature-name">${escapeHtml(item.name)}</span>
            <span class="feature-sub">${item.borderVertexCount} boundary vertices, ${item.surfacePointCount} point input(s), ${item.breaklineCount} breakline(s)</span>
          </button>
        </span>
        <span class="evidence-badge" title="Region surface inputs and boundary provenance summary">${item.edgeEvidenceCount} edge refs</span>
      </div>`,
          )
          .join('')

  const optionsHtml = view.templates
    .map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.displayName)}</option>`)
    .join('')

  return `
      <div class="feature-list">${listHtml}</div>
      <div class="region-add-row">
        <select id="region-template-select" title="Region type">${optionsHtml}</select>
        <button class="sim-add-button" data-action="region-add">+ Add region</button>
      </div>
  `
}

function renderRegionAuthoringHtml(authoring: RegionAuthoringView): string {
  const evidenceLine = `<div class="authoring-evidence">${authoring.snappedCount} snapped / ${authoring.freeCount} free placed</div>`
  const cancelButton = `<button data-action="region-cancel">Cancel</button>`
  if (authoring.phase === 'border') {
    return `
      <div class="authoring-rail" data-phase="border">
        <div class="authoring-hint">Region (${escapeHtml(authoring.subtype)}): click in the viewer to place the authored boundary edge. ${authoring.activeVertexCount} placed.</div>
        ${evidenceLine}
        <button data-action="region-close-border"${authoring.canCloseBorder ? '' : ' disabled'}>Close boundary</button>
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
        <div class="authoring-hint">Boundary closed (${authoring.borderVertexCount} vertices, ${authoring.breaklineCount} breakline(s)). Add breaklines or finish the region.</div>
        ${evidenceLine}
        <button data-action="region-add-breakline">Add breakline</button>
        <button data-action="region-finish">Finish region</button>
        ${cancelButton}
      </div>
  `
}

function renderVisibilityToggle(featureId: string, key: string, label: string, checked: boolean): string {
  return `<label class="ws-meta-row"><span class="ws-meta-label">${escapeHtml(label)}</span><span class="ws-meta-value"><input type="checkbox" data-action="region-visibility" data-feature-id="${escapeHtml(featureId)}" data-visibility-key="${escapeHtml(key)}"${checked ? ' checked' : ''} /></span></label>`
}

function renderParamControl(featureId: string, param: RegionEditorModel['params'][number]): string {
  const data = `data-action="feature-param" data-feature-id="${escapeHtml(featureId)}" data-param-name="${escapeHtml(param.name)}"`
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

export function renderRegionDetailHtml(detail: RegionDetailView, edit: RegionEditView | null): string {
  const editor = detail.editor
  const visibilityHtml = [
    renderVisibilityToggle(detail.id, 'boundary', 'Boundary', editor.visibility.boundary),
    renderVisibilityToggle(detail.id, 'surface', 'Surface', editor.visibility.surface),
    renderVisibilityToggle(detail.id, 'surfacePoints', 'Surface points', editor.visibility.surfacePoints),
    renderVisibilityToggle(detail.id, 'breaklines', 'Breaklines', editor.visibility.breaklines),
    renderVisibilityToggle(detail.id, 'edgeEvidence', 'Edge evidence', editor.visibility.edgeEvidence),
    renderVisibilityToggle(detail.id, 'interiorEvidence', 'Interior evidence', editor.visibility.interiorEvidence),
    renderVisibilityToggle(detail.id, 'wireframe', 'Surface wireframe', editor.visibility.wireframe),
  ].join('')
  const paramHtml = editor.params.length === 0 ? '<div class="ws-detail">No parameters.</div>' : editor.params.map((param) => renderParamControl(detail.id, param)).join('')
  const regionTypeOptions = editor.templateOptions
    .map(
      (option) =>
        `<option value="${escapeHtml(option.id)}"${option.id === editor.templateId ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
    )
    .join('')
  const activeEditHtml =
    edit?.featureId === detail.id && edit.kind === 'surface-point'
      ? `
      <div class="authoring-rail" data-phase="surface-point">
        <div class="authoring-hint">Surface point: click inside the region to add one interior point.</div>
        <button data-action="region-edit-cancel">Cancel</button>
      </div>`
      : edit?.featureId === detail.id && edit.kind === 'breakline'
        ? `
      <div class="authoring-rail" data-phase="breakline">
        <div class="authoring-hint">Breakline: click in the viewer to place vertices over the region. ${edit.activeVertexCount} placed.</div>
        <button data-action="region-edit-finish-breakline"${edit.canFinish ? '' : ' disabled'}>Finish breakline</button>
        <button data-action="region-edit-cancel">Cancel</button>
      </div>`
        : edit?.featureId === detail.id && edit.kind === 'boundary'
          ? `
      <div class="authoring-rail" data-phase="boundary-redraw">
        <div class="authoring-hint">Boundary / edge redraw: click in the viewer to place the new authored region edge. ${edit.activeVertexCount} placed.</div>
        <button data-action="region-edit-finish-boundary"${edit.canFinish ? '' : ' disabled'}>Close new boundary</button>
        <button data-action="region-edit-cancel">Cancel</button>
      </div>`
        : `
      <div class="ws-detail">Boundary vertices are the authored region edge. Surface points, generated grid samples, and breaklines are surface inputs for the Region SIM surface.</div>
      <div class="region-add-row">
        <button data-action="region-show-focus" data-feature-id="${escapeHtml(detail.id)}"${editor.focused ? ' disabled' : ''}>Show Region</button>
        <button data-action="region-show-all"${editor.focused ? '' : ' disabled'}>Show All</button>
        <button data-action="region-redraw-boundary" data-feature-id="${escapeHtml(detail.id)}">Redraw boundary</button>
      </div>
      <div class="region-add-row">
        <button data-action="region-add-surface-point" data-feature-id="${escapeHtml(detail.id)}">+ Add surface point</button>
        <button data-action="region-add-breakline-detail" data-feature-id="${escapeHtml(detail.id)}">+ Add breakline</button>
      </div>
      <div class="region-add-row">
        <input id="region-grid-spacing" type="number" min="0.1" step="0.1" value="${escapeHtml(editor.gridSpacing)}" />
        <button data-action="region-add-grid" data-feature-id="${escapeHtml(detail.id)}">${escapeHtml(editor.gridActionLabel)}</button>
        <button data-action="region-generate-surface" data-feature-id="${escapeHtml(detail.id)}">${editor.generatedAt ? 'Update surface' : 'Generate surface'}</button>
      </div>
      <div class="ws-detail">${escapeHtml(editor.gridBehaviorNote)}</div>
      <div class="ws-detail">Breakline vertices are included in the generated surface inputs and breaklines render clearly above the surface, but breaklines are not yet hard constrained TIN edges.</div>`

  return `
      <div class="feature-detail">
        <button data-action="feature-back">&lt; Back</button>
        <div class="ws-title">
          <input class="feature-rename" data-action="feature-rename" data-feature-id="${escapeHtml(detail.id)}" value="${escapeHtml(detail.name)}" title="Rename region" />
          <span class="authorship-badge authorship-${escapeHtml(detail.authorship)}">${escapeHtml(detail.authorship)}</span>
        </div>
        <div class="ws-meta">
          <div class="ws-meta-row"><span class="ws-meta-label">Family</span><span class="ws-meta-value">${escapeHtml(detail.family)}</span></div>
          <div class="ws-meta-row"><span class="ws-meta-label">Area</span><span class="ws-meta-value">${escapeHtml(editor.areaLabel)}</span></div>
          <div class="ws-meta-row"><span class="ws-meta-label">Visible</span><span class="ws-meta-value">${editor.visible ? 'yes' : 'no'}</span></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">Region Type</div>
          <label class="ws-meta-row"><span class="ws-meta-label">Material / use</span><span class="ws-meta-value"><select data-action="feature-region-type" data-feature-id="${escapeHtml(detail.id)}">${regionTypeOptions}</select></span></label>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">Boundary / Edge</div>
          <div class="ws-meta-row"><span class="ws-meta-label">Boundary vertices</span><span class="ws-meta-value">${editor.boundaryVertexCount}</span></div>
          <div class="ws-detail">The Region boundary is the authored region edge and the default focus / isolate boundary.</div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">Surface Inputs</div>
          ${activeEditHtml}
          <div class="ws-meta-row"><span class="ws-meta-label">Surface points</span><span class="ws-meta-value">${editor.manualSurfacePointCount}</span></div>
          <div class="ws-meta-row"><span class="ws-meta-label">Grid samples</span><span class="ws-meta-value">${editor.gridSurfacePointCount}</span></div>
          <div class="ws-meta-row"><span class="ws-meta-label">Breaklines</span><span class="ws-meta-value">${editor.breaklineCount}</span></div>
          <div class="ws-meta-row"><span class="ws-meta-label">Breakline vertices</span><span class="ws-meta-value">${editor.breaklineVertexCount}</span></div>
          <div class="ws-meta-row"><span class="ws-meta-label">Surface input total</span><span class="ws-meta-value">${editor.surfaceInputCount}</span></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">Display</div>
          ${visibilityHtml}
        </div>
        <div class="ws-section">
          <div class="ws-section-title">Generated Surface</div>
          <div class="ws-meta-row"><span class="ws-meta-label">Triangles</span><span class="ws-meta-value">${editor.triangleCount}</span></div>
          <div class="ws-meta-row"><span class="ws-meta-label">Min elevation</span><span class="ws-meta-value">${escapeHtml(editor.minElevationLabel)}</span></div>
          <div class="ws-meta-row"><span class="ws-meta-label">Max elevation</span><span class="ws-meta-value">${escapeHtml(editor.maxElevationLabel)}</span></div>
          <div class="ws-meta-row"><span class="ws-meta-label">Average elevation</span><span class="ws-meta-value">${escapeHtml(editor.averageElevationLabel)}</span></div>
          <div class="ws-meta-row"><span class="ws-meta-label">Elevation range</span><span class="ws-meta-value">${escapeHtml(editor.elevationRangeLabel)}</span></div>
          <div class="ws-meta-row"><span class="ws-meta-label">Generated</span><span class="ws-meta-value">${escapeHtml(editor.generatedAt ?? 'not yet')}</span></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">Source / Provenance</div>
          ${editor.sourceSummary.length === 0 ? '<div class="ws-detail">No source / provenance captured yet beyond the boundary edge.</div>' : editor.sourceSummary.map((entry) => `<div class="ws-detail">${escapeHtml(entry.label)}: ${entry.count}</div>`).join('')}
          <div class="ws-detail">Boundary edge provenance refs: ${editor.edgeEvidenceCount}</div>
          ${editor.interiorEvidenceCount > 0 ? `<div class="ws-detail">Supplemental interior provenance refs: ${editor.interiorEvidenceCount}</div>` : ''}
        </div>
        <div class="ws-section">
          <div class="ws-section-title">Parameters</div>
          ${paramHtml}
        </div>
        <button class="feature-delete" data-action="feature-delete" data-feature-id="${escapeHtml(detail.id)}">Delete feature</button>
      </div>
  `
}