// src/ui/features.ts - Create Sim feature authoring controller. Bridges the
// right panel to the engine authoring cores (authoring.ts / snap.ts) and the
// single saveProject write path. Region v1 flow: subtype pick -> border draw
// -> optional breaklines -> record persisted as primitives + params +
// evidence (NEVER baked geometry) -> display regenerated through the pure
// region patch generator on every session change.

import type { ProjectSession } from '../shared/ipc'
import {
  getTemplate,
  objectCategoryLabel,
  templatesForFamily,
  type FeatureTemplate,
  type ObjectCategoryId,
  type TemplateParamSpec,
} from '../shared/template-catalog'
import { utilitySystemLabel, utilityTemplateGeometry } from '../shared/utility-catalog'
import type { EvidenceRef, FeatureRecord, ProjectManifest } from '../shared/workbench-types'
import type { ViewerEngine } from '../viewer'
import type { Vec3 } from '../viewer/geometry'
import type { RegionXY } from '../viewer/pointCloudStreaming'
import {
  buildObjectDisplay,
  buildBuildingDisplay,
  buildLineDisplay,
  buildPointPrimitiveDisplay,
  buildRegionPatch,
  buildingGeometryFromFeature,
  lineGeometryFromFeature,
  pointPrimitiveGeometryFromFeature,
  regionGeometryFromFeature,
  type BuildingRoofType,
} from '../viewer/generators'
import { buildUtilityDisplayEntry, utilityOriginFromFeature } from '../viewer/utilityGenerators'
import { buildBuildingComponentDisplayEntries, focusBoundaryFromFeature, isEnvelopeBuilding } from '../viewer/buildingGenerators'
import { emptyBuildingComponents } from '../shared/building-catalog'
import type { FeatureDisplayEntry } from '../viewer/RenderFeatures'

export interface FeatureControllerDeps {
  getSession(): ProjectSession | null
  getViewer(): ViewerEngine | null
  ensureViewer(): ViewerEngine
  persistManifest(manifest: ProjectManifest): Promise<void>
  /** Re-render the panels after authoring-state changes that do not persist. */
  onAuthoringChanged(): void
}

export type RegionAuthoringPhase = 'border' | 'review' | 'breakline'

/** What the right panel needs to render the in-flight region tool rail. */
export interface RegionAuthoringView {
  phase: RegionAuthoringPhase
  templateId: string
  subtype: string
  activeVertexCount: number
  borderVertexCount: number
  breaklineCount: number
  canCloseBorder: boolean
  canFinishBreakline: boolean
  snappedCount: number
  freeCount: number
}

export type BuildingAuthoringPhase = 'footprint' | 'review'

/** What the right panel needs to render the in-flight building tool rail. */
export interface BuildingAuthoringView {
  phase: BuildingAuthoringPhase
  templateId: string
  subtype: string
  activeVertexCount: number
  footprintVertexCount: number
  canCloseFootprint: boolean
  snappedCount: number
  freeCount: number
}

export type SimpleFeatureFamily = 'object' | 'line' | 'marker' | 'utility'
export type SimpleAuthoringPhase = 'placing' | 'review'
export type ObjectPlacementMode = 'snap' | 'manual'
export type SimpleGeometryMode = 'point' | 'polyline'

export interface SimpleAuthoringView {
  family: SimpleFeatureFamily
  phase: SimpleAuthoringPhase
  templateId: string
  subtype: string
  /** Point features pin once; polyline features collect 2+ vertices. */
  geometry: SimpleGeometryMode
  activeVertexCount: number
  vertexCount: number
  canReview: boolean
  snappedCount: number
  freeCount: number
}

export interface ObjectCreationToolbarView {
  categoryId: ObjectCategoryId
  typeTemplateId: string
  placementMode: ObjectPlacementMode
  categories: { id: ObjectCategoryId; label: string }[]
  types: { templateId: string; label: string }[]
}

interface AuthoredVertexRecord {
  world: Vec3
  snapped: boolean
  evidence: EvidenceRef
}

interface PendingRegion {
  templateId: string
  subtype: string
  border: AuthoredVertexRecord[]
  breaklines: AuthoredVertexRecord[][]
}

interface PendingBuilding {
  templateId: string
  /** Legacy massing roof type, or 'envelope' for the beta envelope-first building. */
  subtype: BuildingRoofType | 'envelope'
  footprint: AuthoredVertexRecord[]
}

interface PendingSimpleFeature {
  family: SimpleFeatureFamily
  templateId: string
  subtype: string
  geometry: SimpleGeometryMode
  vertices: AuthoredVertexRecord[]
  placementMode: ObjectPlacementMode
}

export type ObjectEditKind = 'isolate' | 'evidence'

/** In-flight per-object edit mode (isolate boundary draw or evidence picking). */
export interface ObjectEditView {
  featureId: string
  kind: ObjectEditKind
  /** Isolate draw only: boundary vertices placed so far. */
  activeVertexCount: number
  /** Isolate draw only: boundary can close (>= 3 vertices). */
  canFinish: boolean
  /** Transient feedback for the last evidence action (e.g. window sampling). */
  note?: string
}

/** Active isolate load-all state for the panel (full-density area streaming). */
export interface IsolateLoadView {
  featureId: string
  sectorCount: number
  activeSector: number
}

const DEFAULT_OBJECT_TEMPLATE_ID = 'object.box'

/** Reality display tints per region subtype (display hint only, not persisted). */
const REGION_FILL_COLOR: Record<string, number> = {
  grass: 0x4caf50,
  pavement: 0x757575,
  gravel: 0xbdb76b,
  dirt: 0x8d6e63,
  concrete: 0xb0bec5,
  landscape: 0x81c784,
  water: 0x42a5f5,
  unknown: 0x9575cd,
}

export function regionFillColor(subtype: string | undefined): number {
  return REGION_FILL_COLOR[subtype ?? ''] ?? REGION_FILL_COLOR.unknown!
}

export class FeatureController {
  private readonly deps: FeatureControllerDeps
  private phase: RegionAuthoringPhase | null = null
  private pending: PendingRegion | null = null
  private buildingPhase: BuildingAuthoringPhase | null = null
  private pendingBuilding: PendingBuilding | null = null
  private simplePhase: SimpleAuthoringPhase | null = null
  private pendingSimple: PendingSimpleFeature | null = null
  private objectEdit: { featureId: string; kind: ObjectEditKind } | null = null
  private objectEditNote: string | null = null
  private focusedFeatureId: string | null = null
  private isolateLoad: { featureId: string; sectors: RegionXY[]; active: number } | null = null

  constructor(deps: FeatureControllerDeps) {
    this.deps = deps
  }

  regionTemplates(): FeatureTemplate[] {
    return templatesForFamily('region')
  }

  buildingTemplates(): FeatureTemplate[] {
    return templatesForFamily('building')
  }

  objectTemplates(): FeatureTemplate[] {
    return templatesForFamily('object')
  }

