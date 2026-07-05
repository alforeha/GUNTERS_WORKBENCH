import type {
  CreateProjectInput,
  ImportPointCloudInput,
  LoadPointCloudDensifiedNodesInput,
  LoadPointCloudPreviewInput,
  OpenProjectError,
  OpenProjectInput,
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
  readDerivedSurfaceArtifact(managedPath: string): Promise<SerializableSurfaceModel>;
  saveProject(manifest: ProjectManifest): Promise<ProjectSession>;
  closeProject(): Promise<void>;
  addUnitMismatchWarning(input: UnitWarningInput): Promise<ProjectSession>;
  generatePlaceholderDerivedLayer(): Promise<{
    session: ProjectSession;
    surface: SerializableSurfaceModel;
  }>;
  onPointCloudPreviewProgress(listener: (progress: PointCloudPreviewProgress) => void): () => void;
}

export function isOpenProjectError(error: unknown): error is OpenProjectError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'manifest-missing-or-corrupt'
  );
}
