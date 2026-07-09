// tests/ui-manifest-drift.test.ts - asserts the display UI cannot drift the
// manifest shape: the only writes are layer status/modifiedAt updates (plus
// the disclosed asset-removal path), and the view-model builders never mutate
// their input at all.

import { describe, expect, it } from 'vitest'
import {
  applyLayerErrorStatus,
  applyLayerStatusUpdates,
  buildPointCloudCards,
  buildSimPanelModel,
  buildSurfaceCards,
  buildWorkSurfaceModel,
  removeAssetFromManifest,
} from '../src/ui/model'
import {
  INDEX_ASSET_ID,
  INDEX_LAYER_ID,
  PREVIEW_LAYER_ID,
  SOURCE_ASSET_ID,
  SURFEL_ASSET_ID,
  SURFEL_LAYER_ID,
  deepFreeze,
  makeManifest,
} from './ui-fixtures'
import type { ProjectManifest } from '../src/shared/workbench-types'

/** Deep-copies `manifest`, then overwrites status/modifiedAt on the given layers
 *  from `reference` so a comparison isolates every OTHER field. */
function normalizeLayerWrites(manifest: ProjectManifest, reference: ProjectManifest, layerIds: string[]): ProjectManifest {
  const copy = structuredClone(manifest)
  for (const layerId of layerIds) {
    const layer = copy.simulationLayers.find((candidate) => candidate.id === layerId)
    const ref = reference.simulationLayers.find((candidate) => candidate.id === layerId)
    if (layer && ref) {
      layer.status = ref.status
      layer.modifiedAt = ref.modifiedAt
    }
  }
  return copy
}

describe('applyLayerStatusUpdates', () => {
  it('changes only status and modifiedAt on the targeted layers', () => {
    const original = deepFreeze(makeManifest())
    const next = applyLayerStatusUpdates(original, [
      { layerId: PREVIEW_LAYER_ID, visible: false },
      { layerId: SURFEL_LAYER_ID, visible: true },
    ])

    const preview = next.simulationLayers.find((layer) => layer.id === PREVIEW_LAYER_ID)
    const surfel = next.simulationLayers.find((layer) => layer.id === SURFEL_LAYER_ID)
    expect(preview?.status).toBe('hidden')
    expect(surfel?.status).toBe('active')

    const normalized = normalizeLayerWrites(next, original, [PREVIEW_LAYER_ID, SURFEL_LAYER_ID])
    expect(normalized).toEqual(original)
  })

  it('does not mutate the input manifest', () => {
    const original = deepFreeze(makeManifest())
    expect(() => applyLayerStatusUpdates(original, [{ layerId: PREVIEW_LAYER_ID, visible: false }])).not.toThrow()
    expect(original.simulationLayers.find((layer) => layer.id === PREVIEW_LAYER_ID)?.status).toBe('active')
  })

  it('ignores unknown layer ids without touching anything else', () => {
    const original = deepFreeze(makeManifest())
    const next = applyLayerStatusUpdates(original, [{ layerId: 'layer-does-not-exist', visible: false }])
    expect(next).toEqual(original)
  })
})

describe('applyLayerErrorStatus', () => {
  it('writes only the error status on the one layer', () => {
    const original = deepFreeze(makeManifest())
    const next = applyLayerErrorStatus(original, INDEX_LAYER_ID)
    expect(next.simulationLayers.find((layer) => layer.id === INDEX_LAYER_ID)?.status).toBe('error')
    const normalized = normalizeLayerWrites(next, original, [INDEX_LAYER_ID])
    expect(normalized).toEqual(original)
  })
})

describe('removeAssetFromManifest', () => {
  it('removes the source asset, its derived assets, and their layers - nothing else', () => {
    const original = deepFreeze(makeManifest({ includeSurface: true }))
    const result = removeAssetFromManifest(original, SOURCE_ASSET_ID)

    expect(result.removedAssetIds.sort()).toEqual([SOURCE_ASSET_ID, INDEX_ASSET_ID, SURFEL_ASSET_ID].sort())
    expect(result.removedLayerIds.sort()).toEqual([PREVIEW_LAYER_ID, INDEX_LAYER_ID, SURFEL_LAYER_ID].sort())

    // The surface asset + layer survive untouched.
    expect(result.manifest.assets.map((asset) => asset.kind)).toEqual(['surface'])
    expect(result.manifest.simulationLayers).toHaveLength(1)

    // Everything outside assets/simulationLayers is untouched.
    expect(result.manifest.realitySimulation).toEqual(original.realitySimulation)
    expect(result.manifest.features).toEqual(original.features)
    expect(result.manifest.recovery).toEqual(original.recovery)
    expect(result.manifest.schemaVersion).toBe(original.schemaVersion)
  })

  it('does not mutate the input manifest', () => {
    const original = deepFreeze(makeManifest())
    expect(() => removeAssetFromManifest(original, SOURCE_ASSET_ID)).not.toThrow()
    expect(original.assets).toHaveLength(3)
  })
})

describe('view-model builders never mutate the manifest', () => {
  it('buildPointCloudCards / buildSurfaceCards / buildSimPanelModel / buildWorkSurfaceModel are read-only', () => {
    const original = deepFreeze(makeManifest({ includeSurface: true, staleIndexWarning: true, staleSurfelSha: true }))
    const snapshot = structuredClone(original)

    expect(() => {
      buildPointCloudCards(original)
      buildSurfaceCards(original)
      buildSimPanelModel(original)
      buildWorkSurfaceModel(original, SOURCE_ASSET_ID)
    }).not.toThrow()

    expect(original).toEqual(snapshot)
  })
})