  lineTemplates(): FeatureTemplate[] {
    return templatesForFamily('line')
  }

  markerTemplates(): FeatureTemplate[] {
    return templatesForFamily('marker')
  }

  utilityTemplates(): FeatureTemplate[] {
    return templatesForFamily('utility')
  }

  getAuthoring(): RegionAuthoringView | null {
    if (!this.phase || !this.pending) return null
    const viewer = this.deps.getViewer()
    const draft = viewer?.getFeatureAuthoringSnapshot().draft ?? null
    const activeVertices = this.phase === 'review' ? [] : draft?.vertices ?? []
    const collected = [...this.pending.border, ...this.pending.breaklines.flat()]
    const active = activeVertices.map((vertex) => ({ snapped: vertex.snapped }))
    const all = [...collected, ...active]
    return {
      phase: this.phase,
      templateId: this.pending.templateId,
      subtype: this.pending.subtype,
      activeVertexCount: activeVertices.length,
      borderVertexCount: this.pending.border.length,
      breaklineCount: this.pending.breaklines.length,
      canCloseBorder: this.phase === 'border' && activeVertices.length >= 3,
      canFinishBreakline: this.phase === 'breakline' && activeVertices.length >= 2,
      snappedCount: all.filter((vertex) => vertex.snapped).length,
      freeCount: all.filter((vertex) => !vertex.snapped).length,
    }
  }

  getBuildingAuthoring(): BuildingAuthoringView | null {
    if (!this.buildingPhase || !this.pendingBuilding) return null
    const viewer = this.deps.getViewer()
    const draft = viewer?.getFeatureAuthoringSnapshot().draft ?? null
    const activeVertices = this.buildingPhase === 'review' ? [] : draft?.vertices ?? []
    const collected = this.pendingBuilding.footprint
    const active = activeVertices.map((vertex) => ({ snapped: vertex.snapped }))
    const all = [...collected, ...active]
    return {
      phase: this.buildingPhase,
      templateId: this.pendingBuilding.templateId,
      subtype: this.pendingBuilding.subtype,
      activeVertexCount: activeVertices.length,
      footprintVertexCount: this.pendingBuilding.footprint.length,
      canCloseFootprint: this.buildingPhase === 'footprint' && activeVertices.length >= 3,
      snappedCount: all.filter((vertex) => vertex.snapped).length,
      freeCount: all.filter((vertex) => !vertex.snapped).length,
    }
  }

  getSimpleAuthoring(): SimpleAuthoringView | null {
    if (!this.simplePhase || !this.pendingSimple) return null
    const viewer = this.deps.getViewer()
    const draft = viewer?.getFeatureAuthoringSnapshot().draft ?? null
    const activeVertices = this.simplePhase === 'review' ? [] : draft?.vertices ?? []
    const active = activeVertices.map((vertex) => ({ snapped: vertex.snapped }))
    const all = [...this.pendingSimple.vertices, ...active]
    return {
      family: this.pendingSimple.family,
      phase: this.simplePhase,
      templateId: this.pendingSimple.templateId,
      subtype: this.pendingSimple.subtype,
      geometry: this.pendingSimple.geometry,
      activeVertexCount: activeVertices.length,
      vertexCount: this.pendingSimple.vertices.length,
      canReview: this.pendingSimple.geometry === 'polyline' ? activeVertices.length >= 2 : activeVertices.length >= 1,
      snappedCount: all.filter((vertex) => vertex.snapped).length,
      freeCount: all.filter((vertex) => !vertex.snapped).length,
    }
  }

  isAuthoring(): boolean {
    return this.phase !== null || this.buildingPhase !== null || this.simplePhase !== null || this.objectEdit !== null
  }

  getObjectEdit(): ObjectEditView | null {
    if (!this.objectEdit) return null
    if (this.objectEdit.kind === 'evidence') {
      return {
        ...this.objectEdit,
        activeVertexCount: 0,
        canFinish: false,
        ...(this.objectEditNote ? { note: this.objectEditNote } : {}),
      }
    }
    const draft = this.deps.getViewer()?.getFeatureAuthoringSnapshot().draft
    const count = draft?.vertices.length ?? 0
    return { ...this.objectEdit, activeVertexCount: count, canFinish: count >= 3 }
  }

  /**
   * Starts drawing the isolate/focus boundary for an object: an XY polygon of
   * viewer context. Boundary vertices are NEVER stored as evidence - ground
   * and clutter inside the area stay out of the object's provenance.
   */
  startIsolateBoundary(featureId: string): void {
    const feature = this.deps.getSession()?.manifest.features.find((candidate) => candidate.id === featureId)
    if (!feature || !isRefinableFamily(feature) || this.isAuthoring()) return
    const viewer = this.deps.ensureViewer()
    viewer.startFeatureAuthoring(feature.family, feature.templateId ?? null, 'polygon')
    this.objectEdit = { featureId, kind: 'isolate' }
    this.deps.onAuthoringChanged()
  }

  async finishIsolateBoundary(): Promise<void> {
    const session = this.deps.getSession()
    const viewer = this.deps.getViewer()
    if (!session || !viewer || this.objectEdit?.kind !== 'isolate') return
    viewer.requestCloseFeatureAuthoring()
    const snapshot = viewer.confirmFeatureAuthoring()
    if (snapshot.state !== 'complete' || !snapshot.draft || snapshot.draft.vertices.length < 3) return
    const featureId = this.objectEdit.featureId
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = manifest.features.find((candidate) => candidate.id === featureId)
    if (!feature) return
    feature.metadata = {
      ...(feature.metadata ?? {}),
      isolateBoundary: { polygon: snapshot.draft.vertices.map((vertex) => vertex.world) },
    }
    feature.modifiedAt = new Date().toISOString()
    this.clearObjectEdit()
    this.clearIsolateLoad() // a redrawn boundary invalidates the old sector plan
    await this.deps.persistManifest(manifest)
  }

  async clearIsolateBoundary(featureId: string): Promise<void> {
    const session = this.deps.getSession()
    if (!session) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = manifest.features.find((candidate) => candidate.id === featureId)
    if (!feature?.metadata || !('isolateBoundary' in feature.metadata)) return
    delete feature.metadata.isolateBoundary
    feature.modifiedAt = new Date().toISOString()
    this.clearIsolateLoad()
    await this.deps.persistManifest(manifest)
  }

  getIsolateLoad(): IsolateLoadView | null {
    if (!this.isolateLoad) return null
    return {
      featureId: this.isolateLoad.featureId,
      sectorCount: this.isolateLoad.sectors.length,
      activeSector: this.isolateLoad.active,
    }
  }

