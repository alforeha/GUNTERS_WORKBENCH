import { mkdir, readFile, rename, rm, writeFile, copyFile, access, appendFile, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { projectManifestSchema } from '../src/shared/manifest-schema';
import { createDefaultManifest } from '../src/shared/project-defaults';
import type { PointCloudDataset, PointCloudNodePayload } from '../src/core/contract';
import { parseLasMetadata } from '../src/core/las/metadata';
import { computeStride, handleLasSourceRequest, type ChunkSource } from '../src/workers/las.worker';
import type {
  AnalyticSurfelHierarchy,
  AnalyticSurfelMetricsSummary,
  AnalyticSurfelProgress,
  AnalyticSurfelTilePayload,
  AssetRecord,
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
  PointCloudPreviewState,
  ProjectManifest,
  SerializableSurfaceModel,
  UnitWarningInput,
} from '../src/shared/workbench-types';
import type { ProjectSession } from '../src/shared/ipc';
import {
  ANALYTIC_SURFEL_ASSET_KIND,
  formatAnalyticSurfelWarning,
  isManagedAnalyticSurfelWarning,
} from '../src/shared/analytic-surfels';
import {
  POINT_CLOUD_INDEX_ASSET_KIND,
  POINT_CLOUD_INDEX_BUILDER_VERSION,
  POINT_CLOUD_INDEX_WARNING_PREFIX,
  detectIndexStaleness,
  formatStaleIndexWarning,
  hasValidIndexForStreaming,
  isManagedIndexWarning,
  type CurrentSourceFingerprint,
} from '../src/shared/pointcloud-index';
import { decodeReturnByte } from '../src/shared/wpi-tile';
import {
  buildAnalyticSurfelsFromIndex,
  buildAnalyticSurfelsFromPreview,
  isAnalyticSurfelComplete,
  readAnalyticSurfelManifest,
} from './analytic-surfel-builder';
import {
  ANALYTIC_SURFEL_TILES_DIR,
  readAnalyticSurfelTile,
} from '../src/shared/analytic-surfel-format';
import {
  decodeWpiTileFile,
  isWpiIndexComplete,
  readWpiIndexManifest,
  type BuildPointCloudIndexResult,
} from './pointcloud-index-builder';
import { createWorkerIndexBuild, type RunIndexBuild } from './pointcloud-index-runner';
import { generateTestMesh } from '../src/viewer/synthetic';
import {
  previewCacheRelativePath,
  readPreviewCache,
  readPreviewCacheDescriptor,
  removePreviewCache,
  validatePreviewCache,
  writePreviewCache,
} from './pointcloud-preview-cache';

const PROJECT_FILE = 'project.json';
const PROJECT_BACKUP_FILE = 'project.json.bak';
const SAVE_TEMP_FILE = 'project.json.tmp';
const JOURNAL_FILE = 'history/journal.log';
const REQUIRED_DIRS = ['sources', 'derived', 'edited', 'exports', 'reports', 'history', 'cache'];
const MISSING_SOURCE_WARNING = 'Referenced point cloud source is missing.';
const MISSING_SOURCE_CACHE_WARNING = 'Source file is missing; showing cached preview that may be stale.';
const UNIT_WARNING = 'Point-cloud units could not be confirmed from LAS VLRs.';
const MISSING_DERIVED_SURFEL_WARNING =
  'Derived analytic surfel artifact is missing. Regenerate the surfel layer to restore it.';
const DENSIFIED_DISCLOSURE_SUFFIX = 'source densification fallback';

interface SaveIntent {
  id: string;
  at: string;
  kind: 'save';
}

export class ProjectService {
  private currentFolder: string | null = null;
  private currentManifest: ProjectManifest | null = null;
  private readonly runIndexBuild: RunIndexBuild;
  private readonly indexBuilds = new Map<string, AbortController>();
  private readonly surfelBuilds = new Map<string, AbortController>();

  constructor(options?: { runIndexBuild?: RunIndexBuild }) {
    this.runIndexBuild = options?.runIndexBuild ?? createWorkerIndexBuild();
  }

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
    const manifest = await this.applyPointCloudOpenChecks(input.projectFolder, parsed.data);

    if (recoveryDetected) {
      manifest.recovery.uncleanShutdown = true;
      manifest.recovery.lastRecoveredAt = new Date().toISOString();
    }

    this.currentFolder = input.projectFolder;
    this.currentManifest = manifest;

    return this.toSession(input.projectFolder, manifest, recoveryDetected);
  }

  async importPointCloud(input: ImportPointCloudInput): Promise<ProjectSession> {
    this.requireOpenProject();
    const folder = this.currentFolder as string;
    const manifest = structuredClone(this.currentManifest as ProjectManifest);
    const sourceStats = await stat(input.filePath);
    const extension = path.extname(input.filePath).toLowerCase();
    if (extension === '.laz') {
      throw new Error('LAZ is not supported yet in this build. Import LAS files for now.');
    }
    if (extension !== '.las') {
      throw new Error(`Unsupported point-cloud format: ${extension || 'unknown'}`);
    }

    const preamble = await this.readLasPreamble(input.filePath);
    const dataset = parseLasMetadata({
      fileName: path.basename(input.filePath),
      fileSize: sourceStats.size,
      header: preamble.slice(0, Math.min(375, preamble.byteLength)),
      preamble,
    });
    const headerSha256 = createHash('sha256')
      .update(new Uint8Array(preamble))
      .update(Buffer.from(String(sourceStats.size)))
      .digest('hex');

    let managedPath: string | null = null;
    if (input.importPolicy === 'copy') {
      const fileName = this.uniqueManagedFileName(manifest, path.basename(input.filePath));
      const targetPath = path.join(folder, 'sources', fileName);
      await copyFile(input.filePath, targetPath);
      managedPath = path.relative(folder, targetPath).replace(/\\/g, '/');
    }

    const now = new Date().toISOString();
    const assetId = `point-cloud-${Date.now()}`;
    const warnings: string[] = [];
    if (dataset.unitSource === 'assumed') warnings.push(UNIT_WARNING);

    manifest.assets.push({
      id: assetId,
      name: path.basename(input.filePath),
      kind: 'point-cloud',
      truthStatus: 'source',
      importPolicy: input.importPolicy,
      sourcePath: input.filePath,
      managedPath,
      units: dataset.meta.units.linear,
      warnings,
      hashes: {
        importedAt: now,
        modifiedAt: sourceStats.mtime.toISOString(),
      },
      pointCloud: {
        format: 'las',
        extension,
        fileSize: sourceStats.size,
        pointCount: dataset.pointCount,
        lasVersion: dataset.lasVersion,
        pointFormat: dataset.pointFormat,
        pointRecordLength: dataset.pointRecordLength,
        bounds: dataset.bounds,
        scale: dataset.scale,
        offset: dataset.offset,
        crsText: dataset.crsText,
        unitsLinear: dataset.meta.units.linear,
        unitsRaw: dataset.meta.units.raw,
        headerSha256,
      },
    });

    manifest.simulationLayers.push({
      id: `layer-${assetId}`,
      simulationId: manifest.realitySimulation.id,
      kind: 'point-cloud-preview',
      name: `${path.basename(input.filePath)} preview`,
      status: 'active',
      assetId,
      createdAt: now,
      modifiedAt: now,
    });

    manifest.realitySimulation.status = 'point-cloud-source-loaded';

    return this.saveProject(manifest);
  }

  async loadPointCloudPreview(
    input: LoadPointCloudPreviewInput,
    onProgress?: (progress: { assetId: string; label: string; pct: number | null }) => void,
  ): Promise<{ assetId: string; dataset: PointCloudDataset; preview: PointCloudPreviewState }> {
    this.requireOpenProject();
    const folder = this.currentFolder as string;
    const manifest = this.currentManifest as ProjectManifest;
    const asset = manifest.assets.find((candidate) => candidate.id === input.assetId);
    if (!asset || asset.kind !== 'point-cloud') {
      throw new Error(`Point cloud asset ${input.assetId} not found.`);
    }
    if (!asset.pointCloud) {
      throw new Error(`Point cloud asset ${input.assetId} is missing metadata.`);
    }

    const sourcePath = this.resolvePointCloudSourcePath(folder, asset);
    const quality = input.quality ?? 'balanced';
    const sourceExists = await this.exists(sourcePath);
    const cachePath = previewCacheRelativePath(asset.id);
    const sourceStats = sourceExists ? await stat(sourcePath) : null;
    const headerSha256 = sourceExists ? await this.computeSourceHeaderSha256(sourcePath, sourceStats!.size) : undefined;
    const cacheValidation = await validatePreviewCache(folder, {
      assetId: asset.id,
      sourceExists,
      quality,
      pointCloud: asset.pointCloud,
      fileSize: sourceStats?.size,
      mtimeMs: sourceStats?.mtimeMs,
      headerSha256,
    });

    if (cacheValidation.valid) {
      try {
        const cached = await readPreviewCache(folder, asset.id);
        const preview = this.buildPointCloudPreview({
          assetId: asset.id,
          dataset: cached.dataset,
          sourcePath,
          cachePath,
          warnings: sourceExists ? [] : [MISSING_SOURCE_CACHE_WARNING],
        });
        return { assetId: asset.id, dataset: cached.dataset, preview };
      } catch {
        await removePreviewCache(folder, asset.id);
      }
    } else if (cacheValidation.reason === 'schema-version-mismatch' && cacheValidation.descriptor?.schemaVersion === 1) {
      if (!sourceExists) {
        const cached = await readPreviewCache(folder, asset.id);
        const preview = this.buildPointCloudPreview({
          assetId: asset.id,
          dataset: cached.dataset,
          sourcePath,
          cachePath,
          warnings: [MISSING_SOURCE_CACHE_WARNING],
        });
        preview.sourceAvailable = false;
        return { assetId: asset.id, dataset: cached.dataset, preview };
      }
      await removePreviewCache(folder, asset.id);
    } else if (cacheValidation.descriptor === null || cacheValidation.reason) {
      await removePreviewCache(folder, asset.id);
    }

    if (!sourceExists) {
      throw new Error(`${MISSING_SOURCE_WARNING} ${sourcePath}`);
    }

    const source = await this.fileChunkSource(sourcePath);
    const result = await handleLasSourceRequest(
      {
        id: 1,
        fileName: asset.name,
        source,
        quality,
      },
      (label, pct) => onProgress?.({ assetId: input.assetId, label, pct }),
    );

    if (result.response.type !== 'result') {
      throw new Error('Point-cloud preview did not return a result message.');
    }
    if (!result.response.ok) {
      throw new Error(result.response.error);
    }

    const dataset = result.response.dataset;
    const ensuredSourceStats = sourceStats;
    if (!ensuredSourceStats || !headerSha256) {
      throw new Error(`Point cloud source became unavailable while loading preview: ${sourcePath}`);
    }
    await writePreviewCache(folder, {
      assetId: asset.id,
      fileSize: ensuredSourceStats.size,
      mtimeMs: ensuredSourceStats.mtimeMs,
      headerSha256,
      quality,
      attributeStride: computeStride(dataset.pointCount),
      dataset,
    });
    const preview = this.buildPointCloudPreview({
      assetId: asset.id,
      dataset,
      sourcePath,
      cachePath,
      warnings: [],
    });

    return { assetId: asset.id, dataset, preview };
  }

  async loadPointCloudDensifiedNodes(
    input: LoadPointCloudDensifiedNodesInput,
  ): Promise<{
    assetId: string;
    sourceAvailable: boolean;
    warning: string | null;
    nodes: { nodeId: number; payload: import('../src/core/contract').PointCloudNodePayload }[];
  }> {
    this.requireOpenProject();
    const folder = this.currentFolder as string;
    const manifest = this.currentManifest as ProjectManifest;
    const asset = manifest.assets.find((candidate) => candidate.id === input.assetId);
    if (!asset || asset.kind !== 'point-cloud' || !asset.pointCloud) {
      throw new Error(`Point cloud asset ${input.assetId} not found.`);
    }
    const sourcePath = this.resolvePointCloudSourcePath(folder, asset);
    if (!(await this.exists(sourcePath))) {
      return {
        assetId: input.assetId,
        sourceAvailable: false,
        warning: MISSING_SOURCE_CACHE_WARNING,
        nodes: [],
      };
    }
    const descriptor = await readPreviewCacheDescriptor(folder, asset.id);
    const nodeIndex = new Map<number, typeof descriptor.dataset.octree.root>();
    const visit = (node: typeof descriptor.dataset.octree.root) => {
      nodeIndex.set(node.id, node);
      node.children.forEach(visit);
    };
    visit(descriptor.dataset.octree.root);
    const source = await this.fileChunkSource(sourcePath);
    const { loadDensifiedNodeFromSource } = await import('../src/workers/las.worker');
    const nodes = [];
    for (const nodeId of [...new Set(input.nodeIds)]) {
      const node = nodeIndex.get(nodeId);
      if (!node || (node.sourceRanges?.length ?? 0) === 0) continue;
      nodes.push(
        await loadDensifiedNodeFromSource(source, {
          dataset: {
            pointFormat: descriptor.dataset.pointFormat,
            pointRecordLength: descriptor.dataset.pointRecordLength,
            scale: descriptor.dataset.scale,
            offset: descriptor.dataset.offset,
            offsetToPointData: descriptor.dataset.offsetToPointData,
            octree: {
              origin: descriptor.dataset.octree.origin,
            },
          },
          node: {
            id: node.id,
            sourceRanges: node.sourceRanges ?? [],
            bounds: node.bounds,
          },
        }),
      );
    }
    return {
      assetId: input.assetId,
      sourceAvailable: true,
      warning: null,
      nodes,
    };
  }

  async generatePointCloudIndex(
    input: GeneratePointCloudIndexInput,
    onProgress?: (progress: PointCloudIndexProgress) => void,
  ): Promise<{ session: ProjectSession; indexAssetId: string; metrics: PointCloudIndexMetricsSummary }> {
    this.requireOpenProject();
    const folder = this.currentFolder as string;
    const sourceAsset = (this.currentManifest as ProjectManifest).assets.find((a) => a.id === input.assetId);
    if (!sourceAsset || sourceAsset.kind !== 'point-cloud' || !sourceAsset.pointCloud) {
      throw new Error(`Point cloud asset ${input.assetId} not found.`);
    }
    const sourcePath = this.resolvePointCloudSourcePath(folder, sourceAsset);
    if (!(await this.exists(sourcePath))) {
      throw new Error(`${MISSING_SOURCE_WARNING} ${sourcePath}`);
    }
    const sourceStats = await stat(sourcePath);
    const headerSha256 = await this.computeSourceHeaderSha256(sourcePath, sourceStats.size);

    // Build into a staging dir and only swap it into place on success so a failed regenerate
    // never destroys a previously-good index or corrupts the manifest.
    const indexParent = path.join(folder, 'derived', sourceAsset.id);
    const finalDir = path.join(indexParent, 'index');
    const stageDir = path.join(indexParent, 'index.staging');
    await mkdir(indexParent, { recursive: true });
    await rm(stageDir, { recursive: true, force: true });

    const controller = new AbortController();
    this.indexBuilds.set(sourceAsset.id, controller);
    let result: BuildPointCloudIndexResult;
    try {
      result = await this.runIndexBuild(
        {
          sourcePath,
          outDir: stageDir,
          fileName: sourceAsset.name,
          sourceFingerprint: { headerSha256, fileSize: sourceStats.size, mtimeMs: sourceStats.mtimeMs },
          generatorVersion: POINT_CLOUD_INDEX_BUILDER_VERSION,
        },
        {
          onProgress: (label, pct) => onProgress?.({ assetId: sourceAsset.id, label, pct }),
          signal: controller.signal,
        },
      );
      if (!(await isWpiIndexComplete(stageDir))) {
        throw new Error('Point-cloud index build finished without a completion marker.');
      }
      await rm(finalDir, { recursive: true, force: true });
      await rename(stageDir, finalDir);
    } catch (err) {
      await rm(stageDir, { recursive: true, force: true });
      throw err;
    } finally {
      this.indexBuilds.delete(sourceAsset.id);
    }

    const manifest = structuredClone(this.currentManifest as ProjectManifest);
    const indexAssetId = `${sourceAsset.id}-index`;
    const now = new Date().toISOString();
    const built = result.manifest;
    const record: AssetRecord = {
      id: indexAssetId,
      name: `${sourceAsset.name} index`,
      kind: POINT_CLOUD_INDEX_ASSET_KIND,
      truthStatus: 'indexed-full',
      importPolicy: 'copy',
      sourcePath: null,
      managedPath: path.relative(folder, path.join(finalDir, 'index.json')).replace(/\\/g, '/'),
      units: built.units,
      warnings: [],
      hashes: { importedAt: now, modifiedAt: now },
      pointCloudIndex: {
        sourceAssetId: sourceAsset.id,
        indexType: 'wpi-octree',
        indexVersion: 1,
        source: { headerSha256, fileSize: sourceStats.size, mtimeMs: sourceStats.mtimeMs },
        pointCount: built.source.pointCount,
        bounds: built.bounds,
        scale: built.scale,
        offset: built.offset,
        units: built.units,
        generatedAt: built.generatedAt,
        generator: built.generator,
      },
    };
    // Replace any prior index for this source (regeneration), then register on success only.
    manifest.assets = manifest.assets.filter((a) => a.id !== indexAssetId);
    manifest.assets.push(record);
    manifest.simulationLayers = manifest.simulationLayers.filter((layer) => layer.id !== `layer-${indexAssetId}`);
    manifest.simulationLayers.push({
      id: `layer-${indexAssetId}`,
      simulationId: manifest.realitySimulation.id,
      kind: 'point-cloud-index',
      name: `${sourceAsset.name} index`,
      status: 'active',
      assetId: indexAssetId,
      createdAt: now,
      modifiedAt: now,
    });
    const session = await this.saveProject(manifest);

    return {
      session,
      indexAssetId,
      metrics: {
        pointCount: result.metrics.pointCount,
        storedPointCount: result.metrics.storedPointCount,
        tileCount: result.metrics.tileCount,
        indexSizeBytes: result.metrics.indexSizeBytes,
        maxDepthUsed: result.metrics.maxDepthUsed,
        wallTimeMs: result.metrics.wallTimeMs,
        peakBufferedBytes: result.metrics.peakBufferedBytes,
      },
    };
  }

  cancelPointCloudIndex(input: GeneratePointCloudIndexInput): void {
    this.indexBuilds.get(input.assetId)?.abort();
  }

  async generateAnalyticSurfels(
    input: GenerateAnalyticSurfelsInput,
    onProgress?: (progress: AnalyticSurfelProgress) => void,
  ): Promise<{ session: ProjectSession; surfelAssetId: string; metrics: AnalyticSurfelMetricsSummary }> {
    this.requireOpenProject();
    const folder = this.currentFolder as string;
    const sourceAsset = (this.currentManifest as ProjectManifest).assets.find((a) => a.id === input.assetId);
    if (!sourceAsset || sourceAsset.kind !== 'point-cloud' || !sourceAsset.pointCloud) {
      throw new Error(`Point cloud asset ${input.assetId} not found.`);
    }
    const sourcePath = this.resolvePointCloudSourcePath(folder, sourceAsset);
    if (!(await this.exists(sourcePath))) {
      throw new Error(`${MISSING_SOURCE_WARNING} ${sourcePath}`);
    }
    const sourceStats = await stat(sourcePath);
    const headerSha256 = await this.computeSourceHeaderSha256(sourcePath, sourceStats.size);
    const surfelParent = path.join(folder, 'derived', sourceAsset.id);
    const finalDir = path.join(surfelParent, 'surfels');
    const stageDir = path.join(surfelParent, 'surfels.staging');
    await mkdir(surfelParent, { recursive: true });
    await rm(stageDir, { recursive: true, force: true });

    const controller = new AbortController();
    this.surfelBuilds.set(sourceAsset.id, controller);
    const indexAsset = (this.currentManifest as ProjectManifest).assets.find(
      (candidate) => candidate.pointCloudIndex?.sourceAssetId === sourceAsset.id && hasValidIndexForStreaming(candidate),
    );
    let result;
    try {
      if (indexAsset?.pointCloudIndex) {
        const indexDir = path.join(folder, 'derived', sourceAsset.id, 'index');
        const indexManifest = await readWpiIndexManifest(indexDir);
        result = await buildAnalyticSurfelsFromIndex({
          outDir: stageDir,
          sourceAssetId: sourceAsset.id,
          indexAssetId: indexAsset.id,
          sourceFingerprint: { headerSha256, fileSize: sourceStats.size, mtimeMs: sourceStats.mtimeMs },
          indexDir,
          indexManifest,
          onProgress: (label, pct) => onProgress?.({ assetId: sourceAsset.id, label, pct }),
          shouldCancel: () => controller.signal.aborted,
        });
      } else {
        const preview = await this.loadPointCloudPreview({ assetId: sourceAsset.id });
        result = await buildAnalyticSurfelsFromPreview({
          outDir: stageDir,
          sourceAssetId: sourceAsset.id,
          indexAssetId: null,
          sourceFingerprint: { headerSha256, fileSize: sourceStats.size, mtimeMs: sourceStats.mtimeMs },
          dataset: preview.dataset,
          onProgress: (label, pct) => onProgress?.({ assetId: sourceAsset.id, label, pct }),
          shouldCancel: () => controller.signal.aborted,
        });
      }
      if (!(await isAnalyticSurfelComplete(stageDir))) {
        throw new Error('Analytic surfel build finished without a completion marker.');
      }
      await rm(finalDir, { recursive: true, force: true });
      await rename(stageDir, finalDir);
    } catch (err) {
      await rm(stageDir, { recursive: true, force: true });
      throw err;
    } finally {
      this.surfelBuilds.delete(sourceAsset.id);
    }

    const manifest = structuredClone(this.currentManifest as ProjectManifest);
    const surfelAssetId = `${sourceAsset.id}-analytic-surfel`;
    const now = new Date().toISOString();
    const record: AssetRecord = {
      id: surfelAssetId,
      name: `${sourceAsset.name} surfels`,
      kind: ANALYTIC_SURFEL_ASSET_KIND,
      truthStatus: 'derived',
      importPolicy: 'copy',
      sourcePath: null,
      managedPath: path.relative(folder, path.join(finalDir, 'index.json')).replace(/\\/g, '/'),
      units: sourceAsset.units,
      warnings: [],
      hashes: { importedAt: now, modifiedAt: now },
      analyticSurfel: {
        sourceAssetId: sourceAsset.id,
        indexAssetId: result.manifest.indexAssetId,
        surfelType: result.manifest.surfelType,
        surfelVersion: result.manifest.surfelVersion,
        source: { headerSha256, fileSize: sourceStats.size, mtimeMs: sourceStats.mtimeMs },
        surfelCount: result.manifest.totalSurfels,
        bounds: result.manifest.bounds,
        generatedAt: result.manifest.generatedAt,
        generator: result.manifest.generator,
      },
    };
    manifest.assets = manifest.assets.filter((a) => a.id !== surfelAssetId);
    manifest.assets.push(record);
    manifest.simulationLayers = manifest.simulationLayers.filter((layer) => layer.id !== `layer-${surfelAssetId}`);
    manifest.simulationLayers.push({
      id: `layer-${surfelAssetId}`,
      simulationId: manifest.realitySimulation.id,
      kind: 'derived-surfel',
      name: `${sourceAsset.name} surfels`,
      status: 'active',
      assetId: surfelAssetId,
      createdAt: now,
      modifiedAt: now,
    });
    const session = await this.saveProject(manifest);
    return {
      session,
      surfelAssetId,
      metrics: result.metrics,
    };
  }

  cancelAnalyticSurfels(input: GenerateAnalyticSurfelsInput): void {
    this.surfelBuilds.get(input.assetId)?.abort();
  }

  async loadPointCloudIndexHierarchy(input: LoadPointCloudIndexHierarchyInput): Promise<PointCloudIndexHierarchy> {
    this.requireOpenProject();
    const { manifest } = await this.readIndexForAsset(input.assetId);
    const origin = this.indexOrigin(manifest.bounds);
    return {
      assetId: input.assetId,
      indexAssetId: `${input.assetId}-index`,
      root: manifest.root,
      origin,
      bounds: manifest.bounds,
      scale: manifest.scale,
      offset: manifest.offset,
      units: manifest.units,
      pointFormat: manifest.source.pointFormat,
      hasRgb: manifest.hasRgb,
      totalPoints: manifest.source.pointCount,
      nodes: manifest.nodes.map((node) => ({
        key: node.key,
        level: node.level,
        bounds: node.bounds,
        pointCount: node.pointCount,
        childKeys: node.childKeys,
      })),
    };
  }

  async loadPointCloudIndexTiles(
    input: LoadPointCloudIndexTilesInput,
  ): Promise<{ assetId: string; tiles: { key: string; payload: PointCloudNodePayload }[] }> {
    this.requireOpenProject();
    const { indexDir, manifest } = await this.readIndexForAsset(input.assetId);
    const nodeByKey = new Map(manifest.nodes.map((node) => [node.key, node]));
    const origin = this.indexOrigin(manifest.bounds);
    const [sx, sy, sz] = manifest.scale;
    const [ox, oy, oz] = manifest.offset;
    const tiles: { key: string; payload: PointCloudNodePayload }[] = [];

    for (const key of [...new Set(input.keys)]) {
      const node = nodeByKey.get(key);
      if (!node) continue;
      const decoded = await decodeWpiTileFile(indexDir, node.tile);
      const count = decoded.pointCount;
      const positions = new Float32Array(count * 3);
      const colors = new Uint8Array(count * 3);
      const intensities = new Float32Array(count);
      const classifications = new Uint8Array(count);
      const returnNumbers = new Uint8Array(count);
      const numberOfReturns = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        // int32 grid → world → origin-relative f32 (rebase done here, off the render thread).
        positions[i * 3] = decoded.x[i]! * sx + ox - origin[0];
        positions[i * 3 + 1] = decoded.y[i]! * sy + oy - origin[1];
        positions[i * 3 + 2] = decoded.z[i]! * sz + oz - origin[2];
        if (decoded.hasRgb) {
          colors[i * 3] = decoded.r![i]! >> 8;
          colors[i * 3 + 1] = decoded.g![i]! >> 8;
          colors[i * 3 + 2] = decoded.b![i]! >> 8;
        } else {
          colors[i * 3] = 255;
          colors[i * 3 + 1] = 255;
          colors[i * 3 + 2] = 255;
        }
        intensities[i] = decoded.intensity[i]! / 65535;
        classifications[i] = decoded.classification[i]!;
        const { returnNumber, numberOfReturns: nr } = decodeReturnByte(decoded.returnByte[i]!, manifest.source.pointFormat);
        returnNumbers[i] = returnNumber;
        numberOfReturns[i] = nr;
      }
      tiles.push({ key, payload: { pointCount: count, positions, colors, intensities, classifications, returnNumbers, numberOfReturns } });
    }
    return { assetId: input.assetId, tiles };
  }

  async loadAnalyticSurfelHierarchy(input: LoadAnalyticSurfelHierarchyInput): Promise<AnalyticSurfelHierarchy> {
    this.requireOpenProject();
    const { asset, manifest } = await this.readAnalyticSurfelForAsset(input.assetId);
    const origin = this.indexOrigin(manifest.bounds);
    return {
      assetId: asset.id,
      sourceAssetId: manifest.sourceAssetId,
      indexAssetId: manifest.indexAssetId,
      root: manifest.root,
      origin,
      bounds: manifest.bounds,
      totalSurfels: manifest.totalSurfels,
      nodes: manifest.nodes.map((node) => ({
        key: node.key,
        level: node.level,
        bounds: node.bounds,
        surfelCount: node.surfelCount,
        childKeys: node.childKeys,
      })),
    };
  }

  async loadAnalyticSurfelTiles(
    input: LoadAnalyticSurfelTilesInput,
  ): Promise<{ assetId: string; tiles: { key: string; payload: AnalyticSurfelTilePayload }[] }> {
    this.requireOpenProject();
    const { asset, surfelDir, manifest } = await this.readAnalyticSurfelForAsset(input.assetId);
    const nodeByKey = new Map(manifest.nodes.map((node) => [node.key, node]));
    const origin = this.indexOrigin(manifest.bounds);
    const tiles: { key: string; payload: AnalyticSurfelTilePayload }[] = [];
    for (const key of [...new Set(input.keys)]) {
      const node = nodeByKey.get(key);
      if (!node) continue;
      const decoded = await readAnalyticSurfelTile(path.join(surfelDir, ANALYTIC_SURFEL_TILES_DIR), node.tile);
      const positions = new Float32Array(decoded.positions.length);
      for (let i = 0; i < decoded.surfelCount; i++) {
        positions[i * 3] = decoded.positions[i * 3] - origin[0];
        positions[i * 3 + 1] = decoded.positions[i * 3 + 1] - origin[1];
        positions[i * 3 + 2] = decoded.positions[i * 3 + 2] - origin[2];
      }
      tiles.push({
        key,
        payload: {
          surfelCount: decoded.surfelCount,
          positions,
          colors: decoded.colors,
          radii: decoded.radii,
          normals: decoded.normals,
          confidence: decoded.confidence,
          flags: decoded.flags,
        },
      });
    }
    return { assetId: asset.id, tiles };
  }

  private indexOrigin(bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }): [number, number, number] {
    return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, (bounds.minZ + bounds.maxZ) / 2];
  }

  private async readIndexForAsset(assetId: string): Promise<{ indexDir: string; manifest: Awaited<ReturnType<typeof readWpiIndexManifest>> }> {
    const folder = this.currentFolder as string;
    const indexAssetId = `${assetId}-index`;
    const indexAsset = (this.currentManifest as ProjectManifest).assets.find((a) => a.id === indexAssetId && a.pointCloudIndex);
    if (!indexAsset) {
      throw new Error(`No point-cloud index is registered for asset ${assetId}.`);
    }
    const indexDir = path.join(folder, 'derived', assetId, 'index');
    const manifest = await readWpiIndexManifest(indexDir); // throws on missing marker / corrupt
    return { indexDir, manifest };
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
      kind: 'derived-surface',
      name: `${surface.name} (derived)`,
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

  private async applyPointCloudOpenChecks(projectFolder: string, manifest: ProjectManifest): Promise<ProjectManifest> {
    const next = structuredClone(manifest);
    for (const asset of next.assets) {
      if (asset.kind !== 'point-cloud') continue;
      const previewLayers = next.simulationLayers.filter(
        (candidate) =>
          candidate.assetId === asset.id && (candidate.kind === 'point-cloud-preview' || candidate.kind === 'asset'),
      );
      const sourcePath = this.resolvePointCloudSourcePath(projectFolder, asset);
      const exists = await this.exists(sourcePath);
      asset.warnings = asset.warnings.filter((warning) => warning !== MISSING_SOURCE_WARNING);
      if (!exists) {
        if (!asset.warnings.includes(MISSING_SOURCE_WARNING)) asset.warnings.push(MISSING_SOURCE_WARNING);
        for (const layer of previewLayers) layer.status = 'error';
      } else {
        for (const layer of previewLayers) {
          if (layer.status === 'error') layer.status = 'active';
        }
      }
    }

    for (const asset of next.assets) {
      if (asset.kind !== POINT_CLOUD_INDEX_ASSET_KIND || !asset.pointCloudIndex) continue;
      // Drop any stale/missing warning we added on a prior open so this stays idempotent.
      asset.warnings = asset.warnings.filter((warning) => !isManagedIndexWarning(warning));
      const sourceAsset = next.assets.find((candidate) => candidate.id === asset.pointCloudIndex!.sourceAssetId);
      if (!sourceAsset) continue; // dangling refs are rejected by the schema; defensive only
      try {
        const current = await this.computeCurrentSourceFingerprint(projectFolder, sourceAsset);
        const warning = formatStaleIndexWarning(detectIndexStaleness(asset.pointCloudIndex.source, current));
        if (warning) asset.warnings.push(warning);
      } catch {
        asset.warnings.push(`${POINT_CLOUD_INDEX_WARNING_PREFIX} freshness could not be verified from the current source.`);
      }
    }

    for (const asset of next.assets) {
      if (asset.kind !== ANALYTIC_SURFEL_ASSET_KIND || !asset.analyticSurfel) continue;
      asset.warnings = asset.warnings.filter(
        (warning) => warning !== MISSING_DERIVED_SURFEL_WARNING && !isManagedAnalyticSurfelWarning(warning),
      );
      const surfelPath = asset.managedPath ? this.resolveManagedPath(projectFolder, asset.managedPath) : null;
      const layers = next.simulationLayers.filter(
        (layer) => layer.assetId === asset.id && (layer.kind === 'derived-surfel' || layer.kind === 'asset'),
      );
      if (!surfelPath || !(await this.exists(surfelPath))) {
        asset.warnings.push(MISSING_DERIVED_SURFEL_WARNING);
        for (const layer of layers) layer.status = 'error';
        continue;
      }
      const sourceAsset = next.assets.find((candidate) => candidate.id === asset.analyticSurfel!.sourceAssetId);
      if (!sourceAsset) continue;
      try {
        const current = await this.computeCurrentSourceFingerprint(projectFolder, sourceAsset);
        const warning = formatAnalyticSurfelWarning(detectIndexStaleness(asset.analyticSurfel.source, current));
        if (warning) asset.warnings.push(warning);
        for (const layer of layers) {
          if (layer.status === 'error') layer.status = 'active';
        }
      } catch {
        asset.warnings.push('Analytic surfel render freshness could not be verified from the current source.');
      }
    }
    return next;
  }

  private async readAnalyticSurfelForAsset(assetId: string): Promise<{
    asset: AssetRecord;
    surfelDir: string;
    manifest: Awaited<ReturnType<typeof readAnalyticSurfelManifest>>;
  }> {
    const folder = this.currentFolder as string;
    const asset = (this.currentManifest as ProjectManifest).assets.find((candidate) => candidate.id === assetId && candidate.analyticSurfel);
    if (!asset || !asset.managedPath) {
      throw new Error(`No analytic surfel asset is registered for asset ${assetId}.`);
    }
    const surfelDir = path.dirname(this.resolveManagedPath(folder, asset.managedPath));
    const manifest = await readAnalyticSurfelManifest(surfelDir);
    return { asset, surfelDir, manifest };
  }

  private async computeCurrentSourceFingerprint(
    projectFolder: string,
    sourceAsset: ProjectManifest['assets'][number],
  ): Promise<CurrentSourceFingerprint> {
    const sourcePath = this.resolvePointCloudSourcePath(projectFolder, sourceAsset);
    if (!(await this.exists(sourcePath))) return { exists: false };
    const sourceStats = await stat(sourcePath);
    const headerSha256 = await this.computeSourceHeaderSha256(sourcePath, sourceStats.size);
    return { exists: true, headerSha256, fileSize: sourceStats.size, mtimeMs: sourceStats.mtimeMs };
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

  private async fileChunkSource(filePath: string): Promise<ChunkSource> {
    const sourceStats = await stat(filePath);
    return {
      size: sourceStats.size,
      async read(start: number, end: number): Promise<ArrayBuffer> {
        const handle = await open(filePath, 'r');
        try {
          const length = Math.max(0, end - start);
          const buffer = Buffer.alloc(length);
          let offset = 0;
          while (offset < length) {
            const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
            if (bytesRead <= 0) break;
            offset += bytesRead;
          }
          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        } finally {
          await handle.close();
        }
      },
    };
  }

  private async readLasPreamble(filePath: string): Promise<ArrayBuffer> {
    const handle = await open(filePath, 'r');
    try {
      const headerBuffer = Buffer.alloc(375);
      await handle.read(headerBuffer, 0, headerBuffer.length, 0);
      const header = headerBuffer.buffer.slice(headerBuffer.byteOffset, headerBuffer.byteOffset + headerBuffer.byteLength);
      const offsetToPointData = new DataView(header).getUint32(96, true);
      const preambleBuffer = Buffer.alloc(offsetToPointData);
      await handle.read(preambleBuffer, 0, preambleBuffer.length, 0);
      return preambleBuffer.buffer.slice(preambleBuffer.byteOffset, preambleBuffer.byteOffset + preambleBuffer.byteLength);
    } finally {
      await handle.close();
    }
  }

  private uniqueManagedFileName(manifest: ProjectManifest, baseName: string): string {
    const taken = new Set(manifest.assets.map((asset) => asset.managedPath).filter((value): value is string => Boolean(value)));
    if (!taken.has(`sources/${baseName}`)) return baseName;
    const parsed = path.parse(baseName);
    let index = 1;
    while (taken.has(`sources/${parsed.name}-${index}${parsed.ext}`)) index++;
    return `${parsed.name}-${index}${parsed.ext}`;
  }

  private resolvePointCloudSourcePath(projectFolder: string, asset: ProjectManifest['assets'][number]): string {
    if (asset.importPolicy === 'copy') {
      if (!asset.managedPath) throw new Error(`Point cloud asset ${asset.id} has no managedPath.`);
      return this.resolveManagedPath(projectFolder, asset.managedPath);
    }
    if (!asset.sourcePath) throw new Error(`Point cloud asset ${asset.id} has no sourcePath.`);
    return asset.sourcePath;
  }

  private buildPointCloudPreview(input: {
    assetId: string;
    dataset: PointCloudDataset;
    sourcePath: string;
    cachePath: string;
    warnings: string[];
  }): PointCloudPreviewState {
    const disclosure = this.buildPointCloudDisclosure(
      input.dataset.octree?.totalSampledPoints ?? 0,
      input.dataset.pointCount,
      false,
    );
    return {
      assetId: input.assetId,
      sourceAssetTruthStatus: 'source',
      displayTruthStatus: 'preview-sampled',
      sampledPointCount: input.dataset.octree?.totalSampledPoints ?? 0,
      totalPointCount: input.dataset.pointCount,
      densifiedPointCount: 0,
      sourceAvailable: input.warnings.length === 0 || !input.warnings.includes(MISSING_SOURCE_CACHE_WARNING),
      disclosure,
      sourcePath: input.sourcePath,
      cachePath: input.cachePath,
      warnings: [...input.warnings],
    };
  }

  private buildPointCloudDisclosure(sampledPointCount: number, totalPointCount: number, hasDensifiedPoints: boolean): string {
    const sampled = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(sampledPointCount);
    const total = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(totalPointCount);
    return hasDensifiedPoints
      ? `Preview - sampled ${sampled} of ${total} points · ${DENSIFIED_DISCLOSURE_SUFFIX}`
      : `Preview - sampled ${sampled} of ${total} points`;
  }

  private async computeSourceHeaderSha256(filePath: string, fileSize: number): Promise<string> {
    const preamble = await this.readLasPreamble(filePath);
    return createHash('sha256').update(new Uint8Array(preamble)).update(Buffer.from(String(fileSize))).digest('hex');
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
