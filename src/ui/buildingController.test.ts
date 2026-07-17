// src/ui/buildingController.test.ts - beta Buildings flows: envelope creation
// through the FeatureController (envelope doubles as the isolate boundary,
// components initialize empty) and the BuildingComponentController's
// fit -> preview -> accept path plus hosted-feature CRUD.

import { describe, expect, it, vi } from 'vitest'
import { makeManifest } from '../../tests/ui-fixtures'
import type { ProjectSession } from '../shared/ipc'
import type { FeatureRecord, ProjectManifest } from '../shared/workbench-types'
import type { BuildingComponentsRecord } from '../shared/building-catalog'
import { AuthoringMachine } from '../viewer/authoring'
import type { PlacementResolution } from '../viewer/snap'
import { BuildingComponentController } from './buildingController'
import { FeatureController } from './features'

/** Just enough viewer for envelope authoring, fit previews, and focus checks. */
class FakeViewer {
  readonly machine = new AuthoringMachine()
  draftPreview: unknown = 'unset'
  isolateFocus: unknown = 'unset'
  isolateLoadRegion: unknown = 'unset'
  private clicks: [number, number, number][] = []
  private next = 0

  queueClicks(points: [number, number, number][]): void {
    this.clicks = points
    this.next = 0
  }

  startFeatureAuthoring(family: Parameters<AuthoringMachine['start']>[0], templateId: string | null, mode?: never): void {
    this.machine.start(family, templateId, mode)
  }

  placeFeatureVertexAtPointer(): ReturnType<AuthoringMachine['snapshot']> {
    const world = this.clicks[this.next] ?? [this.next, 0, 0]
    this.next++
    const placement: PlacementResolution = { snapped: false, world }
    this.machine.place(placement)
    return this.machine.snapshot()
  }

  requestCloseFeatureAuthoring(): void {
    this.machine.requestClose()
  }

  confirmFeatureAuthoring(): ReturnType<AuthoringMachine['snapshot']> {
    this.machine.confirm()
    return this.machine.snapshot()
  }

  cancelFeatureAuthoring(): void {
    this.machine.cancel()
  }

  getFeatureAuthoringSnapshot(): ReturnType<AuthoringMachine['snapshot']> {
    return this.machine.snapshot()
  }

  setAuthoringDraftPreview(preview: unknown): void {
    this.draftPreview = preview
  }

  setSnapPreview(): void {}
  setAuthoredFeatures(): void {}
  setFeatureFocusOverlay(): void {}

  setIsolateFocus(boundary: unknown): void {
    this.isolateFocus = boundary
  }

  setEvidencePickActive(): void {}

  planIsolateSectors(boundary: [number, number, number][]): { minX: number; minY: number; maxX: number; maxY: number }[] {
    const xs = boundary.map((v) => v[0])
    const ys = boundary.map((v) => v[1])
    return [{ minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }]
  }

  setIsolateLoadRegion(region: unknown): void {
    this.isolateLoadRegion = region
  }

  estimateIsolateRegionPoints(): number | null {
    return null
  }
}

function makeHarness() {
  const manifest = makeManifest()
  const viewer = new FakeViewer()
  const session: ProjectSession = {
    projectFolder: 'C:/tmp/project',
    manifestPath: 'C:/tmp/project/project.json',
    manifest,
    backupPath: 'C:/tmp/project/project.json.bak',
    recoveryDetected: false,
  }
  const persistManifest = vi.fn(async (next: ProjectManifest) => {
    session.manifest = next
  })
  const features = new FeatureController({
    getSession: () => session,
    getViewer: () => viewer as never,
    ensureViewer: () => viewer as never,
    persistManifest,
    onAuthoringChanged: vi.fn(),
  })
  const buildings = new BuildingComponentController({
    getSession: () => session,
    getViewer: () => viewer as never,
    persistManifest,
    isAuthoringBusy: () => features.isAuthoring(),
    onChanged: vi.fn(),
  })
  return { features, buildings, session, viewer, persistManifest }
}

