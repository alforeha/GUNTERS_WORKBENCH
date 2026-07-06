// electron/pointcloud-index-builder.ts — WPI v1 point-cloud index builder (Electron-main /
// worker-thread side). Streaming, bounded-memory, two-pass construction modeled on
// las.worker.ts: a topology pass discovers the octree structure, a distribution pass routes
// every source point to exactly one node and spools it to disk, then each node's records are
// gzipped into a tile. The union of all tiles reproduces the source point set losslessly.
//
// COPC-shaped addressing (L-X-Y-Z octree keys) only — this is a workbench-internal index and
// is NOT COPC. No external tooling. The source file is read but never written.

import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { PointCloudBounds } from '../src/core/contract';
import { parseLasMetadata } from '../src/core/las/metadata';
import type { ChunkSource } from '../src/workers/las.worker';
import {
  WPI_TILE_HEADER_BYTES,
  decodeWpiTile,
  wpiRecordStride,
  wpiTileByteLayout,
  writeWpiRecord,
  writeWpiTileHeader,
  type DecodedWpiTile,
} from '../src/shared/wpi-tile';

// ── tunables ──────────────────────────────────────────────────────────────────
/** Points a node owns before it splits and pushes the remainder to children. */
export const WPI_NODE_CAPACITY = 100_000;
/** Safety cap on octree depth (splitting is capacity-driven, so this is rarely reached). */
export const WPI_MAX_DEPTH = 16;
/** Stop subdividing once a node cube is this small (world units) — guards coincident points. */
const MIN_NODE_EXTENT = 1e-3;
/** Source points read per byte-range chunk (bounded IO, no whole-file loads). */
const READ_CHUNK_POINTS = 1_000_000;
/** Flush spooled tile records to disk once buffered bytes cross this ceiling. */
const FLUSH_BYTES = 128 * 1024 * 1024;
/** Per-node buffer ceiling — any single node flushes to disk when it crosses this. */
const PER_NODE_BUFFER_CAP = 64 * 1024 * 1024;
const LAS_HEADER_BYTES = 375;

export const WPI_INDEX_MANIFEST_FILE = 'index.json';
export const WPI_INDEX_COMPLETE_MARKER = 'COMPLETE';
export const WPI_INDEX_TILES_DIR = 'tiles';

/** Per-dimension voxel cells for the claim grid at each node — one sample per cell. */
export function voxelCellsPerDim(nodeCapacity: number): number {
  return Math.max(8, Math.ceil(Math.cbrt(nodeCapacity)));
}

/** Total claim cells per node (cubed). */
export function voxelCellsTotal(cellsPerDim: number): number {
  return cellsPerDim * cellsPerDim * cellsPerDim;
}

// ── on-disk index.json shape ────────────────────────────────────────────────────
export interface WpiIndexNode {
  key: string;
  level: number;
  x: number;
  y: number;
  z: number;
  bounds: PointCloudBounds;
  pointCount: number;
  childKeys: string[];
  tile: string;
}

export interface WpiIndexManifest {
  wpiIndexVersion: 1.1;
  indexType: 'wpi-octree';
  generator: { name: 'workbench'; version: string };
  generatedAt: string;
  source: {
    headerSha256: string;
    fileSize: number;
    mtimeMs: number | null;
    pointCount: number;
    pointFormat: number;
    pointRecordLength: number;
  };
  bounds: PointCloudBounds;
  scale: [number, number, number];
  offset: [number, number, number];
  units: string;
  cube: { origin: [number, number, number]; size: number };
  hasRgb: boolean;
  tileByteLayout: ReturnType<typeof wpiTileByteLayout>;
  nodeCapacity: number;
  voxelGridDim: number;
  maxDepth: number;
  tileCount: number;
  storedPointCount: number;
  root: string;
  nodes: WpiIndexNode[];
}

