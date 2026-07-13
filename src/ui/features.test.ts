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
