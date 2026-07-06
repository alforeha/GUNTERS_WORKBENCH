import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  PointCloudIndexCancelled,
  WPI_INDEX_COMPLETE_MARKER,
  WPI_INDEX_MANIFEST_FILE,
  buildPointCloudIndex,
  decodeWpiTileFile,
  isWpiIndexComplete,
  readWpiIndexManifest,
} from '../electron/pointcloud-index-builder';
import type { ChunkSource } from '../src/workers/las.worker';

interface SourcePoint {
  x: number;
  y: number;
  z: number;
  intensity: number;
  classification: number;
  returnByte: number;
  r: number;
  g: number;
  b: number;
}

const SCALE = 0.01;
const RECORD_LENGTH = 36; // LAS 1.4 PDRF 7 minimum

function makeSourcePoints(count: number): SourcePoint[] {
  const points: SourcePoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push({
      x: (i * 7919) % 100000,
      y: (i * 104729) % 100000,
      z: (i * 1299709) % 20000,
      intensity: (i * 37) & 0xffff,
      classification: i % 32,
      returnByte: i % 8,
      r: (i * 5) & 0xffff,
      g: (i * 7) & 0xffff,
      b: (i * 11) & 0xffff,
    });
  }
  return points;
}

/** Build a minimal but valid LAS 1.4 / PDRF 7 buffer from raw source points. */
function buildLas(points: SourcePoint[]): Buffer {
  const header = Buffer.alloc(375);
  const hv = new DataView(header.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) hv.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, 'LASF');
  hv.setUint8(24, 1);
  hv.setUint8(25, 4);
  hv.setUint16(94, 375, true);
  hv.setUint32(96, 375, true);
  hv.setUint32(100, 0, true);
  hv.setUint8(104, 7);
  hv.setUint16(105, RECORD_LENGTH, true);
  hv.setBigUint64(247, BigInt(points.length), true);
  hv.setFloat64(131, SCALE, true);
  hv.setFloat64(139, SCALE, true);
  hv.setFloat64(147, SCALE, true);
  hv.setFloat64(155, 0, true);
  hv.setFloat64(163, 0, true);
  hv.setFloat64(171, 0, true);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const zs = points.map((p) => p.z);
  hv.setFloat64(179, Math.max(...xs) * SCALE, true); // maxX
  hv.setFloat64(187, Math.min(...xs) * SCALE, true); // minX
  hv.setFloat64(195, Math.max(...ys) * SCALE, true);
  hv.setFloat64(203, Math.min(...ys) * SCALE, true);
  hv.setFloat64(211, Math.max(...zs) * SCALE, true);
  hv.setFloat64(219, Math.min(...zs) * SCALE, true);

  const body = Buffer.alloc(points.length * RECORD_LENGTH);
  const bv = new DataView(body.buffer);
  points.forEach((p, i) => {
    const o = i * RECORD_LENGTH;
    bv.setInt32(o, p.x, true);
    bv.setInt32(o + 4, p.y, true);
    bv.setInt32(o + 8, p.z, true);
    bv.setUint16(o + 12, p.intensity, true);
    bv.setUint8(o + 14, p.returnByte);
    bv.setUint8(o + 16, p.classification);
    bv.setUint16(o + 30, p.r, true);
    bv.setUint16(o + 32, p.g, true);
    bv.setUint16(o + 34, p.b, true);
  });
  return Buffer.concat([header, body]);
}

function chunkSource(buf: Buffer): ChunkSource {
  const ab = new Uint8Array(buf).buffer; // standalone ArrayBuffer, offset 0
  return {
    size: ab.byteLength,
    read: (start: number, end: number) => Promise.resolve(ab.slice(start, end)),
  };
}

function canonical(p: { x: number; y: number; z: number; intensity: number; classification: number; returnByte: number; r: number; g: number; b: number }): string {
  return [p.x, p.y, p.z, p.intensity, p.classification, p.returnByte, p.r, p.g, p.b].join(',');
}

