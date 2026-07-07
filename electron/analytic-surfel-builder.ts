import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PointCloudDataset, PointCloudOctreeNode } from '../src/core/contract';
import { deriveAnalyticSurfels, estimatePointSpacing } from '../src/core/pointcloud/analytic-surfels';
import {
  ANALYTIC_SURFEL_BUILDER_VERSION,
  DEFAULT_SURFEL_CELL_SCALE,
  ANALYTIC_SURFEL_GENERATOR_NAME,
  ANALYTIC_SURFEL_TYPE,
  ANALYTIC_SURFEL_VERSION,
} from '../src/shared/analytic-surfels';
import {
  ANALYTIC_SURFEL_COMPLETE_MARKER,
  ANALYTIC_SURFEL_MANIFEST_FILE,
  ANALYTIC_SURFEL_TILES_DIR,
  writeAnalyticSurfelTile,
  type AnalyticSurfelManifest,
  type AnalyticSurfelManifestNode,
} from '../src/shared/analytic-surfel-format';
import { decodeWpiTileFile, type WpiIndexManifest } from './pointcloud-index-builder';
import type { MergeMetrics } from '../src/core/pointcloud/analytic-surfels';

export interface BuildAnalyticSurfelsMetrics {
  surfelCount: number;
  nodeCount: number;
  inputPointCount: number;
  outputSizeBytes: number;
  wallTimeMs: number;
  mergeMetrics?: MergeMetrics;
}

export interface BuildAnalyticSurfelsResult {
  manifest: AnalyticSurfelManifest;
  metrics: BuildAnalyticSurfelsMetrics;
}

interface BuildCommonInput {
  outDir: string;
  sourceAssetId: string;
  indexAssetId: string | null;
  rgbEncoding: 'u16' | 'u8-in-u16' | null;
  surfelCellScale?: number;
  sourceFingerprint: { headerSha256: string; fileSize: number; mtimeMs: number | null };
  onProgress?: (label: string, pct: number | null) => void;
  shouldCancel?: () => boolean;
  yieldTick?: () => Promise<void>;
}

export interface BuildAnalyticSurfelsFromIndexInput extends BuildCommonInput {
  indexDir: string;
  indexManifest: WpiIndexManifest;
  bbox?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null;
  maxPoints?: number | null;
}

export interface BuildAnalyticSurfelsFromPreviewInput extends BuildCommonInput {
  dataset: PointCloudDataset;
}

export class AnalyticSurfelBuildCancelled extends Error {
  constructor() {
    super('Analytic surfel build was cancelled.');
    this.name = 'AnalyticSurfelBuildCancelled';
  }
}