const ENVELOPE_CLICKS: [number, number, number][] = [
  [0, 0, 100],
  [40, 0, 100],
  [40, 30, 100],
  [0, 30, 100],
]

async function createEnvelopeBuilding(harness: ReturnType<typeof makeHarness>): Promise<FeatureRecord> {
  harness.viewer.queueClicks(ENVELOPE_CLICKS)
  harness.features.startBuilding('building.envelope')
  for (let i = 0; i < ENVELOPE_CLICKS.length; i++) harness.features.handleViewerClick()
  harness.features.closeBuildingFootprint()
  await harness.features.finishBuilding()
  return harness.session.manifest.features.at(-1)!
}

function componentsOf(feature: FeatureRecord): BuildingComponentsRecord {
  return feature.metadata!.building as BuildingComponentsRecord
}

/** Evidence on the vertical wall plane x=40 of the drawn envelope. */
const WALL_EVIDENCE: [number, number, number][] = [
  [40, 0, 100],
  [40, 30, 100],
  [40, 30, 112],
  [40, 0, 112],
]

function seedEvidence(session: ProjectSession, featureId: string, points: [number, number, number][]): void {
  const feature = (session.manifest as ProjectManifest).features.find((candidate) => candidate.id === featureId)!
  feature.evidenceRefs = points.map((coordinate) => ({ kind: 'asset-point', coordinate }))
}

describe('envelope building creation (FeatureController)', () => {
  it('stores the envelope with NO evidence refs and NO boundary override', async () => {
    const harness = makeHarness()
    const record = await createEnvelopeBuilding(harness)

    expect(record).toMatchObject({
      family: 'building',
      templateId: 'building.envelope',
      subtype: 'envelope',
      name: 'Building 1 (envelope)',
    })
    expect(record.geometry).toEqual({ footprint: ENVELOPE_CLICKS })
    expect(record.geometry).not.toHaveProperty('roofType')
    // Envelope boundary points are context, NEVER evidence.
    expect(record.evidenceRefs).toEqual([])
    // No copied boundary: the envelope itself is the focus boundary, and
    // metadata.isolateBoundary is reserved for a user-drawn override.
    expect(record.metadata).not.toHaveProperty('isolateBoundary')
    expect(componentsOf(record)).toEqual({ faces: [], faceFeatures: [] })
    // Envelope buildings still ground-exclude their footprint.
    expect((harness.session.manifest as ProjectManifest).exclusionZones.at(-1)).toMatchObject({ featureId: record.id })
  })

  it('focuses the envelope on open, even with all evidence removed (isolation is not optional)', async () => {
    const harness = makeHarness()
    const record = await createEnvelopeBuilding(harness)

    harness.features.setFocusedFeature(record.id)
    expect(harness.viewer.isolateFocus).toEqual(ENVELOPE_CLICKS)

    // Seed then wipe evidence - the boundary must not care.
    seedEvidence(harness.session, record.id, WALL_EVIDENCE)
    await harness.features.clearEvidenceRefs(record.id)
    harness.features.setFocusedFeature(record.id)
    expect(harness.viewer.isolateFocus).toEqual(ENVELOPE_CLICKS)

    // Load-all also resolves the envelope as its area.
    harness.features.startIsolateLoadAll(record.id)
    expect(harness.viewer.isolateLoadRegion).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 30 })
  })

  it('treats a drawn boundary as an override and reset falls back to the envelope', async () => {
    const harness = makeHarness()
    const record = await createEnvelopeBuilding(harness)
    harness.features.setFocusedFeature(record.id)

    // Draw a tighter custom boundary.
    const custom: [number, number, number][] = [
      [10, 10, 100],
      [20, 10, 100],
      [20, 20, 100],
    ]
    harness.viewer.queueClicks(custom)
    harness.features.startIsolateBoundary(record.id)
    for (let i = 0; i < custom.length; i++) harness.features.handleViewerClick()
    await harness.features.finishIsolateBoundary()
    harness.features.setFocusedFeature(record.id)
    expect(harness.viewer.isolateFocus).toEqual(custom)

    // Reset: override removed, envelope takes over - never null.
    await harness.features.clearIsolateBoundary(record.id)
    harness.features.setFocusedFeature(record.id)
    expect(harness.viewer.isolateFocus).toEqual(ENVELOPE_CLICKS)
  })

  it('keeps legacy massing buildings on their old record shape', async () => {
    const harness = makeHarness()
    harness.viewer.queueClicks(ENVELOPE_CLICKS)
    harness.features.startBuilding('building.gable')
    for (let i = 0; i < 4; i++) harness.features.handleViewerClick()
    harness.features.closeBuildingFootprint()
    await harness.features.finishBuilding()

    const record = harness.session.manifest.features.at(-1)!
    expect(record.geometry).toMatchObject({ roofType: 'gable' })
    expect(record.metadata).toEqual({ ridge: 'inferred-with-override-reserved' })
  })
})

