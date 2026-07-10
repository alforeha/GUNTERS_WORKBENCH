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

  startFeatureAuthoring(family: Parameters<AuthoringMachine['start']>[0], templateId: string | null, mode?: AuthoringGeometryMode): AuthoringSnapshot {
    this.machine.start(family, templateId, mode)
    return this.machine.snapshot()
  }

  placeFeatureVertexAtPointer(): AuthoringSnapshot {
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
  it('consumes object clicks and moves point authoring to review', () => {
    const { controller } = makeController()
    controller.startObject('object.tree')

    expect(controller.handleViewerClick()).toBe(true)
    expect(controller.getSimpleAuthoring()).toMatchObject({
      family: 'object',
      phase: 'review',
      vertexCount: 1,
      freeCount: 1,
    })
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
})