export interface BuildPointCloudIndexInput {
  source: ChunkSource;
  outDir: string;
  fileName: string;
  sourceFingerprint: { headerSha256: string; fileSize: number; mtimeMs: number | null };
  generatorVersion: string;
  onProgress?: (label: string, pct: number | null) => void;
  shouldCancel?: () => boolean;
  yieldTick?: () => Promise<void>;
  /** Override for tests to force splits on small fixtures. Defaults to WPI_NODE_CAPACITY. */
  nodeCapacity?: number;
  /** Override for tests. Defaults to WPI_MAX_DEPTH. */
  maxDepth?: number;
}

export interface BuildPointCloudIndexMetrics {
  pointCount: number;
  storedPointCount: number;
  tileCount: number;
  indexSizeBytes: number;
  maxDepthUsed: number;
  wallTimeMs: number;
  peakBufferedBytes: number;
  peakVoxelBytes: number;
  nodeCount: number;
  maxChainDepth: number;
  largestNodePoints: number;
  largestBufferBytes: number;
}

export interface BuildPointCloudIndexResult {
  manifest: WpiIndexManifest;
  metrics: BuildPointCloudIndexMetrics;
}

/** Thrown when a build observes its cancellation signal; callers clean up partial output. */
export class PointCloudIndexCancelled extends Error {
  constructor() {
    super('Point-cloud index build was cancelled.');
    this.name = 'PointCloudIndexCancelled';
  }
}

// ── LAS record field offsets (replicated locally; las.worker keeps these private) ─
function rgbOffset(format: number): number | null {
  if (format === 2 || format === 3 || format === 5) return format === 3 || format === 5 ? 28 : 20;
  if (format === 7 || format === 8 || format === 10) return 30;
  return null;
}

function classificationOffset(format: number): number {
  return format >= 6 ? 16 : 15;
}

// ── octree geometry ─────────────────────────────────────────────────────────────
function childIndex(bounds: PointCloudBounds, x: number, y: number, z: number): number {
  const midX = (bounds.minX + bounds.maxX) * 0.5;
  const midY = (bounds.minY + bounds.maxY) * 0.5;
  const midZ = (bounds.minZ + bounds.maxZ) * 0.5;
  return (x >= midX ? 1 : 0) | (y >= midY ? 2 : 0) | (z >= midZ ? 4 : 0);
}

function childBounds(bounds: PointCloudBounds, idx: number): PointCloudBounds {
  const midX = (bounds.minX + bounds.maxX) * 0.5;
  const midY = (bounds.minY + bounds.maxY) * 0.5;
  const midZ = (bounds.minZ + bounds.maxZ) * 0.5;
  return {
    minX: idx & 1 ? midX : bounds.minX,
    maxX: idx & 1 ? bounds.maxX : midX,
    minY: idx & 2 ? midY : bounds.minY,
    maxY: idx & 2 ? bounds.maxY : midY,
    minZ: idx & 4 ? midZ : bounds.minZ,
    maxZ: idx & 4 ? bounds.maxZ : midZ,
  };
}

class BuildNode {
  ownCount = 0;
  written = 0;
  children: (BuildNode | null)[] | null = null;
  /** Lazily-allocated voxel-claim bitset (1 bit per cell, tracked for peak-memory reporting). */
  voxelBits: Uint8Array | null = null;

  constructor(
    readonly level: number,
    readonly x: number,
    readonly y: number,
    readonly z: number,
    readonly bounds: PointCloudBounds,
  ) {}

  get key(): string {
    return `${this.level}-${this.x}-${this.y}-${this.z}`;
  }

  /** Allocate the voxel-claim bitset for this node (cellsPerDim^3 cells, 1 bit each). */
  ensureVoxelBits(cellsPerDim: number): void {
    if (this.voxelBits) return;
    const total = voxelCellsTotal(cellsPerDim);
    this.voxelBits = new Uint8Array(Math.ceil(total / 8));
  }

