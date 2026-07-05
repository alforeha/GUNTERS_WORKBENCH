import type { PointCloudBounds, PointCloudDataset, PointCloudOctree, PointCloudOctreeNode } from '../core/contract';
import { parseLasMetadata } from '../core/las/metadata';

const LAS_HEADER_BYTES = 375;
const SAMPLE_POINT_LIMIT = 1_000_000;
const CHUNK_POINT_LIMIT = 1_000_000;
const TARGET_LEAF_POINTS = 50_000;
const MAX_OCTREE_DEPTH = 7;

export type LasImportQuality = 'fast' | 'balanced' | 'all-detail';

interface LasQualitySettings {
  label: string;
  nodeSampleCap: number;
  sampleStride: (depth: number) => number;
}

const LAS_QUALITY: Record<LasImportQuality, LasQualitySettings> = {
  fast: {
    label: 'Fast',
    nodeSampleCap: 50_000,
    sampleStride: (depth) => Math.max(128, 4096 >> depth),
  },
  balanced: {
    label: 'Balanced',
    nodeSampleCap: 50_000,
    sampleStride: (depth) => Math.max(16, 512 >> depth),
  },
  'all-detail': {
    label: 'All Detail',
    nodeSampleCap: 200_000,
    sampleStride: (depth) => Math.max(1, 64 >> depth),
  },
};

export interface LasWorkerRequest {
  id: number;
  fileName: string;
  payload: Blob | ArrayBuffer;
  quality?: LasImportQuality;
}

export type LasWorkerMessage =
  | { id: number; type: 'progress'; label: string; pct: number | null }
  | { id: number; type: 'result'; ok: true; dataset: PointCloudDataset }
  | { id: number; type: 'result'; ok: false; error: string };

function headerView(payload: Blob | ArrayBuffer): Promise<ArrayBuffer> {
  if (payload instanceof ArrayBuffer) return Promise.resolve(payload.slice(0, LAS_HEADER_BYTES));
  return payload.slice(0, LAS_HEADER_BYTES).arrayBuffer();
}

async function sampleView(payload: Blob | ArrayBuffer, offsetToPointData: number, pointRecordLength: number): Promise<ArrayBuffer> {
  const bytes = SAMPLE_POINT_LIMIT * pointRecordLength;
  if (payload instanceof ArrayBuffer) return payload.slice(offsetToPointData, offsetToPointData + bytes);
  return payload.slice(offsetToPointData, offsetToPointData + bytes).arrayBuffer();
}

function readSampleOffsets(header: ArrayBuffer): { offsetToPointData: number; pointRecordLength: number } {
  const view = new DataView(header);
  return {
    offsetToPointData: view.getUint32(96, true),
    pointRecordLength: view.getUint16(105, true),
  };
}

function payloadSize(payload: Blob | ArrayBuffer): number {
  return payload instanceof ArrayBuffer ? payload.byteLength : payload.size;
}

function rgbOffset(format: number): number | null {
  if (format === 2 || format === 3 || format === 5) return format === 3 || format === 5 ? 28 : 20;
  if (format === 7 || format === 8 || format === 10) return 30;
  return null;
}

function classificationOffset(format: number): number {
  return format >= 6 ? 16 : 15;
}

/**
 * Decode return number + number-of-returns from the per-point return byte(s).
 * Formats 0-5: one byte at offset 14 — return number = bits 0-2, num returns = bits 3-5.
 * Formats 6-10: byte 14 low nibble = return number, byte 15 low nibble = num returns.
 */
function readReturns(view: DataView, recordOffset: number, format: number): { returnNumber: number; numberOfReturns: number } {
  if (format >= 6) {
    const b14 = view.getUint8(recordOffset + 14);
    const b15 = view.getUint8(recordOffset + 15);
    return { returnNumber: b14 & 0x0f, numberOfReturns: b15 & 0x0f };
  }
  const b = view.getUint8(recordOffset + 14);
  return { returnNumber: b & 0x07, numberOfReturns: (b >> 3) & 0x07 };
}

