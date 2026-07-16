// src/ui/utilitiesPanel.ts - pure HTML renderers for the Utilities tab list +
// authoring rail (beta Generic + Storm). The feature DETAIL view is rendered
// by rightPanel.ts through the shared renderFeatureDetailHtml, so this module
// stays one-directional: rightPanel imports it, never the reverse. Node-
// testable like the other pure renderers.

import { getTemplate } from '../shared/template-catalog'
import { utilityClassLabel, utilitySystemLabel, utilityTemplateGeometry } from '../shared/utility-catalog'
import type { SimpleAuthoringView } from './features'
import { escapeHtml } from './model'
import type { UtilityAddModel, UtilityListItem } from './utilityModel'

export interface UtilitiesTabView {
  authoring: SimpleAuthoringView | null
  list: UtilityListItem[]
  add: UtilityAddModel
}

const UTILITIES_PLACEHOLDER = 'No utilities yet. Pick a system and type below, then place it in the viewer.'

function authoringLabel(templateId: string): string {
  const template = getTemplate(templateId)
  if (!template) return 'Utility'
  return `${utilitySystemLabel(template.utilitySystem)} / ${utilityClassLabel(template.utilityClass)}`
}

/** In-flight utility tool rail: point pins save on click; runs review then finish. */
export function renderUtilityAuthoringHtml(authoring: SimpleAuthoringView): string {
  const label = authoringLabel(authoring.templateId)
  const evidenceLine = `<div class="authoring-evidence">${authoring.snappedCount} snapped / ${authoring.freeCount} free placed</div>`
  const cancelButton = `<button data-action="region-cancel">Cancel</button>`
  if (authoring.phase === 'placing') {
    if (authoring.geometry === 'polyline') {
      const template = getTemplate(authoring.templateId)
      const stub = template?.utilityClass === 'stub'
      const hint = stub
        ? `Stub (${escapeHtml(label)}): place the known start, then the assumed end. ${authoring.activeVertexCount} placed.`
        : `Run (${escapeHtml(label)}): click in the viewer to place alignment points (2 minimum). ${authoring.activeVertexCount} placed.`
      return `
      <div class="authoring-rail" data-phase="placing">
        <div class="authoring-hint">${hint}</div>
        ${evidenceLine}
        <button data-action="simple-review"${authoring.canReview ? '' : ' disabled'}>Review run</button>
        ${cancelButton}
      </div>
    `
    }
    return `
      <div class="authoring-rail" data-phase="placing">
        <div class="authoring-hint">${escapeHtml(label)}: click in the viewer to place the pin. Placement saves immediately.</div>
        ${evidenceLine}
        ${cancelButton}
      </div>
    `
  }
  return `
      <div class="authoring-rail" data-phase="review">
        <div class="authoring-hint">${escapeHtml(label)} run ready (${authoring.vertexCount} points). Finish to store params and evidence.</div>
        ${evidenceLine}
        <button data-action="simple-finish">Finish utility</button>
        ${cancelButton}
      </div>
  `
}

function renderUtilityRowHtml(item: UtilityListItem): string {
  const evidence = `${item.snappedEvidenceCount} snapped / ${item.freeEvidenceCount} free`
  return `
      <div class="feature-row feature-row-object">
        <span class="feature-row-object-main">
          <button class="feature-pill feature-pill-toggle${item.visible ? '' : ' feature-pill-off'}" data-action="feature-visibility" data-feature-id="${escapeHtml(item.id)}" data-visible="${item.visible ? 'true' : 'false'}" title="${item.visible ? 'Hide utility' : 'Show utility'}">${escapeHtml(item.systemLabel)} / ${escapeHtml(item.classLabel)}</button>
          <button class="feature-row-object-copy" data-action="feature-select" data-feature-id="${escapeHtml(item.id)}">
            <span class="feature-name">${escapeHtml(item.name)}</span>
            <span class="feature-sub">${escapeHtml(item.summary)} · ${evidence}</span>
          </button>
        </span>
      </div>`
}

export function renderUtilitiesTabHtml(view: UtilitiesTabView): string {
  if (view.authoring && view.authoring.family === 'utility') return renderUtilityAuthoringHtml(view.authoring)

  const systemsHtml = view.add.systems
    .map(
      (system) =>
        `<option value="${escapeHtml(system.id)}"${system.id === view.add.selectedSystemId ? ' selected' : ''}>${escapeHtml(system.label)}</option>`,
    )
    .join('')
  const classesHtml = view.add.classes
    .map((entry) => {
      const template = getTemplate(entry.templateId)
      const runTag = template && utilityTemplateGeometry(template) === 'line' ? ' (run)' : ''
      return `<option value="${escapeHtml(entry.templateId)}">${escapeHtml(entry.label)}${runTag}</option>`
    })
    .join('')
  const listHtml =
    view.list.length === 0
      ? `<div class="tab-placeholder">${escapeHtml(UTILITIES_PLACEHOLDER)}</div>`
      : view.list.map((item) => renderUtilityRowHtml(item)).join('')

  return `
      <div class="object-tab-topstrip">
        <span class="object-tab-total">Utility total: ${view.list.length}</span>
      </div>
      <div class="feature-list">${listHtml}</div>
      <div class="region-add-row">
        <select id="utility-system-select" data-action="utility-add-system" title="Utility system/group">${systemsHtml}</select>
        <select id="utility-class-select" title="Utility type">${classesHtml}</select>
        <button class="sim-add-button" data-action="utility-add">+ Add utility</button>
      </div>
  `
}
