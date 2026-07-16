import { describe, expect, it, vi } from 'vitest'
import { FeatureController } from './features'
import type { ProjectSession } from '../shared/ipc'
import type { ProjectManifest } from '../shared/workbench-types'
import { readRegionMetadata } from '../shared/regionMetadata'
import type { AuthoringGeometryMode, AuthoringSnapshot } from '../viewer/authoring'
import { AuthoringMachine } from '../viewer/authoring'
import type { PlacementResolution } from '../viewer/snap'
import { makeManifest } from '../../tests/ui-fixtures'

class FakeViewer {
  readonly machine = new AuthoringMachine()
  point = 0
  nextPlacements: [number, number, number][] = []
  lastAllowSnap = true
  authoredEntries: Array<{ featureId: string; fill?: unknown; lines: unknown[] }> = []
  focusOverlay: { boundary: unknown; evidence: unknown[]; origin: unknown } | null = null
  isolateFocus: unknown = 'unset'
  nextEvidence: { world: [number, number, number]; evidence: { kind: string; coordinate: [number, number, number] } } | null = null

  startFeatureAuthoring(family: Parameters<AuthoringMachine['start']>[0], templateId: string | null, mode?: AuthoringGeometryMode): AuthoringSnapshot {
    this.machine.start(family, templateId, mode)
    return this.machine.snapshot()
  }

  placeFeatureVertexAtPointer(_tolerancePx?: number, allowSnap = true): AuthoringSnapshot {
    this.lastAllowSnap = allowSnap
    const world = this.nextPlacements.shift() ?? [this.point++, 0, 0]
    const placement: PlacementResolution = { snapped: false, world }
    this.machine.place(placement)
    return this.machine.snapshot()
  }

  requestCloseFeatureAuthoring(): AuthoringSnapshot {
    this.machine.requestClose()
    return this.machine.snapshot()
  }

  confirmFeatureAuthoring(): AuthoringSnapshot {
    this.machine.confirm()
    return this.machine.snapshot()
  }

  cancelFeatureAuthoring(): AuthoringSnapshot {
    this.machine.cancel()
    return this.machine.snapshot()
  }

  getFeatureAuthoringSnapshot(): AuthoringSnapshot {
    return this.machine.snapshot()
  }

  setAuthoringDraftPreview(): void {}

  setSnapPreview(): void {}

  setAuthoredFeatures(entries: Array<{ featureId: string; fill?: unknown; lines: unknown[] }>): void {
    this.authoredEntries = entries
  }

  setFeatureFocusOverlay(overlay: { boundary: unknown; evidence: unknown[]; origin: unknown } | null): void {
    this.focusOverlay = overlay
  }

  setIsolateFocus(boundary: unknown): void {
    this.isolateFocus = boundary
  }

  setEvidencePickActive(): void {}

  windowPicks: { world: [number, number, number]; evidence: { kind: string; coordinate: [number, number, number] } }[] | null = null
  windowTotal: number | null = null

  armEvidenceWindow(): Promise<{ picks: NonNullable<FakeViewer['windowPicks']>; total: number } | null> {
    if (!this.windowPicks) return Promise.resolve(null)
    return Promise.resolve({ picks: this.windowPicks, total: this.windowTotal ?? this.windowPicks.length })
  }

  cancelEvidenceWindow(): void {}

  isolateSectors: { minX: number; minY: number; maxX: number; maxY: number }[] | null = null
  isolateLoadRegion: unknown = 'unset'

  planIsolateSectors(boundary: [number, number, number][]): { minX: number; minY: number; maxX: number; maxY: number }[] {
    if (this.isolateSectors) return this.isolateSectors
    const xs = boundary.map((v) => v[0])
    const ys = boundary.map((v) => v[1])
    return [{ minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }]
  }

  setIsolateLoadRegion(region: unknown): void {
    this.isolateLoadRegion = region
  }

  resolveEvidenceAtPointer(): FakeViewer['nextEvidence'] {
    return this.nextEvidence
  }
}

