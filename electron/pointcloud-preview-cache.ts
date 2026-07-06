import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  LasAttributeSummary,
  PointCloudBounds,
  PointCloudDataset,
  PointCloudOctree,
  PointCloudOctreeNode,
} from '../src/core/contract';
import type { PointCloudAssetMetadata } from '../src/shared/workbench-types';
import type { LasImportQuality } from '../src/workers/las.worker';

export const PREVIEW_CACHE_SCHEMA_VERSION = 2;

const DESCRIPTOR_FILE = 'descriptor.json';
const POSITIONS_FILE = 'positions.f32.bin';
const COLORS_FILE = 'colors.u8.bin';
const INTENSITIES_FILE = 'intensities.f32.bin';
const CLASSIFICATIONS_FILE = 'classifications.u8.bin';
const RETURN_NUMBERS_FILE = 'returnNumbers.u8.bin';
const NUMBER_OF_RETURNS_FILE = 'numberOfReturns.u8.bin';

interface NumericRange {
  offset: number;
  length: number;
}

interface CachedNodeDescriptor {
  id: number;
  depth: number;
  bounds: PointCloudBounds;
  localBounds: PointCloudBounds;
  pointCount: number;
  sampleCount: number;
  positions: NumericRange;
  colors: NumericRange;
  intensities: NumericRange;
  classifications: NumericRange;
  returnNumbers: NumericRange;
  numberOfReturns: NumericRange;
  sourceRanges?: PointCloudOctreeNode['sourceRanges'];
  children: CachedNodeDescriptor[];
}

interface PreviewCacheDescriptor {
  schemaVersion: number;
  assetId: string;
  generatedAt: string;
  source: {
    fileSize: number;
    mtimeMs: number;
    headerSha256: string;
  };
  sampling: {
    sampledPointCount: number;
    totalPointCount: number;
    attributeSampledPointCount: number;
    qualityTier: LasImportQuality;
    attributeStride: number;
  };
  dataset: Omit<PointCloudDataset, 'octree'> & {
    octree: {
      origin: [number, number, number];
      maxDepth: number;
      targetLeafPointCount: number;
      totalSampledPoints: number;
      presentClasses: number[];
      presentReturns: number[];
      maxReturnCount: number;
      zRange: [number, number];
      root: CachedNodeDescriptor;
    };
  };
}

export interface PreviewCacheWriteInput {
  assetId: string;
  fileSize: number;
  mtimeMs: number;
  headerSha256: string;
  quality: LasImportQuality;
  attributeStride: number;
  dataset: PointCloudDataset;
}

export interface PreviewCacheValidation {
  assetId: string;
  sourceExists: boolean;
  quality: LasImportQuality;
  pointCloud: PointCloudAssetMetadata;
  fileSize?: number;
  mtimeMs?: number;
  headerSha256?: string;
}

export interface LoadedPreviewCache {
  descriptor: PreviewCacheDescriptor;
  dataset: PointCloudDataset;
  cacheDir: string;
}

export type PreviewCacheDescriptorData = PreviewCacheDescriptor;

export interface PreviewCacheValidationResult {
  valid: boolean;
  descriptor: PreviewCacheDescriptor | null;
  reason?: string;
}

function cacheDir(root: string, assetId: string): string {
  return path.join(root, 'cache', assetId);
}

function descriptorPath(root: string, assetId: string): string {
  return path.join(cacheDir(root, assetId), DESCRIPTOR_FILE);
}

function cloneAttributes(attributes: LasAttributeSummary): LasAttributeSummary {
  return {
    hasIntensity: attributes.hasIntensity,
    hasReturns: attributes.hasReturns,
    hasClassification: attributes.hasClassification,
    hasClassificationFlags: attributes.hasClassificationFlags,
    hasUserData: attributes.hasUserData,
    hasScanAngle: attributes.hasScanAngle,
    hasPointSourceId: attributes.hasPointSourceId,
    hasGpsTime: attributes.hasGpsTime,
    hasRgb: attributes.hasRgb,
    rgbEncoding: attributes.rgbEncoding,
    intensityRange: attributes.intensityRange ? [...attributes.intensityRange] as [number, number] : null,
    rgbRange: attributes.rgbRange
      ? [
          [...attributes.rgbRange[0]] as [number, number, number],
          [...attributes.rgbRange[1]] as [number, number, number],
        ]
      : null,
    sampledPoints: attributes.sampledPoints,
    classificationCounts: { ...attributes.classificationCounts },
    returnNumberCounts: { ...attributes.returnNumberCounts },
    numberOfReturnsCounts: { ...attributes.numberOfReturnsCounts },
    userDataCounts: { ...attributes.userDataCounts },
  };
}

