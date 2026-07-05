import { mkdir, readFile, rename, rm, writeFile, copyFile, access, appendFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectManifestSchema } from '../src/shared/manifest-schema';
import { createDefaultManifest } from '../src/shared/project-defaults';
import type {
  CreateProjectInput,
  OpenProjectError,
  OpenProjectInput,
  ProjectManifest,
  SerializableSurfaceModel,
  UnitWarningInput,
} from '../src/shared/workbench-types';
import type { ProjectSession } from '../src/shared/ipc';
import { generateTestMesh } from '../src/viewer/synthetic';

const PROJECT_FILE = 'project.json';
const PROJECT_BACKUP_FILE = 'project.json.bak';
const SAVE_TEMP_FILE = 'project.json.tmp';
const JOURNAL_FILE = 'history/journal.log';
const REQUIRED_DIRS = ['sources', 'derived', 'edited', 'exports', 'reports', 'history', 'cache'];

interface SaveIntent {
  id: string;
  at: string;
  kind: 'save';
}

export class ProjectService {
  private currentFolder: string | null = null;
  private currentManifest: ProjectManifest | null = null;

  async createProject(input: CreateProjectInput): Promise<ProjectSession> {
    const projectFolder = path.join(input.parentDir, input.projectName);
    await mkdir(projectFolder, { recursive: true });

    for (const dir of REQUIRED_DIRS) {
      await mkdir(path.join(projectFolder, dir), { recursive: true });
    }

    const manifest = createDefaultManifest(input.projectName);
    await this.atomicWriteManifest(projectFolder, manifest);

    this.currentFolder = projectFolder;
    this.currentManifest = manifest;

    return this.toSession(projectFolder, manifest, false);
  }

  async openProject(input: OpenProjectInput): Promise<ProjectSession> {
    const manifestPath = path.join(input.projectFolder, PROJECT_FILE);
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch {
      throw this.createManifestOpenError();
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw this.createManifestOpenError();
    }

    const parsed = projectManifestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw this.createManifestOpenError();
    }

    const recoveryDetected = await this.detectUncleanShutdown(input.projectFolder);
    const manifest = parsed.data;

    if (recoveryDetected) {
      manifest.recovery.uncleanShutdown = true;
      manifest.recovery.lastRecoveredAt = new Date().toISOString();
    }

    this.currentFolder = input.projectFolder;
    this.currentManifest = manifest;