  /**
   * Loads the full survey data (index, all levels) inside the object's isolate
   * boundary. Areas over the render budget are pre-split into balanced sectors
   * shown one at a time - the over-capacity catch.
   */
  startIsolateLoadAll(featureId: string): void {
    const feature = this.deps.getSession()?.manifest.features.find((candidate) => candidate.id === featureId)
    if (!feature || !isRefinableFamily(feature)) return
    const boundary = focusBoundaryFromFeature(feature)
    if (!boundary) return
    const viewer = this.deps.ensureViewer()
    const sectors = viewer.planIsolateSectors(boundary)
    if (sectors.length === 0) return
    this.isolateLoad = { featureId, sectors, active: 0 }
    viewer.setIsolateLoadRegion(sectors[0]!)
    this.applyFocusOverlay()
    this.deps.onAuthoringChanged()
  }

  stepIsolateSector(delta: number): void {
    const viewer = this.deps.getViewer()
    if (!viewer || !this.isolateLoad || this.isolateLoad.sectors.length < 2) return
    const count = this.isolateLoad.sectors.length
    this.isolateLoad.active = (this.isolateLoad.active + delta + count) % count
    viewer.setIsolateLoadRegion(this.isolateLoad.sectors[this.isolateLoad.active]!)
    this.applyFocusOverlay()
    this.deps.onAuthoringChanged()
  }

  stopIsolateLoadAll(): void {
    if (!this.isolateLoad) return
    this.clearIsolateLoad()
    this.applyFocusOverlay()
    this.deps.onAuthoringChanged()
  }

  private clearIsolateLoad(): void {
    if (!this.isolateLoad) return
    this.isolateLoad = null
    this.deps.getViewer()?.setIsolateLoadRegion(null)
  }

  /** Enters evidence-pick mode: each snapped viewer click adds one explicit ref. */
  startEvidencePick(featureId: string): void {
    const feature = this.deps.getSession()?.manifest.features.find((candidate) => candidate.id === featureId)
    if (!feature || !isRefinableFamily(feature) || this.isAuthoring()) return
    this.objectEdit = { featureId, kind: 'evidence' }
    this.objectEditNote = null
    this.deps.ensureViewer().setEvidencePickActive(true)
    this.deps.onAuthoringChanged()
  }

  stopEvidencePick(): void {
    if (this.objectEdit?.kind !== 'evidence') return
    this.objectEdit = null
    this.objectEditNote = null
    this.deps.getViewer()?.setEvidencePickActive(false)
    this.deps.onAuthoringChanged()
  }

  /**
   * One-shot window selection inside evidence-pick mode: the next viewer drag
   * selects visible cloud points (isolate focus applies) and stores them as
   * evidence refs in a single persist. Duplicates of existing refs are skipped.
   */
  async selectEvidenceWindow(): Promise<void> {
    const viewer = this.deps.getViewer()
    if (!viewer || this.objectEdit?.kind !== 'evidence') return
    const featureId = this.objectEdit.featureId
    const result = await viewer.armEvidenceWindow()
    // Mode may have ended (Done/cancel) while the drag was pending.
    if (!result || result.picks.length === 0 || this.objectEdit?.kind !== 'evidence' || this.objectEdit.featureId !== featureId) return
    const session = this.deps.getSession()
    if (!session) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = manifest.features.find((candidate) => candidate.id === featureId)
    if (!feature) return
    const refs = feature.evidenceRefs ?? []
    const seen = new Set(refs.map((ref) => ref.coordinate.join(',')))
    const added: EvidenceRef[] = []
    for (const pick of result.picks) {
      const key = pick.evidence.coordinate.join(',')
      if (seen.has(key)) continue
      seen.add(key)
      added.push(pick.evidence)
    }
    const duplicates = result.picks.length - added.length
    const sampledOut = result.total - result.picks.length
    this.objectEditNote =
      `Window added ${added.length.toLocaleString()} points` +
      (duplicates > 0 ? `, ${duplicates.toLocaleString()} already present` : '') +
      (sampledOut > 0 ? `; caught ${result.total.toLocaleString()}, sampled for storage safety` : '')
    if (added.length === 0) {
      this.deps.onAuthoringChanged()
      return
    }
    feature.evidenceRefs = [...refs, ...added]
    feature.modifiedAt = new Date().toISOString()
    await this.deps.persistManifest(manifest)
  }

  async removeEvidenceRef(featureId: string, index: number): Promise<void> {
    const session = this.deps.getSession()
    if (!session) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = manifest.features.find((candidate) => candidate.id === featureId)
    if (!feature?.evidenceRefs || index < 0 || index >= feature.evidenceRefs.length) return
    feature.evidenceRefs.splice(index, 1)
    feature.modifiedAt = new Date().toISOString()
    await this.deps.persistManifest(manifest)
  }

  async clearEvidenceRefs(featureId: string): Promise<void> {
    const session = this.deps.getSession()
    if (!session) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = manifest.features.find((candidate) => candidate.id === featureId)
    if (!feature?.evidenceRefs || feature.evidenceRefs.length === 0) return
    feature.evidenceRefs = []
    feature.modifiedAt = new Date().toISOString()
    await this.deps.persistManifest(manifest)
  }

  /** Cancels any in-flight object edit mode without touching other authoring. */
  cancelObjectEdit(): void {
    if (!this.objectEdit) return
    const viewer = this.deps.getViewer()
    if (this.objectEdit.kind === 'isolate') {
      viewer?.cancelFeatureAuthoring()
      viewer?.setAuthoringDraftPreview(null)
      viewer?.setSnapPreview(null)
    } else {
      viewer?.setEvidencePickActive(false)
    }
    this.objectEdit = null
    this.objectEditNote = null
    this.deps.onAuthoringChanged()
  }

  /**
   * Feature open in the detail panel; drives the viewer focus overlay
   * (isolate boundary emphasis + evidence/origin markers).
   */
  setFocusedFeature(featureId: string | null): void {
    if (this.isolateLoad && this.isolateLoad.featureId !== featureId) this.clearIsolateLoad()
    this.focusedFeatureId = featureId
    this.applyFocusOverlay()
  }

  private applyFocusOverlay(): void {
    const viewer = this.deps.getViewer()
    if (!viewer) return
    const feature = this.focusedFeatureId
      ? this.deps.getSession()?.manifest.features.find((candidate) => candidate.id === this.focusedFeatureId)
      : null
    if (!feature || !isRefinableFamily(feature)) {
      viewer.setFeatureFocusOverlay(null)
      viewer.setIsolateFocus(null)
      return
    }
    const geometry = feature.geometry as { point?: unknown }
    const origin = isVec3(geometry.point)
      ? ([...geometry.point] as Vec3)
      : feature.family === 'utility'
        ? utilityOriginFromFeature(feature)
        : null
    const boundary = focusBoundaryFromFeature(feature)
    // The active load-all sector renders as a rect only when the area actually
    // split - a single full-area sector would just retrace the boundary bbox.
    const load = this.isolateLoad?.featureId === feature.id ? this.isolateLoad : null
    const sector = load && load.sectors.length > 1 ? load.sectors[load.active]! : null
    viewer.setFeatureFocusOverlay({
      boundary,
      evidence: (feature.evidenceRefs ?? []).map((ref) => [...ref.coordinate] as Vec3),
      origin,
      sectorRect: sector && boundary ? { ...sector, z: boundary[0]![2] } : null,
    })
    // Focus mode proper: the viewer isolates cloud display to the boundary
    // while this object is open. Context only - never evidence.
    viewer.setIsolateFocus(boundary)
  }

