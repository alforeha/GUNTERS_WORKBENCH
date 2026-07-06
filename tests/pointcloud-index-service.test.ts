import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectService } from '../electron/project-service';
import { PointCloudIndexCancelled, type BuildPointCloudIndexResult } from '../electron/pointcloud-index-builder';
import { inlineIndexBuild } from '../electron/pointcloud-index-runner';
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
    view.setUint8(offset + 16, i % 2 === 0 ? 1 : 2);
    view.setUint16(offset + 30, 256 + i * 128, true);
    view.setUint16(offset + 32, 512 + i * 128, true);
    view.setUint16(offset + 34, 768 + i * 128, true);
  }
  return buffer;
}

function syntheticPointSample8BitRgb(pointCount = 2): ArrayBuffer {
  const buffer = new ArrayBuffer(pointCount * 36);
  const view = new DataView(buffer);
  for (let i = 0; i < pointCount; i++) {
    const offset = i * 36;
    view.setInt32(offset, i * 100, true);
    view.setInt32(offset + 4, i * 200, true);
    view.setInt32(offset + 8, i * 50, true);
    view.setUint16(offset + 12, 100 + i * 100, true);
    view.setUint8(offset + 14, 0x11);
    view.setUint8(offset + 16, i % 2 === 0 ? 1 : 2);
    view.setUint16(offset + 30, 12 + i, true);
    view.setUint16(offset + 32, 34 + i, true);
    view.setUint16(offset + 34, 56 + i, true);
  }
  return buffer;
}

function clusteredPointSample(grid = 16): ArrayBuffer {
  const pointCount = grid * grid;
  const buffer = new ArrayBuffer(pointCount * 36);
  const view = new DataView(buffer);
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      const i = y * grid + x;
      const offset = i * 36;
      view.setInt32(offset, x * 10, true);
      view.setInt32(offset + 4, y * 10, true);
      view.setInt32(offset + 8, 0, true);
      view.setUint16(offset + 12, 100, true);
      view.setUint8(offset + 14, 0x11);
      view.setUint8(offset + 16, 1);
      view.setUint16(offset + 30, 256, true);
      view.setUint16(offset + 32, 512, true);
      view.setUint16(offset + 34, 768, true);
    }
  }
  return buffer;
}

async function writeSyntheticLasFile(folder: string, fileName = 'fixture.las', pointCount = 8): Promise<string> {
  const filePath = path.join(folder, fileName);
  const payload = Buffer.concat([Buffer.from(syntheticLasHeader(pointCount)), Buffer.from(syntheticPointSample(pointCount))]);
  await writeFile(filePath, payload);
  return filePath;
}

async function writeSynthetic8BitRgbLasFile(folder: string, fileName = 'fixture-8bit-rgb.las', pointCount = 8): Promise<string> {
  const filePath = path.join(folder, fileName);
  const payload = Buffer.concat([Buffer.from(syntheticLasHeader(pointCount)), Buffer.from(syntheticPointSample8BitRgb(pointCount))]);
  await writeFile(filePath, payload);
  return filePath;
}

async function writeClusteredLasFile(folder: string, fileName = 'clustered-fixture.las', grid = 16): Promise<string> {
  const pointCount = grid * grid;
  const filePath = path.join(folder, fileName);
  const payload = Buffer.concat([Buffer.from(syntheticLasHeader(pointCount)), Buffer.from(clusteredPointSample(grid))]);
  await writeFile(filePath, payload);
  return filePath;
}

async function importedProject(runIndexBuild?: ConstructorParameters<typeof ProjectService>[0]) {
  const parent = await mkdtemp(path.join(tmpdir(), 'wb-gen-'));
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'las-gen-'));
  const sourceFile = await writeSyntheticLasFile(fixtureDir);
  const svc = new ProjectService(runIndexBuild);
  const created = await svc.createProject({ parentDir: parent, projectName: 'GEN' });
  const imported = await svc.importPointCloud({ filePath: sourceFile, importPolicy: 'reference' });
  const asset = imported.manifest.assets.find((a) => a.kind === 'point-cloud')!;
  return { svc, projectFolder: created.projectFolder, sourceFile, assetId: asset.id };
}

