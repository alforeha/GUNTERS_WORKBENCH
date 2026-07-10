import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectService } from '../electron/project-service';
import { projectManifestSchema } from '../src/shared/manifest-schema';
import {
  POINT_CLOUD_INDEX_ASSET_KIND,
  detectIndexStaleness,
  formatOutdatedIndexWarning,
  formatStaleIndexWarning,
  hasValidIndexForStreaming,
  isStaleIndexWarning,
  type PointCloudIndexSourceFingerprint,
} from '../src/shared/pointcloud-index';
import type { AssetRecord, ProjectManifest } from '../src/shared/workbench-types';

// ── synthetic LAS fixture (mirrors projectLifecycle.test.ts) ──────────────────
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

async function writeSyntheticLasFile(folder: string, fileName: string, pointCount = 2): Promise<string> {
  const filePath = path.join(folder, fileName);
  const payload = Buffer.concat([Buffer.from(syntheticLasHeader(pointCount)), Buffer.from(syntheticPointSample(pointCount))]);
  await writeFile(filePath, payload);
  return filePath;
}

function indexAssetFor(sourceAsset: AssetRecord, fingerprint: PointCloudIndexSourceFingerprint): AssetRecord {
  const pc = sourceAsset.pointCloud!;
  const now = new Date().toISOString();
  return {
    id: `${sourceAsset.id}-index`,
    name: `${sourceAsset.name} index`,
    kind: POINT_CLOUD_INDEX_ASSET_KIND,
    truthStatus: 'indexed-full',
    importPolicy: 'copy',
    sourcePath: null,
    managedPath: `derived/${sourceAsset.id}-index/index/index.json`,
    units: pc.unitsLinear,
    warnings: [],
    hashes: { importedAt: now, modifiedAt: now },
    pointCloudIndex: {
      sourceAssetId: sourceAsset.id,
      indexType: 'wpi-octree',
      indexVersion: 2,
      ownership: 'strided',
      source: { ...fingerprint, rgbEncoding: sourceAsset.pointCloud?.rgbEncoding },
      pointCount: pc.pointCount,
      bounds: pc.bounds,
      scale: pc.scale,
      offset: pc.offset,
      units: pc.unitsLinear,
      generatedAt: now,
      generator: { name: 'workbench', version: '0.0.0' },
    },
  };
}

async function importedProjectWithIndex(): Promise<{
  svc: ProjectService;
  projectFolder: string;
  sourceFile: string;
  sourceAsset: AssetRecord;
  indexId: string;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), 'wb-idx-'));
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'las-idx-'));
  const sourceFile = await writeSyntheticLasFile(fixtureDir, 'index-fixture.las', 2);
  const svc = new ProjectService();
  await svc.createProject({ parentDir: parent, projectName: 'IDX' });
  const imported = await svc.importPointCloud({ filePath: sourceFile, importPolicy: 'reference' });
  const sourceAsset = imported.manifest.assets.find((a) => a.kind === 'point-cloud')!;
  const stats = await stat(sourceFile);

  const manifest = structuredClone(imported.manifest) as ProjectManifest;
  const indexAsset = indexAssetFor(sourceAsset, {
    headerSha256: sourceAsset.pointCloud!.headerSha256,
    fileSize: sourceAsset.pointCloud!.fileSize,
    mtimeMs: stats.mtimeMs,
  });
  manifest.assets.push(indexAsset);
  const saved = await svc.saveProject(manifest);
  return { svc, projectFolder: saved.projectFolder, sourceFile, sourceAsset, indexId: indexAsset.id };
}

function indexWarnings(manifest: ProjectManifest, indexId: string): string[] {
  return manifest.assets.find((a) => a.id === indexId)?.warnings ?? [];
}