  private async addEvidenceAtPointer(): Promise<void> {
    const session = this.deps.getSession()
    const viewer = this.deps.getViewer()
    if (!session || !viewer || this.objectEdit?.kind !== 'evidence') return
    const picked = viewer.resolveEvidenceAtPointer()
    if (!picked) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = manifest.features.find((candidate) => candidate.id === this.objectEdit!.featureId)
    if (!feature) return
    const refs = feature.evidenceRefs ?? []
    const duplicate = refs.some(
      (ref) =>
        ref.coordinate[0] === picked.evidence.coordinate[0] &&
        ref.coordinate[1] === picked.evidence.coordinate[1] &&
        ref.coordinate[2] === picked.evidence.coordinate[2],
    )
    if (duplicate) return
    feature.evidenceRefs = [...refs, picked.evidence]
    feature.modifiedAt = new Date().toISOString()
    await this.deps.persistManifest(manifest)
  }

  private clearObjectEdit(): void {
    const viewer = this.deps.getViewer()
    viewer?.setAuthoringDraftPreview(null)
    viewer?.setSnapPreview(null)
    this.objectEdit = null
  }

  startRegion(templateId: string): void {
    const template = getTemplate(templateId)
    if (!template || template.family !== 'region' || !this.deps.getSession() || this.isAuthoring()) return
    const viewer = this.deps.ensureViewer()
    viewer.startFeatureAuthoring('region', templateId)
    this.phase = 'border'
    this.pending = { templateId, subtype: template.subtype, border: [], breaklines: [] }
    this.deps.onAuthoringChanged()
  }

  startBuilding(templateId: string): void {
    const template = getTemplate(templateId)
    if (
      !template ||
      template.family !== 'building' ||
      !this.deps.getSession() ||
      this.isAuthoring() ||
      (template.subtype !== 'flat' &&
        template.subtype !== 'gable' &&
        template.subtype !== 'hip' &&
        template.subtype !== 'envelope')
    ) {
      return
    }
    const viewer = this.deps.ensureViewer()
    viewer.startFeatureAuthoring('building', templateId)
    this.buildingPhase = 'footprint'
    this.pendingBuilding = { templateId, subtype: template.subtype, footprint: [] }
    this.deps.onAuthoringChanged()
  }

  startObject(templateId: string): void {
    this.startSimpleFeature('object', templateId, 'snap')
  }

  startObjectCreation(): void {
    this.startSimpleFeature('object', DEFAULT_OBJECT_TEMPLATE_ID, 'snap')
  }

  startLine(templateId: string): void {
    this.startSimpleFeature('line', templateId, 'snap')
  }

  startMarker(templateId: string): void {
    this.startSimpleFeature('marker', templateId, 'snap')
  }

  /** Utilities ride the simple rail: point classes pin once, line classes collect a run. */
  startUtility(templateId: string): void {
    this.startSimpleFeature('utility', templateId, 'snap')
  }

  getObjectCreationToolbar(): ObjectCreationToolbarView | null {
    if (this.simplePhase !== 'placing' || this.pendingSimple?.family !== 'object') return null
    const currentTemplate = getTemplate(this.pendingSimple.templateId)
    const categoryId = currentTemplate?.objectCategory ?? 'generic'
    return {
      categoryId,
      typeTemplateId: this.pendingSimple.templateId,
      placementMode: this.pendingSimple.placementMode,
      categories: this.objectTemplatesByCategory().map(([id]) => ({ id, label: objectCategoryLabel(id) })),
      types: this.objectTemplates()
        .filter((template) => template.objectCategory === categoryId)
        .map((template) => ({ templateId: template.id, label: template.displayName })),
    }
  }

  setObjectCreationCategory(categoryId: ObjectCategoryId): void {
    if (this.simplePhase !== 'placing' || this.pendingSimple?.family !== 'object') return
    const template = this.objectTemplates().find((candidate) => candidate.objectCategory === categoryId)
    if (!template) return
    this.restartPendingObjectCreation(template.id, this.pendingSimple.placementMode)
  }

  setObjectCreationTemplate(templateId: string): void {
    if (this.simplePhase !== 'placing' || this.pendingSimple?.family !== 'object') return
    this.restartPendingObjectCreation(templateId, this.pendingSimple.placementMode)
  }

  setObjectPlacementMode(mode: ObjectPlacementMode): void {
    if (this.simplePhase !== 'placing' || this.pendingSimple?.family !== 'object' || !this.pendingSimple) return
    this.pendingSimple.placementMode = mode
    this.deps.onAuthoringChanged()
  }

  private startSimpleFeature(
    family: SimpleFeatureFamily,
    templateId: string,
    placementMode: ObjectPlacementMode,
  ): void {
    const template = getTemplate(templateId)
    if (!template || template.family !== family || !this.deps.getSession() || this.isAuthoring()) return
    const geometry: SimpleGeometryMode =
      family === 'line' || (family === 'utility' && utilityTemplateGeometry(template) === 'line') ? 'polyline' : 'point'
    const viewer = this.deps.ensureViewer()
    viewer.startFeatureAuthoring(family, templateId, geometry)
    this.simplePhase = 'placing'
    this.pendingSimple = { family, templateId, subtype: template.subtype, geometry, vertices: [], placementMode }
    this.deps.onAuthoringChanged()
  }

  private restartPendingObjectCreation(templateId: string, placementMode: ObjectPlacementMode): void {
    this.deps.getViewer()?.cancelFeatureAuthoring()
    this.simplePhase = null
    this.pendingSimple = null
    this.startSimpleFeature('object', templateId, placementMode)
  }

  /** Routed from the viewer-host click handler; true when the click was consumed. */
  handleViewerClick(): boolean {
    if (this.objectEdit?.kind === 'evidence') {
      void this.addEvidenceAtPointer()
      return true
    }
    if (this.objectEdit?.kind === 'isolate') {
      const viewer = this.deps.getViewer()
      if (!viewer) return false
      viewer.placeFeatureVertexAtPointer(undefined, true)
      this.refreshIsolateDraftPreview()
      this.deps.onAuthoringChanged()
      return true
    }
    const regionActive = this.phase !== null && this.phase !== 'review'
    const buildingActive = this.buildingPhase !== null && this.buildingPhase !== 'review'
    const simpleActive = this.simplePhase !== null && this.simplePhase !== 'review'
    if (!regionActive && !buildingActive && !simpleActive) return false
    const viewer = this.deps.getViewer()
    if (!viewer) return false
    const placementMode = this.pendingSimple?.family === 'object' ? this.pendingSimple.placementMode : 'snap'
    const snapshot = viewer.placeFeatureVertexAtPointer(undefined, placementMode !== 'manual')
    this.captureCompletedPointDraft(snapshot)
    this.refreshDraftPreview()
    this.refreshBuildingDraftPreview()
    this.refreshSimpleDraftPreview()
    this.deps.onAuthoringChanged()
    return true
  }

