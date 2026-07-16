// src/ui/buildingController.ts - component operations for beta BUILDINGS:
// evidence-fitted face/roof-plane creation (fit -> preview -> accept) and the
// hosted-feature CRUD on metadata.building. Deliberately separate from
// features.ts (owner prefers focused modules): it shares the same deps shape
// and the single persistManifest write path, and the FeatureController stays
// the only owner of viewer authoring modes - this controller only reads the
// building's explicit evidence refs and writes accepted components.

import {
  defaultFaceFeatureSize,
  emptyBuildingComponents,
  faceFeatureTypeLabel,
  BUILDING_FACE_FEATURE_TYPES,
  type BuildingComponentsRecord,
  type BuildingFaceFeatureType,
  type BuildingFaceKind,
  type BuildingFaceRecord,
} from '../shared/building-catalog'
import type { ProjectSession } from '../shared/ipc'
import type { FeatureRecord, ProjectManifest } from '../shared/workbench-types'
import type { ViewerEngine } from '../viewer'
import {
  buildingComponentsFromFeature,
  faceFitPreviewLines,
  fitFaceFromEvidence,
  isEnvelopeBuilding,
  nextFaceName,
  representativeEvidence,
  type FittedFace,
} from '../viewer/buildingGenerators'
import type { Vec3 } from '../viewer/geometry'

export interface BuildingControllerDeps {
  getSession(): ProjectSession | null
  getViewer(): ViewerEngine | null
  persistManifest(manifest: ProjectManifest): Promise<void>
  /** True while region/building/object authoring or an object edit is in flight. */
  isAuthoringBusy(): boolean
  /** Re-render the panels after in-memory state changes that do not persist. */
  onChanged(): void
}

/** The in-flight fit shown in the panel + as viewer draft lines until accepted. */
export interface BuildingFaceFitView {
  featureId: string
  kind: BuildingFaceKind
  fitted: FittedFace
}

/** Params a hosted feature exposes for editing (all plain numbers, feet). */
export type FaceFeatureParamName = 'offsetU' | 'offsetV' | 'width' | 'height' | 'depth'

const FACE_FEATURE_PARAMS: FaceFeatureParamName[] = ['offsetU', 'offsetV', 'width', 'height', 'depth']

export class BuildingComponentController {
  private readonly deps: BuildingControllerDeps
  private pendingFit: { featureId: string; kind: BuildingFaceKind; fitted: FittedFace } | null = null
  private fitNote: string | null = null

  constructor(deps: BuildingControllerDeps) {
    this.deps = deps
  }

  getFaceFit(): BuildingFaceFitView | null {
    return this.pendingFit ? { ...this.pendingFit } : null
  }

  /** Rejection feedback when a fit could not start (too few / collinear points). */
  getFitNote(): string | null {
    return this.fitNote
  }

  /**
   * Fits a plane to the building's CURRENT explicit evidence refs and holds
   * the result as a preview. Nothing persists until acceptFaceFit; the
   * evidence refs themselves are never touched.
   */
  startFaceFit(featureId: string, kind: BuildingFaceKind): void {
    if (this.deps.isAuthoringBusy()) return
    const feature = this.findFeature(this.deps.getSession()?.manifest ?? null, featureId)
    if (!feature || !isEnvelopeBuilding(feature)) return
    const points = (feature.evidenceRefs ?? []).map((ref) => [...ref.coordinate] as Vec3)
    if (points.length < 3) {
      this.pendingFit = null
      this.fitNote = `Need at least 3 evidence points to fit a plane (${points.length} selected). Use + Add evidence point or Select by window first.`
      this.deps.onChanged()
      return
    }
    const fitted = fitFaceFromEvidence(points)
    if (!fitted) {
      this.pendingFit = null
      this.fitNote = 'Evidence points are collinear or coincident - no unique plane. Add points spread across the face.'
      this.deps.onChanged()
      return
    }
    this.pendingFit = { featureId, kind, fitted }
    this.fitNote = null
    this.deps.getViewer()?.setAuthoringDraftPreview({ lines: faceFitPreviewLines(fitted), activeVertices: [] })
    this.deps.onChanged()
  }

  /** Persists the previewed fit as a face component. Evidence refs stay put. */
  async acceptFaceFit(): Promise<void> {
    const pending = this.pendingFit
    if (!pending) return
    const now = new Date().toISOString()
    await this.mutateComponents(pending.featureId, (components, feature) => {
      const points = (feature.evidenceRefs ?? []).map((ref) => [...ref.coordinate] as Vec3)
      components.faces.push({
        id: `face-${crypto.randomUUID()}`,
        name: nextFaceName(components, pending.kind),
        kind: pending.kind,
        plane: pending.fitted.plane,
        extents: pending.fitted.extents,
        fitRms: pending.fitted.fitRms,
        evidence: {
          count: pending.fitted.pointCount,
          representative: representativeEvidence(points),
        },
        visible: true,
        createdAt: now,
      })
      return true
    })
    this.clearFit()
  }

  cancelFaceFit(): void {
    if (!this.pendingFit && !this.fitNote) return
    this.clearFit()
    this.deps.onChanged()
  }

  private clearFit(): void {
    if (this.pendingFit) this.deps.getViewer()?.setAuthoringDraftPreview(null)
    this.pendingFit = null
    this.fitNote = null
  }

