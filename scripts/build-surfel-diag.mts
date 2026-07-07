import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectService } from '../electron/project-service.ts';
import { inlineIndexBuild } from '../electron/pointcloud-index-runner.ts';
import type { LargestSurfelMetric } from '../src/core/pointcloud/analytic-surfels.ts';

interface BBox {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

function parseBBox(arg: string): BBox {
  const parts = arg.split(',').map(Number);
  if (parts.length !== 6 || parts.some(isNaN)) {
    throw new Error(`Invalid --bbox: expected minX,minY,minZ,maxX,maxY,maxZ, got "${arg}"`);
  }
  return {
    minX: parts[0]!, minY: parts[1]!, minZ: parts[2]!,
    maxX: parts[3]!, maxY: parts[4]!, maxZ: parts[5]!,
  };
}

function bboxIntersects(a: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }, b: BBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX
    && a.minY <= b.maxY && a.maxY >= b.minY
    && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const lasPath = args.find((arg) => !arg.startsWith('--'));
  const buildIndex = !args.includes('--skip-index');
  const surfelCellScaleArg = args.find((arg) => arg.startsWith('--surfel-cell-scale='));
  const surfelCellScale = surfelCellScaleArg ? Number(surfelCellScaleArg.split('=')[1]) : 1;
  const bboxArg = args.find((arg) => arg.startsWith('--bbox='));
  const maxPointsArg = args.find((arg) => arg.startsWith('--max-points='));
  const jsonArg = args.find((arg) => arg.startsWith('--json='));
  const projectFolderArg = args.find((arg) => arg.startsWith('--project-folder='));
  const assetIdArg = args.find((arg) => arg.startsWith('--asset-id='));
  const bbox = bboxArg ? parseBBox(bboxArg.split('=')[1]!) : null;
  const maxPoints = maxPointsArg ? Number(maxPointsArg.split('=')[1]) : null;
  const jsonPath = jsonArg ? jsonArg.split('=')[1]! : null;
  const projectFolder = projectFolderArg ? projectFolderArg.split('=')[1]! : null;
  const assetId = assetIdArg ? assetIdArg.split('=')[1]! : null;

  if (!lasPath && !projectFolder) {
    console.error('usage: npx tsx scripts/build-surfel-diag.mts <path-to-las> [--skip-index] [--surfel-cell-scale=<number>] [--bbox=minX,minY,minZ,maxX,maxY,maxZ] [--max-points=N] [--json=out.json] [--project-folder=existing-project] [--asset-id=point-cloud-id]');
    process.exitCode = 1;
    return;
  }

  const workRoot = await mkdtemp(path.join(tmpdir(), 'wb-surfel-diag-'));
  const service = new ProjectService({ runIndexBuild: inlineIndexBuild });
  const session = projectFolder
    ? await service.openProject({ projectFolder })
    : await service.createProject({ parentDir: workRoot, projectName: 'surfel-diag' });
  const imported = (!projectFolder && lasPath)
    ? await service.importPointCloud({ filePath: lasPath, importPolicy: 'reference' })
    : session;
  const sourceAsset = assetId
    ? imported.manifest.assets.find((asset) => asset.id === assetId)
    : imported.manifest.assets.find((asset) => asset.kind === 'point-cloud');
  if (!sourceAsset) throw new Error('Failed to import point cloud source.');
  if (sourceAsset.kind !== 'point-cloud') throw new Error(`Asset ${sourceAsset.id} is not a point cloud source.`);

  let indexMetrics: unknown = null;
  if (buildIndex) {
    console.log(`[surfel-diag] building index for ${sourceAsset.name}`);
    const indexed = await service.generatePointCloudIndex({ assetId: sourceAsset.id }, (progress) => {
      const pct = progress.pct === null ? '' : ` ${progress.pct}%`;
      console.log(`[index] ${progress.label}${pct}`);
    });
    indexMetrics = indexed.metrics;
  }

  if (bbox) {
    console.log(`[surfel-diag] cropping to bbox: [${bbox.minX},${bbox.minY},${bbox.minZ}] - [${bbox.maxX},${bbox.maxY},${bbox.maxZ}]`);
  }
  if (maxPoints !== null) {
    console.log(`[surfel-diag] max points: ${maxPoints.toLocaleString()}`);
  }

  console.log(`[surfel-diag] building analytic surfels for ${sourceAsset.name} (cell scale ${surfelCellScale})`);
  const surfels = await service.generateAnalyticSurfels({
    assetId: sourceAsset.id,
    surfelCellScale,
    bbox: bbox ?? undefined,
    maxPoints: maxPoints ?? undefined,
  }, (progress) => {
    const pct = progress.pct === null ? '' : ` ${progress.pct}%`;
    console.log(`[surfels] ${progress.label}${pct}`);
  });

  const hierarchy = await service.loadAnalyticSurfelHierarchy({ assetId: surfels.surfelAssetId });
  const mergeMetrics = surfels.metrics.mergeMetrics;
  const exactDiagnostics = await computeExactRadiusDiagnostics(service, surfels.surfelAssetId, hierarchy);
  const summary: Record<string, unknown> = {
    projectFolder: imported.projectFolder,
    sourceAssetId: sourceAsset.id,
    indexBuilt: buildIndex,
    surfelCellScale,
    bbox: bbox ?? null,
    maxPoints: maxPoints ?? null,
    indexMetrics,
    surfelAssetId: surfels.surfelAssetId,
    inputPointCount: surfels.metrics.inputPointCount,
    surfelCount: surfels.metrics.surfelCount,
    pointsPerSurfelMean: surfels.metrics.surfelCount > 0
      ? surfels.metrics.inputPointCount / surfels.metrics.surfelCount
      : 0,
    nodeCount: surfels.metrics.nodeCount,
    outputSizeBytes: surfels.metrics.outputSizeBytes,
    wallTimeMs: surfels.metrics.wallTimeMs,
  };

