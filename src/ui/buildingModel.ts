// src/ui/buildingModel.ts - pure view-model builders for the Buildings tab
// (beta envelope-first buildings). Same rules as model.ts / utilityModel.ts:
// no DOM, no three.js, plain node so tests run without a browser. Formats the
// component records (faces, roof planes, hosted features) and the pending
// plane fit into panel-ready rows and labels.

import {
  faceFeatureTypeLabel,
  faceKindLabel,
  BUILDING_FACE_FEATURE_TYPES,
  type BuildingFaceFeatureType,
} from '../shared/building-catalog'
import type { ProjectManifest } from '../shared/workbench-types'
import {
  buildingComponentsFromFeature,
  buildingEnvelopeFromFeature,
  faceCorners,
  focusBoundaryFromFeature,
  isEnvelopeBuilding,
  roofSlopeInfo,
} from '../viewer/buildingGenerators'
import { isolateBoundaryFromFeature, signedAreaXY } from '../viewer/generators'
import type { BuildingFaceFitView } from './buildingController'
import { buildBuildingListModel, EVIDENCE_DETAIL_ROWS, EVIDENCE_KIND_LABEL, type BuildingListItem } from './model'

type FeatureLike = ProjectManifest['features'][number]

function formatMeasure(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

// ---------------------------------------------------------------------------
// List row summary (the buildings tab list)
// ---------------------------------------------------------------------------

/** Field-friendly one-liner: envelope buildings count components, legacy shows roof. */
export function buildingSummary(feature: FeatureLike): string {
  if (!isEnvelopeBuilding(feature)) {
    const geometry = feature.geometry as { footprint?: unknown[] }
    const count = Array.isArray(geometry.footprint) ? geometry.footprint.length : 0
    return `${feature.subtype ?? 'flat'} roof - ${count} footprint vertices`
  }
  const envelope = buildingEnvelopeFromFeature(feature)
  const components = buildingComponentsFromFeature(feature)
  const walls = components.faces.filter((face) => face.kind === 'wall').length
  const roofs = components.faces.filter((face) => face.kind === 'roof').length
  const other = components.faces.length - walls - roofs
  const parts = [
    `${envelope?.length ?? 0}-pt envelope`,
    `${walls} wall${walls === 1 ? '' : 's'}`,
    `${roofs} roof plane${roofs === 1 ? '' : 's'}`,
  ]
  if (other > 0) parts.push(`${other} other face${other === 1 ? '' : 's'}`)
  if (components.faceFeatures.length > 0) parts.push(`${components.faceFeatures.length} feature${components.faceFeatures.length === 1 ? '' : 's'}`)
  return parts.join(', ')
}

/** Buildings-tab rows: the base list model enriched with pill label + summary. */
export function buildBuildingRowsModel(manifest: ProjectManifest | null): BuildingListItem[] {
  const features = manifest?.features ?? []
  return buildBuildingListModel(manifest).map((item) => {
    const feature = features.find((candidate) => candidate.id === item.id)
    return {
      ...item,
      typeLabel: item.subtype === 'envelope' ? 'Envelope' : `${item.subtype} roof`,
      summary: feature ? buildingSummary(feature) : item.subtype,
      visible: feature?.display?.visible !== false,
    }
  })
}

// ---------------------------------------------------------------------------
// Detail editor model
// ---------------------------------------------------------------------------

export interface BuildingFaceRow {
  id: string
  name: string
  kind: string
  kindLabel: string
  /** `24.5 x 9.2 - 225 sf` style fitted-rectangle dims. */
  dimsLabel: string
  /** Roof planes: `slope 26.6 deg, downhill SW`; walls/others: elevation range. */
  planeLabel: string
  evidenceLabel: string
  visible: boolean
}

export interface BuildingFaceFeatureRow {
  id: string
  name: string
  type: string
  typeLabel: string
  typeOptions: { id: string; label: string }[]
  hostFaceId: string
  hostFaceName: string
  dimsLabel: string
  params: { name: string; label: string; value: string }[]
  visible: boolean
}

export interface BuildingFaceFitModel {
  kindLabel: string
  pointCount: number
  lengthLabel: string
  heightLabel: string
  areaLabel: string
  rmsLabel: string
  slopeLabel: string | null
  /** Set when the plane orientation disagrees with the chosen kind. */
  orientationNote: string | null
}

export interface BuildingEditorModel {
  envelopeVertexCount: number
  envelopeAreaLabel: string
  summary: string
  evidenceCount: number
  /** Fitting needs 3+ points; the panel disables the fit buttons below that. */
  canFit: boolean
  faces: BuildingFaceRow[]
  features: BuildingFaceFeatureRow[]
  /** Add-feature picker sources (any face can host in beta). */
  faceOptions: { id: string; label: string }[]
  featureTypeOptions: { id: string; label: string }[]
  fit: BuildingFaceFitModel | null
  fitNote: string | null
  /** Shared refinement-section inputs (same shape objects/utilities use). */
  isolateVertexCount: number | null
  /** True when a user-drawn boundary overrides the envelope default. */
  isolateOverride: boolean
  evidenceItems: { index: number; kindLabel: string; coordLabel: string }[]
  evidenceOverflow: number
}

function faceZRange(corners: [number, number, number][]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const [, , z] of corners) {
    min = Math.min(min, z)
    max = Math.max(max, z)
  }
  return { min, max }
}