  private captureCompletedPointDraft(snapshot?: ReturnType<ViewerEngine['getFeatureAuthoringSnapshot']>): void {
    if (!this.pendingSimple || this.pendingSimple.geometry === 'polyline' || this.simplePhase !== 'placing') return
    const resolved = snapshot ?? this.deps.getViewer()?.getFeatureAuthoringSnapshot()
    if (resolved?.state !== 'complete' || !resolved.draft) return
    this.pendingSimple.vertices = resolved.draft.vertices.map((vertex) => ({
      world: vertex.world,
      snapped: vertex.snapped,
      evidence: vertex.evidence,
    }))
    // Point objects and point utilities persist on the placement click; markers
    // keep the explicit review step.
    if (this.pendingSimple.family === 'object' || this.pendingSimple.family === 'utility') {
      this.simplePhase = 'review'
      void this.finishSimpleFeature()
      return
    }
    this.simplePhase = 'review'
  }

  closeBorder(): void {
    const viewer = this.deps.getViewer()
    if (!viewer || this.phase !== 'border' || !this.pending) return
    viewer.requestCloseFeatureAuthoring()
    const snapshot = viewer.confirmFeatureAuthoring()
    if (snapshot.state !== 'complete' || !snapshot.draft) return
    this.pending.border = snapshot.draft.vertices.map((vertex) => ({
      world: vertex.world,
      snapped: vertex.snapped,
      evidence: vertex.evidence,
    }))
    this.phase = 'review'
    this.refreshDraftPreview()
    this.deps.onAuthoringChanged()
  }

  closeBuildingFootprint(): void {
    const viewer = this.deps.getViewer()
    if (!viewer || this.buildingPhase !== 'footprint' || !this.pendingBuilding) return
    viewer.requestCloseFeatureAuthoring()
    const snapshot = viewer.confirmFeatureAuthoring()
    if (snapshot.state !== 'complete' || !snapshot.draft) return
    this.pendingBuilding.footprint = snapshot.draft.vertices.map((vertex) => ({
      world: vertex.world,
      snapped: vertex.snapped,
      evidence: vertex.evidence,
    }))
    this.buildingPhase = 'review'
    this.refreshBuildingDraftPreview()
    this.deps.onAuthoringChanged()
  }

  startBreakline(): void {
    const viewer = this.deps.getViewer()
    if (!viewer || this.phase !== 'review' || !this.pending) return
    // The machine collects breakline vertices as a polyline; the finished line
    // is folded into the pending region, not stored as its own feature.
    viewer.startFeatureAuthoring('line', this.pending.templateId, 'polyline')
    this.phase = 'breakline'
    this.deps.onAuthoringChanged()
  }

  finishBreakline(): void {
    const viewer = this.deps.getViewer()
    if (!viewer || this.phase !== 'breakline' || !this.pending) return
    viewer.requestCloseFeatureAuthoring()
    const snapshot = viewer.confirmFeatureAuthoring()
    if (snapshot.state !== 'complete' || !snapshot.draft) return
    this.pending.breaklines.push(
      snapshot.draft.vertices.map((vertex) => ({
        world: vertex.world,
        snapped: vertex.snapped,
        evidence: vertex.evidence,
      })),
    )
    this.phase = 'review'
    this.refreshDraftPreview()
    this.deps.onAuthoringChanged()
  }

  async finishRegion(): Promise<void> {
    const session = this.deps.getSession()
    if (!session || this.phase !== 'review' || !this.pending || this.pending.border.length < 3) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const template = getTemplate(this.pending.templateId)
    const now = new Date().toISOString()
    const regionCount = manifest.features.filter((feature) => feature.family === 'region').length
    const record: FeatureRecord = {
      id: `feat-${crypto.randomUUID()}`,
      simulationId: manifest.realitySimulation.id,
      type: 'polyline',
      name: `Region ${regionCount + 1} (${this.pending.subtype})`,
      geometry: {
        border: this.pending.border.map((vertex) => vertex.world),
        closed: true,
        breaklines: this.pending.breaklines.map((line) => line.map((vertex) => vertex.world)),
      },
      createdAt: now,
      modifiedAt: now,
      family: 'region',
      templateId: this.pending.templateId,
      subtype: this.pending.subtype,
      authorship: 'authored',
      lifecycleStatus: 'authored',
      evidenceRefs: [
        ...this.pending.border.map((vertex) => vertex.evidence),
        ...this.pending.breaklines.flat().map((vertex) => vertex.evidence),
      ],
      parameters: Object.fromEntries((template?.paramSchema ?? []).map((param) => [param.name, param.default])),
      representations: {
        ...(template?.cad ? { cad: { ...template.cad } } : {}),
        ...(template?.report ? { report: { ...template.report } } : {}),
      },
      display: { visible: true },
      metadata: {},
    }
    manifest.features.push(record)
    this.clearAuthoring()
    await this.deps.persistManifest(manifest)
  }

  async finishBuilding(): Promise<void> {
    const session = this.deps.getSession()
    if (
      !session ||
      this.buildingPhase !== 'review' ||
      !this.pendingBuilding ||
      this.pendingBuilding.footprint.length < 3
    ) {
      return
    }
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const template = getTemplate(this.pendingBuilding.templateId)
    const params = Object.fromEntries((template?.paramSchema ?? []).map((param) => [param.name, param.default]))
    const now = new Date().toISOString()
    const buildingCount = manifest.features.filter((feature) => feature.family === 'building').length
    const featureId = `feat-${crypto.randomUUID()}`
    const footprint = this.pendingBuilding.footprint.map((vertex) => vertex.world)
    const envelope = this.pendingBuilding.subtype === 'envelope'
    const record: FeatureRecord = {
      id: featureId,
      simulationId: manifest.realitySimulation.id,
      type: 'polyline',
      name: `Building ${buildingCount + 1} (${this.pendingBuilding.subtype})`,
      geometry: envelope
        ? { footprint }
        : {
            footprint,
            roofType: this.pendingBuilding.subtype,
          },
      createdAt: now,
      modifiedAt: now,
      family: 'building',
      templateId: this.pendingBuilding.templateId,
      subtype: this.pendingBuilding.subtype,
      authorship: 'authored',
      lifecycleStatus: 'authored',
      // Envelope buildings: the boundary is context, NEVER evidence - the
      // record starts with no evidence refs (same rule as isolate boundaries).
      evidenceRefs: envelope ? [] : this.pendingBuilding.footprint.map((vertex) => vertex.evidence),
      parameters: params,
      representations: {
        ...(template?.cad ? { cad: { ...template.cad } } : {}),
        ...(template?.report ? { report: { ...template.report } } : {}),
      },
      display: { visible: true },
      // The envelope IS the building's isolate/focus boundary (resolved via
      // focusBoundaryFromFeature); metadata.isolateBoundary stays reserved for
      // a user-drawn tighter override, so isolation can never be lost.
      metadata: envelope
        ? { building: emptyBuildingComponents() }
        : { ridge: 'inferred-with-override-reserved' },
    }
    manifest.features.push(record)
    manifest.exclusionZones.push({
      id: `zone-${crypto.randomUUID()}`,
      simulationId: manifest.realitySimulation.id,
      featureId,
      name: `${record.name} footprint`,
      polygon: footprint.map((point) => [point[0], point[1], point[2]]),
      createdAt: now,
      modifiedAt: now,
    })
    this.clearAuthoring()
    await this.deps.persistManifest(manifest)
  }