  /** Return the peak bytes occupied by voxel-claim bitsets across the tree. */
  static peakVoxelBytes = 0;
}

function canSplit(node: BuildNode, maxDepth: number): boolean {
  if (node.level >= maxDepth) return false;
  return node.bounds.maxX - node.bounds.minX > MIN_NODE_EXTENT;
}

function childNode(parent: BuildNode, idx: number): BuildNode {
  return new BuildNode(
    parent.level + 1,
    parent.x * 2 + (idx & 1 ? 1 : 0),
    parent.y * 2 + (idx & 2 ? 1 : 0),
    parent.z * 2 + (idx & 4 ? 1 : 0),
    childBounds(parent.bounds, idx),
  );
}

// ── voxel-claim helpers ────────────────────────────────────────────────────────
function voxelCellIndex(bounds: PointCloudBounds, wx: number, wy: number, wz: number, cellsPerDim: number): number {
  const extent = bounds.maxX - bounds.minX;
  const cellSize = extent / cellsPerDim;
  const cx = Math.min(cellsPerDim - 1, Math.max(0, Math.floor((wx - bounds.minX) / cellSize)));
  const cy = Math.min(cellsPerDim - 1, Math.max(0, Math.floor((wy - bounds.minY) / cellSize)));
  const cz = Math.min(cellsPerDim - 1, Math.max(0, Math.floor((wz - bounds.minZ) / cellSize)));
  return cx + cy * cellsPerDim + cz * cellsPerDim * cellsPerDim;
}

function isVoxelClaimed(node: BuildNode, cellIdx: number): boolean {
  if (!node.voxelBits) return false;
  const byteIdx = cellIdx >>> 3;
  const bit = 1 << (cellIdx & 7);
  return (node.voxelBits[byteIdx]! & bit) !== 0;
}

function claimVoxel(node: BuildNode, cellsPerDim: number, cellIdx: number): void {
  node.ensureVoxelBits(cellsPerDim);
  const byteIdx = cellIdx >>> 3;
  const bit = 1 << (cellIdx & 7);
  node.voxelBits![byteIdx]! |= bit;
}

function trackPeakVoxelBytes(nodes: BuildNode[]): void {
  let total = 0;
  for (const node of nodes) {
    if (node.voxelBits) total += node.voxelBits.byteLength;
  }
  if (total > BuildNode.peakVoxelBytes) BuildNode.peakVoxelBytes = total;
}

/** Clear voxel claims between passes so pass-2 replay starts with a fresh slate. */
function clearVoxelClaims(nodes: BuildNode[]): void {
  for (const node of nodes) {
    if (node.voxelBits) {
      node.voxelBits.fill(0);
    }
  }
}

/** Pass 1: place a point via voxel-claim decimation.  A point is owned at the shallowest
 *  node where its voxel cell is unclaimed.  If the cell was already claimed by an earlier
 *  point (same file-order pass), the point drops to the child, same as the original
 *  owner-partition but with spatial uniformity instead of first-N-in-order.
 *
 *  minOwnedForSplit prevents early splitting when only a few cells are filled — the node
 *  must own at least this many points before it can create children.  This bounds node
 *  count in clustered data without changing the lossless-union invariant.  Leaves own
 *  whatever reaches them regardless. */
function insertPoint(
  root: BuildNode,
  wx: number,
  wy: number,
  wz: number,
  cellsPerDim: number,
  maxDepth: number,
  minOwnedForSplit: number,
): void {
  let cur = root;
  for (;;) {
    const cellIdx = voxelCellIndex(cur.bounds, wx, wy, wz, cellsPerDim);
    if (!isVoxelClaimed(cur, cellIdx)) {
      claimVoxel(cur, cellsPerDim, cellIdx);
      cur.ownCount++;
      return;
    }
    // Voxel already claimed — only split when the node has filled enough cells.
    if (cur.ownCount < minOwnedForSplit || !canSplit(cur, maxDepth)) {
      cur.ownCount++;
      return;
    }
    if (!cur.children) {
      cur.children = new Array<BuildNode | null>(8).fill(null);
    }
    const childIdx = childIndex(cur.bounds, wx, wy, wz);
    let child = cur.children[childIdx];
    if (!child) {
      child = childNode(cur, childIdx);
      cur.children[childIdx] = child;
    }
    cur = child;
  }
}