function makeObjectFeature(id: string, manifest: ProjectManifest): void {
  manifest.features.push({
    id,
    simulationId: manifest.realitySimulation.id,
    type: 'marker',
    name: 'Box 1',
    geometry: { point: [10, 20, 5] },
    createdAt: '2026-07-12T00:00:00.000Z',
    modifiedAt: '2026-07-12T00:00:00.000Z',
    family: 'object',
    templateId: 'object.box',
    subtype: 'box',
    parameters: { width: 4, depth: 6, height: 8, rotationYaw: 0 },
    evidenceRefs: [{ kind: 'asset-point', coordinate: [10, 20, 5] }],
    display: { visible: true },
    metadata: {},
  })
}

function makeRegionFeature(id: string, manifest: ProjectManifest): void {
  manifest.features.push({
    id,
    simulationId: manifest.realitySimulation.id,
    type: 'polyline',
    name: 'Region 1 (generic)',
    geometry: {
      border: [
        [0, 0, 10],
        [10, 0, 11],
        [10, 10, 12],
        [0, 10, 13],
      ],
      closed: true,
      breaklines: [],
    },
    createdAt: '2026-07-16T00:00:00.000Z',
    modifiedAt: '2026-07-16T00:00:00.000Z',
    family: 'region',
    templateId: 'region.generic',
    subtype: 'generic',
    parameters: { heightBehavior: 'drape', verticalScale: 0, appearancePreset: 'default' },
    evidenceRefs: [],
    display: { visible: true },
    metadata: {
      region: {
        edgeEvidence: [
          { kind: 'asset-point', coordinate: [0, 0, 10] },
          { kind: 'asset-point', coordinate: [10, 0, 11] },
        ],
        interiorEvidence: [],
        surfacePoints: [],
        surface: null,
        visibility: {
          boundary: true,
          surface: true,
          surfacePoints: true,
          breaklines: true,
          edgeEvidence: false,
          interiorEvidence: false,
          wireframe: true,
        },
        gridSpacing: 10,
      },
    },
  })
}

function makeController() {
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
  const controller = new FeatureController({
    getSession: () => session,
    getViewer: () => viewer as never,
    ensureViewer: () => viewer as never,
    persistManifest,
    onAuthoringChanged: vi.fn(),
  })
  return { controller, session, viewer, persistManifest }
}