  reviewSimpleFeature(): void {
    const viewer = this.deps.getViewer()
    if (!viewer || this.simplePhase !== 'placing' || !this.pendingSimple || this.pendingSimple.geometry !== 'polyline') return
    viewer.requestCloseFeatureAuthoring()
    const snapshot = viewer.confirmFeatureAuthoring()
    if (snapshot.state !== 'complete' || !snapshot.draft) return
    this.pendingSimple.vertices = snapshot.draft.vertices.map((vertex) => ({
      world: vertex.world,
      snapped: vertex.snapped,
      evidence: vertex.evidence,
    }))
    this.simplePhase = 'review'
    this.refreshSimpleDraftPreview()
    this.deps.onAuthoringChanged()
  }

  async finishSimpleFeature(): Promise<void> {
    const session = this.deps.getSession()
    if (!session || this.simplePhase !== 'review' || !this.pendingSimple || this.pendingSimple.vertices.length === 0) return
    if (this.pendingSimple.geometry === 'polyline' && this.pendingSimple.vertices.length < 2) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const pending = this.pendingSimple
    const template = getTemplate(pending.templateId)
    const params = Object.fromEntries((template?.paramSchema ?? []).map((param) => [param.name, param.default]))
    if (pending.family === 'line') params.breaklineType = pending.subtype
    const now = new Date().toISOString()
    const familyCount = manifest.features.filter((feature) => feature.family === pending.family).length
    const type = pending.geometry === 'polyline' ? 'polyline' : 'marker'
    const point = pending.vertices[0]?.world ?? [0, 0, 0]
    const record: FeatureRecord = {
      id: `feat-${crypto.randomUUID()}`,
      simulationId: manifest.realitySimulation.id,
      type,
      name: simpleFeatureName(pending, template, familyCount),
      geometry:
        pending.geometry === 'polyline'
          ? { vertices: pending.vertices.map((vertex) => vertex.world) }
          : { point },
      createdAt: now,
      modifiedAt: now,
      family: pending.family,
      templateId: pending.templateId,
      subtype: pending.subtype,
      authorship: 'authored',
      lifecycleStatus: 'authored',
      evidenceRefs: pending.vertices.map((vertex) => vertex.evidence),
      parameters: params,
      representations: {
        ...(template?.cad ? { cad: { ...template.cad } } : {}),
        ...(template?.report ? { report: { ...template.report } } : {}),
      },
      display: { visible: true },
      metadata: simpleFeatureMetadata(pending, template),
    }
    manifest.features.push(record)
    this.clearAuthoring()
    await this.deps.persistManifest(manifest)
  }

  cancel(): void {
    this.clearAuthoring()
    this.deps.onAuthoringChanged()
  }

  async renameFeature(featureId: string, name: string): Promise<void> {
    const session = this.deps.getSession()
    const trimmed = name.trim()
    if (!session || trimmed.length === 0) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = manifest.features.find((candidate) => candidate.id === featureId)
    if (!feature || feature.name === trimmed) return
    feature.name = trimmed
    feature.modifiedAt = new Date().toISOString()
    await this.deps.persistManifest(manifest)
  }

  async updateFeatureParameter(featureId: string, paramName: string, rawValue: string): Promise<void> {
    const session = this.deps.getSession()
    if (!session) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = manifest.features.find((candidate) => candidate.id === featureId)
    if (!feature?.templateId) return
    const template = getTemplate(feature.templateId)
    const param = template?.paramSchema.find((candidate) => candidate.name === paramName)
    if (!param) return
    const value = coerceParamValue(param, rawValue)
    if (value === undefined) return
    feature.parameters = { ...(feature.parameters ?? {}), [param.name]: value }
    feature.modifiedAt = new Date().toISOString()
    await this.deps.persistManifest(manifest)
  }

  async updateObjectTemplate(featureId: string, templateId: string): Promise<void> {
    const session = this.deps.getSession()
    if (!session) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = manifest.features.find((candidate) => candidate.id === featureId)
    const nextTemplate = getTemplate(templateId)
    if (!feature || feature.family !== 'object' || !nextTemplate || nextTemplate.family !== 'object') return
    const previousTemplate = feature.templateId ? getTemplate(feature.templateId) : null
    feature.templateId = nextTemplate.id
    feature.subtype = nextTemplate.subtype
    feature.parameters = remapTemplateParameters(feature.parameters ?? {}, previousTemplate, nextTemplate)
    feature.representations = {
      ...(nextTemplate.cad ? { cad: { ...nextTemplate.cad } } : {}),
      ...(nextTemplate.report ? { report: { ...nextTemplate.report } } : {}),
    }
    feature.metadata = { ...(feature.metadata ?? {}), ...(nextTemplate.objectCategory ? { objectCategory: nextTemplate.objectCategory } : {}) }
    feature.modifiedAt = new Date().toISOString()
    await this.deps.persistManifest(manifest)
  }

  async updateObjectCategory(featureId: string, categoryId: ObjectCategoryId): Promise<void> {
    const template = this.objectTemplates().find((candidate) => candidate.objectCategory === categoryId)
    if (!template) return
    await this.updateObjectTemplate(featureId, template.id)
  }

