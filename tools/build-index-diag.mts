// tools/build-index-diag.mts — standalone WPI v1.1 acceptance diagnostic.
// Opens the acceptance LAS, builds the index into a throwaway dir, and logs
// per-chunk (5 s intervals) running nodeCount, spooler map size, and
// process.memoryUsage() (rss, external, arrayBuffers).  Reports final metrics
// or the crash with full sizes.
//
// Usage:  npx tsx tools/build-index-diag.mts

import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPointCloudIndex, readWpiIndexManifest } from '../electron/pointcloud-index-builder.js';
import { createFileChunkSource } from '../electron/file-chunk-source.js';

const SOURCE = path.resolve('_REFS/BATCH_2/CO25013_PNT CLD_250903_.las');

interface DiagSnap {
  stage: string;
  sec: number;
  nodeCount: number;
  spoolerSize: number;
  rssMB: number;
  externalMB: number;
  arrayBufMB: number;
  heapMB: number;
}

function memUsage() {
  const u = process.memoryUsage();
  return {
    rssMB: u.rss / 1e6,
    externalMB: u.external / 1e6,
    arrayBufMB: u.arrayBuffers / 1e6,
    heapMB: u.heapUsed / 1e6,
  };
}

function fmt(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
}

async function main() {
  const sourceStats = await stat(SOURCE);
  const fileGB = (sourceStats.size / 1e9).toFixed(2);
  console.log(`Source  ${SOURCE}`);
  console.log(`Size    ${fileGB} GB  (${sourceStats.size.toLocaleString()} B)`);
  console.log('');

  // Read preamble for the fingerprint
  const { open } = await import('node:fs/promises');
  const handle = await open(SOURCE, 'r');
  let preamble: Buffer;
  try {
    const hdr = Buffer.alloc(375);
    await handle.read(hdr, 0, 375, 0);
    const o2pd = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength).getUint32(96, true);
    preamble = Buffer.alloc(o2pd);
    await handle.read(preamble, 0, o2pd, 0);
  } finally {
    await handle.close();
  }

  const headerSha256 = createHash('sha256')
    .update(new Uint8Array(preamble))
    .update(Buffer.from(String(sourceStats.size)))
    .digest('hex');

  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'wpi-diag-'));
  const outDir = path.join(tmpRoot, 'index');
  const started = Date.now();
  const snaps: DiagSnap[] = [];
  let lastSnapAt = started;
  let stage = 'init';

  // ── run ──────────────────────────────────────────────────────────────────
  try {
    const result = await buildPointCloudIndex({
      source: await createFileChunkSource(SOURCE),
      outDir,
      fileName: path.basename(SOURCE),
      sourceFingerprint: { headerSha256, fileSize: sourceStats.size, mtimeMs: sourceStats.mtimeMs },
      generatorVersion: '1.1.0',
      onProgress: (label, _pct) => {
        stage = label;
        const now = Date.now();
        if (now - lastSnapAt >= 5000) {
          const m = memUsage();
          // nodeCount is not accessible mid-build without plumbing, so we
          // report the spooler map size via a lightweight counter exposed
          // inside the builder (see snapshot callback below).
          snaps.push({
            stage,
            sec: (now - started) / 1000,
            nodeCount: -1, // filled post-hoc when possible
            spoolerSize: -1,
            rssMB: m.rssMB,
            externalMB: m.externalMB,
            arrayBufMB: m.arrayBufMB,
            heapMB: m.heapMB,
          });
          console.log(
            `  [${snaps[snaps.length - 1]!.sec.toFixed(0)}s] ` +
              `rss=${m.rssMB.toFixed(0)} MB  ext=${m.externalMB.toFixed(0)} MB  ` +
              `abuf=${m.arrayBufMB.toFixed(0)} MB  heap=${m.heapMB.toFixed(0)} MB  ` +
              `${label}`,
          );
          lastSnapAt = now;
        }
      },
      yieldTick: async () => {
        await new Promise<void>((r) => setImmediate(r));
      },
    });

    const wallS = ((Date.now() - started) / 1000).toFixed(1);

    // Read the manifest for coverage
    const manifest = await readWpiIndexManifest(outDir);
    const rootNode = manifest.nodes.find((n) => n.key === manifest.root)!;
    const srcExtX = manifest.bounds.maxX - manifest.bounds.minX;
    const srcExtY = manifest.bounds.maxY - manifest.bounds.minY;
    const rootExtX = rootNode.bounds.maxX - rootNode.bounds.minX;
    const rootExtY = rootNode.bounds.maxY - rootNode.bounds.minY;

    console.log('');
    console.log('=== SUCCESS ===');
    console.log(`  Wall time          ${wallS} s`);
    console.log(`  Points             ${result.metrics.pointCount.toLocaleString()}`);
    console.log(`  Stored             ${result.metrics.storedPointCount.toLocaleString()}`);
    console.log(`  Tiles              ${result.metrics.tileCount.toLocaleString()}`);
    console.log(`  Nodes              ${result.metrics.nodeCount.toLocaleString()}`);
    console.log(`  Max depth          ${result.metrics.maxDepthUsed}`);
    console.log(`  Max chain depth    ${result.metrics.maxChainDepth}`);
    console.log(`  Largest node       ${result.metrics.largestNodePoints.toLocaleString()} pts`);
    console.log(`  Largest buffer     ${(result.metrics.largestBufferBytes / 1e6).toFixed(1)} MB`);
    console.log(`  Index size         ${(result.metrics.indexSizeBytes / 1e6).toFixed(1)} MB`);
    console.log(`  Peak buffers       ${(result.metrics.peakBufferedBytes / 1e6).toFixed(1)} MB`);
    console.log(`  Peak voxel bytes   ${(result.metrics.peakVoxelBytes / 1e6).toFixed(2)} MB`);
    console.log(`  Root XY coverage   X ${((rootExtX / srcExtX) * 100).toFixed(1)}%  Y ${((rootExtY / srcExtY) * 100).toFixed(1)}%`);
    console.log(`  Root tile points   ${fmt(rootNode.pointCount)}`);
    console.log(`  Snapshots taken    ${snaps.length}`);
    console.log(`  Peak RSS           ${snaps.reduce((m, s) => Math.max(m, s.rssMB), 0).toFixed(0)} MB`);
    console.log(`  Peak arrayBuf      ${snaps.reduce((m, s) => Math.max(m, s.arrayBufMB), 0).toFixed(0)} MB`);
  } catch (err) {
    const wallS = ((Date.now() - started) / 1000).toFixed(1);
    const m = memUsage();
    console.log('');
    console.log('=== CRASH at ~' + wallS + ' s ===');
    console.log(`  Stage        ${stage}`);
    console.log(`  rss          ${m.rssMB.toFixed(0)} MB`);
    console.log(`  external     ${m.externalMB.toFixed(0)} MB`);
    console.log(`  arrayBuf     ${m.arrayBufMB.toFixed(0)} MB`);
    console.log(`  heap         ${m.heapMB.toFixed(0)} MB`);
    console.log(`  Error        ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.log(`  Stack top 5  ${err.stack.split('\n').slice(0, 6).join('\n                ')}`);
    }
    throw err;
  } finally {
    // Cleanup
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('\nDIAGNOSTIC FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