describe('FeatureController simple-family click bridge', () => {
  it('persists an object immediately after placement', async () => {
    const { controller, session } = makeController()
    controller.startObjectCreation()

    expect(controller.handleViewerClick()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(controller.getSimpleAuthoring()).toBeNull()
    expect(session.manifest.features.at(-1)).toMatchObject({
      family: 'object',
      templateId: 'object.box',
      subtype: 'box',
      geometry: { point: [0, 0, 0] },
    })
    expect(session.manifest.features.at(-1)?.evidenceRefs).toHaveLength(1)
  })

  it('uses manual placement mode to bypass snapping for object placement', () => {
    const { controller, viewer } = makeController()
    controller.startObjectCreation()
    controller.setObjectPlacementMode('manual')

    expect(controller.handleViewerClick()).toBe(true)
    expect(viewer.lastAllowSnap).toBe(false)
  })

  it('consumes line clicks, then reviews a two-vertex line', () => {
    const { controller } = makeController()
    controller.startLine('line.curb')

    expect(controller.handleViewerClick()).toBe(true)
    expect(controller.handleViewerClick()).toBe(true)
    expect(controller.getSimpleAuthoring()).toMatchObject({
      family: 'line',
      phase: 'placing',
      activeVertexCount: 2,
      canReview: true,
    })

    controller.reviewSimpleFeature()
    expect(controller.getSimpleAuthoring()).toMatchObject({
      family: 'line',
      phase: 'review',
      vertexCount: 2,
    })
  })

  it('regenerates visible object display entries and skips hidden ones', () => {
    const { controller, session, viewer } = makeController()
    session.manifest.features.push({
      id: 'feat-object-visible',
      simulationId: session.manifest.realitySimulation.id,
      type: 'marker',
      name: 'Box 1',
      geometry: { point: [10, 20, 5] },
      createdAt: '2026-07-12T00:00:00.000Z',
      modifiedAt: '2026-07-12T00:00:00.000Z',
      family: 'object',
      templateId: 'object.box',
      subtype: 'box',
      parameters: { width: 4, depth: 6, height: 8, rotationYaw: 0 },
      display: { visible: true },
    })
    session.manifest.features.push({
      id: 'feat-object-hidden',
      simulationId: session.manifest.realitySimulation.id,
      type: 'marker',
      name: 'Hidden Box',
      geometry: { point: [0, 0, 0] },
      createdAt: '2026-07-12T00:00:00.000Z',
      modifiedAt: '2026-07-12T00:00:00.000Z',
      family: 'object',
      templateId: 'object.box',
      subtype: 'box',
      parameters: { width: 4, depth: 4, height: 4, rotationYaw: 0 },
      display: { visible: false },
    })

    controller.refreshDisplays()

    expect(viewer.authoredEntries).toHaveLength(1)
    expect(viewer.authoredEntries[0]).toMatchObject({ featureId: 'feat-object-visible' })
    expect(viewer.authoredEntries[0]?.fill).toBeDefined()
    expect(viewer.authoredEntries[0]?.lines.length).toBeGreaterThan(0)
  })
})

describe('FeatureController isolate area', () => {
  it('stores a drawn boundary on the object without adding evidence', async () => {
    const { controller, session } = makeController()
    makeObjectFeature('feat-obj', session.manifest)

    controller.startIsolateBoundary('feat-obj')
    expect(controller.getObjectEdit()).toMatchObject({ featureId: 'feat-obj', kind: 'isolate', canFinish: false })
    expect(controller.handleViewerClick()).toBe(true)
    expect(controller.handleViewerClick()).toBe(true)
    expect(controller.handleViewerClick()).toBe(true)
    expect(controller.getObjectEdit()).toMatchObject({ activeVertexCount: 3, canFinish: true })

    await controller.finishIsolateBoundary()

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-obj')
    expect(feature?.metadata?.isolateBoundary).toEqual({
      polygon: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
    })
    // Isolate is context, never evidence: refs are untouched.
    expect(feature?.evidenceRefs).toHaveLength(1)
    expect(controller.getObjectEdit()).toBeNull()
  })

  it('refuses to close a boundary with fewer than 3 vertices', async () => {
    const { controller, session, persistManifest } = makeController()
    makeObjectFeature('feat-obj', session.manifest)

    controller.startIsolateBoundary('feat-obj')
    controller.handleViewerClick()
    controller.handleViewerClick()
    await controller.finishIsolateBoundary()

    expect(persistManifest).not.toHaveBeenCalled()
    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-obj')
    expect(feature?.metadata?.isolateBoundary).toBeUndefined()
  })

  it('clears a stored boundary', async () => {
    const { controller, session } = makeController()
    makeObjectFeature('feat-obj', session.manifest)
    session.manifest.features.at(-1)!.metadata = {
      isolateBoundary: { polygon: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] },
    }

    await controller.clearIsolateBoundary('feat-obj')

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-obj')
    expect(feature?.metadata?.isolateBoundary).toBeUndefined()
  })
})