function slopeLabelFor(normal: [number, number, number]): string {
  const info = roofSlopeInfo(normal)
  if (info.aspectLabel === null) return 'flat (slope 0 deg)'
  return `slope ${round1(info.slopeDeg)} deg, downhill ${info.aspectLabel}`
}

function featureTypeOptions(): { id: string; label: string }[] {
  return BUILDING_FACE_FEATURE_TYPES.map((type) => ({ id: type, label: faceFeatureTypeLabel(type) }))
}

export function buildBuildingEditorModel(
  feature: FeatureLike,
  faceFit: BuildingFaceFitView | null = null,
  fitNote: string | null = null,
): BuildingEditorModel | null {
  if (!isEnvelopeBuilding(feature)) return null
  const envelope = buildingEnvelopeFromFeature(feature)
  const components = buildingComponentsFromFeature(feature)
  const evidence = feature.evidenceRefs ?? []
  // Buildings always resolve a boundary (user override, else the envelope).
  const isolate = focusBoundaryFromFeature(feature)

  const faces: BuildingFaceRow[] = components.faces.map((face) => {
    const length = face.extents.maxU - face.extents.minU
    const height = face.extents.maxV - face.extents.minV
    const corners = faceCorners(face.plane, face.extents)
    const zRange = faceZRange(corners)
    const planeLabel =
      face.kind === 'roof'
        ? `${slopeLabelFor(face.plane.normal)} - Z ${round1(zRange.min)} to ${round1(zRange.max)}`
        : `Z ${round1(zRange.min)} to ${round1(zRange.max)}`
    return {
      id: face.id,
      name: face.name,
      kind: face.kind,
      kindLabel: faceKindLabel(face.kind),
      dimsLabel: `${formatMeasure(round1(length))} x ${formatMeasure(round1(height))} - ${formatMeasure(Math.round(length * height))} sf`,
      planeLabel,
      evidenceLabel: `${face.evidence.count} pts, fit rms ${face.fitRms.toFixed(2)}`,
      visible: face.visible !== false,
    }
  })

  const faceNames = new Map(components.faces.map((face) => [face.id, face.name]))
  const features: BuildingFaceFeatureRow[] = components.faceFeatures.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    typeLabel: faceFeatureTypeLabel(item.type),
    typeOptions: featureTypeOptions(),
    hostFaceId: item.faceId,
    hostFaceName: faceNames.get(item.faceId) ?? item.faceId,
    dimsLabel: `${formatMeasure(item.width)}w x ${formatMeasure(item.height)}h x ${formatMeasure(item.depth)}d`,
    params: [
      { name: 'offsetU', label: 'Offset along face', value: String(round1(item.offsetU)) },
      { name: 'offsetV', label: item.type === 'door' || item.type === 'window' ? 'Sill height' : 'Offset up face', value: String(round1(item.offsetV)) },
      { name: 'width', label: 'Width', value: String(item.width) },
      { name: 'height', label: 'Height', value: String(item.height) },
      { name: 'depth', label: item.type === 'chimney' ? 'Rise above roof' : 'Depth', value: String(item.depth) },
    ],
    visible: item.visible !== false,
  }))

  const fit: BuildingFaceFitModel | null =
    faceFit && faceFit.featureId === feature.id
      ? {
          kindLabel: faceKindLabel(faceFit.kind),
          pointCount: faceFit.fitted.pointCount,
          lengthLabel: `${formatMeasure(round1(faceFit.fitted.length))} along face`,
          heightLabel: `${formatMeasure(round1(faceFit.fitted.height))} ${faceFit.kind === 'roof' ? 'up slope' : 'high'}`,
          areaLabel: `${formatMeasure(Math.round(faceFit.fitted.area))} sf (fitted rect)`,
          rmsLabel: `fit rms ${faceFit.fitted.fitRms.toFixed(2)}`,
          slopeLabel: faceFit.kind === 'roof' ? slopeLabelFor(faceFit.fitted.plane.normal) : null,
          orientationNote:
            faceFit.kind !== faceFit.fitted.suggestedKind && (faceFit.kind === 'wall' || faceFit.kind === 'roof')
              ? `Plane orientation reads more like a ${faceFit.fitted.suggestedKind}; accept only if intended.`
              : null,
        }
      : null

  return {
    envelopeVertexCount: envelope?.length ?? 0,
    envelopeAreaLabel: envelope ? `${formatMeasure(Math.round(Math.abs(signedAreaXY(envelope))))} sf plan` : '--',
    summary: buildingSummary(feature),
    evidenceCount: evidence.length,
    canFit: evidence.length >= 3,
    faces,
    features,
    faceOptions: components.faces.map((face) => ({ id: face.id, label: `${face.name} (${faceKindLabel(face.kind)})` })),
    featureTypeOptions: featureTypeOptions(),
    fit,
    fitNote,
    isolateVertexCount: isolate ? isolate.length : null,
    isolateOverride: isolateBoundaryFromFeature(feature) !== null,
    evidenceItems: evidence.slice(0, EVIDENCE_DETAIL_ROWS).map((ref, index) => ({
      index,
      kindLabel: EVIDENCE_KIND_LABEL[ref.kind] ?? ref.kind,
      coordLabel: ref.coordinate.map((axis) => axis.toFixed(1)).join(', '),
    })),
    evidenceOverflow: Math.max(evidence.length - EVIDENCE_DETAIL_ROWS, 0),
  }
}

export type { BuildingFaceFeatureType }
