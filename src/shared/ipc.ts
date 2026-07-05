import type {
  CreateProjectInput,
  OpenProjectError,
  OpenProjectInput,
  ProjectManifest,
  SerializableSurfaceModel,
  UnitWarningInput,
} from './workbench-types';

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
  createProject(input: CreateProjectInput): Promise<ProjectSession>;
  openProject(input: OpenProjectInput): Promise<ProjectSession>;
  readDerivedSurfaceArtifact(managedPath: string): Promise<SerializableSurfaceModel>;
  saveProject(manifest: ProjectManifest): Promise<ProjectSession>;
  closeProject(): Promise<void>;
  addUnitMismatchWarning(input: UnitWarningInput): Promise<ProjectSession>;
  generatePlaceholderDerivedLayer(): Promise<{
    session: ProjectSession;
    surface: SerializableSurfaceModel;
  }>;
}

export function isOpenProjectError(error: unknown): error is OpenProjectError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'manifest-missing-or-corrupt'
  );
}
