// src/ui/buildingsPanel.ts - pure HTML renderers for the Buildings tab list
// rows and the building detail sections (envelope, evidence-fitted faces /
// roof planes, face-hosted features). The shared feature detail shell stays
// in rightPanel.ts (renderFeatureDetailHtml) and injects these sections, so
// this module stays one-directional: rightPanel imports it, never the
// reverse. Node-testable like the other pure renderers.

import type { BuildingListItem } from './model'
import type { BuildingEditorModel, BuildingFaceFeatureRow, BuildingFaceRow } from './buildingModel'
import { escapeHtml } from './model'

const BUILDINGS_PLACEHOLDER =
  'No buildings yet. Add a building, draw its envelope in the viewer, then fit faces from selected evidence.'

export function renderBuildingRowHtml(item: BuildingListItem): string {
  const evidence = `${item.snappedEvidenceCount} snapped / ${item.freeEvidenceCount} free`
  const typeLabel = item.typeLabel ?? `${item.subtype} roof`
  const summary = item.summary ?? `${item.subtype} - ${item.footprintVertexCount} footprint vertices`
  const visible = item.visible !== false
  return `
      <div class="feature-row feature-row-object">
        <span class="feature-row-object-main">
          <button class="feature-pill feature-pill-toggle${visible ? '' : ' feature-pill-off'}" data-action="feature-visibility" data-feature-id="${escapeHtml(item.id)}" data-visible="${visible ? 'true' : 'false'}" title="${visible ? 'Hide building' : 'Show building'}">${escapeHtml(typeLabel)}</button>
          <button class="feature-row-object-copy" data-action="feature-select" data-feature-id="${escapeHtml(item.id)}">
            <span class="feature-name">${escapeHtml(item.name)}</span>
            <span class="feature-sub">${escapeHtml(summary)} · ${evidence}</span>
          </button>
        </span>
      </div>`
}

/** Buildings tab list + add row (same select/action ids the shell always used). */
export function renderBuildingsListHtml(
  list: BuildingListItem[],
  templates: { id: string; displayName: string }[],
): string {
  const listHtml =
    list.length === 0
      ? `<div class="tab-placeholder">${escapeHtml(BUILDINGS_PLACEHOLDER)}</div>`
      : list.map((item) => renderBuildingRowHtml(item)).join('')
  const optionsHtml = templates
    .map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.displayName)}</option>`)
    .join('')
  return `
      <div class="object-tab-topstrip">
        <span class="object-tab-total">Building total: ${list.length}</span>
      </div>
      <div class="feature-list">${listHtml}</div>
      <div class="region-add-row">
        <select id="building-template-select" title="Building type (from the template catalog)">${optionsHtml}</select>
        <button class="sim-add-button" data-action="building-add">+ Add building</button>
      </div>
  `
}

function renderFaceRowHtml(detailId: string, face: BuildingFaceRow): string {
  const id = escapeHtml(detailId)
  const faceId = escapeHtml(face.id)
  return `
      <div class="feature-row feature-row-object building-face-row">
        <span class="feature-row-object-main">
          <button class="feature-pill feature-pill-toggle${face.visible ? '' : ' feature-pill-off'}" data-action="building-face-visibility" data-feature-id="${id}" data-face-id="${faceId}" data-visible="${face.visible ? 'true' : 'false'}" title="${face.visible ? 'Hide face' : 'Show face'}">${escapeHtml(face.kindLabel)}</button>
          <span class="feature-row-object-copy">
            <input class="feature-rename" data-action="building-face-rename" data-feature-id="${id}" data-face-id="${faceId}" value="${escapeHtml(face.name)}" title="Rename face" />
            <span class="feature-sub">${escapeHtml(face.dimsLabel)}</span>
            <span class="feature-sub">${escapeHtml(face.planeLabel)} · ${escapeHtml(face.evidenceLabel)}</span>
          </span>
        </span>
        <button class="evidence-remove" data-action="building-face-remove" data-feature-id="${id}" data-face-id="${faceId}" title="Delete this face and its hosted features">&times;</button>
      </div>`
}

function renderFaceFitHtml(detailId: string, editor: BuildingEditorModel): string {
  const id = escapeHtml(detailId)
  if (editor.fit) {
    const fit = editor.fit
    const slopeHtml = fit.slopeLabel ? `<div class="ws-detail">${escapeHtml(fit.slopeLabel)}</div>` : ''
    const noteHtml = fit.orientationNote ? `<div class="ws-detail warn-text">${escapeHtml(fit.orientationNote)}</div>` : ''
    return `
        <div class="authoring-rail" data-phase="face-fit">
          <div class="authoring-hint">${escapeHtml(fit.kindLabel)} fitted to ${fit.pointCount} evidence points (preview in viewer).</div>
          <div class="ws-detail">${escapeHtml(fit.lengthLabel)} x ${escapeHtml(fit.heightLabel)}</div>
          <div class="ws-detail">${escapeHtml(fit.areaLabel)} · ${escapeHtml(fit.rmsLabel)}</div>
          ${slopeHtml}
          ${noteHtml}
          <button data-action="building-face-accept">Accept ${escapeHtml(fit.kindLabel.toLowerCase())}</button>
          <button data-action="building-face-cancel">Cancel</button>
        </div>`
  }
  const hint = editor.canFit
    ? `Fit a plane to the ${editor.evidenceCount} selected evidence points.`
    : `Select 3+ evidence points first (${editor.evidenceCount} selected) - use the Evidence section below.`
  const disabled = editor.canFit ? '' : ' disabled'
  const noteHtml = editor.fitNote ? `<div class="ws-detail warn-text">${escapeHtml(editor.fitNote)}</div>` : ''
  return `
        <div class="ws-detail">${escapeHtml(hint)}</div>
        ${noteHtml}
        <button data-action="building-face-fit" data-feature-id="${id}" data-face-kind="wall"${disabled}>+ Add wall face from evidence</button>
        <button data-action="building-face-fit" data-feature-id="${id}" data-face-kind="roof"${disabled}>+ Add roof plane from evidence</button>`
}

function renderFeatureRowHtml(detailId: string, item: BuildingFaceFeatureRow): string {
  const id = escapeHtml(detailId)
  const componentId = escapeHtml(item.id)
  const typeOptions = item.typeOptions
    .map(
      (option) =>
        `<option value="${escapeHtml(option.id)}"${option.id === item.type ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
    )
    .join('')
  const paramsHtml = item.params
    .map(
      (param) => `
          <label class="ws-meta-row"><span class="ws-meta-label">${escapeHtml(param.label)}</span><span class="ws-meta-value"><input type="number" value="${escapeHtml(param.value)}" data-action="building-feature-param" data-feature-id="${id}" data-component-id="${componentId}" data-param-name="${escapeHtml(param.name)}" /></span></label>`,
    )
    .join('')
  return `
      <div class="building-feature-row">
        <div class="feature-row feature-row-object">
          <span class="feature-row-object-main">
            <button class="feature-pill feature-pill-toggle${item.visible ? '' : ' feature-pill-off'}" data-action="building-feature-visibility" data-feature-id="${id}" data-component-id="${componentId}" data-visible="${item.visible ? 'true' : 'false'}" title="${item.visible ? 'Hide feature' : 'Show feature'}">${escapeHtml(item.typeLabel)}</button>
            <span class="feature-row-object-copy">
              <span class="feature-name">${escapeHtml(item.name)}</span>
              <span class="feature-sub">on ${escapeHtml(item.hostFaceName)} · ${escapeHtml(item.dimsLabel)}</span>
            </span>
          </span>
          <button class="evidence-remove" data-action="building-feature-remove" data-feature-id="${id}" data-component-id="${componentId}" title="Delete this feature">&times;</button>
        </div>
        <label class="ws-meta-row"><span class="ws-meta-label">Type</span><span class="ws-meta-value"><select data-action="building-feature-type" data-feature-id="${id}" data-component-id="${componentId}">${typeOptions}</select></span></label>
        ${paramsHtml}
      </div>`
}