describe('FeatureController regions', () => {
  it('stores the drawn boundary as authored geometry and edge evidence, not ordinary evidence refs', async () => {
    const { controller, session } = makeController()
    controller.startRegion('region.generic')
    controller.handleViewerClick()
    controller.handleViewerClick()
    controller.handleViewerClick()
    controller.closeBorder()

    await controller.finishRegion()

    const feature = session.manifest.features.at(-1)
    expect(feature).toMatchObject({
      family: 'region',
      templateId: 'region.generic',
      geometry: { border: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], closed: true },
      evidenceRefs: [],
    })
    const region = readRegionMetadata(feature!)
    expect(region.edgeEvidence).toHaveLength(3)
    expect(region.interiorEvidence).toHaveLength(0)
  })

  it('adds a manual surface point with preserved provenance', async () => {
    const { controller, session } = makeController()
    makeRegionFeature('feat-region', session.manifest)

    controller.startRegionSurfacePoint('feat-region')
    expect(controller.handleViewerClick()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-region')!
    const region = readRegionMetadata(feature)
    expect(region.surfacePoints).toHaveLength(1)
    expect(region.surfacePoints[0]).toMatchObject({ coordinate: [0, 0, 0], source: 'manual' })
    expect(region.surfacePoints[0]?.evidence).toMatchObject({ kind: 'picked-coordinate', coordinate: [0, 0, 0] })
  })

  it('persists a region breakline separately from the boundary geometry', async () => {
    const { controller, session, viewer } = makeController()
    makeRegionFeature('feat-region', session.manifest)

    controller.startRegionBreakline('feat-region')
    viewer.nextPlacements = [
      [3, 3, 10],
      [7, 7, 12],
    ]
    controller.handleViewerClick()
    controller.handleViewerClick()
    await controller.finishRegionBreakline()

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-region')!
    expect(feature.geometry).toMatchObject({ breaklines: [[[3, 3, 10], [7, 7, 12]]] })
    await controller.generateRegionSurface('feat-region')
    const region = readRegionMetadata(session.manifest.features.find((candidate) => candidate.id === 'feat-region')!)
    const surfacePositions = region.surface?.positions ?? []
    expect(region.surface).not.toBeNull()
    expect(surfacePositions).toContain(3)
    expect(surfacePositions).toContain(7)
  })

  it('adds generated flat grid points inside the region boundary with source labeling', async () => {
    const { controller, session } = makeController()
    makeRegionFeature('feat-region', session.manifest)

    await controller.addRegionGridPoints('feat-region', '5')

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-region')!
    const region = readRegionMetadata(feature)
    expect(region.surfacePoints.length).toBeGreaterThan(0)
    expect(region.gridMode).toBe('generated-flat')
    expect(region.surfacePoints.every((point) => point.source === 'generated-grid')).toBe(true)
    expect(region.surfacePoints.every((point) => point.coordinate[0] > 0 && point.coordinate[0] < 10)).toBe(true)
    expect(region.surfacePoints.every((point) => point.coordinate[1] > 0 && point.coordinate[1] < 10)).toBe(true)
  })

  it('generates a stored surface mesh with triangle and elevation stats', async () => {
    const { controller, session } = makeController()
    makeRegionFeature('feat-region', session.manifest)
    await controller.addRegionGridPoints('feat-region', '5')

    await controller.generateRegionSurface('feat-region')

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-region')!
    const region = readRegionMetadata(feature)
    expect(region.surface).not.toBeNull()
    expect(region.surface?.triangleCount).toBeGreaterThan(0)
    expect(region.surface?.positions.length).toBeGreaterThan(0)
    expect(region.surface?.minElevation).not.toBeNull()
  })

  it('uses the region boundary as the default focus/isolate boundary', () => {
    const { controller, session, viewer } = makeController()
    makeRegionFeature('feat-region', session.manifest)

    controller.setFocusedFeature('feat-region')

    expect(viewer.focusOverlay).toMatchObject({
      boundary: [[0, 0, 10], [10, 0, 11], [10, 10, 12], [0, 10, 13]],
      evidence: [[0, 0, 10], [10, 0, 11]],
      origin: null,
    })
    expect(viewer.isolateFocus).toEqual([[0, 0, 10], [10, 0, 11], [10, 10, 12], [0, 10, 13]])
  })

  it('supports Show All by clearing region focus while leaving the region record intact', () => {
    const { controller, session, viewer } = makeController()
    makeRegionFeature('feat-region', session.manifest)

    controller.setFocusedFeature('feat-region')
    controller.setFocusedFeature(null)

    expect(viewer.focusOverlay).toBeNull()
    expect(viewer.isolateFocus).toBeNull()
  })

  it('redraws the region boundary and refreshes edge provenance', async () => {
    const { controller, session } = makeController()
    makeRegionFeature('feat-region', session.manifest)

    controller.startRegionBoundaryRedraw('feat-region')
    controller.handleViewerClick()
    controller.handleViewerClick()
    controller.handleViewerClick()
    await controller.finishRegionBoundaryRedraw()

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-region')!
    expect(feature.geometry).toMatchObject({ border: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], closed: true })
    const region = readRegionMetadata(feature)
    expect(region.edgeEvidence).toHaveLength(3)
  })
})