/** Pass 2: re-derive the owner of a point, replaying voxel claims in the same file order
 *  as pass 1 so ownership is deterministic. */
function routePoint(
  root: BuildNode,
  wx: number,
  wy: number,
  wz: number,
  cellsPerDim: number,
): BuildNode {
  let cur = root;
  for (;;) {
    const cellIdx = voxelCellIndex(cur.bounds, wx, wy, wz, cellsPerDim);
    if (!isVoxelClaimed(cur, cellIdx)) {
      claimVoxel(cur, cellsPerDim, cellIdx);
      return cur;
    }
    if (!cur.children) return cur;
    const childIdx = childIndex(cur.bounds, wx, wy, wz);
    const child = cur.children[childIdx];
    if (!child) return cur;
    cur = child;
  }
}

// ── streaming source reader ──────────────────────────────────────────────────────
interface SourceMetaLite {
  offsetToPointData: number;
  pointRecordLength: number;
  pointFormat: number;
  pointCount: number;
  scale: [number, number, number];
  offset: [number, number, number];
  bounds: PointCloudBounds;
  units: string;
}

async function readSourceMeta(source: ChunkSource, fileName: string): Promise<SourceMetaLite> {
  const header = await source.read(0, Math.min(LAS_HEADER_BYTES, source.size));
  const offsetToPointData = new DataView(header).getUint32(96, true);
  const preamble = await source.read(0, Math.min(offsetToPointData, source.size));
  const dataset = parseLasMetadata({ fileName, fileSize: source.size, header, preamble });
  return {
    offsetToPointData: dataset.offsetToPointData,
    pointRecordLength: dataset.pointRecordLength,
    pointFormat: dataset.pointFormat,
    pointCount: dataset.pointCount,
    scale: dataset.scale,
    offset: dataset.offset,
    bounds: dataset.bounds,
    units: dataset.meta.units.linear,
  };
}

async function streamPoints(
  source: ChunkSource,
  meta: SourceMetaLite,
  handle: (view: DataView, recordOffset: number) => void,
  onChunk: (processed: number) => Promise<void>,
  shouldCancel: () => boolean,
): Promise<void> {
  const recordLength = meta.pointRecordLength;
  const chunkBytes = READ_CHUNK_POINTS * recordLength;
  const pointDataEnd = meta.offsetToPointData + meta.pointCount * recordLength;
  let processed = 0;
  let nextOffset = meta.offsetToPointData;

  while (processed < meta.pointCount && nextOffset < pointDataEnd) {
    if (shouldCancel()) throw new PointCloudIndexCancelled();
    const end = Math.min(pointDataEnd, nextOffset + chunkBytes);
    const chunk = await source.read(nextOffset, end);
    const view = new DataView(chunk);
    const pointsInChunk = Math.floor(view.byteLength / recordLength);
    for (let i = 0; i < pointsInChunk && processed < meta.pointCount; i++) {
      handle(view, i * recordLength);
      processed++;
    }
    nextOffset = end;
    await onChunk(processed);
  }
}

// ── tile record spooler (bounded, flushes to per-node raw files) ──────────────────
interface SpoolEntry {
  buf: Buffer;
  view: DataView;
  len: number;
  bytesOnDisk: number;
}

class TileSpooler {
  private readonly entries = new Map<BuildNode, SpoolEntry>();
  private readonly hotNodes = new Set<BuildNode>();
  private globalBytes = 0;
  peakBytes = 0;
  largestNodePoints = 0;
  largestNodeBufferBytes = 0;
  readonly nodeCount = 0; // set by build after collectNodes
  private readonly initialBytes: number;

