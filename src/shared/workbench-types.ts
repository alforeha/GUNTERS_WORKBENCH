export const SCHEMA_VERSION = '1.0.0';

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

export interface UnitWarningInput {
  assetId: string;
  warning: string;
}

export interface OpenProjectError {
  code: 'manifest-missing-or-corrupt';
  message: string;
}
