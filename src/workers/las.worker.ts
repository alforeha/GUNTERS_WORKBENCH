import type {
  LasAttributeSummary,
  PointCloudBounds,
  PointCloudDataset,
  PointCloudNodePayload,
  PointCloudOctree,
  PointCloudOctreeNode,
  PointCloudSourceRange,
} from '../core/contract';
import { parseLasMetadata } from '../core/las/metadata';

const LAS_HEADER_BYTES = 375;
const SAMPLE_POINT_LIMIT = 1_000_000;
const CHUNK_POINT_LIMIT = 1_000_000;
const TARGET_LEAF_POINTS = 50_000;
const MAX_OCTREE_DEPTH = 7;
const SOURCE_RANGE_BLOCK_POINTS = 4_096;

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

export interface LoadDensifiedNodeRequest {
  dataset: Pick<PointCloudDataset, 'pointFormat' | 'pointRecordLength' | 'scale' | 'offset' | 'offsetToPointData'> & {
    octree: Pick<PointCloudOctree, 'origin'>;
  };
  node: Pick<PointCloudOctreeNode, 'id' | 'sourceRanges' | 'bounds'>;
}

export interface ChunkSource {
  size: number;
  read(start: number, end: number): Promise<ArrayBuffer>;
}

export type LasWorkerMessage =
  | { id: number; type: 'progress'; label: string; pct: number | null }
  | { id: number; type: 'result'; ok: true; dataset: PointCloudDataset }
  | { id: number; type: 'result'; ok: false; error: string };

function createPayloadSource(payload: Blob | ArrayBuffer): ChunkSource {
  return {
    size: payload instanceof ArrayBuffer ? payload.byteLength : payload.size,
    read(start: number, end: number): Promise<ArrayBuffer> {
      if (payload instanceof ArrayBuffer) return Promise.resolve(payload.slice(start, end));
      return payload.slice(start, end).arrayBuffer();
    },
  };
}

export function computeStride(totalPoints: number, budget = SAMPLE_POINT_LIMIT): number {
  if (totalPoints <= 0) return 1;
  return Math.max(1, Math.ceil(totalPoints / Math.max(1, budget)));
}

function rgbOffset(format: number): number | null {
  if (format === 2 || format === 3 || format === 5) return format === 3 || format === 5 ? 28 : 20;
  if (format === 7 || format === 8 || format === 10) return 30;
  return null;
}

function classificationOffset(format: number): number {
  return format >= 6 ? 16 : 15;
}

function defaultAttributes(pointFormat: number): LasAttributeSummary {
  return {
    hasIntensity: true,
    hasReturns: true,
    hasClassification: true,
    hasClassificationFlags: pointFormat >= 6,
    hasUserData: true,
    hasScanAngle: true,
    hasPointSourceId: true,
    hasGpsTime: pointFormat === 1 || pointFormat === 3 || pointFormat === 4 || pointFormat === 5 || pointFormat >= 6,
    hasRgb: pointFormat === 2 || pointFormat === 3 || pointFormat === 5 || pointFormat === 7 || pointFormat === 8 || pointFormat === 10,
    intensityRange: null,
    rgbRange: null,
    sampledPoints: 0,
    classificationCounts: {},
    returnNumberCounts: {},
    numberOfReturnsCounts: {},
    userDataCounts: {},
  };
}

function addCount(counts: Record<string, number>, key: number): void {
  counts[String(key)] = (counts[String(key)] ?? 0) + 1;
}

function readReturns(view: DataView, recordOffset: number, format: number): { returnNumber: number; numberOfReturns: number } {
  if (format >= 6) {
    const b14 = view.getUint8(recordOffset + 14);
    const b15 = view.getUint8(recordOffset + 15);
    return { returnNumber: b14 & 0x0f, numberOfReturns: b15 & 0x0f };
  }
  const b = view.getUint8(recordOffset + 14);
  return { returnNumber: b & 0x07, numberOfReturns: (b >> 3) & 0x07 };
}