  /**
   * Re-types a utility to another system/class combo. Only same-geometry
   * targets are legal (a pinned manhole cannot become a pipe run); parameters
   * remap by name so shared fields survive the switch.
   */
  async updateUtilityTemplate(featureId: string, templateId: string): Promise<void> {
    const session = this.deps.getSession()
    if (!session) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = manifest.features.find((candidate) => candidate.id === featureId)
    const nextTemplate = getTemplate(templateId)
    if (!feature || feature.family !== 'utility' || !nextTemplate || nextTemplate.family !== 'utility') return
    const previousTemplate = feature.templateId ? getTemplate(feature.templateId) : null
    if (
      previousTemplate &&
      utilityTemplateGeometry(previousTemplate) !== utilityTemplateGeometry(nextTemplate)
    ) {
      return
    }
    feature.templateId = nextTemplate.id
    feature.subtype = nextTemplate.subtype
    feature.parameters = remapTemplateParameters(feature.parameters ?? {}, previousTemplate, nextTemplate)
    feature.representations = {
      ...(nextTemplate.cad ? { cad: { ...nextTemplate.cad } } : {}),
      ...(nextTemplate.report ? { report: { ...nextTemplate.report } } : {}),
    }
    feature.metadata = {
      ...(feature.metadata ?? {}),
      ...(nextTemplate.utilitySystem && nextTemplate.utilityClass
        ? { utilitySystem: nextTemplate.utilitySystem, utilityClass: nextTemplate.utilityClass }
        : {}),
    }
    feature.modifiedAt = new Date().toISOString()
    await this.deps.persistManifest(manifest)
  }

  async updateFeaturePlacement(featureId: string, axis: 'x' | 'y' | 'z', rawValue: string): Promise<void> {
    const session = this.deps.getSession()
    if (!session) return
    const value = Number(rawValue)
    if (!Number.isFinite(value)) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = manifest.features.find((candidate) => candidate.id === featureId)
    if (!feature || (feature.family !== 'object' && feature.family !== 'marker' && feature.family !== 'utility')) return
    // Point-pinned features only; line utilities keep their placed alignment (beta).
    const geometry = feature.geometry as { point?: unknown }
    if (!isVec3(geometry.point)) return
    const point: Vec3 = [geometry.point[0], geometry.point[1], geometry.point[2]]
    if (axis === 'x') point[0] = value
    if (axis === 'y') point[1] = value
    if (axis === 'z') point[2] = value
    feature.geometry = { ...feature.geometry, point }
    feature.modifiedAt = new Date().toISOString()
    await this.deps.persistManifest(manifest)
  }

  async updateFeatureVisibility(featureId: string, visible: boolean): Promise<void> {
    const session = this.deps.getSession()
    if (!session) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const feature = manifest.features.find((candidate) => candidate.id === featureId)
    if (!feature) return
    feature.display = { ...(feature.display ?? { visible: true }), visible }
    feature.modifiedAt = new Date().toISOString()
    await this.deps.persistManifest(manifest)
  }

  async deleteFeature(featureId: string): Promise<void> {
    const session = this.deps.getSession()
    if (!session) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    if (!manifest.features.some((candidate) => candidate.id === featureId)) return
    manifest.features = manifest.features.filter((candidate) => candidate.id !== featureId)
    // Zones are owned by their feature; the FK check requires they go together.
    manifest.exclusionZones = manifest.exclusionZones.filter((zone) => zone.featureId !== featureId)
    await this.deps.persistManifest(manifest)
  }

  /** Sim master toggle: show/hide all authored features as one group. */
  setSimVisible(visible: boolean): void {
    this.deps.getViewer()?.setAuthoredFeaturesVisible(visible)
  }

  /** Regenerates every authored feature's display geometry from stored primitives. */
  refreshDisplays(): void {
    const session = this.deps.getSession()
    const features = (session?.manifest.features ?? []).filter(
      (feature): feature is FeatureRecord =>
        feature.display?.visible !== false &&
        (feature.family === 'region' ||
          feature.family === 'building' ||
          feature.family === 'object' ||
          feature.family === 'utility' ||
          feature.family === 'line' ||
          feature.family === 'marker'),
    )
    const viewer = features.length > 0 ? this.deps.ensureViewer() : this.deps.getViewer()
    if (!viewer) return
    const entries: FeatureDisplayEntry[] = []
    for (const feature of features) {
      if (feature.family === 'region') {
        const geometry = regionGeometryFromFeature(feature)
        if (!geometry) continue
        const patch = buildRegionPatch(geometry)
        const color = regionFillColor(feature.subtype)
        entries.push({
          featureId: feature.id,
          ...(patch.indices.length > 0 ? { fill: { positions: patch.positions, indices: patch.indices } } : {}),
          lines: [patch.outline, ...patch.breaklines],
          fillColor: color,
          lineColor: color,
        })
        continue
      }
      if (isEnvelopeBuilding(feature)) {
        // Envelope buildings render as components: envelope outline + accepted
        // faces + hosted features (several entries share one featureId).
        for (const parts of buildBuildingComponentDisplayEntries(feature)) {
          entries.push({ featureId: feature.id, ...parts })
        }
        continue
      }
      const geometry = buildingGeometryFromFeature(feature)
      if (!geometry) continue
      const display = buildBuildingDisplay({
        footprint: geometry.footprint,
        roofType: geometry.roofType,
        height: numberParam(feature, 'height', 10),
        roofPitchDeg: numberParam(feature, 'roofPitch', 30),
        overhang: numberParam(feature, 'overhang', 0),
        ridge: geometry.ridge,
      })
      entries.push({
        featureId: feature.id,
        fill: { positions: display.positions, indices: display.indices },
        lines: [
          display.lines.footprint,
          display.lines.face,
          display.lines.overhang,
          display.lines.roof,
          display.lines.ridge,
          display.lines.hip,
        ],
        fillColor: 0xb8c0cc,
        lineColor: 0x455a64,
      })
      continue
    }
    for (const feature of features) {
      if (feature.family === 'object') {
        const display = buildObjectDisplay(feature)
        if (!display) continue
        const color = objectDisplayColor(feature)
        entries.push({ featureId: feature.id, ...display, fillColor: color.fill, lineColor: color.line })
        continue
      }
      if (feature.family === 'utility') {
        const entry = buildUtilityDisplayEntry(feature)
        if (entry) entries.push({ featureId: feature.id, ...entry })
        continue
      }
      if (feature.family === 'marker') {
        const geometry = pointPrimitiveGeometryFromFeature(feature)
        if (!geometry) continue
        const display = buildPointPrimitiveDisplay({
          point: geometry.point,
          size: numberParam(feature, 'scale', numberParam(feature, 'diameter', 2)),
          height: numberParam(feature, 'height', 2),
        })
        const color = 0xffc857
        entries.push({ featureId: feature.id, lines: display.lines, fillColor: color, lineColor: color })
        continue
      }
      if (feature.family === 'line') {
        const geometry = lineGeometryFromFeature(feature)
        if (!geometry) continue
        const display = buildLineDisplay(geometry)
        const isBreakline = feature.parameters?.isBreakline !== false
        const color = isBreakline ? 0xd97757 : 0x90a4ae
        entries.push({ featureId: feature.id, lines: display.lines, fillColor: color, lineColor: color })
      }
    }
    viewer.setAuthoredFeatures(entries)
    // Focus overlay reflects manifest state (evidence/boundary), so re-apply
    // whenever displays regenerate after a persist.
    this.applyFocusOverlay()
  }

