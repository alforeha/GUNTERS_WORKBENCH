import type {
  AnalyticSurfelHierarchy,
  AnalyticSurfelMetricsSummary,
  AnalyticSurfelProgress,
  AnalyticSurfelTilePayload,
  CreateProjectInput,
  GenerateAnalyticSurfelsInput,
  GeneratePointCloudIndexInput,
  ImportPointCloudInput,
  LoadAnalyticSurfelHierarchyInput,
  LoadAnalyticSurfelTilesInput,
  LoadPointCloudDensifiedNodesInput,
  LoadPointCloudIndexHierarchyInput,
  LoadPointCloudIndexTilesInput,
  LoadPointCloudPreviewInput,
  OpenProjectError,
  OpenProjectInput,
  PointCloudIndexHierarchy,
  PointCloudIndexMetricsSummary,
  PointCloudIndexProgress,
  PointCloudPreviewProgress,
  PointCloudPreviewState,
  ProjectManifest,
  SerializableSurfaceModel,
  UnitWarningInput,
} from './workbench-types';
import type { PointCloudDataset, PointCloudNodePayload } from '../core/contract';

export interface ProjectSession {
  projectFolder: string;
  manifestPath: string;
  backupPath: string;
  manifest: ProjectManifest;
  recoveryDetected: boolean;
}

export interface WorkbenchIpc {
  pickNewProjectPath(): Promise<CreateProjectInput | null>;
  pickProjectFolder(): Promise<string | null>;
  pickPointCloudImport(): Promise<ImportPointCloudInput | null>;
  createProject(input: CreateProjectInput): Promise<ProjectSession>;
  openProject(input: OpenProjectInput): Promise<ProjectSession>;
  importPointCloud(input: ImportPointCloudInput): Promise<ProjectSession>;
  loadPointCloudPreview(input: LoadPointCloudPreviewInput): Promise<{
    assetId: string;
    dataset: PointCloudDataset;
    preview: PointCloudPreviewState;
  }>;
  loadPointCloudDensifiedNodes(input: LoadPointCloudDensifiedNodesInput): Promise<{
    assetId: string;
    sourceAvailable: boolean;
    warning: string | null;
    nodes: { nodeId: number; payload: PointCloudNodePayload }[];
  }>;
  generatePointCloudIndex(input: GeneratePointCloudIndexInput): Promise<{
    session: ProjectSession;
    indexAssetId: string;
    metrics: PointCloudIndexMetricsSummary;
  }>;
  generateAnalyticSurfels(input: GenerateAnalyticSurfelsInput): Promise<{
    session: ProjectSession;
    surfelAssetId: string;
    metrics: AnalyticSurfelMetricsSummary;
  }>;
  cancelPointCloudIndex(input: GeneratePointCloudIndexInput): Promise<void>;
  cancelAnalyticSurfels(input: GenerateAnalyticSurfelsInput): Promise<void>;
  loadPointCloudIndexHierarchy(input: LoadPointCloudIndexHierarchyInput): Promise<PointCloudIndexHierarchy>;
  loadPointCloudIndexTiles(input: LoadPointCloudIndexTilesInput): Promise<{
    assetId: string;
    tiles: { key: string; payload: PointCloudNodePayload }[];
  }>;
  loadAnalyticSurfelHierarchy(input: LoadAnalyticSurfelHierarchyInput): Promise<AnalyticSurfelHierarchy>;
  loadAnalyticSurfelTiles(input: LoadAnalyticSurfelTilesInput): Promise<{
    assetId: string;
    tiles: { key: string; payload: AnalyticSurfelTilePayload }[];
  }>;
  readDerivedSurfaceArtifact(managedPath: string): Promise<SerializableSurfaceModel>;
  saveProject(manifest: ProjectManifest): Promise<ProjectSession>;
  closeProject(): Promise<void>;
  addUnitMismatchWarning(input: UnitWarningInput): Promise<ProjectSession>;
  generatePlaceholderDerivedLayer(): Promise<{
    session: ProjectSession;
    surface: SerializableSurfaceModel;
  }>;
  onPointCloudPreviewProgress(listener: (progress: PointCloudPreviewProgress) => void): () => void;
  onPointCloudIndexProgress(listener: (progress: PointCloudIndexProgress) => void): () => void;
  onAnalyticSurfelProgress(listener: (progress: AnalyticSurfelProgress) => void): () => void;
}

export function isOpenProjectError(error: unknown): error is OpenProjectError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'manifest-missing-or-corrupt'
  );
}