  constructor(
    private readonly tilesDir: string,
    private readonly hasRgb: boolean,
    private readonly stride: number,
  ) {
    this.initialBytes = Math.min(stride * 256, PER_NODE_BUFFER_CAP);
  }

  private makeEntry(): SpoolEntry {
    const buf = Buffer.allocUnsafe(this.initialBytes);
    return { buf, view: new DataView(buf.buffer, buf.byteOffset, buf.length), len: 0, bytesOnDisk: 0 };
  }

  private rawPath(node: BuildNode): string {
    return path.join(this.tilesDir, `${node.key}.raw`);
  }

  /** Synchronous: fills an in-memory bucket only. IO happens via flushNode / flushAll. */
  write(node: BuildNode, rec: Parameters<typeof writeWpiRecord>[2]): void {
    let entry = this.entries.get(node);
    if (!entry) {
      entry = this.makeEntry();
      this.entries.set(node, entry);
    }
    if (entry.len + this.stride > entry.buf.length) {
      const next = Buffer.allocUnsafe(Math.max(entry.buf.length * 2, entry.len + this.stride));
      entry.buf.copy(next, 0, 0, entry.len);
      entry.buf = next;
      entry.view = new DataView(next.buffer, next.byteOffset, next.length);
    }
    writeWpiRecord(entry.view, entry.len, rec, this.hasRgb);
    entry.len += this.stride;
    node.written++;
    this.globalBytes += this.stride;
    if (this.globalBytes > this.peakBytes) this.peakBytes = this.globalBytes;
    if (entry.len >= PER_NODE_BUFFER_CAP && !this.hotNodes.has(node)) {
      this.hotNodes.add(node);
    }
  }

  /** Flush a single hot node to disk and reset its buffer. */
  async flushNode(node: BuildNode): Promise<void> {
    const entry = this.entries.get(node);
    if (!entry || entry.len === 0) return;
    this.globalBytes -= entry.len;
    if (entry.len > this.largestNodeBufferBytes) this.largestNodeBufferBytes = entry.len;
    await appendFile(this.rawPath(node), entry.buf.subarray(0, entry.len));
    entry.bytesOnDisk += entry.len;
    entry.len = 0;
    this.hotNodes.delete(node);
    if (entry.buf.length > this.initialBytes) {
      entry.buf = Buffer.allocUnsafe(this.initialBytes);
      entry.view = new DataView(entry.buf.buffer, entry.buf.byteOffset, entry.buf.length);
    }
  }

  /** Post-pass-2: record per-node point count max for reporting. */
  recordLargestNode(node: BuildNode): void {
    if (node.written > this.largestNodePoints) this.largestNodePoints = node.written;
  }

  /** Whether global buffered bytes have crossed the flush ceiling. */
  shouldFlush(): boolean {
    return this.globalBytes >= FLUSH_BYTES;
  }

  async flushHotNodes(): Promise<void> {
    const nodes = [...this.hotNodes];
    for (const node of nodes) await this.flushNode(node);
  }

  async flushAll(): Promise<void> {
    for (const [node, entry] of this.entries) {
      if (entry.len === 0) continue;
      if (entry.len > this.largestNodeBufferBytes) this.largestNodeBufferBytes = entry.len;
      await appendFile(this.rawPath(node), entry.buf.subarray(0, entry.len));
      entry.bytesOnDisk += entry.len;
      entry.len = 0;
      if (entry.buf.length > this.initialBytes) {
        entry.buf = Buffer.allocUnsafe(this.initialBytes);
        entry.view = new DataView(entry.buf.buffer, entry.buf.byteOffset, entry.buf.length);
      }
    }
    this.hotNodes.clear();
    this.globalBytes = 0;
  }
}

