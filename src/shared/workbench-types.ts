export const SCHEMA_VERSION = '1.2.0';

export type TruthStatus =
  | 'source'
  | 'source-normalized'
  | 'preview-sampled'
  | 'indexed-full'
  | 'derived'
  | 'authored'
  | 'edited'
  | 'export';

export type FeatureType = 'marker' | 'polyline' | 'measurement';
export type SimulationLayerStatus = 'active' | 'hidden' | 'error';

export interface AssetRecord {
  id: string;
  name: string;
  kind: string;
  truthStatus: TruthStatus;
  importPolicy: 'copy' | 'reference';
  sourcePath: string | null;
  managedPath: string | null;
  units: string | null;
  warnings: string[];
  hashes: {
    sha256?: string;
    importedAt?: string;
    modifiedAt?: string;
  };
  pointCloud?: PointCloudAssetMetadata;
  pointCloudIndex?: PointCloudIndexMetadata;
}

export interface PointCloudBoundsBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export type PointCloudIndexType = 'wpi-octree';

/**
 * Metadata for a WPI v1 point-cloud index asset (kind `point-cloud-index`, truthStatus
 * `indexed-full`). The index is a workbench-internal, COPC-shaped octree — never real
 * COPC. `source` fingerprints the LAS the index was built from so staleness is detectable
 * independently of the disposable preview cache. See src/shared/pointcloud-index.ts.
 */
export interface PointCloudIndexMetadata {
  /** Points back to the immutable source point-cloud asset. */
  sourceAssetId: string;
  indexType: PointCloudIndexType;
  indexVersion: 1;
  source: {
    headerSha256: string;
    fileSize: number;
    /** Nullable: reference imports may not expose a reliable mtime. */
    mtimeMs: number | null;
  };
  pointCount: number;
  bounds: PointCloudBoundsBox;
  scale: [number, number, number];
  offset: [number, number, number];
  units: string;
  generatedAt: string;
  generator: { name: 'workbench'; version: string };
}

export interface PointCloudAssetMetadata {
  format: 'las' | 'laz';
  extension: string;
  fileSize: number;
  pointCount: number;
  lasVersion: string;
  pointFormat: number;
  pointRecordLength: number;
  bounds: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
  scale: [number, number, number];
  offset: [number, number, number];
  crsText: string | null;
  unitsLinear: 'usSurveyFoot' | 'foot' | 'meter' | 'unknown';
  unitsRaw: string;
  headerSha256: string;
}

export interface RealitySimulation {
  id: string;
  name: string;
  status: string;
  mode: string;
  phaseContext: string;
  settings: Record<string, unknown>;
  warnings: string[];
  createdAt: string;
  modifiedAt: string;
}

export interface SimulationLayer {
  id: string;
  simulationId: string;
  name: string;
  status: SimulationLayerStatus;
  assetId: string | null;
  createdAt: string;
  modifiedAt: string;
}

export interface FeatureRecord {
  id: string;
  simulationId: string;
  type: FeatureType;
  name: string;
  geometry: Record<string, unknown>;
  createdAt: string;
  modifiedAt: string;
}

export interface ReviewFlag {
  id: string;
  simulationId: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
  status: 'open' | 'resolved';
  createdAt: string;
  modifiedAt: string;
}

export interface ComparisonRef {
  id: string;
  simulationId: string;
  name: string;
  target: string;
  createdAt: string;
  modifiedAt: string;
}

export interface AnalysisResult {
  id: string;
  simulationId: string;
  name: string;
  summary: string;
  createdAt: string;
  modifiedAt: string;
}

export interface RecoveryState {
  uncleanShutdown: boolean;
  lastIntentId: string | null;
  lastIntentAt: string | null;
  lastRecoveredAt: string | null;
}

export interface ProjectManifest {
  schemaVersion: string;
  info: Record<string, unknown>;
  crs: Record<string, unknown>;
  settings: Record<string, unknown>;
  standards: Record<string, unknown>;
  assets: AssetRecord[];
  groups: Record<string, unknown>[];
  realitySimulation: RealitySimulation;
  simulationLayers: SimulationLayer[];
  features: FeatureRecord[];
  reviewFlags: ReviewFlag[];
  comparisonRefs: ComparisonRef[];
  analysisResults: AnalysisResult[];
  lineouts: Record<string, unknown>[];
  reports: Record<string, unknown>[];
  exports: Record<string, unknown>[];
  recovery: RecoveryState;
}

export interface SerializableSurfaceModel {
  id: string;
  name: string;
  positions: number[];
  sourcePointIds: number[];
  indices: number[];
}

export interface CreateProjectInput {
  parentDir: string;
  projectName: string;
}

export interface OpenProjectInput {
  projectFolder: string;
}

export interface ImportPointCloudInput {
  filePath: string;
  importPolicy: 'copy' | 'reference';
}

export interface LoadPointCloudPreviewInput {
  assetId: string;
  quality?: 'fast' | 'balanced' | 'all-detail';
}

export interface LoadPointCloudDensifiedNodesInput {
  assetId: string;
  nodeIds: number[];
}

export interface PointCloudPreviewProgress {
  assetId: string;
  label: string;
  pct: number | null;
}

export interface PointCloudPreviewState {
  assetId: string;
  sourceAssetTruthStatus: 'source';
  displayTruthStatus: 'preview-sampled';
  sampledPointCount: number;
  totalPointCount: number;
  densifiedPointCount: number;
  sourceAvailable: boolean;
  disclosure: string;
  sourcePath: string;
  cachePath: string;
  warnings: string[];
}

export interface UnitWarningInput {
  assetId: string;
  warning: string;
}

export interface GeneratePointCloudIndexInput {
  assetId: string;
}

export interface PointCloudIndexProgress {
  assetId: string;
  label: string;
  pct: number | null;
}

export interface PointCloudIndexMetricsSummary {
  pointCount: number;
  storedPointCount: number;
  tileCount: number;
  indexSizeBytes: number;
  maxDepthUsed: number;
  wallTimeMs: number;
  peakBufferedBytes: number;
}

export interface OpenProjectError {
  code: 'manifest-missing-or-corrupt';
  message: string;
}