    return this.toSession(input.projectFolder, manifest, recoveryDetected);
  }

  async readDerivedSurfaceArtifact(managedPath: string): Promise<SerializableSurfaceModel> {
    this.requireOpenProject();
    const folder = this.currentFolder as string;
    const assetPath = this.resolveManagedPath(folder, managedPath);
    const raw = await readFile(assetPath, 'utf8');
    return this.parseSurfaceArtifact(raw, managedPath);
  }

  async saveProject(manifest: ProjectManifest): Promise<ProjectSession> {
    this.requireOpenProject();
    const folder = this.currentFolder as string;

    const parsed = projectManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      throw new Error(`Manifest validation failed: ${parsed.error.message}`);
    }

    if (parsed.data.realitySimulation.id !== this.currentManifest?.realitySimulation.id) {
      throw new Error('Primary realitySimulation replacement is not allowed.');
    }

    const updated = parsed.data;
    updated.info.modifiedAt = new Date().toISOString();
    updated.realitySimulation.modifiedAt = updated.info.modifiedAt as string;
    updated.recovery.uncleanShutdown = false;

    await this.atomicWriteManifest(folder, updated);

    this.currentManifest = updated;
    return this.toSession(folder, updated, false);
  }

  async closeProject(): Promise<void> {
    this.currentFolder = null;
    this.currentManifest = null;
  }

  async addUnitMismatchWarning(input: UnitWarningInput): Promise<ProjectSession> {
    this.requireOpenProject();
    const manifest = structuredClone(this.currentManifest as ProjectManifest);
    const asset = manifest.assets.find((a) => a.id === input.assetId);

    if (!asset) {
      throw new Error(`Asset ${input.assetId} not found.`);
    }

    asset.warnings.push(input.warning);
    asset.hashes.modifiedAt = new Date().toISOString();

    return this.saveProject(manifest);
  }

  async generatePlaceholderDerivedLayer(): Promise<{ session: ProjectSession; surface: SerializableSurfaceModel }> {
    this.requireOpenProject();
    const folder = this.currentFolder as string;
    const manifest = structuredClone(this.currentManifest as ProjectManifest);
    const now = new Date().toISOString();
    const simulationId = manifest.realitySimulation.id;

    const surface = generateTestMesh(4096, 2026);
    const artifactId = `derived-surface-${Date.now()}`;
    const artifactPath = path.join(folder, 'derived', `${artifactId}.json`);

    const serializableSurface: SerializableSurfaceModel = {
      id: surface.id,
      name: surface.name,
      positions: Array.from(surface.positions),
      sourcePointIds: Array.from(surface.sourcePointIds),
      indices: Array.from(surface.indices ?? []),
    };

    await writeFile(artifactPath, JSON.stringify(serializableSurface, null, 2), 'utf8');

    manifest.assets.push({
      id: artifactId,
      name: surface.name,
      kind: 'surface',
      truthStatus: 'derived',
      importPolicy: 'copy',
      sourcePath: null,
      managedPath: path.relative(folder, artifactPath).replace(/\\/g, '/'),
      units: 'usSurveyFoot',
      warnings: [],
      hashes: { importedAt: now, modifiedAt: now },
    });

    manifest.simulationLayers.push({
      id: `layer-${artifactId}`,
      simulationId,
      name: `${surface.name} (derived)` ,
      status: 'active',
      assetId: artifactId,
      createdAt: now,
      modifiedAt: now,
    });

    const session = await this.saveProject(manifest);
    return { session, surface: serializableSurface };
  }

  private async atomicWriteManifest(projectFolder: string, manifest: ProjectManifest): Promise<void> {
    const manifestPath = path.join(projectFolder, PROJECT_FILE);
    const backupPath = path.join(projectFolder, PROJECT_BACKUP_FILE);
    const tempPath = path.join(projectFolder, SAVE_TEMP_FILE);
    const intent: SaveIntent = { id: randomUUID(), at: new Date().toISOString(), kind: 'save' };

    await this.appendJournal(projectFolder, { event: 'intent', ...intent });

    await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    if (await this.exists(manifestPath)) {
      if (await this.exists(backupPath)) {
        await rm(backupPath, { force: true });
      }
      await copyFile(manifestPath, backupPath);
    } else {
      await writeFile(backupPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }

    await rename(tempPath, manifestPath);

    await this.appendJournal(projectFolder, { event: 'complete', intentId: intent.id, at: new Date().toISOString() });
  }

  private async appendJournal(projectFolder: string, data: Record<string, unknown>): Promise<void> {
    const journalPath = path.join(projectFolder, JOURNAL_FILE);
    await appendFile(journalPath, `${JSON.stringify(data)}\n`, 'utf8');
  }

  private async detectUncleanShutdown(projectFolder: string): Promise<boolean> {
    const tempPath = path.join(projectFolder, SAVE_TEMP_FILE);
    if (await this.exists(tempPath)) {
      return true;
    }

    const journalPath = path.join(projectFolder, JOURNAL_FILE);
    if (!(await this.exists(journalPath))) {
      return false;
    }

    const lines = (await readFile(journalPath, 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return false;
    }

    let lastEntry: { event?: string };
    try {
      lastEntry = JSON.parse(lines[lines.length - 1] as string) as { event?: string };
    } catch {
      return true;
    }
    return lastEntry.event !== 'complete';
  }

  private toSession(projectFolder: string, manifest: ProjectManifest, recoveryDetected: boolean): ProjectSession {
    return {
      projectFolder,
      manifestPath: path.join(projectFolder, PROJECT_FILE),
      backupPath: path.join(projectFolder, PROJECT_BACKUP_FILE),
      manifest,
      recoveryDetected,
    };
  }

  private requireOpenProject(): void {
    if (!this.currentFolder || !this.currentManifest) {
      throw new Error('No project is currently open.');
    }
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private createManifestOpenError(): OpenProjectError {
    return {
      code: 'manifest-missing-or-corrupt',
      message:
        'Project manifest is missing or corrupt. Manual restore is available from project.json.bak; auto-restore is not implemented yet.',
    };
  }

  private resolveManagedPath(projectFolder: string, managedPath: string): string {
    const resolved = path.resolve(projectFolder, managedPath);
    const relative = path.relative(projectFolder, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Managed path escapes project folder: ${managedPath}`);
    }
    return resolved;
  }

  private parseSurfaceArtifact(raw: string, managedPath: string): SerializableSurfaceModel {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Derived surface artifact is not valid JSON: ${managedPath}`);
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { id?: unknown }).id !== 'string' ||
      typeof (parsed as { name?: unknown }).name !== 'string' ||
      !Array.isArray((parsed as { positions?: unknown }).positions) ||
      !Array.isArray((parsed as { sourcePointIds?: unknown }).sourcePointIds) ||
      !Array.isArray((parsed as { indices?: unknown }).indices)
    ) {
      throw new Error(`Derived surface artifact has an invalid shape: ${managedPath}`);
    }

    return parsed as SerializableSurfaceModel;
  }
}