  private refreshDraftPreview(): void {
    const viewer = this.deps.getViewer()
    if (!viewer || !this.pending) return
    const lines: Vec3[][] = []
    if (this.pending.border.length >= 3) {
      lines.push([...this.pending.border.map((vertex) => vertex.world), this.pending.border[0]!.world])
    }
    for (const breakline of this.pending.breaklines) {
      lines.push(breakline.map((vertex) => vertex.world))
    }
    const draft = viewer.getFeatureAuthoringSnapshot().draft
    const activeVertices = this.phase === 'review' ? [] : draft?.vertices.map((vertex) => vertex.world) ?? []
    if (this.phase !== 'review' && activeVertices.length >= 2) lines.push(activeVertices)
    viewer.setAuthoringDraftPreview({ lines, activeVertices })
  }

  private refreshBuildingDraftPreview(): void {
    const viewer = this.deps.getViewer()
    if (!viewer || !this.pendingBuilding) return
    const lines: Vec3[][] = []
    if (this.pendingBuilding.footprint.length >= 3) {
      lines.push([
        ...this.pendingBuilding.footprint.map((vertex) => vertex.world),
        this.pendingBuilding.footprint[0]!.world,
      ])
    }
    const draft = viewer.getFeatureAuthoringSnapshot().draft
    const activeVertices = this.buildingPhase === 'review' ? [] : draft?.vertices.map((vertex) => vertex.world) ?? []
    if (this.buildingPhase !== 'review' && activeVertices.length >= 2) lines.push(activeVertices)
    viewer.setAuthoringDraftPreview({ lines, activeVertices })
  }

  private refreshIsolateDraftPreview(): void {
    const viewer = this.deps.getViewer()
    if (!viewer || this.objectEdit?.kind !== 'isolate') return
    const draft = viewer.getFeatureAuthoringSnapshot().draft
    const activeVertices = draft?.vertices.map((vertex) => vertex.world) ?? []
    const lines: Vec3[][] = activeVertices.length >= 2 ? [activeVertices] : []
    viewer.setAuthoringDraftPreview({ lines, activeVertices })
  }

  private refreshSimpleDraftPreview(): void {
    const viewer = this.deps.getViewer()
    if (!viewer || !this.pendingSimple) return
    const lines: Vec3[][] = []
    if (this.pendingSimple.geometry === 'polyline' && this.pendingSimple.vertices.length >= 2) {
      lines.push(this.pendingSimple.vertices.map((vertex) => vertex.world))
    }
    const draft = viewer.getFeatureAuthoringSnapshot().draft
    const activeVertices = this.simplePhase === 'review' ? [] : draft?.vertices.map((vertex) => vertex.world) ?? []
    if (this.simplePhase !== 'review' && activeVertices.length >= 2) lines.push(activeVertices)
    viewer.setAuthoringDraftPreview({ lines, activeVertices })
  }

  private clearAuthoring(): void {
    const viewer = this.deps.getViewer()
    viewer?.cancelFeatureAuthoring()
    viewer?.setAuthoringDraftPreview(null)
    viewer?.setSnapPreview(null)
    this.phase = null
    this.pending = null
    this.buildingPhase = null
    this.pendingBuilding = null
    this.simplePhase = null
    this.pendingSimple = null
    if (this.objectEdit?.kind === 'evidence') viewer?.setEvidencePickActive(false)
    this.objectEdit = null
    this.objectEditNote = null
  }

  private objectTemplatesByCategory(): Array<[ObjectCategoryId, FeatureTemplate[]]> {
    const groups = new Map<ObjectCategoryId, FeatureTemplate[]>()
    for (const template of this.objectTemplates()) {
      const category = template.objectCategory ?? 'generic'
      const bucket = groups.get(category) ?? []
      bucket.push(template)
      groups.set(category, bucket)
    }
    return [...groups.entries()]
  }
}

function numberParam(feature: FeatureRecord, name: string, fallback: number): number {
  const value = feature.parameters?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function featureFamilyLabel(family: SimpleFeatureFamily): string {
  if (family === 'object') return 'Object'
  if (family === 'line') return 'Line'
  if (family === 'utility') return 'Utility'
  return 'Marker'
}

function simpleFeatureName(pending: PendingSimpleFeature, template: FeatureTemplate | null, familyCount: number): string {
  if (pending.family === 'object') return `${template?.displayName ?? 'Object'} ${familyCount + 1}`
  if (pending.family === 'utility') {
    return `${utilitySystemLabel(template?.utilitySystem)} ${template?.displayName ?? 'Utility'} ${familyCount + 1}`
  }
  return `${featureFamilyLabel(pending.family)} ${familyCount + 1} (${pending.subtype})`
}

function simpleFeatureMetadata(pending: PendingSimpleFeature, template: FeatureTemplate | null): Record<string, unknown> {
  if (pending.family === 'object' && template?.objectCategory) return { objectCategory: template.objectCategory }
  if (pending.family === 'utility' && template?.utilitySystem && template.utilityClass) {
    return { utilitySystem: template.utilitySystem, utilityClass: template.utilityClass }
  }
  return {}
}

/** Families whose detail supports isolate areas + explicit evidence refinement. */
function isRefinableFamily(feature: FeatureRecord): feature is FeatureRecord & { family: 'object' | 'utility' | 'building' } {
  return feature.family === 'object' || feature.family === 'utility' || feature.family === 'building'
}

function coerceParamValue(param: TemplateParamSpec, rawValue: string): number | string | boolean | undefined {
  if (param.type === 'boolean') return rawValue === 'true' || rawValue === 'on'
  if (param.type === 'number') {
    const value = Number(rawValue)
    if (!Number.isFinite(value)) return undefined
    if (param.min !== undefined && value < param.min) return undefined
    if (param.max !== undefined && value > param.max) return undefined
    return value
  }
  if (param.type === 'enum') {
    return param.options?.includes(rawValue) ? rawValue : undefined
  }
  return rawValue
}

function remapTemplateParameters(
  existing: Record<string, unknown>,
  previousTemplate: FeatureTemplate | null,
  nextTemplate: FeatureTemplate,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const param of nextTemplate.paramSchema) {
    const raw = existing[param.name]
    if (raw === undefined) {
      out[param.name] = param.default
      continue
    }
    const coerced = coerceParamValue(param, String(raw))
    out[param.name] = coerced === undefined ? param.default : coerced
  }
  if (previousTemplate?.family === 'object' && existing.rotationYaw !== undefined && out.rotationYaw === undefined) {
    out.rotationYaw = existing.rotationYaw
  }
  return out
}

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every((axis) => typeof axis === 'number')
}

function objectDisplayColor(feature: FeatureRecord): { fill: number; line: number } {
  const template = feature.templateId ? getTemplate(feature.templateId) : null
  if (template?.objectCategory === 'foliage') return { fill: 0x6ea05a, line: 0x335f2e }
  if (template?.objectCategory === 'site-fixture') return { fill: 0xa0aab8, line: 0x495464 }
  return { fill: 0x7ea4c6, line: 0x284c70 }
}