// ── build ─────────────────────────────────────────────────────────────────────
function collectNodes(root: BuildNode): BuildNode[] {
  const out: BuildNode[] = [];
  const stack: BuildNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    out.push(node);
    if (node.children) for (const child of node.children) if (child) stack.push(child);
  }
  return out;
}

export async function buildPointCloudIndex(input: BuildPointCloudIndexInput): Promise<BuildPointCloudIndexResult> {
  const started = Date.now();
  BuildNode.peakVoxelBytes = 0;
  const shouldCancel = input.shouldCancel ?? (() => false);
  const yieldTick = input.yieldTick ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const onProgress = input.onProgress ?? (() => {});
  const nodeCapacity = input.nodeCapacity ?? WPI_NODE_CAPACITY;
  const maxDepth = input.maxDepth ?? WPI_MAX_DEPTH;
  const cellsPerDim = voxelCellsPerDim(nodeCapacity);
  const minOwnedForSplit = Math.max(1, Math.floor(voxelCellsTotal(cellsPerDim) / 4));

  const tilesDir = path.join(input.outDir, WPI_INDEX_TILES_DIR);
  await rm(input.outDir, { recursive: true, force: true });
  await mkdir(tilesDir, { recursive: true });

  onProgress('reading LAS header...', 2);
  const meta = await readSourceMeta(input.source, input.fileName);
  const hasRgb = rgbOffset(meta.pointFormat) !== null;
  const rgbAt = rgbOffset(meta.pointFormat);
  const classAt = classificationOffset(meta.pointFormat);
  const [sx, sy, sz] = meta.scale;
  const [ox, oy, oz] = meta.offset;

  // Cubic root cube so the octree stays isotropic (L-X-Y-Z addressing).
  const extentX = meta.bounds.maxX - meta.bounds.minX;
  const extentY = meta.bounds.maxY - meta.bounds.minY;
  const extentZ = meta.bounds.maxZ - meta.bounds.minZ;
  const cubeSize = Math.max(extentX, extentY, extentZ, MIN_NODE_EXTENT);
  const cubeOrigin: [number, number, number] = [meta.bounds.minX, meta.bounds.minY, meta.bounds.minZ];
  const rootBounds: PointCloudBounds = {
    minX: cubeOrigin[0],
    minY: cubeOrigin[1],
    minZ: cubeOrigin[2],
    maxX: cubeOrigin[0] + cubeSize,
    maxY: cubeOrigin[1] + cubeSize,
    maxZ: cubeOrigin[2] + cubeSize,
  };
  const root = new BuildNode(0, 0, 0, 0, rootBounds);

  // Pass 1 — topology.
  await streamPoints(
    input.source,
    meta,
    (view, o) => {
      const wx = view.getInt32(o, true) * sx + ox;
      const wy = view.getInt32(o + 4, true) * sy + oy;
      const wz = view.getInt32(o + 8, true) * sz + oz;
      insertPoint(root, wx, wy, wz, cellsPerDim, maxDepth, minOwnedForSplit);
    },
    async (processed) => {
      onProgress(
        `indexing topology (${processed.toLocaleString()} / ${meta.pointCount.toLocaleString()})...`,
        Math.min(49, Math.round((processed / Math.max(meta.pointCount, 1)) * 49)),
      );
      await yieldTick();
    },
    shouldCancel,
  );

  const nodes = collectNodes(root);
  trackPeakVoxelBytes(nodes);
  clearVoxelClaims(nodes);
  const stride = wpiRecordStride(hasRgb);
  const spooler = new TileSpooler(tilesDir, hasRgb, stride);

  // Pass 2 — distribution (spool each point to its owner node's raw file).
  await streamPoints(
    input.source,
    meta,
    (view, o) => {
      const ix = view.getInt32(o, true);
      const iy = view.getInt32(o + 4, true);
      const iz = view.getInt32(o + 8, true);
      const wx = ix * sx + ox;
      const wy = iy * sy + oy;
      const wz = iz * sz + oz;
      const node = routePoint(root, wx, wy, wz, cellsPerDim);
      spooler.write(node, {
        x: ix,
        y: iy,
        z: iz,
        intensity: view.getUint16(o + 12, true),
        classification: meta.pointFormat >= 6 ? view.getUint8(o + classAt) : view.getUint8(o + classAt) & 0x1f,
        returnByte: view.getUint8(o + 14),
        r: rgbAt !== null ? view.getUint16(o + rgbAt, true) : 0,
        g: rgbAt !== null ? view.getUint16(o + rgbAt + 2, true) : 0,
        b: rgbAt !== null ? view.getUint16(o + rgbAt + 4, true) : 0,
      });
    },
    async (processed) => {
      if (spooler.shouldFlush()) await spooler.flushAll();
      else await spooler.flushHotNodes();
      onProgress(
        `writing index tiles (${processed.toLocaleString()} / ${meta.pointCount.toLocaleString()})...`,
        Math.min(89, 50 + Math.round((processed / Math.max(meta.pointCount, 1)) * 39)),
      );
      await yieldTick();
    },
    shouldCancel,
  );
  await spooler.flushAll();

  // Finalize — stream-gzip each node's raw records into a tile.
  const manifestNodes: WpiIndexNode[] = [];
  let tileCount = 0;
  let storedPointCount = 0;
  let indexSizeBytes = 0;
  let maxDepthUsed = 0;
  const headerBuf = Buffer.alloc(WPI_TILE_HEADER_BYTES);
  const headerView = new DataView(headerBuf.buffer, headerBuf.byteOffset, headerBuf.length);
  let maxChainDepth = 0;

  // Instrumentation: chain depth
  {
    const depthByKey = new Map<string, number>();
    depthByKey.set(root.key, 0);
    for (const node of nodes) {
      if (node.level > maxDepthUsed) maxDepthUsed = node.level;
      if (node.children) {
        const pd = depthByKey.get(node.key) ?? 0;
        let childCount = 0;
        for (const child of node.children) {
          if (!child) continue;
          childCount++;
          depthByKey.set(child.key, pd + 1);
        }
        if (childCount === 1) {
          const chainDepth = pd + 1;
          if (chainDepth > maxChainDepth) maxChainDepth = chainDepth;
        }
      }
    }
  }

  for (let n = 0; n < nodes.length; n++) {
    if (shouldCancel()) throw new PointCloudIndexCancelled();
    const node = nodes[n]!;
    if (node.written === 0) continue;
    spooler.recordLargestNode(node);

    const rawPath = path.join(tilesDir, `${node.key}.raw`);
    const rawStats = await stat(rawPath);
    const count = Math.floor(rawStats.size / stride);
    writeWpiTileHeader(headerView, 0, count, hasRgb);

    const tileRel = `${WPI_INDEX_TILES_DIR}/${node.key}.bin.gz`;
    const tilePath = path.join(input.outDir, tileRel);
    try {
      const gzip = createGzip();
      gzip.write(headerBuf.subarray(0, WPI_TILE_HEADER_BYTES));
      await pipeline(createReadStream(rawPath), gzip, createWriteStream(tilePath));
    } catch (err) {
      const rawSize = rawStats.size;
      const msg = `WPI tile finalize failed for node ${node.key} (${count.toLocaleString()} pts, raw ${(rawSize / 1e6).toFixed(1)} MB): ${err instanceof Error ? err.message : String(err)}`;
      throw new Error(msg);
    }
    await rm(rawPath, { force: true });

    tileCount++;
    storedPointCount += count;
    indexSizeBytes += (await stat(tilePath)).size;
    if (node.level > maxDepthUsed) maxDepthUsed = node.level;
    manifestNodes.push({
      key: node.key,
      level: node.level,
      x: node.x,
      y: node.y,
      z: node.z,
      bounds: node.bounds,
      pointCount: count,
      childKeys: node.children
        ? node.children.filter((c): c is BuildNode => !!c && c.written > 0).map((c) => c.key)
        : [],
      tile: tileRel,
    });

    if (n % 64 === 0) {
      onProgress(`compressing tiles (${tileCount.toLocaleString()})...`, Math.min(98, 90 + Math.round((n / nodes.length) * 8)));
      await yieldTick();
    }
  }

  if (storedPointCount !== meta.pointCount) {
    throw new Error(
      `WPI index integrity check failed: stored ${storedPointCount} points but source has ${meta.pointCount}.`,
    );
  }

  const manifest: WpiIndexManifest = {
    wpiIndexVersion: 1.1,
    indexType: 'wpi-octree',
    generator: { name: 'workbench', version: input.generatorVersion },
    generatedAt: new Date().toISOString(),
    source: {
      headerSha256: input.sourceFingerprint.headerSha256,
      fileSize: input.sourceFingerprint.fileSize,
      mtimeMs: input.sourceFingerprint.mtimeMs,
      pointCount: meta.pointCount,
      pointFormat: meta.pointFormat,
      pointRecordLength: meta.pointRecordLength,
    },
    bounds: meta.bounds,
    scale: meta.scale,
    offset: meta.offset,
    units: meta.units,
    cube: { origin: cubeOrigin, size: cubeSize },
    hasRgb,
    tileByteLayout: wpiTileByteLayout(hasRgb),
    nodeCapacity,
    voxelGridDim: cellsPerDim,
    maxDepth,
    tileCount,
    storedPointCount,
    root: root.key,
    nodes: manifestNodes,
  };

  await writeFile(path.join(input.outDir, WPI_INDEX_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // Completion marker written LAST — its absence means partial/corrupt output.
  onProgress('finalizing index...', 99);
  await writeFile(
    path.join(input.outDir, WPI_INDEX_COMPLETE_MARKER),
    `${JSON.stringify({
      generatedAt: manifest.generatedAt,
      pointCount: meta.pointCount,
      storedPointCount,
      tileCount,
      indexSizeBytes,
    })}\n`,
    'utf8',
  );
  onProgress('index ready', 100);

  return {
    manifest,
    metrics: {
      pointCount: meta.pointCount,
      storedPointCount,
      tileCount,
      indexSizeBytes,
      maxDepthUsed,
      wallTimeMs: Date.now() - started,
      peakBufferedBytes: spooler.peakBytes,
      peakVoxelBytes: BuildNode.peakVoxelBytes,
      nodeCount: nodes.length,
      maxChainDepth,
      largestNodePoints: spooler.largestNodePoints,
      largestBufferBytes: spooler.largestNodeBufferBytes,
    },
  };
}

// ── reader / validator (tests + Phase 3 groundwork) ───────────────────────────────
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function isWpiIndexComplete(outDir: string): Promise<boolean> {
  return (
    (await pathExists(path.join(outDir, WPI_INDEX_COMPLETE_MARKER))) &&
    (await pathExists(path.join(outDir, WPI_INDEX_MANIFEST_FILE)))
  );
}

export async function readWpiIndexManifest(outDir: string): Promise<WpiIndexManifest> {
  if (!(await isWpiIndexComplete(outDir))) {
    throw new Error('WPI index is incomplete or corrupt (missing completion marker or manifest).');
  }
  const raw = await readFile(path.join(outDir, WPI_INDEX_MANIFEST_FILE), 'utf8');
  return JSON.parse(raw) as WpiIndexManifest;
}

export async function decodeWpiTileFile(outDir: string, tileRelPath: string): Promise<DecodedWpiTile> {
  const gz = await readFile(path.join(outDir, tileRelPath));
  const raw = gunzipSync(gz);
  return decodeWpiTile(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
}
