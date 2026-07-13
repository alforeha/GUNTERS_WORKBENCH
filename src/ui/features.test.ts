import { describe, expect, it, vi } from 'vitest'
import { FeatureController } from './features'
import type { ProjectSession } from '../shared/ipc'
import type { ProjectManifest } from '../shared/workbench-types'
import type { AuthoringGeometryMode, AuthoringSnapshot } from '../viewer/authoring'
import { AuthoringMachine } from '../viewer/authoring'
import type { PlacementResolution } from '../viewer/snap'
import { makeManifest } from '../../tests/ui-fixtures'

class FakeViewer {
  readonly machine = new AuthoringMachine()
  point = 0
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
    const placement: PlacementResolution = { snapped: false, world: [this.point++, 0, 0] }
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