function childBounds(bounds: PointCloudBounds, childIndex: number): PointCloudBounds {
  const midX = (bounds.minX + bounds.maxX) * 0.5;
  const midY = (bounds.minY + bounds.maxY) * 0.5;
  const midZ = (bounds.minZ + bounds.maxZ) * 0.5;
  return {
    minX: childIndex & 1 ? midX : bounds.minX,
    maxX: childIndex & 1 ? bounds.maxX : midX,
    minY: childIndex & 2 ? midY : bounds.minY,
    maxY: childIndex & 2 ? bounds.maxY : midY,
    minZ: childIndex & 4 ? midZ : bounds.minZ,
    maxZ: childIndex & 4 ? bounds.maxZ : midZ,
  };
}

function childIndex(bounds: PointCloudBounds, x: number, y: number, z: number): number {
  const midX = (bounds.minX + bounds.maxX) * 0.5;
  const midY = (bounds.minY + bounds.maxY) * 0.5;
  const midZ = (bounds.minZ + bounds.maxZ) * 0.5;
  return (x >= midX ? 1 : 0) | (y >= midY ? 2 : 0) | (z >= midZ ? 4 : 0);
}

function canSplit(bounds: PointCloudBounds, depth: number): boolean {
  if (depth >= MAX_OCTREE_DEPTH) return false;
  return Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ) > 0.001;
}

class MutableOctreeNode {
  readonly depth: number;
  readonly bounds: PointCloudBounds;
  children: MutableOctreeNode[] | null = null;
  pointCount = 0;
  private sampleCount = 0;
  private positions: number[] = [];
  private colors: number[] = [];
  private intensities: number[] = [];
  private classifications: number[] = [];
  private returnNumbers: number[] = [];
  private numberOfReturns: number[] = [];
  private quality: LasQualitySettings;

  constructor(depth: number, bounds: PointCloudBounds, quality: LasQualitySettings) {
    this.depth = depth;
    this.bounds = bounds;
    this.quality = quality;
  }

  insert(
    x: number,
    y: number,
    z: number,
    origin: [number, number, number],
    r: number,
    g: number,
    b: number,
    intensity: number,
    classification: number,
    returnNumber: number,
    numberOfReturns: number,
    globalPointIndex: number,
  ): void {
    if (this.children) {
      this.children[childIndex(this.bounds, x, y, z)]!.insert(
        x,
        y,
        z,
        origin,
        r,
        g,
        b,
        intensity,
        classification,
        returnNumber,
        numberOfReturns,
        globalPointIndex,
      );
      return;
    }

    this.pointCount++;
    if (this.sampleCount < this.quality.nodeSampleCap && globalPointIndex % this.quality.sampleStride(this.depth) === 0) {
      this.positions.push(x - origin[0], y - origin[1], z - origin[2]);
      this.colors.push(r, g, b);
      this.intensities.push(intensity);
      this.classifications.push(classification);
      this.returnNumbers.push(returnNumber);
      this.numberOfReturns.push(numberOfReturns);
      this.sampleCount++;
    }
    if (this.pointCount > TARGET_LEAF_POINTS && canSplit(this.bounds, this.depth)) {
      this.children = Array.from(
        { length: 8 },
        (_, i) => new MutableOctreeNode(this.depth + 1, childBounds(this.bounds, i), this.quality),
      );
    }
  }

  finalize(origin: [number, number, number], nextId: { value: number }, transfers: Transferable[]): PointCloudOctreeNode {
    const children = this.children?.map((child) => child.finalize(origin, nextId, transfers)) ?? [];
    const positions = new Float32Array(this.positions);
    const colors = new Uint8Array(this.colors);
    const intensities = new Float32Array(this.intensities);
    const classifications = new Uint8Array(this.classifications);
    const returnNumbers = new Uint8Array(this.returnNumbers);
    const numberOfReturns = new Uint8Array(this.numberOfReturns);
    transfers.push(
      positions.buffer,
      colors.buffer,
      intensities.buffer,
      classifications.buffer,
      returnNumbers.buffer,
      numberOfReturns.buffer,
    );
    const node: PointCloudOctreeNode = {
      id: nextId.value++,
      depth: this.depth,
      bounds: this.bounds,
      localBounds: {
        minX: this.bounds.minX - origin[0],
        minY: this.bounds.minY - origin[1],
        minZ: this.bounds.minZ - origin[2],
        maxX: this.bounds.maxX - origin[0],
        maxY: this.bounds.maxY - origin[1],
        maxZ: this.bounds.maxZ - origin[2],
      },
      pointCount: this.pointCount + children.reduce((sum, child) => sum + child.pointCount, 0),
      sampleCount: positions.length / 3,
      positions,
      colors,
      intensities,
      classifications,
      returnNumbers,
      numberOfReturns,
      children,
    };
    return node;
  }

