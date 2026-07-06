import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PointCloudDataset, PointCloudOctreeNode } from '../src/core/contract';
import { deriveAnalyticSurfels } from '../src/core/pointcloud/analytic-surfels';
import {
  ANALYTIC_SURFEL_BUILDER_VERSION,
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

export interface BuildAnalyticSurfelsMetrics {
  surfelCount: number;
  nodeCount: number;
  outputSizeBytes: number;
  wallTimeMs: number;
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
  let spacingSum = 0;
  const nodes: AnalyticSurfelManifestNode[] = [];
  const globalSpacing = deriveGlobalSpacing(input.indexManifest.bounds, input.indexManifest.source.pointCount);
  const globalCellSize = Math.max(globalSpacing * 1.5 * (input.surfelCellScale ?? 1), 1e-4);
  const gridOrigin = input.indexManifest.cube.origin;

  for (let i = 0; i < input.indexManifest.nodes.length; i++) {
    if (shouldCancel()) throw new AnalyticSurfelBuildCancelled();
    const node = input.indexManifest.nodes[i]!;
    const decoded = await decodeWpiTileFile(input.indexDir, node.tile);
    const positions = new Float32Array(decoded.pointCount * 3);
    const colors = new Uint8Array(decoded.pointCount * 3);
    for (let p = 0; p < decoded.pointCount; p++) {
      positions[p * 3] = decoded.x[p]! * input.indexManifest.scale[0] + input.indexManifest.offset[0];
      positions[p * 3 + 1] = decoded.y[p]! * input.indexManifest.scale[1] + input.indexManifest.offset[1];
      positions[p * 3 + 2] = decoded.z[p]! * input.indexManifest.scale[2] + input.indexManifest.offset[2];
      if (decoded.hasRgb) {
        colors[p * 3] = normalizeRgbChannel(decoded.r![p]!, input.rgbEncoding);
        colors[p * 3 + 1] = normalizeRgbChannel(decoded.g![p]!, input.rgbEncoding);
        colors[p * 3 + 2] = normalizeRgbChannel(decoded.b![p]!, input.rgbEncoding);
      } else {
        colors[p * 3] = 255;
        colors[p * 3 + 1] = 255;
        colors[p * 3 + 2] = 255;
      }
    }
    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: decoded.pointCount,
      bounds: node.bounds,
      cellSize: globalCellSize,
      gridOrigin,
      spacingEstimate: globalSpacing,
    });
    const tileName = `${node.key}.sftile`;
    await writeAnalyticSurfelTile(tilesDir, tileName, {
      surfelCount: surfels.count,
      positions: surfels.positions,
      colors: surfels.colors,
      radii: surfels.radii,
      normals: surfels.normals,
      confidence: surfels.confidence,
      flags: surfels.flags,
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
    onProgress(
      `deriving surfels from index tiles (${(i + 1).toLocaleString()} / ${input.indexManifest.nodes.length.toLocaleString()})...`,
      Math.round(((i + 1) / Math.max(input.indexManifest.nodes.length, 1)) * 95),
    );
    await yieldTick();
  }

  const manifest: AnalyticSurfelManifest = {
    surfelVersion: ANALYTIC_SURFEL_VERSION,
    surfelType: ANALYTIC_SURFEL_TYPE,
    generator: { name: ANALYTIC_SURFEL_GENERATOR_NAME, version: ANALYTIC_SURFEL_BUILDER_VERSION },
    generatedAt: new Date().toISOString(),
    surfelCellScale: input.surfelCellScale ?? 1,
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
      outputSizeBytes: await dirSize(input.outDir),
      wallTimeMs: Date.now() - started,
    },
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
  let spacingSum = 0;
  const globalSpacing = deriveGlobalSpacing(input.dataset.bounds, input.dataset.pointCount);
  const globalCellSize = Math.max(globalSpacing * 1.5 * (input.surfelCellScale ?? 1), 1e-4);
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
    const surfels = deriveAnalyticSurfels({
      positions,
      colors: node.colors,
      pointCount: node.sampleCount,
      bounds: node.bounds,
      cellSize: globalCellSize,
      gridOrigin,
      spacingEstimate: globalSpacing,
    });
    const tileName = `${previewKey(node.id)}.sftile`;
    await writeAnalyticSurfelTile(tilesDir, tileName, {
      surfelCount: surfels.count,
      positions: surfels.positions,
      colors: surfels.colors,
      radii: surfels.radii,
      normals: surfels.normals,
      confidence: surfels.confidence,
      flags: surfels.flags,
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
    surfelCellScale: input.surfelCellScale ?? 1,
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

function deriveGlobalSpacing(
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  pointCount: number,
): number {
  if (pointCount <= 1) return 0;
  const area = Math.max((bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY), 1e-9);
  return Math.sqrt(area / pointCount);
}

function normalizeRgbChannel(value: number, encoding: 'u16' | 'u8-in-u16' | null): number {
  if (encoding === 'u8-in-u16') return value;
  return value >> 8;
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