describe('face fit -> preview -> accept', () => {
  it('fits from current evidence, previews in the viewer, persists only on accept', async () => {
    const harness = makeHarness()
    const record = await createEnvelopeBuilding(harness)
    seedEvidence(harness.session, record.id, WALL_EVIDENCE)
    const persistCallsBefore = harness.persistManifest.mock.calls.length

    harness.buildings.startFaceFit(record.id, 'wall')
    const fit = harness.buildings.getFaceFit()
    expect(fit).not.toBeNull()
    expect(fit!.fitted.length).toBeCloseTo(30, 5)
    expect(fit!.fitted.height).toBeCloseTo(12, 5)
    expect(harness.viewer.draftPreview).not.toBeNull()
    // Preview persists nothing.
    expect(harness.persistManifest.mock.calls.length).toBe(persistCallsBefore)

    await harness.buildings.acceptFaceFit()
    const updated = harness.session.manifest.features.find((candidate) => candidate.id === record.id)!
    const components = componentsOf(updated)
    expect(components.faces).toHaveLength(1)
    expect(components.faces[0]).toMatchObject({ name: 'Wall 1', kind: 'wall', visible: true })
    expect(components.faces[0]!.evidence.count).toBe(4)
    expect(components.faces[0]!.evidence.representative.length).toBeLessThanOrEqual(8)
    // Fitting never consumes the explicit evidence refs.
    expect(updated.evidenceRefs).toHaveLength(4)
    expect(harness.buildings.getFaceFit()).toBeNull()
    expect(harness.viewer.draftPreview).toBeNull()
  })

  it('rejects fits with too few or collinear evidence points, with a note', async () => {
    const harness = makeHarness()
    const record = await createEnvelopeBuilding(harness)
    seedEvidence(harness.session, record.id, [[0, 0, 0], [1, 0, 0]])
    harness.buildings.startFaceFit(record.id, 'wall')
    expect(harness.buildings.getFaceFit()).toBeNull()
    expect(harness.buildings.getFitNote()).toContain('at least 3 evidence points')

    seedEvidence(harness.session, record.id, [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]])
    harness.buildings.startFaceFit(record.id, 'wall')
    expect(harness.buildings.getFaceFit()).toBeNull()
    expect(harness.buildings.getFitNote()).toContain('collinear')
  })

  it('cancel drops the preview without persisting', async () => {
    const harness = makeHarness()
    const record = await createEnvelopeBuilding(harness)
    seedEvidence(harness.session, record.id, WALL_EVIDENCE)
    harness.buildings.startFaceFit(record.id, 'roof')
    expect(harness.buildings.getFaceFit()).not.toBeNull()
    harness.buildings.cancelFaceFit()
    expect(harness.buildings.getFaceFit()).toBeNull()
    expect(harness.viewer.draftPreview).toBeNull()
    expect(componentsOf(harness.session.manifest.features.find((candidate) => candidate.id === record.id)!).faces).toHaveLength(0)
  })

  it('refuses to start a fit while other authoring is in flight', async () => {
    const harness = makeHarness()
    const record = await createEnvelopeBuilding(harness)
    seedEvidence(harness.session, record.id, WALL_EVIDENCE)
    harness.features.startIsolateBoundary(record.id) // building is refinable now
    harness.buildings.startFaceFit(record.id, 'wall')
    expect(harness.buildings.getFaceFit()).toBeNull()
  })
})

