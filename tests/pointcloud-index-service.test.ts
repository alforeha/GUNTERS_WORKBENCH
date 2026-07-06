import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
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

async function writeSyntheticLasFile(folder: string, fileName = 'fixture.las', pointCount = 8): Promise<string> {
  const filePath = path.join(folder, fileName);
  const payload = Buffer.concat([Buffer.from(syntheticLasHeader(pointCount)), Buffer.from(syntheticPointSample(pointCount))]);
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
});
