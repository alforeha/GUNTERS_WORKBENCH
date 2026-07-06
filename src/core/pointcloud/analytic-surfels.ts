import type { PointCloudBounds } from '../contract';

export interface AnalyticSurfelBuffers {
  positions: Float32Array;
  colors: Uint8Array;
  radii: Float32Array;
  normals: Float32Array;
  confidence: Float32Array;
  flags: Uint8Array;
  count: number;
  bounds: PointCloudBounds;
  spacing: number;
}

export interface DeriveAnalyticSurfelsInput {
  positions: Float32Array;
  colors: Uint8Array;
  pointCount: number;
  bounds: PointCloudBounds;
  cellSize?: number;
  gridOrigin?: [number, number, number];
  spacingEstimate?: number;
  minPointsPerSurfel?: number;
}

export interface SurfaceNormalEstimate {
  normal: [number, number, number];
  planarity: number;
  linearity: number;
  eigenvalues: [number, number, number];
}

export const ANALYTIC_SURFEL_SCREEN_ALIGNED = 1;

interface CellAccumulator {
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

  const populatedBuckets = [...buckets.values()];
  const surfels = populatedBuckets.filter((bucket) => bucket.count >= minPointsPerSurfel);
  const surfelBuckets = surfels.length > 0 ? surfels : populatedBuckets;
  const positions = new Float32Array(surfelBuckets.length * 3);
  const colors = new Uint8Array(surfelBuckets.length * 3);
  const radii = new Float32Array(surfelBuckets.length);
  const normals = new Float32Array(surfelBuckets.length * 3);
  const confidence = new Float32Array(surfelBuckets.length);
  const flags = new Uint8Array(surfelBuckets.length);
  const outBounds = makeEmptyBounds();

  for (let i = 0; i < surfelBuckets.length; i++) {
    const bucket = surfelBuckets[i]!;
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
    confidence[i] = normalEstimate?.planarity ?? 0;
    if (normalEstimate) {
      normals[i * 3] = normalEstimate.normal[0];
      normals[i * 3 + 1] = normalEstimate.normal[1];
      normals[i * 3 + 2] = normalEstimate.normal[2];
    } else {
      normals[i * 3] = 0;
      normals[i * 3 + 1] = 0;
      normals[i * 3 + 2] = 1;
      flags[i] |= ANALYTIC_SURFEL_SCREEN_ALIGNED;
    }

    const localSpacing = cellSize / Math.max(Math.sqrt(bucket.count), 1);
    const radiusFromVariance = normalEstimate
      ? Math.sqrt(Math.max(normalEstimate.eigenvalues[1], 0) + Math.max(normalEstimate.eigenvalues[2], 0)) * 0.5
      : 0;
    radii[i] = Math.max(localSpacing * 0.9, radiusFromVariance, cellSize * 0.22);
    if (!normalEstimate || normalEstimate.planarity < 0.35 || normalEstimate.linearity > normalEstimate.planarity) {
      flags[i] |= ANALYTIC_SURFEL_SCREEN_ALIGNED;
    }
    expandBounds(outBounds, cx, cy, cz);
  }

  return {
    positions,
    colors,
    radii,
    normals,
    confidence,
    flags,
    count: surfelBuckets.length,
    bounds: surfelBuckets.length > 0 ? outBounds : { ...input.bounds },
    spacing,
  };
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
  const planarity = Math.max(0, Math.min(1, (lambda2 - lambda1) / lambda3));
  const linearity = Math.max(0, Math.min(1, (lambda3 - lambda2) / lambda3));
  if (!Number.isFinite(normal[0]) || !Number.isFinite(normal[1]) || !Number.isFinite(normal[2])) return null;
  return {
    normal,
    planarity,
    linearity,
    eigenvalues: [lambda1, lambda2, lambda3],
  };
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