describe('hosted features + face CRUD', () => {
  async function withWallFace(harness: ReturnType<typeof makeHarness>) {
    const record = await createEnvelopeBuilding(harness)
    seedEvidence(harness.session, record.id, WALL_EVIDENCE)
    harness.buildings.startFaceFit(record.id, 'wall')
    await harness.buildings.acceptFaceFit()
    const updated = harness.session.manifest.features.find((candidate) => candidate.id === record.id)!
    return { record: updated, faceId: componentsOf(updated).faces[0]!.id }
  }

  it('adds a door hosted by the face id with type defaults', async () => {
    const harness = makeHarness()
    const { record, faceId } = await withWallFace(harness)
    await harness.buildings.addFaceFeature(record.id, faceId, 'door')

    const components = componentsOf(harness.session.manifest.features.find((candidate) => candidate.id === record.id)!)
    expect(components.faceFeatures).toHaveLength(1)
    expect(components.faceFeatures[0]).toMatchObject({
      faceId,
      type: 'door',
      name: 'Door 1',
      width: 3,
      height: 7,
      offsetV: 0, // doors sit on the face bottom
      visible: true,
    })
    // Centered along the 30 ft face: (30 - 3) / 2.
    expect(components.faceFeatures[0]!.offsetU).toBeCloseTo(13.5, 5)
  })

  it('edits hosted-feature params, rejects non-positive sizes, toggles visibility', async () => {
    const harness = makeHarness()
    const { record, faceId } = await withWallFace(harness)
    await harness.buildings.addFaceFeature(record.id, faceId, 'window')
    const componentId = componentsOf(harness.session.manifest.features.find((c) => c.id === record.id)!).faceFeatures[0]!.id

    await harness.buildings.updateFaceFeatureParam(record.id, componentId, 'width', '4.5')
    await harness.buildings.updateFaceFeatureParam(record.id, componentId, 'height', '0') // rejected
    await harness.buildings.updateFaceFeatureParam(record.id, componentId, 'offsetV', '2.5')
    await harness.buildings.updateFaceFeatureType(record.id, componentId, 'opening')
    await harness.buildings.setFaceFeatureVisibility(record.id, componentId, false)

    const item = componentsOf(harness.session.manifest.features.find((c) => c.id === record.id)!).faceFeatures[0]!
    expect(item.width).toBe(4.5)
    expect(item.height).toBe(4) // unchanged, 0 rejected
    expect(item.offsetV).toBe(2.5)
    expect(item.type).toBe('opening')
    expect(item.visible).toBe(false)
  })

  it('renames and hides faces, and deleting a face removes its hosted features', async () => {
    const harness = makeHarness()
    const { record, faceId } = await withWallFace(harness)
    await harness.buildings.addFaceFeature(record.id, faceId, 'door')
    await harness.buildings.renameFace(record.id, faceId, 'North wall')
    await harness.buildings.setFaceVisibility(record.id, faceId, false)

    let components = componentsOf(harness.session.manifest.features.find((c) => c.id === record.id)!)
    expect(components.faces[0]).toMatchObject({ name: 'North wall', visible: false })

    await harness.buildings.removeFace(record.id, faceId)
    components = componentsOf(harness.session.manifest.features.find((c) => c.id === record.id)!)
    expect(components.faces).toHaveLength(0)
    expect(components.faceFeatures).toHaveLength(0)
  })
})