function childBounds(bounds: PointCloudBounds, childIndexValue: number): PointCloudBounds {
  const midX = (bounds.minX + bounds.maxX) * 0.5;
  const midY = (bounds.minY + bounds.maxY) * 0.5;
  const midZ = (bounds.minZ + bounds.maxZ) * 0.5;
  return {
    minX: childIndexValue & 1 ? midX : bounds.minX,
    maxX: childIndexValue & 1 ? bounds.maxX : midX,
    minY: childIndexValue & 2 ? midY : bounds.minY,
    maxY: childIndexValue & 2 ? bounds.maxY : midY,
    minZ: childIndexValue & 4 ? midZ : bounds.minZ,
    maxZ: childIndexValue & 4 ? bounds.maxZ : midZ,
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

export function appendMergedSourceRange(ranges: PointCloudSourceRange[], pointIndex: number): void {
  const last = ranges[ranges.length - 1];
  if (last && last.startIndex + last.pointCount === pointIndex) {
    last.pointCount++;
    return;
  }
  ranges.push({ startIndex: pointIndex, pointCount: 1 });
}

function appendMergedSourceBlockRange(ranges: PointCloudSourceRange[], pointIndex: number, totalPoints: number): void {
  const blockStart = Math.floor(pointIndex / SOURCE_RANGE_BLOCK_POINTS) * SOURCE_RANGE_BLOCK_POINTS;
  const blockPointCount = Math.min(SOURCE_RANGE_BLOCK_POINTS, totalPoints - blockStart);
  const last = ranges[ranges.length - 1];
  if (last) {
    const lastEnd = last.startIndex + last.pointCount;
    if (blockStart < lastEnd) return;
    if (blockStart === lastEnd) {
      last.pointCount += blockPointCount;
      return;
    }
  }
  ranges.push({ startIndex: blockStart, pointCount: blockPointCount });
}

class TopologyNode {
  readonly depth: number;
  readonly bounds: PointCloudBounds;
  pointCount = 0;
  children: Array<TopologyNode | null> | null = null;

  constructor(depth: number, bounds: PointCloudBounds) {
    this.depth = depth;
    this.bounds = bounds;
  }

  insert(x: number, y: number, z: number): void {
    this.pointCount++;
    if (!canSplit(this.bounds, this.depth)) return;
    const idx = childIndex(this.bounds, x, y, z);
    if (!this.children) this.children = Array.from({ length: 8 }, () => null);
    if (!this.children[idx]) this.children[idx] = new TopologyNode(this.depth + 1, childBounds(this.bounds, idx));
    this.children[idx]!.insert(x, y, z);
  }
}

class GrowableLeafBuffers {
  private positions = new Float32Array(0);
  private colors = new Uint8Array(0);
  private intensities = new Float32Array(0);
  private classifications = new Uint8Array(0);
  private returnNumbers = new Uint8Array(0);
  private numberOfReturns = new Uint8Array(0);
  sampleCount = 0;

  append(
    localX: number,
    localY: number,
    localZ: number,
    r: number,
    g: number,
    b: number,
    intensity: number,
    classification: number,
    returnNumber: number,
    numberOfReturns: number,
  ): void {
    this.ensureCapacity(this.sampleCount + 1);
    const base = this.sampleCount * 3;
    this.positions[base] = localX;
    this.positions[base + 1] = localY;
    this.positions[base + 2] = localZ;
    this.colors[base] = r;
    this.colors[base + 1] = g;
    this.colors[base + 2] = b;
    this.intensities[this.sampleCount] = intensity;
    this.classifications[this.sampleCount] = classification;
    this.returnNumbers[this.sampleCount] = returnNumber;
    this.numberOfReturns[this.sampleCount] = numberOfReturns;
    this.sampleCount++;
  }

  consume(): Omit<PointCloudOctreeNode, 'id' | 'depth' | 'bounds' | 'localBounds' | 'pointCount' | 'sourceRanges' | 'children'> {
    const exactPointValues = this.sampleCount * 3;
    const out = {
      sampleCount: this.sampleCount,
      positions: this.positions.length === exactPointValues ? this.positions : this.positions.slice(0, exactPointValues),
      colors: this.colors.length === exactPointValues ? this.colors : this.colors.slice(0, exactPointValues),
      intensities: this.intensities.length === this.sampleCount ? this.intensities : this.intensities.slice(0, this.sampleCount),
      classifications: this.classifications.length === this.sampleCount ? this.classifications : this.classifications.slice(0, this.sampleCount),
      returnNumbers: this.returnNumbers.length === this.sampleCount ? this.returnNumbers : this.returnNumbers.slice(0, this.sampleCount),
      numberOfReturns:
        this.numberOfReturns.length === this.sampleCount ? this.numberOfReturns : this.numberOfReturns.slice(0, this.sampleCount),
    };
    this.positions = new Float32Array(0);
    this.colors = new Uint8Array(0);
    this.intensities = new Float32Array(0);
    this.classifications = new Uint8Array(0);
    this.returnNumbers = new Uint8Array(0);
    this.numberOfReturns = new Uint8Array(0);
    this.sampleCount = 0;
    return out;
  }

  classificationAt(index: number): number {
    return this.classifications[index] ?? 0;
  }

  returnNumberAt(index: number): number {
    return this.returnNumbers[index] ?? 0;
  }

  numberOfReturnsAt(index: number): number {
    return this.numberOfReturns[index] ?? 0;
  }

  private ensureCapacity(required: number): void {
    const current = this.positions.length / 3;
    if (current >= required) return;
    let next = Math.max(64, current || 0);
    while (next < required) next *= 2;
    const nextPositions = new Float32Array(next * 3);
    const nextColors = new Uint8Array(next * 3);
    const nextIntensities = new Float32Array(next);
    const nextClassifications = new Uint8Array(next);
    const nextReturnNumbers = new Uint8Array(next);
    const nextNumberOfReturns = new Uint8Array(next);
    nextPositions.set(this.positions);
    nextColors.set(this.colors);
    nextIntensities.set(this.intensities);
    nextClassifications.set(this.classifications);
    nextReturnNumbers.set(this.returnNumbers);
    nextNumberOfReturns.set(this.numberOfReturns);
    this.positions = nextPositions;
    this.colors = nextColors;
    this.intensities = nextIntensities;
    this.classifications = nextClassifications;
    this.returnNumbers = nextReturnNumbers;
    this.numberOfReturns = nextNumberOfReturns;
  }
}

class FinalNodeBuilder {
  readonly depth: number;
  readonly bounds: PointCloudBounds;
  readonly pointCount: number;
  children: FinalNodeBuilder[];
  readonly sourceRanges: PointCloudSourceRange[] = [];
  private readonly childSlot: number | null;
  private readonly quality: LasQualitySettings;
  private readonly totalPointCount: number;
  private samples: GrowableLeafBuffers | null;

  constructor(topology: TopologyNode, quality: LasQualitySettings, totalPointCount: number, childSlot: number | null = null) {
    this.depth = topology.depth;
    this.bounds = topology.bounds;
    this.pointCount = topology.pointCount;
    this.childSlot = childSlot;
    this.quality = quality;
    this.totalPointCount = totalPointCount;
    if (
      topology.pointCount > TARGET_LEAF_POINTS &&
      canSplit(topology.bounds, topology.depth) &&
      topology.children?.some((child) => child !== null)
    ) {
      this.children = topology.children.flatMap((child, index) =>
        child ? [new FinalNodeBuilder(child, quality, totalPointCount, index)] : [],
      );
      this.samples = null;
    } else {
      this.children = [];
      this.samples = new GrowableLeafBuffers();
    }
  }

  appendPoint(
    point: {
      x: number;
      y: number;
      z: number;
      r: number;
      g: number;
      b: number;
      intensity: number;
      classification: number;
      returnNumber: number;
      numberOfReturns: number;
    },
    origin: [number, number, number],
    globalPointIndex: number,
  ): void {
    if (this.children.length > 0) {
      const idx = childIndex(this.bounds, point.x, point.y, point.z);
      const child = this.children.find((candidate) => candidate.childSlot === idx);
      if (child) {
        child.appendPoint(point, origin, globalPointIndex);
        return;
      }
    }
    appendMergedSourceBlockRange(this.sourceRanges, globalPointIndex, this.totalPointCount);
    if (!this.samples) return;
    if (this.samples.sampleCount >= this.quality.nodeSampleCap) return;
    if (globalPointIndex % this.quality.sampleStride(this.depth) !== 0) return;
    this.samples.append(
      point.x - origin[0],
      point.y - origin[1],
      point.z - origin[2],
      point.r,
      point.g,
      point.b,
      point.intensity,
      point.classification,
      point.returnNumber,
      point.numberOfReturns,
    );
  }

  finalize(origin: [number, number, number], nextId: { value: number }, transfers: Transferable[]): PointCloudOctreeNode {
    const children = this.children.map((child) => child.finalize(origin, nextId, transfers));
    this.children = [];
    const sampleData = this.samples?.consume() ?? {
      sampleCount: 0,
      positions: new Float32Array(0),
      colors: new Uint8Array(0),
      intensities: new Float32Array(0),
      classifications: new Uint8Array(0),
      returnNumbers: new Uint8Array(0),
      numberOfReturns: new Uint8Array(0),
    };
    this.samples = null;
    transfers.push(
      sampleData.positions.buffer,
      sampleData.colors.buffer,
      sampleData.intensities.buffer,
      sampleData.classifications.buffer,
      sampleData.returnNumbers.buffer,
      sampleData.numberOfReturns.buffer,
    );
    return {
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
      pointCount: this.pointCount,
      sampleCount: sampleData.sampleCount,
      positions: sampleData.positions,
      colors: sampleData.colors,
      intensities: sampleData.intensities,
      classifications: sampleData.classifications,
      returnNumbers: sampleData.returnNumbers,
      numberOfReturns: sampleData.numberOfReturns,
      sourceRanges: this.sourceRanges.splice(0, this.sourceRanges.length).map((range) => ({ ...range })),
      children,
    };
  }

  totalSampledPoints(): number {
    return (this.samples?.sampleCount ?? 0) + this.children.reduce((sum, child) => sum + child.totalSampledPoints(), 0);
  }

  maxDepth(): number {
    return Math.max(this.depth, ...(this.children.map((child) => child.maxDepth())));
  }

  collectSummary(classes: Set<number>, returns: Set<number>, acc: { maxReturnCount: number }): void {
    if (this.samples) {
      for (let i = 0; i < this.samples.sampleCount; i++) {
        classes.add(this.samples.classificationAt(i));
        const returnNumber = this.samples.returnNumberAt(i);
        if (returnNumber > 0) returns.add(returnNumber);
        const numberOfReturns = this.samples.numberOfReturnsAt(i);
        if (numberOfReturns > acc.maxReturnCount) acc.maxReturnCount = numberOfReturns;
      }
      return;
    }
    this.children.forEach((child) => child.collectSummary(classes, returns, acc));
  }
}

class StridedAttributeSampler {
  private readonly stride: number;
  private readonly pointFormat: number;
  private readonly rgbAt: number | null;
  private readonly out: LasAttributeSummary;
  private minIntensity = Infinity;
  private maxIntensity = -Infinity;
  private minRgb: [number, number, number] = [Infinity, Infinity, Infinity];
  private maxRgb: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  private rgbSeen = false;

  constructor(pointFormat: number, totalPoints: number, budget = SAMPLE_POINT_LIMIT) {
    this.pointFormat = pointFormat;
    this.stride = computeStride(totalPoints, budget);
    this.rgbAt = rgbOffset(pointFormat);
    this.out = defaultAttributes(pointFormat);
  }

  inspect(view: DataView, recordOffset: number, globalPointIndex: number): void {
    if (globalPointIndex % this.stride !== 0) return;
    this.out.sampledPoints++;
    const intensity = view.getUint16(recordOffset + 12, true);
    this.minIntensity = Math.min(this.minIntensity, intensity);
    this.maxIntensity = Math.max(this.maxIntensity, intensity);
    const returnByte = view.getUint8(recordOffset + 14);
    addCount(this.out.returnNumberCounts, this.pointFormat >= 6 ? returnByte & 0x0f : returnByte & 0x07);
    addCount(this.out.numberOfReturnsCounts, this.pointFormat >= 6 ? (returnByte >> 4) & 0x0f : (returnByte >> 3) & 0x07);
    const classification = this.pointFormat >= 6 ? view.getUint8(recordOffset + 16) : view.getUint8(recordOffset + 15) & 0x1f;
    addCount(this.out.classificationCounts, classification);
    const userDataOffset = this.pointFormat >= 6 ? 17 : 16;
    addCount(this.out.userDataCounts, view.getUint8(recordOffset + userDataOffset));
    if (this.rgbAt !== null) {
      const rgb: [number, number, number] = [
        view.getUint16(recordOffset + this.rgbAt, true),
        view.getUint16(recordOffset + this.rgbAt + 2, true),
        view.getUint16(recordOffset + this.rgbAt + 4, true),
      ];
      this.minRgb = [Math.min(this.minRgb[0], rgb[0]), Math.min(this.minRgb[1], rgb[1]), Math.min(this.minRgb[2], rgb[2])];
      this.maxRgb = [Math.max(this.maxRgb[0], rgb[0]), Math.max(this.maxRgb[1], rgb[1]), Math.max(this.maxRgb[2], rgb[2])];
      this.rgbSeen = true;
    }
  }

  finalize(): LasAttributeSummary {
    if (this.out.sampledPoints > 0) this.out.intensityRange = [this.minIntensity, this.maxIntensity];
    if (this.rgbSeen) this.out.rgbRange = [this.minRgb, this.maxRgb];
    return this.out;
  }
}

async function readHeader(source: ChunkSource): Promise<ArrayBuffer> {
  return source.read(0, Math.min(LAS_HEADER_BYTES, source.size));
}

async function readPreamble(source: ChunkSource, header: ArrayBuffer): Promise<ArrayBuffer> {
  const view = new DataView(header);
  const offsetToPointData = view.getUint32(96, true);
  return source.read(0, Math.min(offsetToPointData, source.size));
}

async function walkPoints(
  source: ChunkSource,
  dataset: PointCloudDataset,
  onPoint: (view: DataView, recordOffset: number, globalPointIndex: number) => void,
  onProgress: (processed: number) => Promise<void>,
): Promise<void> {
  const recordLength = dataset.pointRecordLength;
  const chunkBytes = CHUNK_POINT_LIMIT * recordLength;
  const pointDataEnd = dataset.offsetToPointData + dataset.pointCount * recordLength;
  let processed = 0;
  let nextOffset = dataset.offsetToPointData;

  while (processed < dataset.pointCount && nextOffset < pointDataEnd) {
    const end = Math.min(pointDataEnd, nextOffset + chunkBytes);
    const chunk = await source.read(nextOffset, end);
    const view = new DataView(chunk);
    const pointsInChunk = Math.floor(view.byteLength / recordLength);
    for (let i = 0; i < pointsInChunk && processed < dataset.pointCount; i++) {
      onPoint(view, i * recordLength, processed);
      processed++;
    }
    nextOffset = end;
    await onProgress(processed);
  }
}

function decodePoint(
  view: DataView,
  recordOffset: number,
  dataset: PointCloudDataset,
  rgbAt: number | null,
  classAt: number,
): {
  x: number;
  y: number;
  z: number;
  intensity: number;
  classification: number;
  returnNumber: number;
  numberOfReturns: number;
  r: number;
  g: number;
  b: number;
} {
  const x = view.getInt32(recordOffset, true) * dataset.scale[0] + dataset.offset[0];
  const y = view.getInt32(recordOffset + 4, true) * dataset.scale[1] + dataset.offset[1];
  const z = view.getInt32(recordOffset + 8, true) * dataset.scale[2] + dataset.offset[2];
  const intensity = view.getUint16(recordOffset + 12, true) / 65535;
  const classification = view.getUint8(recordOffset + classAt) & (dataset.pointFormat >= 6 ? 0xff : 0x1f);
  const { returnNumber, numberOfReturns } = readReturns(view, recordOffset, dataset.pointFormat);
  const r = rgbAt !== null && recordOffset + rgbAt + 5 < view.byteLength ? view.getUint16(recordOffset + rgbAt, true) >> 8 : 255;
  const g = rgbAt !== null && recordOffset + rgbAt + 5 < view.byteLength ? view.getUint16(recordOffset + rgbAt + 2, true) >> 8 : 255;
  const b = rgbAt !== null && recordOffset + rgbAt + 5 < view.byteLength ? view.getUint16(recordOffset + rgbAt + 4, true) >> 8 : 255;
  return { x, y, z, intensity, classification, returnNumber, numberOfReturns, r, g, b };
}

async function buildOctree(
  source: ChunkSource,
  dataset: PointCloudDataset,
  qualityPreset: LasImportQuality,
  onProgress?: (label: string, pct: number | null) => void,
): Promise<{ octree: PointCloudOctree; transfers: Transferable[]; attributes: LasAttributeSummary }> {
  const quality = LAS_QUALITY[qualityPreset];
  const origin: [number, number, number] = [
    (dataset.bounds.minX + dataset.bounds.maxX) * 0.5,
    (dataset.bounds.minY + dataset.bounds.maxY) * 0.5,
    (dataset.bounds.minZ + dataset.bounds.maxZ) * 0.5,
  ];
  const rgbAt = rgbOffset(dataset.pointFormat);
  const classAt = classificationOffset(dataset.pointFormat);

  const topologyRoot = new TopologyNode(0, { ...dataset.bounds });
  await walkPoints(
    source,
    dataset,
    (view, recordOffset) => {
      const point = decodePoint(view, recordOffset, dataset, rgbAt, classAt);
      topologyRoot.insert(point.x, point.y, point.z);
    },
    async (processed) => {
      const pct = Math.min(49, Math.round((processed / Math.max(dataset.pointCount, 1)) * 50));
      onProgress?.(`building ${quality.label} topology (${processed.toLocaleString()} / ${dataset.pointCount.toLocaleString()} points)...`, pct);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  );

  const finalRoot = new FinalNodeBuilder(topologyRoot, quality, dataset.pointCount);
  const attrSampler = new StridedAttributeSampler(dataset.pointFormat, dataset.pointCount);
  await walkPoints(
    source,
    dataset,
    (view, recordOffset, globalPointIndex) => {
      attrSampler.inspect(view, recordOffset, globalPointIndex);
      const point = decodePoint(view, recordOffset, dataset, rgbAt, classAt);
      finalRoot.appendPoint(point, origin, globalPointIndex);
    },
    async (processed) => {
      const pct = Math.min(99, 50 + Math.round((processed / Math.max(dataset.pointCount, 1)) * 49));
      onProgress?.(`sampling ${quality.label} octree (${processed.toLocaleString()} / ${dataset.pointCount.toLocaleString()} points)...`, pct);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  );

  const classes = new Set<number>();
  const returns = new Set<number>();
  const acc = { maxReturnCount: 1 };
  finalRoot.collectSummary(classes, returns, acc);

  const transfers: Transferable[] = [];
  const octree: PointCloudOctree = {
    origin,
    maxDepth: finalRoot.maxDepth(),
    targetLeafPointCount: TARGET_LEAF_POINTS,
    totalSampledPoints: finalRoot.totalSampledPoints(),
    presentClasses: [...classes].sort((a, b) => a - b),
    presentReturns: [...returns].sort((a, b) => a - b),
    maxReturnCount: acc.maxReturnCount,
    zRange: [dataset.bounds.minZ, dataset.bounds.maxZ],
    root: finalRoot.finalize(origin, { value: 1 }, transfers),
  };
  return { octree, transfers, attributes: attrSampler.finalize() };
}

function countNodes(node: PointCloudOctreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

export async function handleLasSourceRequest(
  req: { id: number; fileName: string; source: ChunkSource; quality?: LasImportQuality },
  onProgress?: (label: string, pct: number | null) => void,
): Promise<{ response: LasWorkerMessage; transfer: Transferable[] }> {
  try {
    onProgress?.('reading LAS header...', 5);
    const header = await readHeader(req.source);
    const preamble = await readPreamble(req.source, header);
    onProgress?.('reading LAS metadata...', 20);
    const dataset = parseLasMetadata({
      fileName: req.fileName,
      fileSize: req.source.size,
      header,
      preamble,
    });
    const quality = req.quality ?? 'balanced';
    onProgress?.(`building ${LAS_QUALITY[quality].label} octree...`, 0);
    const { octree, transfers, attributes } = await buildOctree(req.source, dataset, quality, onProgress);
    dataset.attributes = attributes;
    dataset.octree = octree;
    dataset.report.counts.sampledPoints = attributes.sampledPoints;
    dataset.report.counts.octreeNodes = countNodes(octree.root);
    dataset.report.counts.sampledRenderPoints = octree.totalSampledPoints;
    dataset.report.infos.push(`import quality preset: ${LAS_QUALITY[quality].label}`);
    dataset.report.infos.push(
      `strided attribute sample spans full file: ${attributes.sampledPoints.toLocaleString()} of ${dataset.pointCount.toLocaleString()} points`,
    );
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

function countSourceRangePoints(ranges: PointCloudSourceRange[]): number {
  return ranges.reduce((sum, range) => sum + range.pointCount, 0);
}

function pointInBounds(bounds: PointCloudBounds, x: number, y: number, z: number): boolean {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY && z >= bounds.minZ && z <= bounds.maxZ;
}

export async function loadDensifiedNodeFromSource(
  source: ChunkSource,
  request: LoadDensifiedNodeRequest,
): Promise<{ nodeId: number; payload: PointCloudNodePayload }> {
  const rgbAt = rgbOffset(request.dataset.pointFormat);
  const classAt = classificationOffset(request.dataset.pointFormat);
  const recordLength = request.dataset.pointRecordLength;
  const pointCount = countSourceRangePoints(request.node.sourceRanges);
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 3);
  const intensities = new Float32Array(pointCount);
  const classifications = new Uint8Array(pointCount);
  const returnNumbers = new Uint8Array(pointCount);
  const numberOfReturns = new Uint8Array(pointCount);
  const origin = request.dataset.octree.origin;
  let writeIndex = 0;

  for (const range of request.node.sourceRanges) {
    const startByte = request.dataset.offsetToPointData + range.startIndex * recordLength;
    const endByte = startByte + range.pointCount * recordLength;
    const chunk = await source.read(startByte, endByte);
    const view = new DataView(chunk);
    const pointsInChunk = Math.floor(view.byteLength / recordLength);
    for (let i = 0; i < pointsInChunk; i++) {
      const o = i * recordLength;
      const x = view.getInt32(o, true) * request.dataset.scale[0] + request.dataset.offset[0];
      const y = view.getInt32(o + 4, true) * request.dataset.scale[1] + request.dataset.offset[1];
      const z = view.getInt32(o + 8, true) * request.dataset.scale[2] + request.dataset.offset[2];
      if (!pointInBounds(request.node.bounds, x, y, z)) continue;
      const intensity = view.getUint16(o + 12, true) / 65535;
      const classification = view.getUint8(o + classAt) & (request.dataset.pointFormat >= 6 ? 0xff : 0x1f);
      const { returnNumber, numberOfReturns: numReturns } = readReturns(view, o, request.dataset.pointFormat);
      const r = rgbAt !== null && o + rgbAt + 5 < view.byteLength ? view.getUint16(o + rgbAt, true) >> 8 : 255;
      const g = rgbAt !== null && o + rgbAt + 5 < view.byteLength ? view.getUint16(o + rgbAt + 2, true) >> 8 : 255;
      const b = rgbAt !== null && o + rgbAt + 5 < view.byteLength ? view.getUint16(o + rgbAt + 4, true) >> 8 : 255;
      const base = writeIndex * 3;
      positions[base] = x - origin[0];
      positions[base + 1] = y - origin[1];
      positions[base + 2] = z - origin[2];
      colors[base] = r;
      colors[base + 1] = g;
      colors[base + 2] = b;
      intensities[writeIndex] = intensity;
      classifications[writeIndex] = classification;
      returnNumbers[writeIndex] = returnNumber;
      numberOfReturns[writeIndex] = numReturns;
      writeIndex++;
    }
  }

  return {
    nodeId: request.node.id,
    payload: {
      pointCount: writeIndex,
      positions: writeIndex === pointCount ? positions : positions.slice(0, writeIndex * 3),
      colors: writeIndex === pointCount ? colors : colors.slice(0, writeIndex * 3),
      intensities: writeIndex === pointCount ? intensities : intensities.slice(0, writeIndex),
      classifications: writeIndex === pointCount ? classifications : classifications.slice(0, writeIndex),
      returnNumbers: writeIndex === pointCount ? returnNumbers : returnNumbers.slice(0, writeIndex),
      numberOfReturns: writeIndex === pointCount ? numberOfReturns : numberOfReturns.slice(0, writeIndex),
    },
  };
}

export async function handleLasRequest(
  req: LasWorkerRequest,
  onProgress?: (label: string, pct: number | null) => void,
): Promise<LasWorkerMessage> {
  return (await handleLasSourceRequest({ ...req, source: createPayloadSource(req.payload) }, onProgress)).response;
}

declare const WorkerGlobalScope: unknown;

if (typeof WorkerGlobalScope !== 'undefined') {
  const scope = globalThis as unknown as {
    onmessage: ((e: MessageEvent<LasWorkerRequest>) => void) | null;
    postMessage(msg: LasWorkerMessage, transfer?: Transferable[]): void;
  };
  scope.onmessage = (e: MessageEvent<LasWorkerRequest>) => {
    const { id } = e.data;
    void handleLasSourceRequest(
      { ...e.data, source: createPayloadSource(e.data.payload) },
      (label, pct) => scope.postMessage({ id, type: 'progress', label, pct }),
    ).then(({ response, transfer }) => scope.postMessage(response, transfer));
  };
}
