import type { PointCloudBounds } from '../contract';

export interface AnalyticSurfelBuffers {
  positions: Float32Array;
  colors: Uint8Array;
  radii: Float32Array;
  normals: Float32Array;
  confidence: Float32Array;
  flags: Uint8Array;
  eigenvalues: Float32Array;
  count: number;
  bounds: PointCloudBounds;
  spacing: number;
  mergeMetrics?: MergeMetrics;
}

export interface DeriveAnalyticSurfelsInput {
  positions: Float32Array;
  colors: Uint8Array;
  pointCount: number;
  bounds: PointCloudBounds;
  cellSize?: number;
  gridOrigin?: [number, number, number];
  spacingEstimate?: number;
  observedPointSpacing?: number;
  minPointsPerSurfel?: number;
}

export interface SurfaceNormalEstimate {
  normal: [number, number, number];
  anisotropy: number;
  planarity: number;
  linearity: number;
  eigenvalues: [number, number, number];
}

export const ANALYTIC_SURFEL_SCREEN_ALIGNED = 1;

export const MERGE_PLANARITY_THRESHOLD = 0.35;
export const SENSOR_NOISE_FLOOR = 0.05;
export const RELATIVE_FLATNESS = 0.015;
export const MIN_MERGE_POINTS = 12;
export const MAX_MERGE_DOUBLINGS = 12;
export const MAX_ACCEPTED_MERGE_DOUBLINGS = 2;
export const RADIUS_FLOOR_SPACING_MULTIPLIER = 10;
const MAX_SPARSE_ACCEPT_DOUBLINGS = 2;

export interface CellAccumulator {
  count: number;
  sumX: number;
  sumY: number;
  sumZ: number;
  sumR: number;
  sumG: number;
  sumB: number;
  sumXX: number;
  sumXY: number;
  sumXZ: number;
  sumYY: number;
  sumYZ: number;
  sumZZ: number;
}

interface CellEntry {
  acc: CellAccumulator;
  cellSize: number;
  radiusCellSize: number;
}

export interface LargestSurfelMetric {
  radius: number;
  center: [number, number, number];
  level: number;
  count: number;
  nodeKey?: string;
}