  async renameFace(featureId: string, faceId: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    await this.mutateComponents(featureId, (components) => {
      const face = components.faces.find((candidate) => candidate.id === faceId)
      if (!face || face.name === trimmed) return false
      face.name = trimmed
      return true
    })
  }

  async setFaceVisibility(featureId: string, faceId: string, visible: boolean): Promise<void> {
    await this.mutateComponents(featureId, (components) => {
      const face = components.faces.find((candidate) => candidate.id === faceId)
      if (!face || face.visible === visible) return false
      face.visible = visible
      return true
    })
  }

  /** Deletes a face and every feature it hosts (hosted features never orphan). */
  async removeFace(featureId: string, faceId: string): Promise<void> {
    await this.mutateComponents(featureId, (components) => {
      const before = components.faces.length
      components.faces = components.faces.filter((candidate) => candidate.id !== faceId)
      if (components.faces.length === before) return false
      components.faceFeatures = components.faceFeatures.filter((candidate) => candidate.faceId !== faceId)
      return true
    })
  }

  /**
   * Adds a hosted feature to a face with type defaults: doors sit on the face
   * bottom, windows get a sill, roof-hosted features center on the plane.
   * Everything is editable afterwards.
   */
  async addFaceFeature(featureId: string, faceId: string, type: BuildingFaceFeatureType): Promise<void> {
    if (!BUILDING_FACE_FEATURE_TYPES.includes(type)) return
    const now = new Date().toISOString()
    await this.mutateComponents(featureId, (components) => {
      const face = components.faces.find((candidate) => candidate.id === faceId)
      if (!face) return false
      const size = defaultFaceFeatureSize(type)
      const faceLength = face.extents.maxU - face.extents.minU
      const faceHeight = face.extents.maxV - face.extents.minV
      const offsetU = Math.max((faceLength - size.width) / 2, 0)
      const offsetV =
        type === 'door' ? 0 : type === 'window' ? Math.min(3, Math.max(faceHeight - size.height, 0)) : Math.max((faceHeight - size.height) / 2, 0)
      const count = components.faceFeatures.filter((candidate) => candidate.type === type).length
      components.faceFeatures.push({
        id: `bfeat-${crypto.randomUUID()}`,
        faceId,
        name: `${faceFeatureTypeLabel(type)} ${count + 1}`,
        type,
        offsetU,
        offsetV,
        width: size.width,
        height: size.height,
        depth: size.depth,
        visible: true,
        createdAt: now,
      })
      return true
    })
  }

  async updateFaceFeatureParam(featureId: string, componentId: string, param: string, rawValue: string): Promise<void> {
    if (!FACE_FEATURE_PARAMS.includes(param as FaceFeatureParamName)) return
    const value = Number(rawValue)
    if (!Number.isFinite(value)) return
    // Sizes must stay positive; offsets may be negative (feature past the fitted edge is legal).
    if (param !== 'offsetU' && param !== 'offsetV' && value <= 0) return
    await this.mutateComponents(featureId, (components) => {
      const item = components.faceFeatures.find((candidate) => candidate.id === componentId)
      if (!item || item[param as FaceFeatureParamName] === value) return false
      item[param as FaceFeatureParamName] = value
      return true
    })
  }

  async updateFaceFeatureType(featureId: string, componentId: string, type: string): Promise<void> {
    if (!BUILDING_FACE_FEATURE_TYPES.includes(type as BuildingFaceFeatureType)) return
    await this.mutateComponents(featureId, (components) => {
      const item = components.faceFeatures.find((candidate) => candidate.id === componentId)
      if (!item || item.type === type) return false
      item.type = type as BuildingFaceFeatureType
      return true
    })
  }

  async setFaceFeatureVisibility(featureId: string, componentId: string, visible: boolean): Promise<void> {
    await this.mutateComponents(featureId, (components) => {
      const item = components.faceFeatures.find((candidate) => candidate.id === componentId)
      if (!item || item.visible === visible) return false
      item.visible = visible
      return true
    })
  }

  async removeFaceFeature(featureId: string, componentId: string): Promise<void> {
    await this.mutateComponents(featureId, (components) => {
      const before = components.faceFeatures.length
      components.faceFeatures = components.faceFeatures.filter((candidate) => candidate.id !== componentId)
      return components.faceFeatures.length !== before
    })
  }

  private findFeature(manifest: ProjectManifest | null, featureId: string): FeatureRecord | null {
    return manifest?.features.find((candidate) => candidate.id === featureId) ?? null
  }

  /**
   * One write path for every component mutation: clone, validate-read the
   * components (malformed/orphaned entries drop here), let the mutator work
   * on the validated copy, and persist only when it reports a change.
   */
  private async mutateComponents(
    featureId: string,
    mutate: (components: BuildingComponentsRecord, feature: FeatureRecord) => boolean,
  ): Promise<void> {
    const session = this.deps.getSession()
    if (!session) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = this.findFeature(manifest, featureId)
    if (!feature || !isEnvelopeBuilding(feature)) return
    const components = feature.metadata?.building ? buildingComponentsFromFeature(feature) : emptyBuildingComponents()
    if (!mutate(components, feature)) return
    feature.metadata = { ...(feature.metadata ?? {}), building: components }
    feature.modifiedAt = new Date().toISOString()
    await this.deps.persistManifest(manifest)
  }
}

export type { BuildingFaceKind, BuildingFaceRecord }