  if (mergeMetrics) {
    const mm = mergeMetrics;
    summary.mergeLevelHistogram = mm.levelHistogram;
    summary.screenAlignedPercent = (mm.screenAlignedFrac * 100).toFixed(1) + '%';
    summary.screenAlignedCount = mm.screenAlignedCount;
    summary.emittedCount = mm.emittedCount;
    summary.singletonDropped = mm.singletonDropped;
    summary.rejectionReasons = mm.rejectionReasons;
    summary.radiusPercentiles = exactDiagnostics.radiusPercentiles;
    summary.perLevelMaxRadius = mm.perLevelMaxRadius;
    summary.topLargestSurfels = mm.largestSurfels;
    summary.topLargestSurfelsUniqueByAncestry = dedupeLargestSurfelsByAncestry(mm.largestSurfels, hierarchy);
    summary.clampedRadiusCount = mm.clampedRadiusCount;
    summary.level0Fraction = mm.levelHistogram.length > 0
      ? (mm.levelHistogram[0]! / mm.levelHistogram.reduce((a, b) => a + b, 0) * 100).toFixed(1) + '%'
      : 'N/A';
  }

  console.log('[surfel-diag] summary');
  console.log(JSON.stringify(summary, null, 2));

  if (jsonPath) {
    await writeFile(jsonPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`[surfel-diag] JSON written to ${jsonPath}`);
  }
}

void main().catch((error) => {
  console.error('[surfel-diag] failed');
  console.error(error);
  process.exitCode = 1;
});

async function computeExactRadiusDiagnostics(
  service: ProjectService,
  surfelAssetId: string,
  hierarchy: Awaited<ReturnType<ProjectService['loadAnalyticSurfelHierarchy']>>,
): Promise<{ radiusPercentiles: { p50: number; p90: number; p99: number; max: number } }> {
  const radii = new Float32Array(hierarchy.totalSurfels);
  let cursor = 0;
  const batchSize = 32;

  for (let start = 0; start < hierarchy.nodes.length; start += batchSize) {
    const keys = hierarchy.nodes.slice(start, start + batchSize).map((node) => node.key);
    const { tiles } = await service.loadAnalyticSurfelTiles({ assetId: surfelAssetId, keys });
    for (const { key, payload } of tiles) {
      for (let i = 0; i < payload.surfelCount; i++) {
        const radius = payload.radii[i] ?? 0;
        radii[cursor++] = radius;
      }
    }
  }

  const sorted = Array.from(radii.subarray(0, cursor)).sort((a, b) => a - b);
  return {
    radiusPercentiles: {
      p50: percentileFromSorted(sorted, 0.5),
      p90: percentileFromSorted(sorted, 0.9),
      p99: percentileFromSorted(sorted, 0.99),
      max: sorted[sorted.length - 1] ?? 0,
    },
  };
}

function dedupeLargestSurfelsByAncestry(
  entries: LargestSurfelMetric[],
  hierarchy: Awaited<ReturnType<ProjectService['loadAnalyticSurfelHierarchy']>>,
): LargestSurfelMetric[] {
  const parentByKey = new Map<string, string>();
  for (const node of hierarchy.nodes) {
    for (const childKey of node.childKeys) {
      parentByKey.set(childKey, node.key);
    }
  }

  const unique: LargestSurfelMetric[] = [];
  for (const candidate of [...entries].sort((a, b) => b.radius - a.radius)) {
    if (unique.some((entry) => isAncestryDuplicate(entry, candidate, parentByKey))) continue;
    unique.push(candidate);
  }
  return unique;
}

function isAncestryDuplicate(
  left: LargestSurfelMetric,
  right: LargestSurfelMetric,
  parentByKey: Map<string, string>,
): boolean {
  if (!left.nodeKey || !right.nodeKey) return false;
  if (!nodesShareAncestry(left.nodeKey, right.nodeKey, parentByKey)) return false;
  return centersAreNear(left, right);
}

function nodesShareAncestry(
  leftKey: string,
  rightKey: string,
  parentByKey: Map<string, string>,
): boolean {
  if (leftKey === rightKey) return true;
  return isAncestorKey(leftKey, rightKey, parentByKey) || isAncestorKey(rightKey, leftKey, parentByKey);
}

function isAncestorKey(ancestorKey: string, descendantKey: string, parentByKey: Map<string, string>): boolean {
  let current = parentByKey.get(descendantKey);
  while (current) {
    if (current === ancestorKey) return true;
    current = parentByKey.get(current);
  }
  return false;
}

function centersAreNear(left: LargestSurfelMetric, right: LargestSurfelMetric): boolean {
  const dx = left.center[0] - right.center[0];
  const dy = left.center[1] - right.center[1];
  const dz = left.center[2] - right.center[2];
  const tolerance = Math.max(0.5, Math.min(left.radius, right.radius) * 0.25);
  return (dx * dx + dy * dy + dz * dz) <= tolerance * tolerance;
}

function percentileFromSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index] ?? 0;
}