// ── pure staleness detection ──────────────────────────────────────────────────
describe('detectIndexStaleness', () => {
  const stored: PointCloudIndexSourceFingerprint = { headerSha256: 'abc', fileSize: 1000, mtimeMs: 5000 };

  it('reports fresh when the source fingerprint is unchanged', () => {
    const result = detectIndexStaleness(stored, { exists: true, headerSha256: 'abc', fileSize: 1000, mtimeMs: 5000 });
    expect(result).toEqual({ stale: false, sourceMissing: false, reasons: [] });
    expect(formatStaleIndexWarning(result)).toBeNull();
  });

  it('flags a header-sha divergence', () => {
    const result = detectIndexStaleness(stored, { exists: true, headerSha256: 'zzz', fileSize: 1000, mtimeMs: 5000 });
    expect(result.stale).toBe(true);
    expect(result.reasons).toContain('header-sha-changed');
    expect(formatStaleIndexWarning(result)).toMatch(/out of date/i);
  });

  it('flags a file-size divergence', () => {
    const result = detectIndexStaleness(stored, { exists: true, headerSha256: 'abc', fileSize: 2000, mtimeMs: 5000 });
    expect(result.stale).toBe(true);
    expect(result.reasons).toContain('file-size-changed');
  });

  it('flags an mtime divergence', () => {
    const result = detectIndexStaleness(stored, { exists: true, headerSha256: 'abc', fileSize: 1000, mtimeMs: 9999 });
    expect(result.stale).toBe(true);
    expect(result.reasons).toContain('mtime-changed');
  });

  it('ignores mtime when the stored mtime is null (reference imports)', () => {
    const nullMtime: PointCloudIndexSourceFingerprint = { headerSha256: 'abc', fileSize: 1000, mtimeMs: null };
    const result = detectIndexStaleness(nullMtime, { exists: true, headerSha256: 'abc', fileSize: 1000, mtimeMs: 9999 });
    expect(result.stale).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('treats a missing source as unverifiable rather than stale', () => {
    const result = detectIndexStaleness(stored, { exists: false });
    expect(result.stale).toBe(false);
    expect(result.sourceMissing).toBe(true);
    expect(formatStaleIndexWarning(result)).toMatch(/missing/i);
  });

  it('formats a non-gating outdated warning for older index versions', () => {
    expect(formatOutdatedIndexWarning(1)).toMatch(/format is outdated/i);
    expect(formatOutdatedIndexWarning(2)).toBeNull();
  });
});

// ── manifest schema round-trip + validation ────────────────────────────────────
describe('point-cloud index manifest record', () => {
  function baseManifest(): ProjectManifest {
    const now = new Date().toISOString();
    const sourceAsset: AssetRecord = {
      id: 'pc-1',
      name: 'cloud.las',
      kind: 'point-cloud',
      truthStatus: 'source',
      importPolicy: 'reference',
      sourcePath: '/abs/cloud.las',
      managedPath: null,
      units: 'usSurveyFoot',
      warnings: [],
      hashes: { importedAt: now, modifiedAt: now },
      pointCloud: {
        format: 'las',
        extension: '.las',
        fileSize: 1234,
        pointCount: 100,
        lasVersion: '1.4',
        pointFormat: 7,
        pointRecordLength: 36,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 },
        scale: [0.01, 0.01, 0.01],
        offset: [1000, 2000, 3000],
        crsText: null,
        unitsLinear: 'usSurveyFoot',
        unitsRaw: 'ftUS',
        headerSha256: 'deadbeef',
      },
    };
    return {
      schemaVersion: '1.2.0',
      info: {},
      crs: {},
      settings: {},
      standards: {},
      assets: [sourceAsset, indexAssetFor(sourceAsset, { headerSha256: 'deadbeef', fileSize: 1234, mtimeMs: 42 })],
      groups: [],
      realitySimulation: {
        id: 'sim-primary',
        name: 'Primary',
        status: 'empty',
        mode: 'single-primary',
        phaseContext: 'scaffold',
        settings: {},
        warnings: [],
        createdAt: now,
        modifiedAt: now,
      },
      simulationLayers: [],
      features: [],
      exclusionZones: [],
      reviewFlags: [],
      comparisonRefs: [],
      analysisResults: [],
      lineouts: [],
      reports: [],
      exports: [],
      recovery: { uncleanShutdown: false, lastIntentId: null, lastIntentAt: null, lastRecoveredAt: null },
    };
  }

  it('round-trips an index asset through JSON + schema without loss', () => {
    const manifest = baseManifest();
    const parsed = projectManifestSchema.safeParse(JSON.parse(JSON.stringify(manifest)));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const index = parsed.data.assets.find((a) => a.kind === POINT_CLOUD_INDEX_ASSET_KIND)!;
    expect(index.truthStatus).toBe('indexed-full');
    expect(index.truthStatus).not.toBe('source');
    expect(index.pointCloudIndex).toEqual(manifest.assets[1]!.pointCloudIndex);
  });

  it('rejects an index asset whose sourceAssetId dangles', () => {
    const manifest = baseManifest();
    manifest.assets[1]!.pointCloudIndex!.sourceAssetId = 'does-not-exist';
    const parsed = projectManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(false);
  });

  it('rejects an index type that is not wpi-octree', () => {
    const manifest = baseManifest();
    (manifest.assets[1]!.pointCloudIndex as { indexType: string }).indexType = 'copc';
    const parsed = projectManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(false);
  });

  it('rejects pointCloudIndex metadata on a non-index asset', () => {
    const manifest = baseManifest();
    // metadata present but kind/truthStatus say it is not an index asset
    manifest.assets[1]!.kind = 'point-cloud';
    manifest.assets[1]!.truthStatus = 'source';
    const parsed = projectManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(false);
  });

  it('rejects an index-kind/indexed-full asset that lacks pointCloudIndex metadata', () => {
    const manifest = baseManifest();
    delete manifest.assets[1]!.pointCloudIndex;
    const parsed = projectManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(false);
  });
});

// ── open-time staleness against the real project service ────────────────────────
describe('index staleness on reopen', () => {
  it('records no stale warning while the source is unchanged', async () => {
    const { svc, projectFolder, indexId } = await importedProjectWithIndex();
    await svc.closeProject();
    const reopened = await svc.openProject({ projectFolder });
    expect(indexWarnings(reopened.manifest, indexId)).toEqual([]);
  });

  it('keeps the index valid after the disposable cache is deleted', async () => {
    const { svc, projectFolder, sourceAsset, indexId } = await importedProjectWithIndex();
    // populate then delete the preview cache for the source asset
    await svc.loadPointCloudPreview({ assetId: sourceAsset.id });
    await rm(path.join(projectFolder, 'cache', sourceAsset.id), { recursive: true, force: true });
    await svc.closeProject();
    const reopened = await svc.openProject({ projectFolder });
    expect(indexWarnings(reopened.manifest, indexId)).toEqual([]);
  });

  it('surfaces a stale warning after the source file changes', async () => {
    const { svc, projectFolder, sourceFile, indexId } = await importedProjectWithIndex();
    await svc.closeProject();
    await writeSyntheticLasFile(path.dirname(sourceFile), path.basename(sourceFile), 5);
    const reopened = await svc.openProject({ projectFolder });
    const warnings = indexWarnings(reopened.manifest, indexId);
    expect(warnings.some((w) => /out of date/i.test(w))).toBe(true);
  });

  it('does not accumulate duplicate stale warnings across reopens', async () => {
    const { svc, projectFolder, sourceFile, indexId } = await importedProjectWithIndex();
    await svc.closeProject();
    await writeSyntheticLasFile(path.dirname(sourceFile), path.basename(sourceFile), 5);
    await (async () => {
      const first = await svc.openProject({ projectFolder });
      await svc.saveProject(first.manifest);
      await svc.closeProject();
    })();
    const reopened = await svc.openProject({ projectFolder });
    const staleWarnings = indexWarnings(reopened.manifest, indexId).filter((w) => /out of date/i.test(w));
    expect(staleWarnings.length).toBe(1);
  });

  it('marks a missing source as unverifiable, not stale', async () => {
    const { svc, projectFolder, sourceFile, indexId } = await importedProjectWithIndex();
    await svc.closeProject();
    await rm(sourceFile);
    const reopened = await svc.openProject({ projectFolder });
    const warnings = indexWarnings(reopened.manifest, indexId);
    expect(warnings.some((w) => /missing/i.test(w))).toBe(true);
    expect(warnings.some((w) => /out of date/i.test(w))).toBe(false);
  });
});

// ── Phase 4: densification→streaming gate helper ───────────────────────────
describe('hasValidIndexForStreaming', () => {
  it('returns true for a clean index asset (correct kind, no managed warnings)', () => {
    expect(hasValidIndexForStreaming({ kind: POINT_CLOUD_INDEX_ASSET_KIND, warnings: [] })).toBe(true);
  });

  it('returns false when the asset is undefined (no index exists)', () => {
    expect(hasValidIndexForStreaming(undefined)).toBe(false);
  });

  it('returns false when the kind is not point-cloud-index', () => {
    expect(hasValidIndexForStreaming({ kind: 'point-cloud', warnings: [] })).toBe(false);
    expect(hasValidIndexForStreaming({ kind: 'surface', warnings: [] })).toBe(false);
  });

  it('returns false when the index carries a managed staleness warning (stale → absent for gate)', () => {
    expect(
      hasValidIndexForStreaming({
        kind: POINT_CLOUD_INDEX_ASSET_KIND,
        warnings: ['Point-cloud index may be out of date (source file size changed). Regenerate the index to match the current source.'],
      }),
    ).toBe(false);
  });

  it('returns true when the source is missing (index is self-contained, still streamable)', () => {
    expect(
      hasValidIndexForStreaming({
        kind: POINT_CLOUD_INDEX_ASSET_KIND,
        warnings: ['Point-cloud index source is missing; the existing index is still usable but cannot be re-verified or regenerated until the source is available.'],
      }),
    ).toBe(true);
  });

  it('still returns true with non-index warnings present (unit warnings do not invalidate the index)', () => {
    expect(
      hasValidIndexForStreaming({
        kind: POINT_CLOUD_INDEX_ASSET_KIND,
        warnings: ['Point-cloud units could not be confirmed from LAS VLRs.'],
      }),
    ).toBe(true);
  });

  it('still returns true with a format-outdated warning (v1 stays streamable)', () => {
    expect(
      hasValidIndexForStreaming({
        kind: POINT_CLOUD_INDEX_ASSET_KIND,
        warnings: ['Point-cloud index format is outdated (v1); regenerate for improved coarse-level display.'],
      }),
    ).toBe(true);
  });
});

describe('isStaleIndexWarning', () => {
  it('returns true for an "out of date" warning', () => {
    expect(isStaleIndexWarning('Point-cloud index may be out of date (source file size changed). Regenerate the index to match the current source.')).toBe(true);
  });

  it('returns false for a missing-source warning', () => {
    expect(isStaleIndexWarning('Point-cloud index source is missing; the existing index is still usable but cannot be re-verified or regenerated until the source is available.')).toBe(false);
  });

  it('returns false for a non-index warning', () => {
    expect(isStaleIndexWarning('Some other warning about units.')).toBe(false);
  });
});