  /** Collect distinct classes / returns and max num-returns over the sampled points. */
  collectSummary(classes: Set<number>, returns: Set<number>, acc: { maxReturnCount: number }): void {
    for (const c of this.classifications) classes.add(c);
    for (const r of this.returnNumbers) returns.add(r);
    for (const n of this.numberOfReturns) if (n > acc.maxReturnCount) acc.maxReturnCount = n;
    this.children?.forEach((child) => child.collectSummary(classes, returns, acc));
  }

  totalSampledPoints(): number {
    return this.sampleCount + (this.children?.reduce((sum, child) => sum + child.totalSampledPoints(), 0) ?? 0);
  }

  maxDepth(): number {
    return Math.max(this.depth, ...(this.children?.map((child) => child.maxDepth()) ?? [this.depth]));
  }
}

async function pointChunk(payload: Blob | ArrayBuffer, start: number, end: number): Promise<ArrayBuffer> {
  if (payload instanceof ArrayBuffer) return payload.slice(start, end);
  return payload.slice(start, end).arrayBuffer();
}

async function buildOctree(
  payload: Blob | ArrayBuffer,
  dataset: PointCloudDataset,
  qualityPreset: LasImportQuality,
  onProgress?: (label: string, pct: number | null) => void,
): Promise<{ octree: PointCloudOctree; transfers: Transferable[] }> {
  const quality = LAS_QUALITY[qualityPreset];
  const origin: [number, number, number] = [
    (dataset.bounds.minX + dataset.bounds.maxX) * 0.5,
    (dataset.bounds.minY + dataset.bounds.maxY) * 0.5,
    (dataset.bounds.minZ + dataset.bounds.maxZ) * 0.5,
  ];
  const root = new MutableOctreeNode(0, { ...dataset.bounds }, quality);
  const rgbAt = rgbOffset(dataset.pointFormat);
  const classAt = classificationOffset(dataset.pointFormat);
  const recordLength = dataset.pointRecordLength;
  const chunkBytes = CHUNK_POINT_LIMIT * recordLength;
  const pointDataEnd = dataset.offsetToPointData + dataset.pointCount * recordLength;
  let processed = 0;
  let nextOffset = dataset.offsetToPointData;

  while (processed < dataset.pointCount && nextOffset < pointDataEnd) {
    const end = Math.min(pointDataEnd, nextOffset + chunkBytes);
    const chunk = await pointChunk(payload, nextOffset, end);
    const view = new DataView(chunk);
    const pointsInChunk = Math.floor(view.byteLength / recordLength);
    for (let i = 0; i < pointsInChunk && processed < dataset.pointCount; i++) {
      const o = i * recordLength;
      const x = view.getInt32(o, true) * dataset.scale[0] + dataset.offset[0];
      const y = view.getInt32(o + 4, true) * dataset.scale[1] + dataset.offset[1];
      const z = view.getInt32(o + 8, true) * dataset.scale[2] + dataset.offset[2];
      const intensity = view.getUint16(o + 12, true) / 65535;
      const classification = view.getUint8(o + classAt) & (dataset.pointFormat >= 6 ? 0xff : 0x1f);
      const { returnNumber, numberOfReturns } = readReturns(view, o, dataset.pointFormat);
      const r = rgbAt !== null && o + rgbAt + 5 < view.byteLength ? view.getUint16(o + rgbAt, true) >> 8 : 255;
      const g = rgbAt !== null && o + rgbAt + 5 < view.byteLength ? view.getUint16(o + rgbAt + 2, true) >> 8 : 255;
      const b = rgbAt !== null && o + rgbAt + 5 < view.byteLength ? view.getUint16(o + rgbAt + 4, true) >> 8 : 255;
      root.insert(x, y, z, origin, r, g, b, intensity, classification, returnNumber, numberOfReturns, processed);
      processed++;
    }
    nextOffset = end;
    const pct = Math.min(99, Math.round((processed / Math.max(dataset.pointCount, 1)) * 100));
    onProgress?.(
      `building ${quality.label} octree (${processed.toLocaleString()} / ${dataset.pointCount.toLocaleString()} points)...`,
      pct,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const classes = new Set<number>();
  const returns = new Set<number>();
  const acc = { maxReturnCount: 1 };
  root.collectSummary(classes, returns, acc);

  const transfers: Transferable[] = [];
  const octree: PointCloudOctree = {
    origin,
    maxDepth: root.maxDepth(),
    targetLeafPointCount: TARGET_LEAF_POINTS,
    totalSampledPoints: root.totalSampledPoints(),
    presentClasses: [...classes].sort((a, b) => a - b),
    presentReturns: [...returns].filter((r) => r > 0).sort((a, b) => a - b),
    maxReturnCount: acc.maxReturnCount,
    zRange: [dataset.bounds.minZ, dataset.bounds.maxZ],
    root: root.finalize(origin, { value: 1 }, transfers),
  };
  return { octree, transfers };
}

export async function handleLasRequest(
  req: LasWorkerRequest,
  onProgress?: (label: string, pct: number | null) => void,
): Promise<LasWorkerMessage> {
  return (await handleLasRequestWithTransfer(req, onProgress)).response;
}

async function handleLasRequestWithTransfer(
  req: LasWorkerRequest,
  onProgress?: (label: string, pct: number | null) => void,
): Promise<{ response: LasWorkerMessage; transfer: Transferable[] }> {
  try {
    onProgress?.('reading LAS header...', 5);
    const header = await headerView(req.payload);
    const { offsetToPointData, pointRecordLength } = readSampleOffsets(header);
    onProgress?.('sampling point attributes...', 35);
    const sample = await sampleView(req.payload, offsetToPointData, pointRecordLength);
    onProgress?.('building findings...', 85);
    const dataset = parseLasMetadata({
      fileName: req.fileName,
      fileSize: payloadSize(req.payload),
      header,
      sample,
    });
    const quality = req.quality ?? 'balanced';
    onProgress?.(`building ${LAS_QUALITY[quality].label} octree...`, 0);
    const { octree, transfers } = await buildOctree(req.payload, dataset, quality, onProgress);
    dataset.octree = octree;
    dataset.report.counts.octreeNodes = countNodes(octree.root);
    dataset.report.counts.sampledRenderPoints = octree.totalSampledPoints;
    dataset.report.infos.push(`import quality preset: ${LAS_QUALITY[quality].label}`);
    dataset.report.infos.push(
      `octree built: ${dataset.report.counts.octreeNodes.toLocaleString()} nodes, ${octree.totalSampledPoints.toLocaleString()} sampled render points`,
    );
    onProgress?.('octree ready', 100);
    return { response: { id: req.id, type: 'result', ok: true, dataset }, transfer: transfers };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { response: { id: req.id, type: 'result', ok: false, error: msg }, transfer: [] };
  }
}

function countNodes(node: PointCloudOctreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

declare const WorkerGlobalScope: unknown;

if (typeof WorkerGlobalScope !== 'undefined') {
  const scope = globalThis as unknown as {
    onmessage: ((e: MessageEvent<LasWorkerRequest>) => void) | null;
    postMessage(msg: LasWorkerMessage, transfer?: Transferable[]): void;
  };
  scope.onmessage = (e: MessageEvent<LasWorkerRequest>) => {
    const { id } = e.data;
    void handleLasRequestWithTransfer(e.data, (label, pct) => scope.postMessage({ id, type: 'progress', label, pct })).then(
      ({ response, transfer }) => scope.postMessage(response, transfer),
    );
  };
}
