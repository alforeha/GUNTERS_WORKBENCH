import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectService } from '../electron/project-service';
import { projectManifestSchema } from '../src/shared/manifest-schema';

function syntheticLasHeader(pointCount = 2): ArrayBuffer {
  const buffer = new ArrayBuffer(375);
  const view = new DataView(buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, 'LASF');
  view.setUint8(24, 1);
  view.setUint8(25, 4);
  view.setUint16(94, 375, true);
  view.setUint32(96, 375, true);
  view.setUint32(100, 0, true);
  view.setUint8(104, 7);
  view.setUint16(105, 36, true);
  view.setBigUint64(247, BigInt(pointCount), true);
  view.setFloat64(131, 0.01, true);
  view.setFloat64(139, 0.01, true);
  view.setFloat64(147, 0.01, true);
  view.setFloat64(155, 1000, true);
  view.setFloat64(163, 2000, true);
  view.setFloat64(171, 3000, true);
  view.setFloat64(179, 1010, true);
  view.setFloat64(187, 1000, true);
  view.setFloat64(195, 2020, true);
  view.setFloat64(203, 2000, true);
  view.setFloat64(211, 3030, true);
  view.setFloat64(219, 3000, true);
  return buffer;
}

function syntheticPointSample(pointCount = 2): ArrayBuffer {
  const buffer = new ArrayBuffer(pointCount * 36);
  const view = new DataView(buffer);
  for (let i = 0; i < pointCount; i++) {
    const offset = i * 36;
    view.setInt32(offset, i * 100, true);
    view.setInt32(offset + 4, i * 200, true);
    view.setInt32(offset + 8, i * 50, true);
    view.setUint16(offset + 12, 100 + i * 100, true);
    view.setUint8(offset + 14, 0x11);
    view.setUint8(offset + 15, 0x01);
    view.setUint8(offset + 16, i % 2 === 0 ? 1 : 2);
    view.setUint16(offset + 30, 256 + i * 128, true);
    view.setUint16(offset + 32, 512 + i * 128, true);
    view.setUint16(offset + 34, 768 + i * 128, true);
  }
  return buffer;
}

async function writeSyntheticLasFile(folder: string, fileName = 'fixture.las', pointCount = 2): Promise<string> {
  const filePath = path.join(folder, fileName);
  const payload = Buffer.concat([Buffer.from(syntheticLasHeader(pointCount)), Buffer.from(syntheticPointSample(pointCount))]);
  await writeFile(filePath, payload);
  return filePath;
}

async function readCacheDescriptor(projectFolder: string, assetId: string): Promise<any> {
  const raw = await readFile(path.join(projectFolder, 'cache', assetId, 'descriptor.json'), 'utf8');
  return JSON.parse(raw);
}