describe('FeatureController explicit evidence', () => {
  it('adds a snapped pick as one evidence ref and keeps the mode active', async () => {
    const { controller, session, viewer } = makeController()
    makeObjectFeature('feat-obj', session.manifest)

    controller.startEvidencePick('feat-obj')
    viewer.nextEvidence = { world: [3, 4, 5], evidence: { kind: 'asset-point', coordinate: [3, 4, 5] } }
    expect(controller.handleViewerClick()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-obj')
    expect(feature?.evidenceRefs).toHaveLength(2)
    expect(feature?.evidenceRefs?.at(-1)).toMatchObject({ kind: 'asset-point', coordinate: [3, 4, 5] })
    expect(controller.getObjectEdit()).toMatchObject({ featureId: 'feat-obj', kind: 'evidence' })
  })

  it('ignores unsnapped clicks and exact duplicates', async () => {
    const { controller, session, viewer, persistManifest } = makeController()
    makeObjectFeature('feat-obj', session.manifest)

    controller.startEvidencePick('feat-obj')
    viewer.nextEvidence = null
    controller.handleViewerClick()
    await Promise.resolve()
    expect(persistManifest).not.toHaveBeenCalled()

    // Duplicate of the placement ref already stored at [10, 20, 5].
    viewer.nextEvidence = { world: [10, 20, 5], evidence: { kind: 'asset-point', coordinate: [10, 20, 5] } }
    controller.handleViewerClick()
    await Promise.resolve()
    await Promise.resolve()
    expect(persistManifest).not.toHaveBeenCalled()
  })

  it('window selection stores picks as evidence refs in one persist, skipping duplicates', async () => {
    const { controller, session, viewer, persistManifest } = makeController()
    makeObjectFeature('feat-obj', session.manifest)

    controller.startEvidencePick('feat-obj')
    viewer.windowPicks = [
      { world: [1, 1, 1], evidence: { kind: 'asset-point', coordinate: [1, 1, 1] } },
      // Duplicate of the placement ref already stored at [10, 20, 5].
      { world: [10, 20, 5], evidence: { kind: 'asset-point', coordinate: [10, 20, 5] } },
      { world: [2, 2, 2], evidence: { kind: 'asset-point', coordinate: [2, 2, 2] } },
    ]
    await controller.selectEvidenceWindow()

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-obj')
    expect(feature?.evidenceRefs).toHaveLength(3)
    expect(feature?.evidenceRefs?.map((ref) => ref.coordinate)).toEqual([
      [10, 20, 5],
      [1, 1, 1],
      [2, 2, 2],
    ])
    expect(persistManifest).toHaveBeenCalledTimes(1)
    // Mode stays active for further picks.
    expect(controller.getObjectEdit()).toMatchObject({ featureId: 'feat-obj', kind: 'evidence' })
  })

  it('window selection is a no-op when cancelled or outside evidence mode', async () => {
    const { controller, session, viewer, persistManifest } = makeController()
    makeObjectFeature('feat-obj', session.manifest)

    // Not in evidence mode: nothing happens.
    viewer.windowPicks = [{ world: [1, 1, 1], evidence: { kind: 'asset-point', coordinate: [1, 1, 1] } }]
    await controller.selectEvidenceWindow()
    expect(persistManifest).not.toHaveBeenCalled()

    // Cancelled drag resolves null: nothing happens.
    controller.startEvidencePick('feat-obj')
    viewer.windowPicks = null
    await controller.selectEvidenceWindow()
    expect(persistManifest).not.toHaveBeenCalled()
  })

  it('removes an evidence ref by index', async () => {
    const { controller, session } = makeController()
    makeObjectFeature('feat-obj', session.manifest)

    await controller.removeEvidenceRef('feat-obj', 0)

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-obj')
    expect(feature?.evidenceRefs).toHaveLength(0)
  })

  it('clears all evidence refs at once', async () => {
    const { controller, session, viewer } = makeController()
    makeObjectFeature('feat-obj', session.manifest)
    controller.startEvidencePick('feat-obj')
    viewer.windowPicks = [
      { world: [1, 1, 1], evidence: { kind: 'asset-point', coordinate: [1, 1, 1] } },
      { world: [2, 2, 2], evidence: { kind: 'asset-point', coordinate: [2, 2, 2] } },
    ]
    await controller.selectEvidenceWindow()

    await controller.clearEvidenceRefs('feat-obj')

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-obj')
    expect(feature?.evidenceRefs).toHaveLength(0)
  })
})

describe('FeatureController isolate load-all', () => {
  const boundaryMetadata = { isolateBoundary: { polygon: [[0, 0, 5], [8, 0, 5], [8, 8, 5], [0, 8, 5]] } }

  it('activates full-density streaming and steps through planned sectors', () => {
    const { controller, session, viewer } = makeController()
    makeObjectFeature('feat-obj', session.manifest)
    session.manifest.features.at(-1)!.metadata = structuredClone(boundaryMetadata)
    viewer.isolateSectors = [
      { minX: 0, minY: 0, maxX: 4, maxY: 8 },
      { minX: 4, minY: 0, maxX: 8, maxY: 8 },
    ]
    controller.setFocusedFeature('feat-obj')

    controller.startIsolateLoadAll('feat-obj')
    expect(controller.getIsolateLoad()).toMatchObject({ featureId: 'feat-obj', sectorCount: 2, activeSector: 0 })
    expect(viewer.isolateLoadRegion).toEqual(viewer.isolateSectors[0])

    controller.stepIsolateSector(1)
    expect(controller.getIsolateLoad()).toMatchObject({ activeSector: 1 })
    expect(viewer.isolateLoadRegion).toEqual(viewer.isolateSectors[1])

    controller.stepIsolateSector(1) // wraps
    expect(controller.getIsolateLoad()).toMatchObject({ activeSector: 0 })

    controller.stopIsolateLoadAll()
    expect(controller.getIsolateLoad()).toBeNull()
    expect(viewer.isolateLoadRegion).toBeNull()
  })

  it('requires a stored boundary and clears when focus moves elsewhere', () => {
    const { controller, session, viewer } = makeController()
    makeObjectFeature('feat-obj', session.manifest)
    controller.startIsolateLoadAll('feat-obj') // no boundary drawn
    expect(controller.getIsolateLoad()).toBeNull()

    session.manifest.features.at(-1)!.metadata = structuredClone(boundaryMetadata)
    controller.startIsolateLoadAll('feat-obj')
    expect(controller.getIsolateLoad()).not.toBeNull()

    controller.setFocusedFeature(null)
    expect(controller.getIsolateLoad()).toBeNull()
    expect(viewer.isolateLoadRegion).toBeNull()
  })
})

function makeUtilityFeature(id: string, manifest: ProjectManifest, templateId = 'utility.storm-manhole'): void {
  manifest.features.push({
    id,
    simulationId: manifest.realitySimulation.id,
    type: 'marker',
    name: 'Storm Manhole 1',
    geometry: { point: [10, 20, 5] },
    createdAt: '2026-07-13T00:00:00.000Z',
    modifiedAt: '2026-07-13T00:00:00.000Z',
    family: 'utility',
    templateId,
    subtype: templateId.split('.')[1]!,
    parameters: { diameter: 4, depth: 8 },
    evidenceRefs: [{ kind: 'asset-point', coordinate: [10, 20, 5] }],
    display: { visible: true },
    metadata: { utilitySystem: 'storm', utilityClass: 'manhole' },
  })
}

describe('FeatureController utility authoring', () => {
  it('persists a point utility immediately after placement with system/class metadata', async () => {
    const { controller, session } = makeController()
    controller.startUtility('utility.storm-manhole')
    expect(controller.getSimpleAuthoring()).toMatchObject({ family: 'utility', geometry: 'point' })

    expect(controller.handleViewerClick()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(controller.getSimpleAuthoring()).toBeNull()
    const record = session.manifest.features.at(-1)
    expect(record).toMatchObject({
      family: 'utility',
      templateId: 'utility.storm-manhole',
      subtype: 'storm-manhole',
      type: 'marker',
      name: 'Storm Manhole 1',
      geometry: { point: [0, 0, 0] },
      metadata: { utilitySystem: 'storm', utilityClass: 'manhole' },
    })
    expect(record?.parameters).toMatchObject({ diameter: 4, depth: 8, lidType: 'solid' })
    expect(record?.evidenceRefs).toHaveLength(1)
  })

  it('collects a line utility as a 2+ point run through review and finish', async () => {
    const { controller, session } = makeController()
    controller.startUtility('utility.storm-pipe')
    expect(controller.getSimpleAuthoring()).toMatchObject({ family: 'utility', geometry: 'polyline', canReview: false })

    expect(controller.handleViewerClick()).toBe(true)
    expect(controller.getSimpleAuthoring()).toMatchObject({ activeVertexCount: 1, canReview: false })
    expect(controller.handleViewerClick()).toBe(true)
    expect(controller.getSimpleAuthoring()).toMatchObject({ activeVertexCount: 2, canReview: true })

    controller.reviewSimpleFeature()
    expect(controller.getSimpleAuthoring()).toMatchObject({ phase: 'review', vertexCount: 2 })

    await controller.finishSimpleFeature()
    const record = session.manifest.features.at(-1)
    expect(record).toMatchObject({
      family: 'utility',
      templateId: 'utility.storm-pipe',
      type: 'polyline',
      name: 'Storm Pipe/Line 1',
      geometry: { vertices: [[0, 0, 0], [1, 0, 0]] },
      metadata: { utilitySystem: 'storm', utilityClass: 'pipe' },
    })
    expect(record?.evidenceRefs).toHaveLength(2)
  })

  it('stores a stub run the same way (partial line, endpoint assumed by class)', async () => {
    const { controller, session } = makeController()
    controller.startUtility('utility.generic-stub')
    controller.handleViewerClick()
    controller.handleViewerClick()
    controller.reviewSimpleFeature()
    await controller.finishSimpleFeature()

    expect(session.manifest.features.at(-1)).toMatchObject({
      family: 'utility',
      templateId: 'utility.generic-stub',
      type: 'polyline',
      metadata: { utilitySystem: 'generic', utilityClass: 'stub' },
    })
  })

  it('regenerates visible utility display entries and skips hidden ones', () => {
    const { controller, session, viewer } = makeController()
    makeUtilityFeature('feat-util-visible', session.manifest)
    makeUtilityFeature('feat-util-hidden', session.manifest)
    session.manifest.features.at(-1)!.display = { visible: false }

    controller.refreshDisplays()

    expect(viewer.authoredEntries).toHaveLength(1)
    expect(viewer.authoredEntries[0]).toMatchObject({ featureId: 'feat-util-visible' })
    expect(viewer.authoredEntries[0]?.fill).toBeDefined()
  })

  it('re-types a utility only within the same geometry kind', async () => {
    const { controller, session } = makeController()
    makeUtilityFeature('feat-util', session.manifest)

    // Point -> line refused; the stored record is untouched.
    await controller.updateUtilityTemplate('feat-util', 'utility.storm-pipe')
    expect(session.manifest.features.at(-1)).toMatchObject({ templateId: 'utility.storm-manhole' })

    // Point -> point re-types and remaps shared params by name.
    await controller.updateUtilityTemplate('feat-util', 'utility.generic-manhole')
    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-util')
    expect(feature).toMatchObject({
      templateId: 'utility.generic-manhole',
      subtype: 'generic-manhole',
      metadata: { utilitySystem: 'generic', utilityClass: 'manhole' },
    })
    expect(feature?.parameters).toMatchObject({ diameter: 4, depth: 8 })
  })
})

describe('FeatureController utility isolate + evidence', () => {
  it('stores an isolate boundary on a utility without adding evidence', async () => {
    const { controller, session } = makeController()
    makeUtilityFeature('feat-util', session.manifest)

    controller.startIsolateBoundary('feat-util')
    expect(controller.getObjectEdit()).toMatchObject({ featureId: 'feat-util', kind: 'isolate' })
    controller.handleViewerClick()
    controller.handleViewerClick()
    controller.handleViewerClick()
    await controller.finishIsolateBoundary()

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-util')
    expect(feature?.metadata?.isolateBoundary).toEqual({
      polygon: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
    })
    expect(feature?.evidenceRefs).toHaveLength(1)
  })

  it('adds explicit evidence picks to a utility', async () => {
    const { controller, session, viewer } = makeController()
    makeUtilityFeature('feat-util', session.manifest)

    controller.startEvidencePick('feat-util')
    viewer.nextEvidence = { world: [3, 4, 5], evidence: { kind: 'asset-point', coordinate: [3, 4, 5] } }
    expect(controller.handleViewerClick()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()

    const feature = session.manifest.features.find((candidate) => candidate.id === 'feat-util')
    expect(feature?.evidenceRefs).toHaveLength(2)
    expect(feature?.evidenceRefs?.at(-1)).toMatchObject({ kind: 'asset-point', coordinate: [3, 4, 5] })
  })

  it('publishes the focus overlay for a focused utility (origin at the pin)', () => {
    const { controller, session, viewer } = makeController()
    makeUtilityFeature('feat-util', session.manifest)

    controller.setFocusedFeature('feat-util')
    expect(viewer.focusOverlay).toMatchObject({ origin: [10, 20, 5], evidence: [[10, 20, 5]] })

    controller.setFocusedFeature(null)
    expect(viewer.focusOverlay).toBeNull()
  })
})

describe('FeatureController focus overlay', () => {
  it('publishes boundary, evidence, and origin for the focused object', () => {
    const { controller, session, viewer } = makeController()
    makeObjectFeature('feat-obj', session.manifest)
    session.manifest.features.at(-1)!.metadata = {
      isolateBoundary: { polygon: [[0, 0, 0], [4, 0, 0], [4, 4, 0]] },
    }

    controller.setFocusedFeature('feat-obj')
    expect(viewer.focusOverlay).toMatchObject({
      boundary: [[0, 0, 0], [4, 0, 0], [4, 4, 0]],
      evidence: [[10, 20, 5]],
      origin: [10, 20, 5],
    })
    // Focus mode isolates the viewer to the boundary while the object is open.
    expect(viewer.isolateFocus).toEqual([[0, 0, 0], [4, 0, 0], [4, 4, 0]])

    controller.setFocusedFeature(null)
    expect(viewer.focusOverlay).toBeNull()
    expect(viewer.isolateFocus).toBeNull()
  })

  it('keeps the viewer unisolated for objects without a boundary', () => {
    const { controller, session, viewer } = makeController()
    makeObjectFeature('feat-obj', session.manifest)

    controller.setFocusedFeature('feat-obj')

    expect(viewer.focusOverlay).toMatchObject({ boundary: null })
    expect(viewer.isolateFocus).toBeNull()
  })
})
