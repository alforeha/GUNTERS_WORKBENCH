export const SCHEMA_VERSION = '1.4.0';

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
export type SimulationLayerKind =
  | 'asset'
  | 'point-cloud-preview'
  | 'point-cloud-index'
  | 'derived-surface'
  | 'derived-surfel';

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
  analyticSurfel?: AnalyticSurfelMetadata;
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
 * `indexed-full`). The index is a workbench-internal, COPC-shaped octree - never real
 * COPC. `source` fingerprints the LAS the index was built from so staleness is detectable
 * independently of the disposable preview cache. See src/shared/pointcloud-index.ts.
 */
export interface PointCloudIndexMetadata {
  /** Points back to the immutable source point-cloud asset. */
  sourceAssetId: string;
  indexType: PointCloudIndexType;
  indexVersion: 1 | 2;
  ownership?: 'file-order' | 'strided';
  source: {
    headerSha256: string;
    fileSize: number;
    /** Nullable: reference imports may not expose a reliable mtime. */
    mtimeMs: number | null;
    rgbEncoding?: 'u16' | 'u8-in-u16';
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
  rgbEncoding?: 'u16' | 'u8-in-u16';
}

export interface AnalyticSurfelMetadata {
  sourceAssetId: string;
  indexAssetId: string | null;
  surfelType: 'analytic-surfel-octree';
  surfelVersion: 1 | 2;
  surfelCellScale?: number;
  source: {
    headerSha256: string;
    fileSize: number;
    mtimeMs: number | null;
  };
  surfelCount: number;
  bounds: PointCloudBoundsBox;
  generatedAt: string;
  generator: { name: 'workbench'; version: string };
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
  kind: SimulationLayerKind;
  name: string;
  status: SimulationLayerStatus;
  assetId: string | null;
  createdAt: string;
  modifiedAt: string;
}

export type FeatureFamily =
  | 'region'
  | 'object'
  | 'building'
  | 'utility'
  | 'line'
  | 'marker'
  | 'measurement';
export type FeatureAuthorship = 'authored' | 'assisted' | 'derived' | 'edited' | 'imported';
export type FeatureConfidence = 'low' | 'medium' | 'high';
export type FeatureLifecycleStatus = 'draft' | 'authored' | 'reviewed' | 'flagged';

export type EvidenceRefKind =
  | 'picked-coordinate'
  | 'asset-point'
  | 'asset-vertex'
  | 'asset-edge'
  | 'surface-hit'
  | 'manual-note';

/**
 * Provenance for one authored coordinate. assetId stays optional so removing an
 * asset later leaves historical refs dangling-but-valid; surfel assets are never
 * a legal evidence source (schema-enforced).
 */
export interface EvidenceRef {
  kind: EvidenceRefKind;
  coordinate: [number, number, number];
  assetId?: string;
  assetLayerId?: string;
  /** Owning feature when the snap source was another authored feature (vertex/edge). */
  featureId?: string;
  sourceClass?: number;
  sourceRGB?: [number, number, number];
  /** manual-note refs only. */
  note?: string;
}

export interface FeatureRepresentations {
  reality?: Record<string, unknown>;
  cad?: Record<string, unknown>;
  report?: Record<string, unknown>;
  export?: Record<string, unknown>;
}

export interface FeatureDisplay {
  visible: boolean;
}

/**
 * Widened additively for Create Sim: `family` is the primary axis going forward,
 * `type` remains the legacy axis every record still carries. evidenceRefs /
 * parameters / metadata are optional here but defaulted by the schema on parse.
 * Features never carry truthStatus (asset property only).
 */
export interface FeatureRecord {
  id: string;
  simulationId: string;
  type: FeatureType;
  name: string;
  geometry: Record<string, unknown>;
  createdAt: string;
  modifiedAt: string;
  family?: FeatureFamily;
  templateId?: string | null;
  subtype?: string;
  authorship?: FeatureAuthorship;
  confidence?: FeatureConfidence;
  lifecycleStatus?: FeatureLifecycleStatus;
  evidenceRefs?: EvidenceRef[];
  parameters?: Record<string, unknown>;
  representations?: FeatureRepresentations;
  display?: FeatureDisplay;
  /** Reserved for v2 feature-generates-features; unused by v1 flows. */
  parentFeatureId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Ground-behavior exclusion owned by a feature (e.g. a building footprint). */
export interface ExclusionZoneRecord {
  id: string;
  simulationId: string;
  featureId: string;
  name?: string;
  polygon: [number, number, number][];
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
  exclusionZones: ExclusionZoneRecord[];
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

export interface PointCloudIndexHierarchyNode {
  key: string;
  level: number;
  bounds: PointCloudBoundsBox;
  pointCount: number;
  childKeys: string[];
}

/** Camera-agnostic description of a built WPI index, streamed to the renderer once on open. */
export interface PointCloudIndexHierarchy {
  assetId: string;
  indexAssetId: string;
  root: string;
  /** Rebase origin (index bounds center); tile payload positions are relative to this. */
  origin: [number, number, number];
  bounds: PointCloudBoundsBox;
  scale: [number, number, number];
  offset: [number, number, number];
  units: string;
  pointFormat: number;
  hasRgb: boolean;
  totalPoints: number;
  nodes: PointCloudIndexHierarchyNode[];
}

export interface LoadPointCloudIndexHierarchyInput {
  assetId: string;
}

export interface LoadPointCloudIndexTilesInput {
  assetId: string;
  keys: string[];
}

export interface GenerateAnalyticSurfelsInput {
  assetId: string;
  surfelCellScale?: number;
  bbox?: PointCloudBoundsBox;
  maxPoints?: number;
}

export interface AnalyticSurfelProgress {
  assetId: string;
  label: string;
  pct: number | null;
}

export interface AnalyticSurfelMetricsSummary {
  surfelCount: number;
  nodeCount: number;
  inputPointCount: number;
  outputSizeBytes: number;
  wallTimeMs: number;
  mergeMetrics?: import('../core/pointcloud/analytic-surfels').MergeMetrics;
}

export interface AnalyticSurfelHierarchyNode {
  key: string;
  level: number;
  bounds: PointCloudBoundsBox;
  surfelCount: number;
  childKeys: string[];
}

export interface AnalyticSurfelHierarchy {
  assetId: string;
  sourceAssetId: string;
  indexAssetId: string | null;
  root: string;
  origin: [number, number, number];
  bounds: PointCloudBoundsBox;
  totalSurfels: number;
  nodes: AnalyticSurfelHierarchyNode[];
}

export interface AnalyticSurfelTilePayload {
  surfelCount: number;
  positions: Float32Array;
  colors: Uint8Array;
  radii: Float32Array;
  normals: Float32Array;
  confidence: Float32Array;
  flags: Uint8Array;
  eigenvalues: Float32Array;
}

export interface LoadAnalyticSurfelHierarchyInput {
  assetId: string;
}

export interface LoadAnalyticSurfelTilesInput {
  assetId: string;
  keys: string[];
}

export interface OpenProjectError {
  code: 'manifest-missing-or-corrupt';
  message: string;
}