describe('ProjectService lifecycle', () => {
  it('creates required folder structure and valid manifest', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const svc = new ProjectService();
    const session = await svc.createProject({ parentDir: parent, projectName: 'P1' });

    for (const required of ['sources', 'derived', 'edited', 'exports', 'reports', 'history', 'cache']) {
      expect(existsSync(path.join(session.projectFolder, required))).toBe(true);
    }

    const parsed = projectManifestSchema.safeParse(session.manifest);
    expect(parsed.success).toBe(true);
    expect(session.manifest.realitySimulation.id).toBe('sim-primary');
  });

  it('updates backup on save and reloads cleanly', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const svc = new ProjectService();
    const created = await svc.createProject({ parentDir: parent, projectName: 'P2' });

    created.manifest.info['note'] = 'saved once';
    const saved = await svc.saveProject(created.manifest);

    expect(existsSync(saved.backupPath)).toBe(true);

    await svc.closeProject();
    const reopened = await svc.openProject({ projectFolder: saved.projectFolder });
    expect(reopened.manifest.info['note']).toBe('saved once');
    expect(reopened.manifest.recovery.uncleanShutdown).toBe(false);
  });

  it('detects unclean save state from temp file', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const svc = new ProjectService();
    const created = await svc.createProject({ parentDir: parent, projectName: 'P3' });

    await writeFile(path.join(created.projectFolder, 'project.json.tmp'), '{"partial":true}\n', 'utf8');
    await svc.closeProject();

    const reopened = await svc.openProject({ projectFolder: created.projectFolder });
    expect(reopened.recoveryDetected).toBe(true);
    expect(reopened.manifest.recovery.uncleanShutdown).toBe(true);
  });

  it('adds derived layer as flat membership and persists through reopen', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const svc = new ProjectService();
    const created = await svc.createProject({ parentDir: parent, projectName: 'P4' });

    const generated = await svc.generatePlaceholderDerivedLayer();
    expect(generated.session.manifest.assets.some((a) => a.truthStatus === 'derived')).toBe(true);
    expect(generated.session.manifest.simulationLayers.length).toBe(1);
    expect(generated.session.manifest.simulationLayers[0]?.simulationId).toBe(
      generated.session.manifest.realitySimulation.id,
    );
    expect(generated.session.manifest.simulationLayers[0]?.status).toBe('active');

    await svc.closeProject();
    const reopened = await svc.openProject({ projectFolder: created.projectFolder });
    expect(reopened.manifest.simulationLayers.length).toBe(1);
    const artifactPath = path.join(reopened.projectFolder, reopened.manifest.assets[0]?.managedPath ?? '');
    const artifactRaw = await readFile(artifactPath, 'utf8');
    expect(JSON.parse(artifactRaw).positions.length).toBeGreaterThan(0);

    const hydrated = await svc.readDerivedSurfaceArtifact(reopened.manifest.assets[0]?.managedPath ?? '');
    expect(hydrated.id).toBe(generated.surface.id);
    expect(hydrated.positions.length).toBe(generated.surface.positions.length);
    expect(hydrated.indices.length).toBe(generated.surface.indices.length);
  });

  it('imports point-cloud sources by reference, writes a binary preview cache, and reloads from it on reopen', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'las-'));
    const sourceFile = await writeSyntheticLasFile(fixtureDir);
    const svc = new ProjectService();
    const created = await svc.createProject({ parentDir: parent, projectName: 'P6' });

    const imported = await svc.importPointCloud({ filePath: sourceFile, importPolicy: 'reference' });
    const asset = imported.manifest.assets.find((candidate) => candidate.kind === 'point-cloud');
    expect(asset?.truthStatus).toBe('source');
    expect(asset?.sourcePath).toBe(sourceFile);
    expect(asset?.managedPath).toBeNull();
    expect(asset?.pointCloud?.pointCount).toBe(2);
    expect(imported.manifest.simulationLayers[0]?.assetId).toBe(asset?.id);
    expect(imported.manifest.simulationLayers[0]?.status).toBe('active');

    const preview = await svc.loadPointCloudPreview({ assetId: asset?.id as string });
    expect(preview.preview.displayTruthStatus).toBe('preview-sampled');
    expect(preview.preview.warnings).toEqual([]);
    expect(preview.dataset.octree?.totalSampledPoints).toBeGreaterThan(0);

    const cacheDir = path.join(created.projectFolder, 'cache', asset?.id as string);
    expect(existsSync(path.join(cacheDir, 'descriptor.json'))).toBe(true);
    expect(existsSync(path.join(cacheDir, 'positions.f32.bin'))).toBe(true);
    expect(existsSync(path.join(cacheDir, 'colors.u8.bin'))).toBe(true);
    const descriptor = await readCacheDescriptor(created.projectFolder, asset?.id as string);
    const sourceStats = await stat(sourceFile);
    expect(descriptor.assetId).toBe(asset?.id);
    expect(descriptor.source.fileSize).toBe(sourceStats.size);
    expect(descriptor.source.mtimeMs).toBe(sourceStats.mtimeMs);
    expect(descriptor.source.headerSha256).toBe(asset?.pointCloud?.headerSha256);
    expect(descriptor.sampling.sampledPointCount).toBe(preview.preview.sampledPointCount);
    expect(descriptor.sampling.totalPointCount).toBe(preview.preview.totalPointCount);
    expect(descriptor.sampling.qualityTier).toBe('balanced');

    await svc.closeProject();
    await svc.openProject({ projectFolder: created.projectFolder });
    const reopenedPreview = await svc.loadPointCloudPreview({ assetId: asset?.id as string });
    expect(reopenedPreview.dataset.octree?.totalSampledPoints).toBe(preview.dataset.octree?.totalSampledPoints);
    expect(reopenedPreview.preview.cachePath).toBe(path.posix.join('cache', asset?.id as string, 'descriptor.json'));
  });

  it('invalidates a stale cache when the source file changes and rewrites it', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'las-'));
    const sourceFile = await writeSyntheticLasFile(fixtureDir, 'changed-fixture.las', 2);
    const svc = new ProjectService();
    const created = await svc.createProject({ parentDir: parent, projectName: 'P7' });
    const imported = await svc.importPointCloud({ filePath: sourceFile, importPolicy: 'reference' });
    const asset = imported.manifest.assets.find((candidate) => candidate.kind === 'point-cloud')!;

    await svc.loadPointCloudPreview({ assetId: asset.id });
    const descriptorBefore = await readCacheDescriptor(created.projectFolder, asset.id);

    await writeSyntheticLasFile(fixtureDir, 'changed-fixture.las', 3);
    const refreshed = await svc.loadPointCloudPreview({ assetId: asset.id });
    const descriptorAfter = await readCacheDescriptor(created.projectFolder, asset.id);

    expect(refreshed.dataset.pointCount).toBe(3);
    expect(descriptorAfter.source.mtimeMs).not.toBe(descriptorBefore.source.mtimeMs);
    expect(descriptorAfter.sampling.totalPointCount).toBe(3);
  });

  it('falls back to rebuilding when the preview cache is corrupt', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'las-'));
    const sourceFile = await writeSyntheticLasFile(fixtureDir, 'corrupt-fixture.las', 2);
    const svc = new ProjectService();
    const created = await svc.createProject({ parentDir: parent, projectName: 'P8' });
    const imported = await svc.importPointCloud({ filePath: sourceFile, importPolicy: 'reference' });
    const asset = imported.manifest.assets.find((candidate) => candidate.kind === 'point-cloud')!;

    await svc.loadPointCloudPreview({ assetId: asset.id });
    const descriptorPath = path.join(created.projectFolder, 'cache', asset.id, 'descriptor.json');
    await writeFile(descriptorPath, '{"broken":', 'utf8');

    const rebuilt = await svc.loadPointCloudPreview({ assetId: asset.id });
    expect(rebuilt.preview.displayTruthStatus).toBe('preview-sampled');
    expect(rebuilt.dataset.pointCount).toBe(2);
    const repairedDescriptor = await readCacheDescriptor(created.projectFolder, asset.id);
    expect(repairedDescriptor.assetId).toBe(asset.id);
  });

  it('imports point-cloud sources by copy into the project sources folder', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'las-'));
    const sourceFile = await writeSyntheticLasFile(fixtureDir, 'copy-fixture.las');
    const svc = new ProjectService();
    await svc.createProject({ parentDir: parent, projectName: 'P9' });

    const imported = await svc.importPointCloud({ filePath: sourceFile, importPolicy: 'copy' });
    const asset = imported.manifest.assets.find((candidate) => candidate.kind === 'point-cloud');
    expect(asset?.managedPath).toMatch(/^sources\//);
    expect(existsSync(path.join(imported.projectFolder, asset?.managedPath ?? ''))).toBe(true);
  });

  it('loads a cached preview with an explicit stale warning when the referenced source goes missing', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'las-'));
    const sourceFile = await writeSyntheticLasFile(fixtureDir, 'missing-fixture.las');
    const svc = new ProjectService();
    const created = await svc.createProject({ parentDir: parent, projectName: 'P10' });
    const imported = await svc.importPointCloud({ filePath: sourceFile, importPolicy: 'reference' });
    const asset = imported.manifest.assets.find((candidate) => candidate.kind === 'point-cloud')!;

    await svc.loadPointCloudPreview({ assetId: asset.id });
    const descriptorPath = path.join(created.projectFolder, 'cache', asset.id, 'descriptor.json');
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
    descriptor.schemaVersion = 1;
    const stripRanges = (node: any): void => {
      delete node.sourceRanges;
      node.children.forEach(stripRanges);
    };
    stripRanges(descriptor.dataset.octree.root);
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
    await svc.closeProject();
    await rm(sourceFile);

    const reopened = await svc.openProject({ projectFolder: created.projectFolder });
    const reopenedAsset = reopened.manifest.assets.find((candidate) => candidate.id === asset.id);
    expect(reopenedAsset?.warnings.some((warning) => warning.includes('missing'))).toBe(true);
    expect(reopened.manifest.simulationLayers[0]?.status).toBe('error');

    const cachedPreview = await svc.loadPointCloudPreview({ assetId: asset.id });
    expect(cachedPreview.preview.warnings).toContain('Source file is missing; showing cached preview that may be stale.');
    expect(cachedPreview.dataset.pointCount).toBe(2);
  });

  it('rejects manifest shape that puts membership IDs inside realitySimulation', () => {
    const invalid = {
      schemaVersion: '1.0.0',
      info: {},
      crs: {},
      settings: {},
      standards: {},
      assets: [],
      groups: [],
      realitySimulation: {
        id: 'sim-primary',
        name: 'Primary',
        status: 'empty',
        mode: 'single-primary',
        phaseContext: 'scaffold',
        settings: {},
        warnings: [],
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        layerIds: ['bad'],
      },
      simulationLayers: [],
      features: [],
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
    };

    const parsed = projectManifestSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown top-level manifest keys', () => {
    const parsed = projectManifestSchema.safeParse({
      schemaVersion: '1.0.0',
      info: {},
      crs: {},
      settings: {},
      standards: {},
      assets: [],
      groups: [],
      realitySimulation: {
        id: 'sim-primary',
        name: 'Primary',
        status: 'empty',
        mode: 'single-primary',
        phaseContext: 'scaffold',
        settings: {},
        warnings: [],
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
      },
      simulationLayers: [],
      features: [],
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
      extraTopLevel: true,
    });

    expect(parsed.success).toBe(false);
  });

  it('treats an unparseable journal tail as unclean shutdown', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const svc = new ProjectService();
    const created = await svc.createProject({ parentDir: parent, projectName: 'P5' });

    await writeFile(
      path.join(created.projectFolder, 'history', 'journal.log'),
      '{"event":"complete"}\n{"event":"intent"\n',
      'utf8',
    );
    await svc.closeProject();

    const reopened = await svc.openProject({ projectFolder: created.projectFolder });
    expect(reopened.recoveryDetected).toBe(true);
    expect(reopened.manifest.recovery.uncleanShutdown).toBe(true);
  });

  // ── Phase 4: preview disclosure format ──────────────────────────────────
  it('produces a pure preview disclosure (no densification suffix) on initial load', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'las-'));
    const sourceFile = await writeSyntheticLasFile(fixtureDir, 'disclosure-fixture.las');
    const svc = new ProjectService();
    await svc.createProject({ parentDir: parent, projectName: 'DISC' });
    const imported = await svc.importPointCloud({ filePath: sourceFile, importPolicy: 'reference' });
    const asset = imported.manifest.assets.find((candidate) => candidate.kind === 'point-cloud')!;

    const preview = await svc.loadPointCloudPreview({ assetId: asset.id });
    expect(preview.preview.disclosure).toMatch(/^Preview - sampled .+ of .+ points$/);
    expect(preview.preview.disclosure).not.toMatch(/fallback/);
    expect(preview.preview.disclosure).not.toMatch(/densif/i);
    expect(preview.preview.densifiedPointCount).toBe(0);
  });

  it('densification request succeeds when no index is registered', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'las-'));
    const sourceFile = await writeSyntheticLasFile(fixtureDir, 'fallback-fixture.las', 2);
    const svc = new ProjectService();
    await svc.createProject({ parentDir: parent, projectName: 'DENS' });
    const imported = await svc.importPointCloud({ filePath: sourceFile, importPolicy: 'reference' });
    const asset = imported.manifest.assets.find((candidate) => candidate.kind === 'point-cloud')!;

    const preview = await svc.loadPointCloudPreview({ assetId: asset.id });
    const nodeIds = [preview.dataset.octree?.root.id ?? -1].filter((id) => id >= 0);
    if (nodeIds.length === 0) return; // no leaf with source ranges → nothing to request

    const result = await svc.loadPointCloudDensifiedNodes({ assetId: asset.id, nodeIds });
    // No index exists → densification is allowed (sourceAvailable true, no gate).
    expect(result.sourceAvailable).toBe(true);
    expect(result.warning).toBeNull();
  });
});