function cloneReport<T extends PointCloudDataset['report']>(report: T): T {
  return {
    counts: { ...report.counts },
    triangulationPreserved: report.triangulationPreserved,
    warnings: [...report.warnings],
    infos: [...report.infos],
    unknownElements: { ...report.unknownElements },
    fileLevel: report.fileLevel
      ? {
          warnings: [...report.fileLevel.warnings],
          infos: [...report.fileLevel.infos],
          unknownElements: { ...report.fileLevel.unknownElements },
        }
      : undefined,
  } as T;
}

function ensureOctree(dataset: PointCloudDataset): PointCloudOctree {
  if (!dataset.octree) throw new Error('Point cloud dataset has no octree to cache.');
  return dataset.octree;
}

async function encodeNodeToFiles(
  node: PointCloudOctreeNode,
  files: {
    positions: Awaited<ReturnType<typeof open>>;
    colors: Awaited<ReturnType<typeof open>>;
    intensities: Awaited<ReturnType<typeof open>>;
    classifications: Awaited<ReturnType<typeof open>>;
    returnNumbers: Awaited<ReturnType<typeof open>>;
    numberOfReturns: Awaited<ReturnType<typeof open>>;
  },
  cursor: {
    positions: number;
    colors: number;
    intensities: number;
    classifications: number;
    returnNumbers: number;
    numberOfReturns: number;
  },
): Promise<CachedNodeDescriptor> {
  const positionOffset = cursor.positions;
  await files.positions.write(typedArrayToBuffer(node.positions));
  cursor.positions += node.positions.length;

  const colorOffset = cursor.colors;
  await files.colors.write(typedArrayToBuffer(node.colors));
  cursor.colors += node.colors.length;

  const intensityOffset = cursor.intensities;
  await files.intensities.write(typedArrayToBuffer(node.intensities));
  cursor.intensities += node.intensities.length;

  const classificationOffset = cursor.classifications;
  await files.classifications.write(typedArrayToBuffer(node.classifications));
  cursor.classifications += node.classifications.length;

  const returnNumberOffset = cursor.returnNumbers;
  await files.returnNumbers.write(typedArrayToBuffer(node.returnNumbers));
  cursor.returnNumbers += node.returnNumbers.length;

  const numberOfReturnsOffset = cursor.numberOfReturns;
  await files.numberOfReturns.write(typedArrayToBuffer(node.numberOfReturns));
  cursor.numberOfReturns += node.numberOfReturns.length;

  const children: CachedNodeDescriptor[] = [];
  for (const child of node.children) {
    children.push(await encodeNodeToFiles(child, files, cursor));
  }

  return {
    id: node.id,
    depth: node.depth,
    bounds: { ...node.bounds },
    localBounds: { ...node.localBounds },
    pointCount: node.pointCount,
    sampleCount: node.sampleCount,
    positions: { offset: positionOffset, length: node.positions.length },
    colors: { offset: colorOffset, length: node.colors.length },
    intensities: { offset: intensityOffset, length: node.intensities.length },
    classifications: { offset: classificationOffset, length: node.classifications.length },
    returnNumbers: { offset: returnNumberOffset, length: node.returnNumbers.length },
    numberOfReturns: { offset: numberOfReturnsOffset, length: node.numberOfReturns.length },
    sourceRanges: node.sourceRanges.map((range) => ({ ...range })),
    children,
  };
}

function sliceTyped<T extends Float32Array | Uint8Array>(
  array: T,
  range: NumericRange,
  ctor: { new (buffer: ArrayBuffer, byteOffset: number, length: number): T; BYTES_PER_ELEMENT: number },
): T {
  const bytesPerElement = ctor.BYTES_PER_ELEMENT;
  const byteOffset = range.offset * bytesPerElement;
  const byteLength = range.length * bytesPerElement;
  if (byteOffset < 0 || byteLength < 0 || byteOffset + byteLength > array.byteLength) {
    throw new Error('Preview cache buffer range is out of bounds.');
  }
  const bytes = new Uint8Array(array.buffer, array.byteOffset + byteOffset, byteLength);
  return new ctor(bytes.slice().buffer, 0, range.length);
}

