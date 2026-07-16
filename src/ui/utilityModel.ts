// src/ui/utilityModel.ts - pure view-model builders for the Utilities tab
// (beta Generic + Storm). Same rules as model.ts: no DOM, no three.js, plain
// node so tests run without a browser. Utility rows/details deliberately
// mirror the object tab models; the utility-specific parts are the system x
// class identity, the point-vs-line geometry split, and the run summary.

import {
  getTemplate,
  templatesForFamily,
  type FeatureTemplate,
} from '../shared/template-catalog'
import {
  utilityClassLabel,
  utilitySystemLabel,
  utilitySystems,
  utilityTemplateGeometry,
  type UtilityGeometryKind,
  type UtilitySystemId,
} from '../shared/utility-catalog'
import type { ProjectManifest } from '../shared/workbench-types'
import { isolateBoundaryFromFeature } from '../viewer/generators'
import { utilityLineGeometryFromFeature, utilityPointGeometryFromFeature } from '../viewer/utilityGenerators'
import { EVIDENCE_DETAIL_ROWS, EVIDENCE_KIND_LABEL } from './model'

type FeatureLike = ProjectManifest['features'][number]

export interface UtilityListItem {
  id: string
  name: string
  systemLabel: string
  classLabel: string
  subtype: string
  summary: string
  visible: boolean
  snappedEvidenceCount: number
  freeEvidenceCount: number
}

function evidenceSplit(feature: FeatureLike): { snapped: number; free: number } {
  const evidence = feature.evidenceRefs ?? []
  const snapped = evidence.filter((ref) => ref.kind !== 'picked-coordinate' && ref.kind !== 'manual-note').length
  return { snapped, free: evidence.length - snapped }
}

function formatMeasure(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '')
}

