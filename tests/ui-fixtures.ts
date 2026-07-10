// tests/ui-fixtures.ts - shared manifest fixtures for the UI view-model tests.
// Pure data: no DOM, no electron, no three.js.

import type {
  AssetRecord,
  FeatureRecord,
  PointCloudBoundsBox,
  ProjectManifest,
  SimulationLayer,
} from '../src/shared/workbench-types'

export const SIM_ID = 'sim-1'
export const SOURCE_ASSET_ID = 'asset-cloud-1'
export const INDEX_ASSET_ID = 'asset-index-1'
export const SURFEL_ASSET_ID = 'asset-surfel-1'
export const SURFACE_ASSET_ID = 'asset-surface-1'
export const PREVIEW_LAYER_ID = 'layer-preview-1'
export const INDEX_LAYER_ID = 'layer-index-1'
export const SURFEL_LAYER_ID = 'layer-surfel-1'
export const SURFACE_LAYER_ID = 'layer-surface-1'

const BOUNDS: PointCloudBoundsBox = { minX: 100, minY: 200, minZ: 10, maxX: 400, maxY: 600, maxZ: 60 }
const STAMP = '2026-07-01T00:00:00.000Z'
export const SOURCE_SHA = 'sha-source-v1'

function baseAsset(id: string, name: string, kind: string): AssetRecord {
  return {
    id,
    name,
    kind,
    truthStatus: 'source',
    importPolicy: 'copy',
    sourcePath: `C:/data/${name}`,
    managedPath: null,
    units: null,
    warnings: [],
    hashes: { importedAt: STAMP },
  }
}

export function makeSourceCloudAsset(): AssetRecord {
  return {
    ...baseAsset(SOURCE_ASSET_ID, 'survey_site.las', 'point-cloud'),
    pointCloud: {
      format: 'las',
      extension: '.las',
      fileSize: 250_000_000,
      pointCount: 12_400_000,
      lasVersion: '1.4',
      pointFormat: 6,
      pointRecordLength: 30,
      bounds: BOUNDS,
      scale: [0.001, 0.001, 0.001],
      offset: [0, 0, 0],
      crsText: null,
      unitsLinear: 'usSurveyFoot',
      unitsRaw: 'US survey foot',
      headerSha256: SOURCE_SHA,
    },
  }
}

export function makeIndexAsset(options: { staleWarning?: boolean } = {}): AssetRecord {
  return {
    ...baseAsset(INDEX_ASSET_ID, 'survey_site.wpi', 'point-cloud-index'),
    truthStatus: 'indexed-full',
    managedPath: 'derived/index/survey_site',
    warnings: options.staleWarning
      ? ['Point-cloud index may be out of date (source header content changed). Regenerate the index to match the current source.']
      : [],
    pointCloudIndex: {
      sourceAssetId: SOURCE_ASSET_ID,
      indexType: 'wpi-octree',
      indexVersion: 2,
      ownership: 'strided',
      source: { headerSha256: SOURCE_SHA, fileSize: 250_000_000, mtimeMs: 1_000 },
      pointCount: 12_400_000,
      bounds: BOUNDS,
      scale: [0.001, 0.001, 0.001],
      offset: [0, 0, 0],
      units: 'usSurveyFoot',
      generatedAt: STAMP,
      generator: { name: 'workbench', version: '2.0.0' },
    },
  }
}

export function makeSurfelAsset(options: { staleSha?: boolean } = {}): AssetRecord {
  return {
    ...baseAsset(SURFEL_ASSET_ID, 'survey_site.surfels', 'analytic-surfel-render'),
    truthStatus: 'derived',
    managedPath: 'derived/surfels/survey_site',
    analyticSurfel: {
      sourceAssetId: SOURCE_ASSET_ID,
      indexAssetId: INDEX_ASSET_ID,
      surfelType: 'analytic-surfel-octree',
      surfelVersion: 2,
      source: {
        headerSha256: options.staleSha ? 'sha-source-v0-old' : SOURCE_SHA,
        fileSize: 250_000_000,
        mtimeMs: 1_000,
      },
      surfelCount: 4_300_000,
      bounds: BOUNDS,
      generatedAt: STAMP,
      generator: { name: 'workbench', version: '2.0.0' },
    },
  }
}

export function makeSurfaceAsset(): AssetRecord {
  return {
    ...baseAsset(SURFACE_ASSET_ID, 'placeholder_surface', 'surface'),
    truthStatus: 'derived',
    managedPath: 'derived/surfaces/placeholder.json',
  }
}

export function makeLayer(id: string, assetId: string, name: string, status: SimulationLayer['status'] = 'active'): SimulationLayer {
  return {
    id,
    simulationId: SIM_ID,
    kind: 'asset',
    name,
    status,
    assetId,
    createdAt: STAMP,
    modifiedAt: STAMP,
  }
}

export function makeFeature(id: string, type: FeatureRecord['type']): FeatureRecord {
  return {
    id,
    simulationId: SIM_ID,
    type,
    name: `${type}-${id}`,
    geometry: {},
    createdAt: STAMP,
    modifiedAt: STAMP,
  }
}

export interface ManifestFixtureOptions {
  includeIndex?: boolean
  includeSurfels?: boolean
  includeSurface?: boolean
  staleIndexWarning?: boolean
  staleSurfelSha?: boolean
  surfelLayerStatus?: SimulationLayer['status']
  features?: FeatureRecord[]
}

export function makeManifest(options: ManifestFixtureOptions = {}): ProjectManifest {
  const {
    includeIndex = true,
    includeSurfels = true,
    includeSurface = false,
    staleIndexWarning = false,
    staleSurfelSha = false,
    surfelLayerStatus = 'hidden',
    features = [],
  } = options

  const assets: AssetRecord[] = [makeSourceCloudAsset()]
  const simulationLayers: SimulationLayer[] = [makeLayer(PREVIEW_LAYER_ID, SOURCE_ASSET_ID, 'survey_site preview')]

  if (includeIndex) {
    assets.push(makeIndexAsset({ staleWarning: staleIndexWarning }))
    simulationLayers.push(makeLayer(INDEX_LAYER_ID, INDEX_ASSET_ID, 'survey_site index'))
  }
  if (includeSurfels) {
    assets.push(makeSurfelAsset({ staleSha: staleSurfelSha }))
    simulationLayers.push(makeLayer(SURFEL_LAYER_ID, SURFEL_ASSET_ID, 'survey_site surfels', surfelLayerStatus))
  }
  if (includeSurface) {
    assets.push(makeSurfaceAsset())
    simulationLayers.push(makeLayer(SURFACE_LAYER_ID, SURFACE_ASSET_ID, 'placeholder surface'))
  }

  return {
    schemaVersion: '1.3.0',
    info: { name: 'North Site' },
    crs: {},
    settings: {},
    standards: {},
    assets,
    groups: [],
    realitySimulation: {
      id: SIM_ID,
      name: 'Reality Simulation',
      status: 'active',
      mode: 'reality',
      phaseContext: 'test',
      settings: {},
      warnings: [],
      createdAt: STAMP,
      modifiedAt: STAMP,
    },
    simulationLayers,
    features,
    exclusionZones: [],
    reviewFlags: [],
    comparisonRefs: [],
    analysisResults: [],
    lineouts: [],
    reports: [],
    exports: [],
    recovery: {
      uncleanShutdown: false,
      lastIntentId: null,
      lastIntentAt: null,
      lastRecoveredAt: null,
    },
  }
}

/** Recursively freezes a manifest so tests catch accidental mutation by view-model builders. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}