function decodeNode(
  node: CachedNodeDescriptor,
  buffers: {
    positions: Float32Array;
    colors: Uint8Array;
    intensities: Float32Array;
    classifications: Uint8Array;
    returnNumbers: Uint8Array;
    numberOfReturns: Uint8Array;
  },
): PointCloudOctreeNode {
  return {
    id: node.id,
    depth: node.depth,
    bounds: { ...node.bounds },
    localBounds: { ...node.localBounds },
    pointCount: node.pointCount,
    sampleCount: node.sampleCount,
    positions: sliceTyped(buffers.positions, node.positions, Float32Array),
    colors: sliceTyped(buffers.colors, node.colors, Uint8Array),
    intensities: sliceTyped(buffers.intensities, node.intensities, Float32Array),
    classifications: sliceTyped(buffers.classifications, node.classifications, Uint8Array),
    returnNumbers: sliceTyped(buffers.returnNumbers, node.returnNumbers, Uint8Array),
    numberOfReturns: sliceTyped(buffers.numberOfReturns, node.numberOfReturns, Uint8Array),
    sourceRanges: (node.sourceRanges ?? []).map((range) => ({ ...range })),
    children: node.children.map((child) => decodeNode(child, buffers)),
  };
}

function typedArrayToBuffer(array: Float32Array | Uint8Array): Buffer {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer;
}

function assertTypedByteLength(buffer: Buffer, bytesPerElement: number, fileName: string): void {
  if (buffer.byteLength % bytesPerElement !== 0) {
    throw new Error(`Preview cache ${fileName} has an invalid byte length.`);
  }
}

export function previewCacheRelativePath(assetId: string): string {
  return path.posix.join('cache', assetId, DESCRIPTOR_FILE);
}

export async function removePreviewCache(projectFolder: string, assetId: string): Promise<void> {
  await rm(cacheDir(projectFolder, assetId), { recursive: true, force: true });
}