export async function buildAnalyticSurfelsFromIndex(
  input: BuildAnalyticSurfelsFromIndexInput,
): Promise<BuildAnalyticSurfelsResult> {
  const started = Date.now();
  const onProgress = input.onProgress ?? (() => {});
  const shouldCancel = input.shouldCancel ?? (() => false);
  const yieldTick = input.yieldTick ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const tilesDir = path.join(input.outDir, ANALYTIC_SURFEL_TILES_DIR);
  await rm(input.outDir, { recursive: true, force: true });
  await mkdir(tilesDir, { recursive: true });

  let totalSurfels = 0;
  let totalInputPoints = 0;
  let spacingSum = 0;
  const nodes: AnalyticSurfelManifestNode[] = [];
  const surfelCellScale = input.surfelCellScale ?? DEFAULT_SURFEL_CELL_SCALE;
  const globalSpacing = deriveGlobalSpacing(input.indexManifest.bounds, input.indexManifest.source.pointCount);
  const globalCellSize = Math.max(globalSpacing * 1.5 * surfelCellScale, 1e-4);
  const gridOrigin = input.indexManifest.cube.origin;
  let aggregateMergeMetrics: MergeMetrics | undefined;
  const nodesToProcess = input.bbox
    ? input.indexManifest.nodes.filter((node) => boundsIntersect(node.bounds, input.bbox!))
    : input.indexManifest.nodes;
  let remainingPoints = input.maxPoints ?? null;

  for (let i = 0; i < nodesToProcess.length; i++) {
    if (shouldCancel()) throw new AnalyticSurfelBuildCancelled();
    if (remainingPoints !== null && remainingPoints <= 0) break;
    const node = nodesToProcess[i]!;
    const decoded = await decodeWpiTileFile(input.indexDir, node.tile);
    const filtered = filterDecodedNodePoints(decoded, input.indexManifest, input.rgbEncoding, input.bbox ?? null, remainingPoints);
    if (remainingPoints !== null) remainingPoints -= filtered.pointCount;
    if (filtered.pointCount <= 0) continue;
    totalInputPoints += filtered.pointCount;
    const nodeCellSize = nodeLevelCellSize(node.bounds, filtered.pointCount, globalCellSize);
    const observedPointSpacing = deriveObservedPointSpacing(filtered.positions, filtered.pointCount, node.bounds);
    const surfels = deriveAnalyticSurfels({
      positions: filtered.positions,
      colors: filtered.colors,
      pointCount: filtered.pointCount,
      bounds: node.bounds,
      cellSize: nodeCellSize,
      gridOrigin,
      spacingEstimate: globalSpacing,
      observedPointSpacing,
    });
    clampSurfelsToNodeBounds(surfels, node.bounds);
    const tileName = `${node.key}.sftile`;
    await writeAnalyticSurfelTile(tilesDir, tileName, {
      surfelCount: surfels.count,
      positions: surfels.positions,
      colors: surfels.colors,
      radii: surfels.radii,
      normals: surfels.normals,
      confidence: surfels.confidence,
      flags: surfels.flags,
      eigenvalues: surfels.eigenvalues,
    });
    nodes.push({
      key: node.key,
      level: node.level,
      bounds: node.bounds,
      surfelCount: surfels.count,
      childKeys: node.childKeys,
      tile: tileName,
    });
    totalSurfels += surfels.count;
    spacingSum += surfels.spacing;
    if (surfels.mergeMetrics) {
      if (!aggregateMergeMetrics) {
        aggregateMergeMetrics = cloneMergeMetrics(surfels.mergeMetrics);
        aggregateMergeMetrics.largestSurfels = annotateLargestSurfels(aggregateMergeMetrics.largestSurfels, node.key);
      } else {
        const a = aggregateMergeMetrics;
        const m = surfels.mergeMetrics;
        a.singletonDropped += m.singletonDropped;
        a.screenAlignedCount += m.screenAlignedCount;
        a.emittedCount += m.emittedCount;
        a.clampedRadiusCount += m.clampedRadiusCount;
        a.rejectionReasons.occupancy += m.rejectionReasons.occupancy;
        a.rejectionReasons.planarity += m.rejectionReasons.planarity;
        a.rejectionReasons.residual += m.rejectionReasons.residual;
        for (let l = 0; l < m.levelHistogram.length; l++) {
          while (a.levelHistogram.length <= l) a.levelHistogram.push(0);
          a.levelHistogram[l]! += m.levelHistogram[l]!;
        }
        for (let l = 0; l < m.perLevelMaxRadius.length; l++) {
          while (a.perLevelMaxRadius.length <= l) a.perLevelMaxRadius.push(0);
          a.perLevelMaxRadius[l] = Math.max(a.perLevelMaxRadius[l] ?? 0, m.perLevelMaxRadius[l] ?? 0);
        }
        a.radiusPercentiles = mergeRadiusPercentiles(a.radiusPercentiles, m.radiusPercentiles, a.emittedCount, m.emittedCount);
        a.screenAlignedFrac = a.emittedCount > 0 ? a.screenAlignedCount / a.emittedCount : 0;
        a.largestSurfels = mergeLargestSurfels(a.largestSurfels, m.largestSurfels, node.key);
      }
      aggregateMergeMetrics.screenAlignedFrac = aggregateMergeMetrics.emittedCount > 0
        ? aggregateMergeMetrics.screenAlignedCount / aggregateMergeMetrics.emittedCount
        : 0;
    }
    onProgress(
      `deriving surfels from index tiles (${(i + 1).toLocaleString()} / ${nodesToProcess.length.toLocaleString()})...`,
      Math.round(((i + 1) / Math.max(nodesToProcess.length, 1)) * 95),
    );
    await yieldTick();
  }

  const manifest: AnalyticSurfelManifest = {
    surfelVersion: ANALYTIC_SURFEL_VERSION,
    surfelType: ANALYTIC_SURFEL_TYPE,
    generator: { name: ANALYTIC_SURFEL_GENERATOR_NAME, version: ANALYTIC_SURFEL_BUILDER_VERSION },
    generatedAt: new Date().toISOString(),
    surfelCellScale,
    sourceAssetId: input.sourceAssetId,
    indexAssetId: input.indexAssetId,
    source: input.sourceFingerprint,
    bounds: input.indexManifest.bounds,
    spacingEstimate: nodes.length > 0 ? spacingSum / nodes.length : 0,
    totalSurfels,
    root: input.indexManifest.root,
    nodes,
  };

  await writeFile(path.join(input.outDir, ANALYTIC_SURFEL_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(input.outDir, ANALYTIC_SURFEL_COMPLETE_MARKER), 'complete\n', 'utf8');
  onProgress('finalizing analytic surfel artifact...', 100);

  return {
    manifest,
    metrics: {
      surfelCount: totalSurfels,
      nodeCount: nodes.length,
      inputPointCount: totalInputPoints,
      outputSizeBytes: await dirSize(input.outDir),
      wallTimeMs: Date.now() - started,
      mergeMetrics: aggregateMergeMetrics,
    },
  };
}

function filterDecodedNodePoints(
  decoded: Awaited<ReturnType<typeof decodeWpiTileFile>>,
  manifest: WpiIndexManifest,
  rgbEncoding: 'u16' | 'u8-in-u16' | null,
  bbox: BuildAnalyticSurfelsFromIndexInput['bbox'],
  maxPoints: number | null,
): { positions: Float32Array; colors: Uint8Array; pointCount: number } {
  const accepted: number[] = [];
  for (let p = 0; p < decoded.pointCount; p++) {
    if (maxPoints !== null && accepted.length >= maxPoints) break;
    const x = decoded.x[p]! * manifest.scale[0] + manifest.offset[0];
    const y = decoded.y[p]! * manifest.scale[1] + manifest.offset[1];
    const z = decoded.z[p]! * manifest.scale[2] + manifest.offset[2];
    if (bbox && !pointInsideBounds(x, y, z, bbox)) continue;
    accepted.push(p);
  }
  const positions = new Float32Array(accepted.length * 3);
  const colors = new Uint8Array(accepted.length * 3);
  for (let out = 0; out < accepted.length; out++) {
    const p = accepted[out]!;
    positions[out * 3] = decoded.x[p]! * manifest.scale[0] + manifest.offset[0];
    positions[out * 3 + 1] = decoded.y[p]! * manifest.scale[1] + manifest.offset[1];
    positions[out * 3 + 2] = decoded.z[p]! * manifest.scale[2] + manifest.offset[2];
    if (decoded.hasRgb) {
      colors[out * 3] = normalizeRgbChannel(decoded.r![p]!, rgbEncoding);
      colors[out * 3 + 1] = normalizeRgbChannel(decoded.g![p]!, rgbEncoding);
      colors[out * 3 + 2] = normalizeRgbChannel(decoded.b![p]!, rgbEncoding);
    } else {
      colors[out * 3] = 255;
      colors[out * 3 + 1] = 255;
      colors[out * 3 + 2] = 255;
    }
  }
  return { positions, colors, pointCount: accepted.length };
}

function pointInsideBounds(
  x: number,
  y: number,
  z: number,
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
): boolean {
  return x >= bounds.minX && x <= bounds.maxX
    && y >= bounds.minY && y <= bounds.maxY
    && z >= bounds.minZ && z <= bounds.maxZ;
}

function boundsIntersect(
  a: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  b: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX
    && a.minY <= b.maxY && a.maxY >= b.minY
    && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

function cloneMergeMetrics(metrics: MergeMetrics): MergeMetrics {
  return {
    ...metrics,
    levelHistogram: [...metrics.levelHistogram],
    rejectionReasons: { ...metrics.rejectionReasons },
    radiusPercentiles: { ...metrics.radiusPercentiles },
    perLevelMaxRadius: [...metrics.perLevelMaxRadius],
    largestSurfels: [...metrics.largestSurfels],
  };
}

function mergeLargestSurfels(
  existing: MergeMetrics['largestSurfels'],
  incoming: MergeMetrics['largestSurfels'],
  nodeKey: string,
): MergeMetrics['largestSurfels'] {
  return [...existing, ...annotateLargestSurfels(incoming, nodeKey)]
    .sort((a, b) => b.radius - a.radius)
    .slice(0, 10);
}

function annotateLargestSurfels(
  entries: MergeMetrics['largestSurfels'],
  nodeKey: string,
): MergeMetrics['largestSurfels'] {
  return entries.map((entry) => ({ ...entry, nodeKey }));
}

function mergeRadiusPercentiles(
  left: MergeMetrics['radiusPercentiles'],
  right: MergeMetrics['radiusPercentiles'],
  leftCount: number,
  rightCount: number,
): MergeMetrics['radiusPercentiles'] {
  const total = Math.max(leftCount + rightCount, 1);
  return {
    p50: (left.p50 * leftCount + right.p50 * rightCount) / total,
    p90: (left.p90 * leftCount + right.p90 * rightCount) / total,
    p99: (left.p99 * leftCount + right.p99 * rightCount) / total,
    max: Math.max(left.max, right.max),
  };
}

export async function buildAnalyticSurfelsFromPreview(
  input: BuildAnalyticSurfelsFromPreviewInput,
): Promise<BuildAnalyticSurfelsResult> {
  const started = Date.now();
  const onProgress = input.onProgress ?? (() => {});
  const shouldCancel = input.shouldCancel ?? (() => false);
  const yieldTick = input.yieldTick ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  if (!input.dataset.octree) throw new Error('Point cloud preview dataset has no octree.');

  const tilesDir = path.join(input.outDir, ANALYTIC_SURFEL_TILES_DIR);
  await rm(input.outDir, { recursive: true, force: true });
  await mkdir(tilesDir, { recursive: true });

  const previewNodes = flattenPreviewNodes(input.dataset.octree.root);
  const nodes: AnalyticSurfelManifestNode[] = [];
  let totalSurfels = 0;
  let totalInputPoints = 0;
  let spacingSum = 0;
  const surfelCellScale = input.surfelCellScale ?? DEFAULT_SURFEL_CELL_SCALE;
  const globalSpacing = deriveGlobalSpacing(input.dataset.bounds, input.dataset.pointCount);
  const globalCellSize = Math.max(globalSpacing * 1.5 * surfelCellScale, 1e-4);
  const gridOrigin: [number, number, number] = [input.dataset.bounds.minX, input.dataset.bounds.minY, input.dataset.bounds.minZ];

  for (let i = 0; i < previewNodes.length; i++) {
    if (shouldCancel()) throw new AnalyticSurfelBuildCancelled();
    const node = previewNodes[i]!;
    const positions = new Float32Array(node.sampleCount * 3);
    for (let p = 0; p < node.sampleCount; p++) {
      positions[p * 3] = (node.positions[p * 3] ?? 0) + input.dataset.octree.origin[0];
      positions[p * 3 + 1] = (node.positions[p * 3 + 1] ?? 0) + input.dataset.octree.origin[1];
      positions[p * 3 + 2] = (node.positions[p * 3 + 2] ?? 0) + input.dataset.octree.origin[2];
    }
    const nodeCellSize = nodeLevelCellSize(node.bounds, node.sampleCount, globalCellSize);
    const observedPointSpacing = deriveObservedPointSpacing(positions, node.sampleCount, node.bounds);
    const surfels = deriveAnalyticSurfels({
      positions,
      colors: node.colors,
      pointCount: node.sampleCount,
      bounds: node.bounds,
      cellSize: nodeCellSize,
      gridOrigin,
      spacingEstimate: globalSpacing,
      observedPointSpacing,
    });
    clampSurfelsToNodeBounds(surfels, node.bounds);
    const tileName = `${previewKey(node.id)}.sftile`;
    await writeAnalyticSurfelTile(tilesDir, tileName, {
      surfelCount: surfels.count,
      positions: surfels.positions,
      colors: surfels.colors,
      radii: surfels.radii,
      normals: surfels.normals,
      confidence: surfels.confidence,
      flags: surfels.flags,
      eigenvalues: surfels.eigenvalues,
    });
    nodes.push({
      key: previewKey(node.id),
      level: node.depth,
      bounds: node.bounds,
      surfelCount: surfels.count,
      childKeys: node.children.map((child) => previewKey(child.id)),
      tile: tileName,
    });
    totalSurfels += surfels.count;
    totalInputPoints += node.sampleCount;
    spacingSum += surfels.spacing;
    onProgress(
      `deriving surfels from preview octree (${(i + 1).toLocaleString()} / ${previewNodes.length.toLocaleString()})...`,
      Math.round(((i + 1) / Math.max(previewNodes.length, 1)) * 95),
    );
    await yieldTick();
  }

  const manifest: AnalyticSurfelManifest = {
    surfelVersion: ANALYTIC_SURFEL_VERSION,
    surfelType: ANALYTIC_SURFEL_TYPE,
    generator: { name: ANALYTIC_SURFEL_GENERATOR_NAME, version: ANALYTIC_SURFEL_BUILDER_VERSION },
    generatedAt: new Date().toISOString(),
    surfelCellScale,
    sourceAssetId: input.sourceAssetId,
    indexAssetId: null,
    source: input.sourceFingerprint,
    bounds: input.dataset.bounds,
    spacingEstimate: nodes.length > 0 ? spacingSum / nodes.length : 0,
    totalSurfels,
    root: previewKey(input.dataset.octree.root.id),
    nodes,
  };

  await writeFile(path.join(input.outDir, ANALYTIC_SURFEL_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(input.outDir, ANALYTIC_SURFEL_COMPLETE_MARKER), 'complete\n', 'utf8');
  onProgress('finalizing analytic surfel artifact...', 100);

  return {
    manifest,
    metrics: {
      surfelCount: totalSurfels,
      nodeCount: nodes.length,
      inputPointCount: totalInputPoints,
      outputSizeBytes: await dirSize(input.outDir),
      wallTimeMs: Date.now() - started,
    },
  };
}

export async function isAnalyticSurfelComplete(outDir: string): Promise<boolean> {
  try {
    await stat(path.join(outDir, ANALYTIC_SURFEL_COMPLETE_MARKER));
    await stat(path.join(outDir, ANALYTIC_SURFEL_MANIFEST_FILE));
    return true;
  } catch {
    return false;
  }
}

export async function readAnalyticSurfelManifest(outDir: string): Promise<AnalyticSurfelManifest> {
  if (!(await isAnalyticSurfelComplete(outDir))) {
    throw new Error('Analytic surfel artifact is incomplete or corrupt.');
  }
  return JSON.parse(await readFile(path.join(outDir, ANALYTIC_SURFEL_MANIFEST_FILE), 'utf8')) as AnalyticSurfelManifest;
}

function flattenPreviewNodes(root: PointCloudOctreeNode): PointCloudOctreeNode[] {
  const nodes: PointCloudOctreeNode[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes.push(node);
    for (const child of node.children) stack.push(child);
  }
  return nodes;
}

function previewKey(id: number): string {
  return `preview-${id}`;
}

function nodeLevelCellSize(
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  pointCount: number,
  globalCellSize: number,
): number {
  const edge = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
  const fillCellSize = 0.7 * edge / Math.sqrt(Math.max(pointCount, 1));
  const maxCellSize = edge * 0.05;
  return Math.max(globalCellSize, Math.min(fillCellSize, maxCellSize));
}

function deriveGlobalSpacing(
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  pointCount: number,
): number {
  if (pointCount <= 1) return 0;
  const area = Math.max((bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY), 1e-9);
  return Math.sqrt(area / pointCount);
}

function deriveObservedPointSpacing(
  positions: Float32Array,
  pointCount: number,
  fallbackBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
): number {
  if (pointCount <= 1) return 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < pointCount; i++) {
    const x = positions[i * 3] ?? 0;
    const y = positions[i * 3 + 1] ?? 0;
    const z = positions[i * 3 + 2] ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)) {
    return estimatePointSpacing(fallbackBounds, pointCount);
  }

  return estimatePointSpacing({ minX, minY, minZ, maxX, maxY, maxZ }, pointCount);
}

function normalizeRgbChannel(value: number, encoding: 'u16' | 'u8-in-u16' | null): number {
  if (encoding === 'u8-in-u16') return value;
  return value >> 8;
}

function clampSurfelsToNodeBounds(
  surfels: ReturnType<typeof deriveAnalyticSurfels>,
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
): void {
  const nodeEdge = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
  const maxRadius = nodeEdge * 0.5;
  let clamped = 0;
  for (let i = 0; i < surfels.radii.length; i++) {
    if ((surfels.radii[i] ?? 0) <= maxRadius) continue;
    surfels.radii[i] = maxRadius;
    clamped++;
  }
  if (!surfels.mergeMetrics) return;
  surfels.mergeMetrics.clampedRadiusCount += clamped;
  if (clamped <= 0) return;
  surfels.mergeMetrics.radiusPercentiles.max = Math.min(surfels.mergeMetrics.radiusPercentiles.max, maxRadius);
  surfels.mergeMetrics.perLevelMaxRadius = surfels.mergeMetrics.perLevelMaxRadius.map((value) => Math.min(value, maxRadius));
  surfels.mergeMetrics.largestSurfels = surfels.mergeMetrics.largestSurfels.map((entry) => ({
    ...entry,
    radius: Math.min(entry.radius, maxRadius),
  }));
}

async function dirSize(dir: string): Promise<number> {
  const entries = await Promise.all([
    stat(path.join(dir, ANALYTIC_SURFEL_MANIFEST_FILE)).then((s) => s.size),
    stat(path.join(dir, ANALYTIC_SURFEL_COMPLETE_MARKER)).then((s) => s.size),
    readFile(path.join(dir, ANALYTIC_SURFEL_MANIFEST_FILE)),
  ]);
  const tileDir = path.join(dir, ANALYTIC_SURFEL_TILES_DIR);
  const { readdir } = await import('node:fs/promises');
  const tiles = await readdir(tileDir);
  let total = entries[0]! + entries[1]!;
  for (const tile of tiles) {
    total += (await stat(path.join(tileDir, tile))).size;
  }
  return total;
}