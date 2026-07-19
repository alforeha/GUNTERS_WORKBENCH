import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LayerController } from '../src/ui/layers'
import type { ProjectSession } from '../src/shared/ipc'

interface PreviewLayerEntry {
  layerId: string
  assetId: string
  handle: string
  preview: {
    sampledPointCount: number
    totalPointCount: number
    warnings: string[]
    sourceAvailable: boolean
  }
}

interface IndexLayerEntry {
  layerId: string
  assetId: string
  sourceAssetId: string
  handle: string
}

interface LayerControllerInternals {
  viewer: {
    setGlobalShowWithin: ReturnType<typeof vi.fn>
    setPointCloudAppearance: ReturnType<typeof vi.fn>
    setPointCloudIndexAppearance: ReturnType<typeof vi.fn>
    setPointCloudIndexDisplay: ReturnType<typeof vi.fn>
    setPointCloudIndexDetail: ReturnType<typeof vi.fn>
    setPointCloudIndexWalkTargetActive: ReturnType<typeof vi.fn>
    getPointCloudDensifiedPointCount: ReturnType<typeof vi.fn>
    getPointCloudIndexDisclosure: ReturnType<typeof vi.fn>
    getPointCloudIndexIsolateDisclosure: ReturnType<typeof vi.fn>
    getAnalyticSurfelsDisclosure: ReturnType<typeof vi.fn>
  }
  session: ProjectSession
  previewLayers: Map<string, PreviewLayerEntry>
  indexLayers: Map<string, IndexLayerEntry>
}

function installWorkbenchStub(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      workbench: {
        onPointCloudPreviewProgress: vi.fn(),
        onPointCloudIndexProgress: vi.fn(),
        onAnalyticSurfelProgress: vi.fn(),
      },
    },
  })
}

function makeSession(): ProjectSession {
  return {
    manifest: {
      assets: [
        { id: 'source-asset', kind: 'point-cloud', name: 'Walkable cloud', pointCloud: { fileName: 'walk.las', units: 'usSurveyFoot' } },
        {
          id: 'index-asset',
          kind: 'point-cloud-index',
          name: 'Walkable cloud index',
          truthStatus: 'indexed-full',
          warnings: [],
          pointCloudIndex: { sourceAssetId: 'source-asset', indexVersion: 2, ownership: 'managed' },
        },
      ],
      simulationLayers: [
        { id: 'preview-layer', assetId: 'preview-asset', kind: 'asset', status: 'active' },
        { id: 'index-layer', assetId: 'index-asset', kind: 'asset', status: 'active' },
      ],
    },
  } as unknown as ProjectSession
}

describe('LayerController global Show Within', () => {
  beforeEach(() => {
    installWorkbenchStub()
  })

  it('forwards one global Show Within state to ViewerEngine and both point-cloud paths', () => {
    const onViewStateLines = vi.fn()
    const controller = new LayerController({} as HTMLElement, {
      onSessionChanged: vi.fn(),
      onTask: vi.fn(),
      onViewStateLines,
      onViewerCreated: vi.fn(),
    })
    const viewer = {
      setGlobalShowWithin: vi.fn(),
      setPointCloudAppearance: vi.fn(),
      setPointCloudIndexAppearance: vi.fn(),
      setPointCloudIndexDisplay: vi.fn(),
      setPointCloudIndexDetail: vi.fn(),
      setPointCloudIndexWalkTargetActive: vi.fn(),
      getPointCloudDensifiedPointCount: vi.fn(() => 0),
      getPointCloudIndexDisclosure: vi.fn(() => 'Indexed-full - streaming 1.0M of 2.0M points - refining'),
      getPointCloudIndexIsolateDisclosure: vi.fn(() => null),
      getAnalyticSurfelsDisclosure: vi.fn(() => null),
    }
    const internals = controller as unknown as LayerController & LayerControllerInternals

    internals.viewer = viewer
    internals.session = makeSession()
    internals.previewLayers.set('preview-layer', {
      layerId: 'preview-layer',
      assetId: 'preview-asset',
      handle: 'preview-handle',
      preview: { sampledPointCount: 1000, totalPointCount: 2000, warnings: [], sourceAvailable: true },
    })
    internals.indexLayers.set('index-layer', {
      layerId: 'index-layer',
      assetId: 'index-asset',
      sourceAssetId: 'preview-asset',
      handle: 'index-handle',
    })

    controller.setShowWithin(50)

    expect(viewer.setGlobalShowWithin).toHaveBeenCalledWith(50)
    expect(viewer.setPointCloudAppearance).toHaveBeenCalledWith(
      'preview-handle',
      expect.objectContaining({ rangeClipFt: 50 }),
    )
    expect(viewer.setPointCloudIndexAppearance).toHaveBeenCalledWith(
      'index-handle',
      expect.objectContaining({ rangeClipFt: 50 }),
    )

    const lines = onViewStateLines.mock.calls.at(-1)?.[0] as string[]
    expect(lines.filter((line) => line === 'Display: showing within 50 ft')).toHaveLength(1)
  })

  it('keeps a hidden index layer active for walk without forcing it visible', async () => {
    const controller = new LayerController({} as HTMLElement, {
      onSessionChanged: vi.fn(),
      onTask: vi.fn(),
      onViewStateLines: vi.fn(),
      onViewerCreated: vi.fn(),
    })
    const viewer = {
      setGlobalShowWithin: vi.fn(),
      setPointCloudAppearance: vi.fn(),
      setPointCloudIndexAppearance: vi.fn(),
      setPointCloudIndexDisplay: vi.fn(),
      setPointCloudIndexDetail: vi.fn(),
      setPointCloudIndexWalkTargetActive: vi.fn(),
      getPointCloudDensifiedPointCount: vi.fn(() => 0),
      getPointCloudIndexDisclosure: vi.fn(() => null),
      getPointCloudIndexIsolateDisclosure: vi.fn(() => null),
      getAnalyticSurfelsDisclosure: vi.fn(() => null),
    }
    const internals = controller as unknown as LayerController & LayerControllerInternals
    internals.viewer = viewer
    internals.session = makeSession()
    internals.session.manifest.simulationLayers[1]!.status = 'hidden'
    internals.indexLayers.set('index-layer', {
      layerId: 'index-layer',
      assetId: 'index-asset',
      sourceAssetId: 'source-asset',
      handle: 'index-handle',
    })

    const result = await controller.startIndexedPointCloudWalk('source-asset')

    expect(result).toEqual({ ok: true, handle: 'index-handle', label: 'Walkable cloud' })
    expect(viewer.setPointCloudIndexWalkTargetActive).toHaveBeenCalledWith('index-handle', true)
    expect(viewer.setPointCloudIndexDisplay).not.toHaveBeenCalledWith('index-handle', true, expect.anything())

    controller.endWalkTarget()
    expect(viewer.setPointCloudIndexWalkTargetActive).toHaveBeenCalledWith('index-handle', false)
  })
})