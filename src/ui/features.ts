// src/ui/features.ts - Create Sim feature authoring controller. Bridges the
// right panel to the engine authoring cores (authoring.ts / snap.ts) and the
// single saveProject write path. Region v1 flow: subtype pick -> border draw
// -> optional breaklines -> record persisted as primitives + params +
// evidence (NEVER baked geometry) -> display regenerated through the pure
// region patch generator on every session change.

import type { ProjectSession } from '../shared/ipc'
import { getTemplate, templatesForFamily, type FeatureTemplate, type TemplateParamSpec } from '../shared/template-catalog'
import type { EvidenceRef, FeatureRecord, ProjectManifest } from '../shared/workbench-types'
import type { ViewerEngine } from '../viewer'
import type { Vec3 } from '../viewer/geometry'
import {
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

export type SimpleFeatureFamily = 'object' | 'line' | 'marker'
export type SimpleAuthoringPhase = 'placing' | 'review'

export interface SimpleAuthoringView {
  family: SimpleFeatureFamily
  phase: SimpleAuthoringPhase
  templateId: string
  subtype: string
  activeVertexCount: number
  vertexCount: number
  canReview: boolean
  snappedCount: number
  freeCount: number
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
  subtype: BuildingRoofType
  footprint: AuthoredVertexRecord[]
}

interface PendingSimpleFeature {
  family: SimpleFeatureFamily
  templateId: string
  subtype: string
  vertices: AuthoredVertexRecord[]
}

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
      activeVertexCount: activeVertices.length,
      vertexCount: this.pendingSimple.vertices.length,
      canReview: this.pendingSimple.family === 'line' ? activeVertices.length >= 2 : activeVertices.length >= 1,
      snappedCount: all.filter((vertex) => vertex.snapped).length,
      freeCount: all.filter((vertex) => !vertex.snapped).length,
    }
  }

  isAuthoring(): boolean {
    return this.phase !== null || this.buildingPhase !== null || this.simplePhase !== null
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
      (template.subtype !== 'flat' && template.subtype !== 'gable' && template.subtype !== 'hip')
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
    this.startSimpleFeature('object', templateId)
  }

  startLine(templateId: string): void {
    this.startSimpleFeature('line', templateId)
  }

  startMarker(templateId: string): void {
    this.startSimpleFeature('marker', templateId)
  }

  private startSimpleFeature(family: SimpleFeatureFamily, templateId: string): void {
    const template = getTemplate(templateId)
    if (!template || template.family !== family || !this.deps.getSession() || this.isAuthoring()) return
    const viewer = this.deps.ensureViewer()
    viewer.startFeatureAuthoring(family, templateId, family === 'line' ? 'polyline' : 'point')
    this.simplePhase = 'placing'
    this.pendingSimple = { family, templateId, subtype: template.subtype, vertices: [] }
    this.deps.onAuthoringChanged()
  }

  /** Routed from the viewer-host click handler; true when the click was consumed. */
  handleViewerClick(): boolean {
    const regionActive = this.phase !== null && this.phase !== 'review'
    const buildingActive = this.buildingPhase !== null && this.buildingPhase !== 'review'
    const simpleActive = this.simplePhase !== null && this.simplePhase !== 'review'
    if (!regionActive && !buildingActive && !simpleActive) return false
    const viewer = this.deps.getViewer()
    if (!viewer) return false
    viewer.placeFeatureVertexAtPointer()
    this.captureCompletedPointDraft()
    this.refreshDraftPreview()
    this.refreshBuildingDraftPreview()
    this.refreshSimpleDraftPreview()
    this.deps.onAuthoringChanged()
    return true
  }

  private captureCompletedPointDraft(): void {
    if (!this.pendingSimple || this.pendingSimple.family === 'line' || this.simplePhase !== 'placing') return
    const snapshot = this.deps.getViewer()?.getFeatureAuthoringSnapshot()
    if (snapshot?.state !== 'complete' || !snapshot.draft) return
    this.pendingSimple.vertices = snapshot.draft.vertices.map((vertex) => ({
      world: vertex.world,
      snapped: vertex.snapped,
      evidence: vertex.evidence,
    }))
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
    const record: FeatureRecord = {
      id: featureId,
      simulationId: manifest.realitySimulation.id,
      type: 'polyline',
      name: `Building ${buildingCount + 1} (${this.pendingBuilding.subtype})`,
      geometry: {
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
      evidenceRefs: this.pendingBuilding.footprint.map((vertex) => vertex.evidence),
      parameters: params,
      representations: {
        ...(template?.cad ? { cad: { ...template.cad } } : {}),
        ...(template?.report ? { report: { ...template.report } } : {}),
      },
      display: { visible: true },
      metadata: { ridge: 'inferred-with-override-reserved' },
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
    if (!viewer || this.simplePhase !== 'placing' || !this.pendingSimple || this.pendingSimple.family !== 'line') return
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
    if (this.pendingSimple.family === 'line' && this.pendingSimple.vertices.length < 2) return
    const manifest = structuredClone(session.manifest) as ProjectManifest
    const pending = this.pendingSimple
    const template = getTemplate(pending.templateId)
    const params = Object.fromEntries((template?.paramSchema ?? []).map((param) => [param.name, param.default]))
    if (pending.family === 'line') params.breaklineType = pending.subtype
    const now = new Date().toISOString()
    const familyCount = manifest.features.filter((feature) => feature.family === pending.family).length
    const type = pending.family === 'line' ? 'polyline' : 'marker'
    const record: FeatureRecord = {
      id: `feat-${crypto.randomUUID()}`,
      simulationId: manifest.realitySimulation.id,
      type,
      name: `${featureFamilyLabel(pending.family)} ${familyCount + 1} (${pending.subtype})`,
      geometry:
        pending.family === 'line'
          ? { vertices: pending.vertices.map((vertex) => vertex.world) }
          : { point: pending.vertices[0]!.world },
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
      metadata: {},
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
        feature.family === 'region' ||
        feature.family === 'building' ||
        feature.family === 'object' ||
        feature.family === 'line' ||
        feature.family === 'marker',
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
      if (feature.family === 'object' || feature.family === 'marker') {
        const geometry = pointPrimitiveGeometryFromFeature(feature)
        if (!geometry) continue
        const display = buildPointPrimitiveDisplay({
          point: geometry.point,
          size: numberParam(feature, 'scale', numberParam(feature, 'diameter', 2)),
          height: numberParam(feature, 'height', 2),
        })
        const color = feature.family === 'object' ? 0x6d8fbd : 0xffc857
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

  private refreshSimpleDraftPreview(): void {
    const viewer = this.deps.getViewer()
    if (!viewer || !this.pendingSimple) return
    const lines: Vec3[][] = []
    if (this.pendingSimple.family === 'line' && this.pendingSimple.vertices.length >= 2) {
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
    this.phase = null
    this.pending = null
    this.buildingPhase = null
    this.pendingBuilding = null
    this.simplePhase = null
    this.pendingSimple = null
  }
}

function numberParam(feature: FeatureRecord, name: string, fallback: number): number {
  const value = feature.parameters?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function featureFamilyLabel(family: SimpleFeatureFamily): string {
  if (family === 'object') return 'Object'
  if (family === 'line') return 'Line'
  return 'Marker'
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