export async function writePreviewCache(projectFolder: string, input: PreviewCacheWriteInput): Promise<string> {
  const octree = ensureOctree(input.dataset);
  const dir = cacheDir(projectFolder, input.assetId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const files = {
    positions: await open(path.join(dir, POSITIONS_FILE), 'w'),
    colors: await open(path.join(dir, COLORS_FILE), 'w'),
    intensities: await open(path.join(dir, INTENSITIES_FILE), 'w'),
    classifications: await open(path.join(dir, CLASSIFICATIONS_FILE), 'w'),
    returnNumbers: await open(path.join(dir, RETURN_NUMBERS_FILE), 'w'),
    numberOfReturns: await open(path.join(dir, NUMBER_OF_RETURNS_FILE), 'w'),
  };
  try {
    const descriptorRoot = await encodeNodeToFiles(octree.root, files, {
      positions: 0,
      colors: 0,
      intensities: 0,
      classifications: 0,
      returnNumbers: 0,
      numberOfReturns: 0,
    });

    const descriptor: PreviewCacheDescriptor = {
      schemaVersion: PREVIEW_CACHE_SCHEMA_VERSION,
      assetId: input.assetId,
      generatedAt: new Date().toISOString(),
      source: {
        fileSize: input.fileSize,
        mtimeMs: input.mtimeMs,
        headerSha256: input.headerSha256,
      },
      sampling: {
        sampledPointCount: octree.totalSampledPoints,
        totalPointCount: input.dataset.pointCount,
        attributeSampledPointCount: input.dataset.attributes.sampledPoints,
        qualityTier: input.quality,
        attributeStride: input.attributeStride,
      },
      dataset: {
        ...input.dataset,
        attributes: cloneAttributes(input.dataset.attributes),
        report: cloneReport(input.dataset.report),
        octree: {
          origin: [...octree.origin] as [number, number, number],
          maxDepth: octree.maxDepth,
          targetLeafPointCount: octree.targetLeafPointCount,
          totalSampledPoints: octree.totalSampledPoints,
          presentClasses: [...octree.presentClasses],
          presentReturns: [...octree.presentReturns],
          maxReturnCount: octree.maxReturnCount,
          zRange: [...octree.zRange] as [number, number],
          root: descriptorRoot,
        },
      },
    };
    await writeFile(path.join(dir, DESCRIPTOR_FILE), `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
  } finally {
    await Promise.all([
      files.positions.close(),
      files.colors.close(),
      files.intensities.close(),
      files.classifications.close(),
      files.returnNumbers.close(),
      files.numberOfReturns.close(),
    ]);
  }
  return dir;
}

export async function validatePreviewCache(
  projectFolder: string,
  input: PreviewCacheValidation,
): Promise<PreviewCacheValidationResult> {
  try {
    const raw = await readFile(descriptorPath(projectFolder, input.assetId), 'utf8');
    const descriptor = JSON.parse(raw) as PreviewCacheDescriptor;
    if (descriptor.schemaVersion !== PREVIEW_CACHE_SCHEMA_VERSION) {
      return { valid: false, descriptor, reason: 'schema-version-mismatch' };
    }
    if (descriptor.assetId !== input.assetId) {
      return { valid: false, descriptor, reason: 'asset-id-mismatch' };
    }
    if (descriptor.dataset.pointCount !== input.pointCloud.pointCount) {
      return { valid: false, descriptor, reason: 'point-count-mismatch' };
    }
    if (descriptor.source.headerSha256 !== input.pointCloud.headerSha256) {
      return { valid: false, descriptor, reason: 'header-sha-mismatch' };
    }
    if (descriptor.sampling.qualityTier !== input.quality) {
      return { valid: false, descriptor, reason: 'quality-mismatch' };
    }
    if (input.sourceExists) {
      if (descriptor.source.fileSize !== input.fileSize) {
        return { valid: false, descriptor, reason: 'file-size-mismatch' };
      }
      if (descriptor.source.mtimeMs !== input.mtimeMs) {
        return { valid: false, descriptor, reason: 'file-mtime-mismatch' };
      }
      if (descriptor.source.headerSha256 !== input.headerSha256) {
        return { valid: false, descriptor, reason: 'source-header-mismatch' };
      }
    }
    return { valid: true, descriptor };
  } catch (error) {
    return {
      valid: false,
      descriptor: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readPreviewCache(projectFolder: string, assetId: string): Promise<LoadedPreviewCache> {
  const dir = cacheDir(projectFolder, assetId);
  const descriptor = await readPreviewCacheDescriptor(projectFolder, assetId);

  const [
    positionsBuffer,
    colorsBuffer,
    intensitiesBuffer,
    classificationsBuffer,
    returnNumbersBuffer,
    numberOfReturnsBuffer,
  ] = await Promise.all([
    readFile(path.join(dir, POSITIONS_FILE)),
    readFile(path.join(dir, COLORS_FILE)),
    readFile(path.join(dir, INTENSITIES_FILE)),
    readFile(path.join(dir, CLASSIFICATIONS_FILE)),
    readFile(path.join(dir, RETURN_NUMBERS_FILE)),
    readFile(path.join(dir, NUMBER_OF_RETURNS_FILE)),
  ]);

  assertTypedByteLength(positionsBuffer, Float32Array.BYTES_PER_ELEMENT, POSITIONS_FILE);
  assertTypedByteLength(intensitiesBuffer, Float32Array.BYTES_PER_ELEMENT, INTENSITIES_FILE);

  const buffers = {
    positions: new Float32Array(bufferToArrayBuffer(positionsBuffer)),
    colors: new Uint8Array(bufferToArrayBuffer(colorsBuffer)),
    intensities: new Float32Array(bufferToArrayBuffer(intensitiesBuffer)),
    classifications: new Uint8Array(bufferToArrayBuffer(classificationsBuffer)),
    returnNumbers: new Uint8Array(bufferToArrayBuffer(returnNumbersBuffer)),
    numberOfReturns: new Uint8Array(bufferToArrayBuffer(numberOfReturnsBuffer)),
  };

  const dataset: PointCloudDataset = {
    ...descriptor.dataset,
    attributes: cloneAttributes(descriptor.dataset.attributes),
    report: cloneReport(descriptor.dataset.report),
    octree: {
      origin: [...descriptor.dataset.octree.origin] as [number, number, number],
      maxDepth: descriptor.dataset.octree.maxDepth,
      targetLeafPointCount: descriptor.dataset.octree.targetLeafPointCount,
      totalSampledPoints: descriptor.dataset.octree.totalSampledPoints,
      presentClasses: [...descriptor.dataset.octree.presentClasses],
      presentReturns: [...descriptor.dataset.octree.presentReturns],
      maxReturnCount: descriptor.dataset.octree.maxReturnCount,
      zRange: [...descriptor.dataset.octree.zRange] as [number, number],
      root: decodeNode(descriptor.dataset.octree.root, buffers),
    },
  };

  return { descriptor, dataset, cacheDir: dir };
}

export async function readPreviewCacheDescriptor(projectFolder: string, assetId: string): Promise<PreviewCacheDescriptor> {
  const raw = await readFile(descriptorPath(projectFolder, assetId), 'utf8');
  return JSON.parse(raw) as PreviewCacheDescriptor;
}