export interface RadiusPercentiles {
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export interface MergeMetrics {
  levelHistogram: number[];
  screenAlignedFrac: number;
  screenAlignedCount: number;
  emittedCount: number;
  singletonDropped: number;
  rejectionReasons: { occupancy: number; planarity: number; residual: number };
  radiusPercentiles: RadiusPercentiles;
  perLevelMaxRadius: number[];
  largestSurfels: LargestSurfelMetric[];
  clampedRadiusCount: number;
}

export function estimatePointSpacing(bounds: PointCloudBounds, pointCount: number): number {
  if (pointCount <= 1) return 0;
  const dx = Math.max(0, bounds.maxX - bounds.minX);
  const dy = Math.max(0, bounds.maxY - bounds.minY);
  const area = dx * dy;
  if (area > 1e-9) return Math.sqrt(area / pointCount);
  const dz = Math.max(0, bounds.maxZ - bounds.minZ);
  const volume = Math.max(dx * dy * dz, 1e-9);
  return Math.cbrt(volume / pointCount);
}

export function deriveAnalyticSurfels(input: DeriveAnalyticSurfelsInput): AnalyticSurfelBuffers {
  const spacing = Math.max(input.spacingEstimate ?? estimatePointSpacing(input.bounds, input.pointCount), 1e-4);
  const observedPointSpacing = Math.max(input.observedPointSpacing ?? spacing, 1e-4);
  const cellSize = Math.max(input.cellSize ?? spacing * 1.5, 1e-4);
  const minPointsPerSurfel = Math.max(1, input.minPointsPerSurfel ?? 2);
  const gridOrigin = input.gridOrigin ?? [input.bounds.minX, input.bounds.minY, input.bounds.minZ];
  const buckets = new Map<string, CellAccumulator>();

  for (let i = 0; i < input.pointCount; i++) {
    const x = input.positions[i * 3] ?? 0;
    const y = input.positions[i * 3 + 1] ?? 0;
    const z = input.positions[i * 3 + 2] ?? 0;
    const ix = Math.floor((x - gridOrigin[0]) / cellSize);
    const iy = Math.floor((y - gridOrigin[1]) / cellSize);
    const iz = Math.floor((z - gridOrigin[2]) / cellSize);
    const key = `${ix}|${iy}|${iz}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        count: 0,
        sumX: 0,
        sumY: 0,
        sumZ: 0,
        sumR: 0,
        sumG: 0,
        sumB: 0,
        sumXX: 0,
        sumXY: 0,
        sumXZ: 0,
        sumYY: 0,
        sumYZ: 0,
        sumZZ: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.count++;
    bucket.sumX += x;
    bucket.sumY += y;
    bucket.sumZ += z;
    bucket.sumR += input.colors[i * 3] ?? 255;
    bucket.sumG += input.colors[i * 3 + 1] ?? 255;
    bucket.sumB += input.colors[i * 3 + 2] ?? 255;
    bucket.sumXX += x * x;
    bucket.sumXY += x * y;
    bucket.sumXZ += x * z;
    bucket.sumYY += y * y;
    bucket.sumYZ += y * z;
    bucket.sumZZ += z * z;
  }

  const fineCellMap = new Map<string, CellAccumulator>();
  for (const [key, bucket] of buckets) {
    fineCellMap.set(key, bucket);
  }

  const { cells, metrics } = mergeCellsBottomUp(fineCellMap, cellSize, minPointsPerSurfel);

  return emitSurfelsFromCells(cells, input.bounds, spacing, observedPointSpacing, cellSize, metrics);
}

export function mergeAccumulators(children: CellAccumulator[]): CellAccumulator {
  const merged: CellAccumulator = {
    count: 0,
    sumX: 0,
    sumY: 0,
    sumZ: 0,
    sumR: 0,
    sumG: 0,
    sumB: 0,
    sumXX: 0,
    sumXY: 0,
    sumXZ: 0,
    sumYY: 0,
    sumYZ: 0,
    sumZZ: 0,
  };
  for (const child of children) {
    merged.count += child.count;
    merged.sumX += child.sumX;
    merged.sumY += child.sumY;
    merged.sumZ += child.sumZ;
    merged.sumR += child.sumR;
    merged.sumG += child.sumG;
    merged.sumB += child.sumB;
    merged.sumXX += child.sumXX;
    merged.sumXY += child.sumXY;
    merged.sumXZ += child.sumXZ;
    merged.sumYY += child.sumYY;
    merged.sumYZ += child.sumYZ;
    merged.sumZZ += child.sumZZ;
  }
  return merged;
}

export function mergeCellsBottomUp(
  fineCells: Map<string, CellAccumulator>,
  fineCellSize: number,
  minPointsPerSurfel: number,
): { cells: CellEntry[]; metrics: MergeMetrics } {
  let currentLevel = new Map<string, CellEntry>();
  for (const [key, acc] of fineCells) {
    currentLevel.set(key, { acc, cellSize: fineCellSize, radiusCellSize: fineCellSize });
  }

  const terminal: CellEntry[] = [];
  const levelHistogram: number[] = [];
  const rejectionReasons = { occupancy: 0, planarity: 0, residual: 0 };
  let singletonDropped = 0;

  for (let doubling = 0; doubling < MAX_MERGE_DOUBLINGS; doubling++) {
    if (doubling >= MAX_ACCEPTED_MERGE_DOUBLINGS) {
      for (const [, cell] of currentLevel) {
        terminal.push(cell);
      }
      currentLevel = new Map<string, CellEntry>();
      break;
    }

    const parentLevel = new Map<string, CellEntry>();
    const parentGroups = new Map<string, string[]>();

    for (const [key] of currentLevel) {
      const [ix, iy, iz] = key.split('|').map(Number) as [number, number, number];
      const parentKey = `${Math.floor(ix / 2)}|${Math.floor(iy / 2)}|${Math.floor(iz / 2)}`;
      let group = parentGroups.get(parentKey);
      if (!group) {
        group = [];
        parentGroups.set(parentKey, group);
      }
      group.push(key);
    }

    for (const [parentKey, childKeys] of parentGroups) {
      const children: CellEntry[] = [];
      for (const childKey of childKeys) {
        const child = currentLevel.get(childKey);
        if (child) children.push(child);
      }

      if (children.length < 2) {
        rejectionReasons.occupancy++;
        const child = children[0];
        if (child) {
          parentLevel.set(parentKey, {
            acc: child.acc,
            cellSize: child.cellSize * 2,
            radiusCellSize: child.radiusCellSize,
          });
        }
        continue;
      }

      const merged = mergeAccumulators(children.map((c) => c.acc));
      const mergedCellSize = children[0]!.cellSize * 2;
      const inheritedRadiusCellSize = maxRadiusCellSize(children);

      if (merged.count < MIN_MERGE_POINTS) {
        const sparseCell: CellEntry = {
          acc: merged,
          cellSize: mergedCellSize,
          radiusCellSize: inheritedRadiusCellSize,
        };
        if (doubling < MAX_SPARSE_ACCEPT_DOUBLINGS) {
          parentLevel.set(parentKey, sparseCell);
        } else {
          terminal.push(sparseCell);
        }
        continue;
      }

      const cov = covarianceFromAccumulator(merged);
      const normal = estimateSurfaceNormal(cov);
      if (!normal) {
        rejectionReasons.planarity++;
        for (const child of children) terminal.push(child);
        continue;
      }

      if (normal.planarity < MERGE_PLANARITY_THRESHOLD) {
        rejectionReasons.planarity++;
        for (const child of children) terminal.push(child);
        continue;
      }

      const rmsResidual = Math.sqrt(Math.max(normal.eigenvalues[0], 0));
      const residualBudget = Math.max(SENSOR_NOISE_FLOOR, RELATIVE_FLATNESS * mergedCellSize);
      if (rmsResidual > residualBudget) {
        rejectionReasons.residual++;
        for (const child of children) terminal.push(child);
        continue;
      }

      parentLevel.set(parentKey, {
        acc: merged,
        cellSize: mergedCellSize,
        radiusCellSize: mergedCellSize,
      });
    }

    if (parentLevel.size === 0) break;
    currentLevel = parentLevel;
  }

  for (const [, cell] of currentLevel) {
    terminal.push(cell);
  }

  const surviving = terminal.filter((cell) => {
    if (cell.acc.count >= minPointsPerSurfel) return true;
    if (cell.cellSize > fineCellSize) return true;
    singletonDropped++;
    return false;
  });

  for (const cell of surviving) {
    const level = Math.round(Math.log2(cell.cellSize / fineCellSize));
    while (levelHistogram.length <= level) levelHistogram.push(0);
    levelHistogram[level]!++;
  }

  return {
    cells: surviving,
    metrics: {
      levelHistogram,
      screenAlignedFrac: 0,
      screenAlignedCount: 0,
      emittedCount: 0,
      singletonDropped,
      rejectionReasons,
      radiusPercentiles: { p50: 0, p90: 0, p99: 0, max: 0 },
      perLevelMaxRadius: [],
      largestSurfels: [],
      clampedRadiusCount: 0,
    },
  };
}

function emitSurfelsFromCells(
  cells: CellEntry[],
  fallbackBounds: PointCloudBounds,
  spacing: number,
  observedPointSpacing: number,
  fineCellSize: number,
  metrics: MergeMetrics,
): AnalyticSurfelBuffers {
  const count = cells.length;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const radii = new Float32Array(count);
  const normals = new Float32Array(count * 3);
  const confidence = new Float32Array(count);
  const flags = new Uint8Array(count);
  const eigenvalues = new Float32Array(count * 3);
  const outBounds = makeEmptyBounds();
  let screenAlignedCount = 0;
  const emittedRadii: number[] = [];
  const largestSurfels: LargestSurfelMetric[] = [];

  for (let i = 0; i < count; i++) {
    const cell = cells[i]!;
    const bucket = cell.acc;
    const bucketCellSize = cell.cellSize;
    const bucketRadiusCellSize = cell.radiusCellSize;
    const level = Math.round(Math.log2(bucketCellSize / fineCellSize));
    const cx = bucket.sumX / bucket.count;
    const cy = bucket.sumY / bucket.count;
    const cz = bucket.sumZ / bucket.count;
    positions[i * 3] = cx;
    positions[i * 3 + 1] = cy;
    positions[i * 3 + 2] = cz;
    colors[i * 3] = Math.round(bucket.sumR / bucket.count);
    colors[i * 3 + 1] = Math.round(bucket.sumG / bucket.count);
    colors[i * 3 + 2] = Math.round(bucket.sumB / bucket.count);

    const covariance = covarianceFromAccumulator(bucket);
    const normalEstimate = estimateSurfaceNormal(covariance);
    confidence[i] = normalEstimate?.anisotropy ?? 0;
    if (normalEstimate) {
      normals[i * 3] = normalEstimate.normal[0];
      normals[i * 3 + 1] = normalEstimate.normal[1];
      normals[i * 3 + 2] = normalEstimate.normal[2];
      eigenvalues[i * 3] = normalEstimate.eigenvalues[0];
      eigenvalues[i * 3 + 1] = normalEstimate.eigenvalues[1];
      eigenvalues[i * 3 + 2] = normalEstimate.eigenvalues[2];
    } else {
      normals[i * 3] = 0;
      normals[i * 3 + 1] = 0;
      normals[i * 3 + 2] = 1;
      eigenvalues[i * 3] = 0;
      eigenvalues[i * 3 + 1] = 0;
      eigenvalues[i * 3 + 2] = 0;
    }

    const radiusFromVariance = normalEstimate
      ? Math.sqrt(Math.max(normalEstimate.eigenvalues[1], 0) + Math.max(normalEstimate.eigenvalues[2], 0)) * Math.sqrt(0.5) * 1.5
      : 0;
    const floorBasis = Math.min(bucketRadiusCellSize, observedPointSpacing * RADIUS_FLOOR_SPACING_MULTIPLIER);
    radii[i] = Math.max(floorBasis * 0.85, radiusFromVariance, floorBasis * 0.35);
    emittedRadii.push(radii[i]!);

    while (metrics.perLevelMaxRadius.length <= level) metrics.perLevelMaxRadius.push(0);
    metrics.perLevelMaxRadius[level] = Math.max(metrics.perLevelMaxRadius[level] ?? 0, radii[i]!);
    largestSurfels.push({
      radius: radii[i]!,
      center: [cx, cy, cz],
      level,
      count: bucket.count,
    });

    const screenAligned = !normalEstimate || normalEstimate.anisotropy < 0.35;
    if (screenAligned) {
      flags[i] |= ANALYTIC_SURFEL_SCREEN_ALIGNED;
      screenAlignedCount++;
    }

    expandBounds(outBounds, cx, cy, cz);
  }

  metrics.screenAlignedFrac = count > 0 ? screenAlignedCount / count : 0;
  metrics.screenAlignedCount = screenAlignedCount;
  metrics.emittedCount = count;
  emittedRadii.sort((a, b) => a - b);
  metrics.radiusPercentiles = summarizeRadiusPercentiles(emittedRadii);
  largestSurfels.sort((a, b) => b.radius - a.radius);
  metrics.largestSurfels = largestSurfels.slice(0, 10);

  return {
    positions,
    colors,
    radii,
    normals,
    confidence,
    flags,
    eigenvalues,
    count,
    bounds: count > 0 ? outBounds : { ...fallbackBounds },
    spacing,
    mergeMetrics: metrics,
  };
}

function maxRadiusCellSize(children: CellEntry[]): number {
  let maxCellSize = 0;
  for (const child of children) {
    maxCellSize = Math.max(maxCellSize, child.radiusCellSize);
  }
  return maxCellSize;
}

export function estimateSurfaceNormal(covariance: [number, number, number, number, number, number]): SurfaceNormalEstimate | null {
  const matrix = [
    [covariance[0], covariance[1], covariance[2]],
    [covariance[1], covariance[3], covariance[4]],
    [covariance[2], covariance[4], covariance[5]],
  ];
  const { values, vectors } = jacobiEigenDecomposition(matrix);
  const ordered = [0, 1, 2].sort((a, b) => values[a]! - values[b]!);
  const smallest = ordered[0]!;
  const middle = ordered[1]!;
  const largest = ordered[2]!;
  const normal = normalizeVec3([
    vectors[0]![smallest]!,
    vectors[1]![smallest]!,
    vectors[2]![smallest]!,
  ]);
  const lambda1 = Math.max(values[smallest]!, 0);
  const lambda2 = Math.max(values[middle]!, 0);
  const lambda3 = Math.max(values[largest]!, 1e-9);
  const trace = Math.max(lambda1 + lambda2 + lambda3, 1e-9);
  const anisotropy = Math.max(0, Math.min(1, (lambda3 - lambda1) / trace));
  const planarity = Math.max(0, Math.min(1, (lambda2 - lambda1) / lambda3));
  const linearity = Math.max(0, Math.min(1, (lambda3 - lambda2) / lambda3));
  if (!Number.isFinite(normal[0]) || !Number.isFinite(normal[1]) || !Number.isFinite(normal[2])) return null;
  return {
    normal,
    anisotropy,
    planarity,
    linearity,
    eigenvalues: [lambda1, lambda2, lambda3],
  };
}

function summarizeRadiusPercentiles(sorted: number[]): RadiusPercentiles {
  if (sorted.length === 0) return { p50: 0, p90: 0, p99: 0, max: 0 };
  return {
    p50: percentileFromSorted(sorted, 0.5),
    p90: percentileFromSorted(sorted, 0.9),
    p99: percentileFromSorted(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function percentileFromSorted(sorted: number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index] ?? 0;
}

function covarianceFromAccumulator(bucket: CellAccumulator): [number, number, number, number, number, number] {
  const inv = 1 / bucket.count;
  const cx = bucket.sumX * inv;
  const cy = bucket.sumY * inv;
  const cz = bucket.sumZ * inv;
  return [
    bucket.sumXX * inv - cx * cx,
    bucket.sumXY * inv - cx * cy,
    bucket.sumXZ * inv - cx * cz,
    bucket.sumYY * inv - cy * cy,
    bucket.sumYZ * inv - cy * cz,
    bucket.sumZZ * inv - cz * cz,
  ];
}

function jacobiEigenDecomposition(input: number[][]): { values: [number, number, number]; vectors: number[][] } {
  const matrix = input.map((row) => [...row]);
  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 16; iter++) {
    let p = 0;
    let q = 1;
    let max = Math.abs(matrix[0]![1]!);
    if (Math.abs(matrix[0]![2]!) > max) {
      p = 0;
      q = 2;
      max = Math.abs(matrix[0]![2]!);
    }
    if (Math.abs(matrix[1]![2]!) > max) {
      p = 1;
      q = 2;
      max = Math.abs(matrix[1]![2]!);
    }
    if (max < 1e-10) break;

    const app = matrix[p]![p]!;
    const aqq = matrix[q]![q]!;
    const apq = matrix[p]![q]!;
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);

    for (let r = 0; r < 3; r++) {
      const mrp = matrix[r]![p]!;
      const mrq = matrix[r]![q]!;
      matrix[r]![p] = c * mrp - s * mrq;
      matrix[r]![q] = s * mrp + c * mrq;
    }
    for (let r = 0; r < 3; r++) {
      const mpr = matrix[p]![r]!;
      const mqr = matrix[q]![r]!;
      matrix[p]![r] = c * mpr - s * mqr;
      matrix[q]![r] = s * mpr + c * mqr;
    }
    for (let r = 0; r < 3; r++) {
      const vrp = vectors[r]![p]!;
      const vrq = vectors[r]![q]!;
      vectors[r]![p] = c * vrp - s * vrq;
      vectors[r]![q] = s * vrp + c * vrq;
    }
  }

  return {
    values: [matrix[0]![0]!, matrix[1]![1]!, matrix[2]![2]!],
    vectors,
  };
}

function normalizeVec3(vector: [number, number, number]): [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length <= 1e-12) return [0, 0, 1];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function makeEmptyBounds(): PointCloudBounds {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
}

function expandBounds(bounds: PointCloudBounds, x: number, y: number, z: number): void {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.minZ = Math.min(bounds.minZ, z);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
  bounds.maxZ = Math.max(bounds.maxZ, z);
}