describe('ProjectService.generatePointCloudIndex', () => {
  it('builds an index, registers it only on success, and survives reopen', async () => {
    const { svc, projectFolder, assetId } = await importedProject({ runIndexBuild: inlineIndexBuild });
    const generated = await svc.generatePointCloudIndex({ assetId });

    expect(generated.metrics.storedPointCount).toBe(8);
    expect(generated.metrics.pointCount).toBe(8);
    expect(generated.metrics.tileCount).toBeGreaterThan(0);

    const indexAsset = generated.session.manifest.assets.find((a) => a.id === generated.indexAssetId)!;
    expect(indexAsset.kind).toBe('point-cloud-index');
    expect(indexAsset.truthStatus).toBe('indexed-full');
    expect(indexAsset.pointCloudIndex?.sourceAssetId).toBe(assetId);
    expect(indexAsset.pointCloudIndex?.indexType).toBe('wpi-octree');
    expect(indexAsset.pointCloudIndex?.indexVersion).toBe(2);
    expect(indexAsset.pointCloudIndex?.ownership).toBe('strided');

    expect(existsSync(path.join(projectFolder, 'derived', assetId, 'index', 'index.json'))).toBe(true);
    expect(existsSync(path.join(projectFolder, 'derived', assetId, 'index', 'COMPLETE'))).toBe(true);
    // staging dir must be gone after the successful swap
    expect(existsSync(path.join(projectFolder, 'derived', assetId, 'index.staging'))).toBe(false);

    await svc.closeProject();
    const reopened = await svc.openProject({ projectFolder });
    const reopenedIndex = reopened.manifest.assets.find((a) => a.id === generated.indexAssetId);
    expect(reopenedIndex?.truthStatus).toBe('indexed-full');
    expect(reopenedIndex?.warnings ?? []).toEqual([]); // source unchanged → not stale
  });

  it('regenerating replaces the prior index record rather than duplicating it', async () => {
    const { svc, assetId } = await importedProject({ runIndexBuild: inlineIndexBuild });
    const first = await svc.generatePointCloudIndex({ assetId });
    const second = await svc.generatePointCloudIndex({ assetId });
    expect(second.indexAssetId).toBe(first.indexAssetId);
    const indexAssets = second.session.manifest.assets.filter((a) => a.kind === 'point-cloud-index');
    expect(indexAssets).toHaveLength(1);
  });

  it('leaves the project manifest valid and unchanged when a build fails', async () => {
    const { svc, projectFolder, assetId } = await importedProject({
      runIndexBuild: async () => {
        throw new Error('synthetic build failure');
      },
    });
    const before = (await svc.openProject({ projectFolder })).manifest;
    const beforeAssetCount = before.assets.length;

    await expect(svc.generatePointCloudIndex({ assetId })).rejects.toThrow(/synthetic build failure/);

    const after = (await svc.openProject({ projectFolder })).manifest;
    expect(after.assets.length).toBe(beforeAssetCount);
    expect(after.assets.some((a) => a.kind === 'point-cloud-index')).toBe(false);
    expect(projectManifestSchema.safeParse(after).success).toBe(true);
    expect(existsSync(path.join(projectFolder, 'derived', assetId, 'index.staging'))).toBe(false);
  });

  it('streams the index hierarchy and decoded, origin-rebased tiles', async () => {
    const { svc, assetId } = await importedProject({ runIndexBuild: inlineIndexBuild });
    await svc.generatePointCloudIndex({ assetId });

    const hierarchy = await svc.loadPointCloudIndexHierarchy({ assetId });
    expect(hierarchy.root).toBe('0-0-0-0');
    expect(hierarchy.totalPoints).toBe(8);
    expect(hierarchy.nodes.length).toBeGreaterThanOrEqual(1);
    expect(hierarchy.hasRgb).toBe(true);
    expect(hierarchy.pointFormat).toBe(7);

    const { tiles } = await svc.loadPointCloudIndexTiles({ assetId, keys: [hierarchy.root] });
    expect(tiles).toHaveLength(1);
    const payload = tiles[0]!.payload;
    expect(payload.pointCount).toBe(8);

    // Reconstruct world coords from origin-relative positions and match the synthetic source.
    const round = (p: number[]) => p.map((v) => Math.round(v * 100) / 100).join(',');
    const got: string[] = [];
    for (let i = 0; i < payload.pointCount; i++) {
      got.push(
        round([
          payload.positions[i * 3]! + hierarchy.origin[0],
          payload.positions[i * 3 + 1]! + hierarchy.origin[1],
          payload.positions[i * 3 + 2]! + hierarchy.origin[2],
        ]),
      );
    }
    const expected = Array.from({ length: 8 }, (_, i) => round([1000 + i, 2000 + 2 * i, 3000 + 0.5 * i]));
    expect(got.sort()).toEqual(expected.sort());

    // returnByte (0x11) decodes to return number 1 / number of returns 1 for PDRF 7.
    expect(Array.from(payload.returnNumbers)).toEqual(Array(8).fill(1));
    expect(Array.from(payload.numberOfReturns)).toEqual(Array(8).fill(1));
  });

  it('throws a friendly error when no index is registered for the asset', async () => {
    const { svc, assetId } = await importedProject({ runIndexBuild: inlineIndexBuild });
    await expect(svc.loadPointCloudIndexHierarchy({ assetId })).rejects.toThrow(/No point-cloud index/i);
  });

  it('cancels an in-flight build via cancelPointCloudIndex', async () => {
    let abortObserved = false;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { svc, projectFolder, assetId } = await importedProject({
      runIndexBuild: (_params, hooks) =>
        new Promise<BuildPointCloudIndexResult>((_resolve, reject) => {
          hooks.signal?.addEventListener('abort', () => {
            abortObserved = true;
            reject(new PointCloudIndexCancelled());
          });
          started();
        }),
    });

    const pending = svc.generatePointCloudIndex({ assetId });
    await startedPromise; // controller is now registered and the runner is waiting
    svc.cancelPointCloudIndex({ assetId });
    await expect(pending).rejects.toBeInstanceOf(PointCloudIndexCancelled);
    expect(abortObserved).toBe(true);

    const after = (await svc.openProject({ projectFolder })).manifest;
    expect(after.assets.some((a) => a.kind === 'point-cloud-index')).toBe(false);
  });

  it('builds analytic surfels from the preview fallback when no index exists', async () => {
    const { svc, projectFolder, assetId } = await importedProject({ runIndexBuild: inlineIndexBuild });
    const generated = await svc.generateAnalyticSurfels({ assetId });

    const surfelAsset = generated.session.manifest.assets.find((a) => a.id === generated.surfelAssetId)!;
    expect(surfelAsset.kind).toBe('analytic-surfel-render');
    expect(surfelAsset.truthStatus).toBe('derived');
    expect(surfelAsset.analyticSurfel?.sourceAssetId).toBe(assetId);
    expect(surfelAsset.analyticSurfel?.indexAssetId).toBeNull();
    expect(generated.metrics.surfelCount).toBeGreaterThan(0);
    expect(existsSync(path.join(projectFolder, 'derived', assetId, 'surfels', 'index.json'))).toBe(true);

    const hierarchy = await svc.loadAnalyticSurfelHierarchy({ assetId: generated.surfelAssetId });
    expect(hierarchy.sourceAssetId).toBe(assetId);
    expect(hierarchy.totalSurfels).toBeGreaterThan(0);

    const { tiles } = await svc.loadAnalyticSurfelTiles({ assetId: generated.surfelAssetId, keys: [hierarchy.root] });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.payload.surfelCount).toBeGreaterThan(0);
    expect(tiles[0]!.payload.radii.length).toBe(tiles[0]!.payload.surfelCount);
  });

  it('exposes surfel cell scale as a generation control', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-scale-'));
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'las-scale-'));
    const sourceFile = await writeClusteredLasFile(fixtureDir, 'scale-fixture.las', 24);
    const svc = new ProjectService({ runIndexBuild: inlineIndexBuild });
    await svc.createProject({ parentDir: parent, projectName: 'SCALE' });
    const imported = await svc.importPointCloud({ filePath: sourceFile, importPolicy: 'reference' });
    const assetId = imported.manifest.assets.find((asset) => asset.kind === 'point-cloud')!.id;
    const generated = await svc.generateAnalyticSurfels({ assetId, surfelCellScale: 0.5 });
    const surfelAsset = generated.session.manifest.assets.find((asset) => asset.id === generated.surfelAssetId)!;
    expect(surfelAsset.analyticSurfel?.surfelCellScale).toBe(0.5);
  });

  it('builds analytic surfels from an index and survives reopen', async () => {
    const { svc, projectFolder, assetId } = await importedProject({ runIndexBuild: inlineIndexBuild });
    const index = await svc.generatePointCloudIndex({ assetId });
    const surfels = await svc.generateAnalyticSurfels({ assetId });

    const surfelAsset = surfels.session.manifest.assets.find((a) => a.id === surfels.surfelAssetId)!;
    expect(surfelAsset.analyticSurfel?.indexAssetId).toBe(index.indexAssetId);

    await svc.closeProject();
    const reopened = await svc.openProject({ projectFolder });
    const reopenedAsset = reopened.manifest.assets.find((a) => a.id === surfels.surfelAssetId);
    expect(reopenedAsset?.truthStatus).toBe('derived');
    expect(reopenedAsset?.warnings ?? []).toEqual([]);
  });

  it('treats a v1 index as streamable but warns that the format is outdated', async () => {
    const { svc, projectFolder, assetId } = await importedProject({ runIndexBuild: inlineIndexBuild });
    const generated = await svc.generatePointCloudIndex({ assetId });
    const manifest = structuredClone(generated.session.manifest);
    const indexAsset = manifest.assets.find((a) => a.id === generated.indexAssetId)!;
    if (!indexAsset.pointCloudIndex) throw new Error('missing pointCloudIndex metadata');
    indexAsset.pointCloudIndex.indexVersion = 1;
    delete indexAsset.pointCloudIndex.ownership;
    await svc.saveProject(manifest);
    await svc.closeProject();

    const reopened = await svc.openProject({ projectFolder });
    const reopenedIndex = reopened.manifest.assets.find((a) => a.id === generated.indexAssetId)!;
    expect(reopenedIndex.warnings.some((warning) => /format is outdated/i.test(warning))).toBe(true);
    expect(reopenedIndex.warnings.some((warning) => /out of date/i.test(warning))).toBe(false);
  });

  it('keeps 8-bit RGB stored in u16 bright in both preview and indexed paths', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-rgb-'));
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'las-rgb-'));
    const sourceFile = await writeSynthetic8BitRgbLasFile(fixtureDir);
    const svc = new ProjectService({ runIndexBuild: inlineIndexBuild });
    await svc.createProject({ parentDir: parent, projectName: 'RGB' });
    const imported = await svc.importPointCloud({ filePath: sourceFile, importPolicy: 'reference' });
    const asset = imported.manifest.assets.find((a) => a.kind === 'point-cloud')!;
    expect(asset.pointCloud?.rgbEncoding).toBe('u8-in-u16');

    const preview = await svc.loadPointCloudPreview({ assetId: asset.id });
    expect(preview.dataset.octree?.root.colors[0]).toBe(12);
    expect(preview.dataset.octree?.root.colors[1]).toBe(34);
    expect(preview.dataset.octree?.root.colors[2]).toBe(56);

    await svc.generatePointCloudIndex({ assetId: asset.id });
    const hierarchy = await svc.loadPointCloudIndexHierarchy({ assetId: asset.id });
    const { tiles } = await svc.loadPointCloudIndexTiles({ assetId: asset.id, keys: [hierarchy.root] });
    expect(tiles[0]!.payload.colors[0]).toBe(12);
    expect(tiles[0]!.payload.colors[1]).toBe(34);
    expect(tiles[0]!.payload.colors[2]).toBe(56);
  });

  it('marks a missing analytic surfel artifact as error on reopen without crashing', async () => {
    const { svc, projectFolder, assetId } = await importedProject({ runIndexBuild: inlineIndexBuild });
    const surfels = await svc.generateAnalyticSurfels({ assetId });

    await rm(path.join(projectFolder, 'derived', assetId, 'surfels'), { recursive: true, force: true });
    await svc.closeProject();

    const reopened = await svc.openProject({ projectFolder });
    const surfelAsset = reopened.manifest.assets.find((a) => a.id === surfels.surfelAssetId);
    const surfelLayer = reopened.manifest.simulationLayers.find((layer) => layer.assetId === surfels.surfelAssetId);
    expect(surfelAsset?.warnings.some((warning) => warning.includes('Regenerate'))).toBe(true);
    expect(surfelLayer?.status).toBe('error');
  });
});