async function collectDecodedPoints(outDir: string): Promise<string[]> {
  const manifest = await readWpiIndexManifest(outDir);
  const out: string[] = [];
  for (const node of manifest.nodes) {
    const tile = await decodeWpiTileFile(outDir, node.tile);
    for (let i = 0; i < tile.pointCount; i++) {
      out.push(
        canonical({
          x: tile.x[i]!,
          y: tile.y[i]!,
          z: tile.z[i]!,
          intensity: tile.intensity[i]!,
          classification: tile.classification[i]!,
          returnByte: tile.returnByte[i]!,
          r: tile.r ? tile.r[i]! : 0,
          g: tile.g ? tile.g[i]! : 0,
          b: tile.b ? tile.b[i]! : 0,
        }),
      );
    }
  }
  return out;
}

async function tempOutDir(): Promise<string> {
  const base = await mkdtemp(path.join(tmpdir(), 'wpi-'));
  return path.join(base, 'index');
}

const FINGERPRINT = (buf: Buffer) => ({
  headerSha256: createHash('sha256').update(buf.subarray(0, 375)).digest('hex'),
  fileSize: buf.byteLength,
  mtimeMs: 1_700_000_000_000,
});

describe('buildPointCloudIndex', () => {
  it('reconstructs the source points bit-exactly from the union of tiles (single tile)', async () => {
    const points = makeSourcePoints(500);
    const las = buildLas(points);
    const outDir = await tempOutDir();
    const result = await buildPointCloudIndex({
      source: chunkSource(las),
      outDir,
      fileName: 'fixture.las',
      sourceFingerprint: FINGERPRINT(las),
      generatorVersion: '1.0.0',
      nodeCapacity: 1_000_000, // no split → single root tile
    });

    expect(result.metrics.storedPointCount).toBe(points.length);
    expect(result.manifest.tileCount).toBe(1);
    expect(result.manifest.hasRgb).toBe(true);

    const decoded = (await collectDecodedPoints(outDir)).sort();
    const source = points.map(canonical).sort();
    expect(decoded).toEqual(source);
  });

  it('reconstructs the source points bit-exactly across a multi-level tile hierarchy', async () => {
    const points = makeSourcePoints(600);
    const las = buildLas(points);
    const outDir = await tempOutDir();
    const result = await buildPointCloudIndex({
      source: chunkSource(las),
      outDir,
      fileName: 'fixture.las',
      sourceFingerprint: FINGERPRINT(las),
      generatorVersion: '1.0.0',
      nodeCapacity: 32, // force many splits → many tiles at multiple levels
      maxDepth: 12,
    });

    expect(result.manifest.tileCount).toBeGreaterThan(1);
    expect(result.metrics.maxDepthUsed).toBeGreaterThan(0);
    expect(result.metrics.storedPointCount).toBe(points.length);

    const decoded = (await collectDecodedPoints(outDir)).sort();
    const source = points.map(canonical).sort();
    expect(decoded.length).toBe(points.length);
    expect(decoded).toEqual(source);

    // every non-root node key must be reachable from the root via childKeys
    const byKey = new Map(result.manifest.nodes.map((n) => [n.key, n]));
    const reachable = new Set<string>();
    const stack = [result.manifest.root];
    while (stack.length) {
      const key = stack.pop()!;
      if (reachable.has(key)) continue;
      reachable.add(key);
      for (const child of byKey.get(key)?.childKeys ?? []) stack.push(child);
    }
    for (const node of result.manifest.nodes) expect(reachable.has(node.key)).toBe(true);
  });

  it('writes the completion marker last and validates it', async () => {
    const las = buildLas(makeSourcePoints(64));
    const outDir = await tempOutDir();
    await buildPointCloudIndex({
      source: chunkSource(las),
      outDir,
      fileName: 'fixture.las',
      sourceFingerprint: FINGERPRINT(las),
      generatorVersion: '1.0.0',
    });
    expect(await isWpiIndexComplete(outDir)).toBe(true);

    // removing the marker => treated as incomplete/corrupt
    await rm(path.join(outDir, WPI_INDEX_COMPLETE_MARKER));
    expect(await isWpiIndexComplete(outDir)).toBe(false);
    await expect(readWpiIndexManifest(outDir)).rejects.toThrow(/incomplete or corrupt/i);
  });

  it('treats a present marker with a missing manifest as incomplete', async () => {
    const las = buildLas(makeSourcePoints(40));
    const outDir = await tempOutDir();
    await buildPointCloudIndex({
      source: chunkSource(las),
      outDir,
      fileName: 'fixture.las',
      sourceFingerprint: FINGERPRINT(las),
      generatorVersion: '1.0.0',
    });
    await rm(path.join(outDir, WPI_INDEX_MANIFEST_FILE));
    expect(await isWpiIndexComplete(outDir)).toBe(false);
  });

  it('honors cancellation and never writes a completion marker', async () => {
    const las = buildLas(makeSourcePoints(300));
    const outDir = await tempOutDir();
    let ticks = 0;
    await expect(
      buildPointCloudIndex({
        source: chunkSource(las),
        outDir,
        fileName: 'fixture.las',
        sourceFingerprint: FINGERPRINT(las),
        generatorVersion: '1.0.0',
        shouldCancel: () => ticks++ > 0, // cancel after the first chunk boundary check
      }),
    ).rejects.toBeInstanceOf(PointCloudIndexCancelled);
    expect(await isWpiIndexComplete(outDir)).toBe(false);
  });

  it('rebuilds cleanly over a previous index directory', async () => {
    const outDir = await tempOutDir();
    // stray file from a prior run must not survive a rebuild
    await buildPointCloudIndex({
      source: chunkSource(buildLas(makeSourcePoints(80))),
      outDir,
      fileName: 'fixture.las',
      sourceFingerprint: FINGERPRINT(buildLas(makeSourcePoints(80))),
      generatorVersion: '1.0.0',
      nodeCapacity: 16,
    });
    await writeFile(path.join(outDir, 'tiles', 'stale-0-0-0-0.bin.gz'), 'garbage');

    const points = makeSourcePoints(50);
    const las = buildLas(points);
    await buildPointCloudIndex({
      source: chunkSource(las),
      outDir,
      fileName: 'fixture.las',
      sourceFingerprint: FINGERPRINT(las),
      generatorVersion: '1.0.0',
    });
    const stale = await readFile(path.join(outDir, 'tiles', 'stale-0-0-0-0.bin.gz')).catch(() => null);
    expect(stale).toBeNull();
    const decoded = (await collectDecodedPoints(outDir)).sort();
    expect(decoded).toEqual(points.map(canonical).sort());
  });

  it('produces identical ownership across two identical builds (per-cell determinism)', async () => {
    const points = makeSourcePoints(200);
    const las = buildLas(points);

    const out1 = await tempOutDir();
    const r1 = await buildPointCloudIndex({
      source: chunkSource(las), outDir: out1, fileName: 'f.las',
      sourceFingerprint: FINGERPRINT(las), generatorVersion: '1.0.0', nodeCapacity: 16,
    });

    const out2 = await tempOutDir();
    const r2 = await buildPointCloudIndex({
      source: chunkSource(las), outDir: out2, fileName: 'f.las',
      sourceFingerprint: FINGERPRINT(las), generatorVersion: '1.0.0', nodeCapacity: 16,
    });

    expect(r1.metrics.storedPointCount).toBe(r2.metrics.storedPointCount);
    expect(r1.metrics.tileCount).toBe(r2.metrics.tileCount);
    const keys1 = new Set(r1.manifest.nodes.map((n) => n.key));
    const keys2 = new Set(r2.manifest.nodes.map((n) => n.key));
    expect([...keys1].sort()).toEqual([...keys2].sort());

    // each tile must have exactly the same points
    for (const n1 of r1.manifest.nodes) {
      const n2 = r2.manifest.nodes.find((n) => n.key === n1.key)!;
      expect(n2).toBeTruthy();
      expect(n2.pointCount).toBe(n1.pointCount);
      const pts1 = (await collectDecodedPoints(out1)).sort();
      const pts2 = (await collectDecodedPoints(out2)).sort();
      expect(pts1).toEqual(pts2);
    }
  });

  it('root tile XY extent spans the full source extent (voxel-decimated overview)', async () => {
    const points = makeSourcePoints(1000);
    const las = buildLas(points);
    const outDir = await tempOutDir();
    const result = await buildPointCloudIndex({
      source: chunkSource(las),
      outDir,
      fileName: 'fixture.las',
      sourceFingerprint: FINGERPRINT(las),
      generatorVersion: '1.0.0',
      nodeCapacity: 32, // enough splits to test that root still covers the full extent
    });

    const rootNode = result.manifest.nodes.find((n) => n.key === result.manifest.root)!;
    expect(rootNode).toBeTruthy();

    const srcBounds = result.manifest.bounds;
    const rootBounds = rootNode.bounds;

    // Root XY should cover ≥90% of the source XY extent
    const extentX = srcBounds.maxX - srcBounds.minX;
    const extentY = srcBounds.maxY - srcBounds.minY;
    const rootExtentX = rootBounds.maxX - rootBounds.minX;
    const rootExtentY = rootBounds.maxY - rootBounds.minY;
    expect(rootExtentX / Math.max(extentX, 0.01)).toBeGreaterThanOrEqual(0.9);
    expect(rootExtentY / Math.max(extentY, 0.01)).toBeGreaterThanOrEqual(0.9);
  });

  it('wrote wpiIndexVersion 1.1 in the manifest', async () => {
    const las = buildLas(makeSourcePoints(64));
    const outDir = await tempOutDir();
    await buildPointCloudIndex({
      source: chunkSource(las),
      outDir,
      fileName: 'fixture.las',
      sourceFingerprint: FINGERPRINT(las),
      generatorVersion: '1.0.0',
    });
    const manifest = await readWpiIndexManifest(outDir);
    expect(manifest.wpiIndexVersion).toBe(1.1);
    expect(manifest.voxelGridDim).toBeGreaterThan(0);
  });

  it('reports peakVoxelBytes in metrics', async () => {
    const las = buildLas(makeSourcePoints(500));
    const outDir = await tempOutDir();
    const result = await buildPointCloudIndex({
      source: chunkSource(las),
      outDir,
      fileName: 'fixture.las',
      sourceFingerprint: FINGERPRINT(las),
      generatorVersion: '1.0.0',
      nodeCapacity: 8,
    });
    expect(result.metrics.peakVoxelBytes).toBeGreaterThan(0);
  });

  it('handles a dense coincident cluster without allocation failure (streaming compression)', async () => {
    // Simulate 50 000 coincident points (all at the same xyz) — the pathological case
    // that triggers deep single-child chains and large per-node spool buffers.
    const coincident = Array.from({ length: 50_000 }, (_, i) => ({
      x: 50000,
      y: 50000,
      z: 10000,
      intensity: i & 0xffff,
      classification: i % 32,
      returnByte: 0x11,
      r: (i * 5) & 0xffff,
      g: (i * 7) & 0xffff,
      b: (i * 11) & 0xffff,
    }));
    const las = buildLas(coincident);
    const outDir = await tempOutDir();
    const result = await buildPointCloudIndex({
      source: chunkSource(las),
      outDir,
      fileName: 'coincident.las',
      sourceFingerprint: FINGERPRINT(las),
      generatorVersion: '1.0.0',
      nodeCapacity: 32,
      maxDepth: 16,
    });

    expect(result.metrics.storedPointCount).toBe(coincident.length);
    // streaming compression must never hold the whole coincident leaf in a single buffer
    expect(result.metrics.largestBufferBytes).toBeLessThan(100_000_000); // < 100 MB
    // chain depth is bounded by maxDepth, not by point count
    expect(result.metrics.maxChainDepth).toBeLessThanOrEqual(16);

    const decoded = (await collectDecodedPoints(outDir)).sort();
    const source = coincident.map(canonical).sort();
    expect(decoded).toEqual(source);
  });
});