function numberParam(feature: FeatureLike, name: string, fallback: number): number {
  const value = feature.parameters?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringParam(feature: FeatureLike, name: string, fallback: string): string {
  const value = feature.parameters?.[name]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function runLengthXY(feature: FeatureLike): number {
  const geometry = utilityLineGeometryFromFeature(feature)
  if (!geometry) return 0
  let total = 0
  for (let i = 1; i < geometry.vertices.length; i++) {
    const a = geometry.vertices[i - 1]!
    const b = geometry.vertices[i]!
    total += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return total
}

/** Field-friendly one-liner per class, e.g. `15" RCP - 3 pts - 142.6 lf`. */
export function utilitySummary(feature: FeatureLike): string {
  const template = feature.templateId ? getTemplate(feature.templateId) : null
  const evidence = evidenceSplit(feature)
  const evidenceState = evidence.snapped > 0 ? 'snapped evidence' : evidence.free > 0 ? 'manual placement' : 'no evidence'
  if (!template?.utilityClass) return evidenceState
  if (utilityTemplateGeometry(template) === 'line') {
    const size = numberParam(feature, 'pipeSize', 0)
    const shape = stringParam(feature, 'pipeShape', 'round')
    const material = stringParam(feature, 'material', 'unknown')
    const sizeLabel = shape === 'box'
      ? `${formatMeasure(numberParam(feature, 'boxSpan', 0))}x${formatMeasure(numberParam(feature, 'boxRise', 0))} box`
      : `${formatMeasure(size)}" ${material}`
    const vertexCount = utilityLineGeometryFromFeature(feature)?.vertices.length ?? 0
    const run = `${vertexCount} pts - ${formatMeasure(Math.round(runLengthXY(feature) * 10) / 10)} lf`
    const assumed = template.utilityClass === 'stub' ? ' - assumed end' : ''
    return `${sizeLabel} - ${run}${assumed}`
  }
  switch (template.utilityClass) {
    case 'manhole':
      return `dia ${formatMeasure(numberParam(feature, 'diameter', 0))} x ${formatMeasure(numberParam(feature, 'depth', 0))} deep - ${evidenceState}`
    case 'lid':
      return `dia ${formatMeasure(numberParam(feature, 'diameter', 0))} - ${evidenceState}`
    case 'pole':
      return `${formatMeasure(numberParam(feature, 'height', 0))}h - ${evidenceState}`
    case 'inlet':
      return `${stringParam(feature, 'inletType', 'grate')} - ${formatMeasure(numberParam(feature, 'depth', 0))} deep - ${evidenceState}`
    default: {
      const vertical = template.utilityOrigin === 'top'
        ? `${formatMeasure(numberParam(feature, 'depth', 0))} deep`
        : `${formatMeasure(numberParam(feature, 'height', 0))}h`
      return `${formatMeasure(numberParam(feature, 'width', 0))}w x ${formatMeasure(numberParam(feature, 'length', 0))}l x ${vertical} - ${evidenceState}`
    }
  }
}

export function buildUtilityListModel(manifest: ProjectManifest | null): UtilityListItem[] {
  return (manifest?.features ?? [])
    .filter((feature) => feature.family === 'utility')
    .map((feature) => {
      const evidence = evidenceSplit(feature)
      const template = feature.templateId ? getTemplate(feature.templateId) : null
      return {
        id: feature.id,
        name: feature.name,
        systemLabel: utilitySystemLabel(template?.utilitySystem),
        classLabel: template?.utilityClass ? utilityClassLabel(template.utilityClass) : feature.subtype ?? 'Utility',
        subtype: feature.subtype ?? 'utility',
        summary: utilitySummary(feature),
        visible: feature.display?.visible !== false,
        snappedEvidenceCount: evidence.snapped,
        freeEvidenceCount: evidence.free,
      }
    })
}

// ---------------------------------------------------------------------------
// Add-utility picker (system select filters the class select)
// ---------------------------------------------------------------------------

export interface UtilityAddModel {
  systems: { id: UtilitySystemId; label: string }[]
  selectedSystemId: UtilitySystemId
  classes: { templateId: string; label: string }[]
}

export function buildUtilityAddModel(selectedSystemId: UtilitySystemId): UtilityAddModel {
  return {
    systems: utilitySystems(),
    selectedSystemId,
    classes: templatesForFamily('utility')
      .filter((template) => template.utilitySystem === selectedSystemId)
      .map((template) => ({ templateId: template.id, label: template.displayName })),
  }
}

// ---------------------------------------------------------------------------
// Detail editor model (parallel to model.ts objectEditor)
// ---------------------------------------------------------------------------

export interface UtilityEditorModel {
  systemLabel: string
  classLabel: string
  typeTemplateId: string
  /** Re-typing keeps geometry honest: only same-geometry system/class combos. */
  typeOptions: { templateId: string; label: string }[]
  geometryKind: UtilityGeometryKind
  /** Point classes only. */
  placement: { x: string; y: string; z: string } | null
  /** Line classes only. */
  vertexCount: number | null
  lengthLabel: string | null
  originLabel: string
  summary: string
  previewKind: string
  isolateVertexCount: number | null
  evidenceItems: { index: number; kindLabel: string; coordLabel: string }[]
  evidenceOverflow: number
}

function originLabel(template: FeatureTemplate): string {
  if (utilityTemplateGeometry(template) === 'line') {
    return template.utilityClass === 'culvert' ? 'Pin: flowline ends (as placed)' : 'Pin: alignment points (as placed)'
  }
  return template.utilityOrigin === 'top' ? 'Pin: center top (below-ground)' : 'Pin: center bottom (above-ground)'
}

export function buildUtilityEditorModel(feature: FeatureLike): UtilityEditorModel | null {
  if (feature.family !== 'utility' || !feature.templateId) return null
  const template = getTemplate(feature.templateId)
  if (!template?.utilityClass || !template.utilitySystem) return null
  const geometryKind = utilityTemplateGeometry(template) ?? 'point'
  const point = utilityPointGeometryFromFeature(feature)
  const line = utilityLineGeometryFromFeature(feature)
  const isolate = isolateBoundaryFromFeature(feature)
  return {
    systemLabel: utilitySystemLabel(template.utilitySystem),
    classLabel: utilityClassLabel(template.utilityClass),
    typeTemplateId: template.id,
    typeOptions: templatesForFamily('utility')
      .filter((candidate) => utilityTemplateGeometry(candidate) === geometryKind)
      .map((candidate) => ({
        templateId: candidate.id,
        label: `${utilitySystemLabel(candidate.utilitySystem)} / ${candidate.displayName}`,
      })),
    geometryKind,
    placement: point
      ? { x: String(point.point[0]), y: String(point.point[1]), z: String(point.point[2]) }
      : null,
    vertexCount: line ? line.vertices.length : null,
    lengthLabel: line ? `${formatMeasure(Math.round(runLengthXY(feature) * 10) / 10)} lf (plan)` : null,
    originLabel: originLabel(template),
    summary: utilitySummary(feature),
    previewKind: template.utilityClass,
    isolateVertexCount: isolate ? isolate.length : null,
    evidenceItems: (feature.evidenceRefs ?? []).slice(0, EVIDENCE_DETAIL_ROWS).map((ref, index) => ({
      index,
      kindLabel: EVIDENCE_KIND_LABEL[ref.kind] ?? ref.kind,
      coordLabel: ref.coordinate.map((axis) => axis.toFixed(1)).join(', '),
    })),
    evidenceOverflow: Math.max((feature.evidenceRefs ?? []).length - EVIDENCE_DETAIL_ROWS, 0),
  }
}