/**
 * The building-specific detail sections: Envelope, Faces / Roof Planes (with
 * the fit rail), and Face Features. Injected by renderFeatureDetailHtml; the
 * shared isolate/evidence/parameters sections stay in the shell.
 */
export function renderBuildingSectionsHtml(detailId: string, editor: BuildingEditorModel): string {
  const id = escapeHtml(detailId)
  const facesHtml =
    editor.faces.length === 0
      ? '<div class="ws-detail">No faces yet. Select evidence points on a wall or roof, then fit a face below.</div>'
      : editor.faces.map((face) => renderFaceRowHtml(detailId, face)).join('')
  const faceOptionsHtml = editor.faceOptions
    .map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`)
    .join('')
  const featureTypeOptionsHtml = editor.featureTypeOptions
    .map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`)
    .join('')
  const featuresHtml =
    editor.features.length === 0
      ? '<div class="ws-detail">No hosted features yet.</div>'
      : editor.features.map((item) => renderFeatureRowHtml(detailId, item)).join('')
  const addFeatureHtml =
    editor.faceOptions.length === 0
      ? '<div class="ws-detail">Add a face first - features attach to a face.</div>'
      : `
        <div class="region-add-row">
          <select id="building-feature-face-select" title="Host face">${faceOptionsHtml}</select>
          <select id="building-feature-type-select" title="Feature type">${featureTypeOptionsHtml}</select>
          <button class="sim-add-button" data-action="building-feature-add" data-feature-id="${id}">+ Add feature</button>
        </div>`
  return `
      <div class="ws-section">
        <div class="ws-section-title">Envelope</div>
        <div class="ws-detail">${editor.envelopeVertexCount} boundary vertices - ${escapeHtml(editor.envelopeAreaLabel)}</div>
        <div class="ws-detail">The envelope is this building's built-in isolate/focus boundary. A custom boundary drawn below only overrides it - isolation never goes away.</div>
      </div>
      <div class="ws-section">
        <div class="ws-section-title">Faces / Roof Planes</div>
        ${facesHtml}
        ${renderFaceFitHtml(detailId, editor)}
      </div>
      <div class="ws-section">
        <div class="ws-section-title">Face Features</div>
        ${featuresHtml}
        ${addFeatureHtml}
      </div>
  `
}
