import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ANALYTIC_SURFEL_SCREEN_ALIGNED,
  deriveAnalyticSurfels,
  estimatePointSpacing,
  estimateSurfaceNormal,
  mergeAccumulators,
  mergeCellsBottomUp,
  RADIUS_FLOOR_SPACING_MULTIPLIER,
  SENSOR_NOISE_FLOOR,
  RELATIVE_FLATNESS,
  MIN_MERGE_POINTS,
  MAX_ACCEPTED_MERGE_DOUBLINGS,
  type CellAccumulator,
} from '../src/core/pointcloud/analytic-surfels';
import { writeAnalyticSurfelTile, readAnalyticSurfelTile } from '../src/shared/analytic-surfel-format';
import { ANALYTIC_SURFEL_VERSION } from '../src/shared/analytic-surfels';

function fillPointsInCell2D(
  positions: Float32Array,
  colors: Uint8Array,
  offset: number,
  ix: number,
  iy: number,
  iz: number,
  cellSize: number,
  zBase: number,
  zNoise: number,
): number {
  let idx = offset;
  for (let dx = 0; dx < 2; dx++) {
    for (let dy = 0; dy < 2; dy++) {
      positions[idx * 3] = ix * cellSize + (dx + 0.25) * cellSize * 0.5;
      positions[idx * 3 + 1] = iy * cellSize + (dy + 0.25) * cellSize * 0.5;
      positions[idx * 3 + 2] = zBase + (Math.random() - 0.5) * zNoise;
      colors[idx * 3] = 255;
      colors[idx * 3 + 1] = 128;
      colors[idx * 3 + 2] = 64;
      idx++;
    }
  }
  return idx;
}

function makePlanarPoints(
  positions: Float32Array,
  colors: Uint8Array,
  cellSize: number,
  xCount: number,
  yCount: number,
  zBase: number,
  zNoise: number,
  origin: [number, number],
): number {
  let idx = 0;
  const ptsPerDim = 4;
  for (let ix = 0; ix < xCount; ix++) {
    for (let iy = 0; iy < yCount; iy++) {
      const cx = origin[0] + ix * cellSize + cellSize * 0.5;
      const cy = origin[1] + iy * cellSize + cellSize * 0.5;
      const step = cellSize * 0.5 / (ptsPerDim - 1);
      for (let px = 0; px < ptsPerDim; px++) {
        for (let py = 0; py < ptsPerDim; py++) {
          positions[idx * 3] = cx + (px - (ptsPerDim - 1) / 2) * step;
          positions[idx * 3 + 1] = cy + (py - (ptsPerDim - 1) / 2) * step;
          positions[idx * 3 + 2] = zBase + (Math.random() - 0.5) * zNoise;
          colors[idx * 3] = 255;
          colors[idx * 3 + 1] = 128;
          colors[idx * 3 + 2] = 64;
          idx++;
        }
      }
    }
  }
  return idx;
}

describe('analytic surfels', () => {
  it('estimates point spacing from occupied volume', () => {
    const spacing = estimatePointSpacing(
      { minX: 0, minY: 0, minZ: 0, maxX: 8, maxY: 8, maxZ: 8 },
      512,
    );
    expect(spacing).toBeCloseTo(Math.sqrt(64 / 512), 5);
  });

  it('recovers a planar normal from covariance', () => {
    const estimate = estimateSurfaceNormal([1, 0, 0, 1, 0, 0.00001]);
    expect(estimate).not.toBeNull();
    expect(Math.abs(estimate!.normal[2])).toBeGreaterThan(0.99);
    expect(estimate!.planarity).toBeGreaterThan(0.9);
    expect(estimate!.linearity).toBeLessThan(0.1);
  });

  it('aggregates planar patches into surfels with normals', () => {
    const positions = new Float32Array([
      0, 0, 0,
      0.1, 0, 0,
      0, 0.1, 0,
      0.1, 0.1, 0,
      2, 2, 0,
      2.1, 2, 0,
      2, 2.1, 0,
      2.1, 2.1, 0,
    ]);
    const colors = new Uint8Array([
      255, 0, 0, 255, 10, 0, 250, 0, 0, 255, 5, 0,
      0, 255, 0, 0, 250, 0, 10, 255, 0, 0, 255, 10,
    ]);
    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: 8,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2.2, maxY: 2.2, maxZ: 0.1 },
      cellSize: 0.5,
      minPointsPerSurfel: 2,
    });
    expect(surfels.count).toBeGreaterThanOrEqual(1);
    expect(surfels.radii[0]).toBeGreaterThan(0);
  });

  it('keeps global grid phase stable when a shared cell is split by tile bounds', () => {
    const colors = new Uint8Array([255, 255, 255, 255, 255, 255]);
    const left = deriveAnalyticSurfels({
      positions: new Float32Array([0.49, 0, 0, 0.51, 0, 0]),
      colors,
      pointCount: 2,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0.5, maxY: 1, maxZ: 1 },
      cellSize: 1,
      gridOrigin: [0, 0, 0],
      minPointsPerSurfel: 1,
    });
    const right = deriveAnalyticSurfels({
      positions: new Float32Array([0.49, 0, 0, 0.51, 0, 0]),
      colors,
      pointCount: 2,
      bounds: { minX: 0.5, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      cellSize: 1,
      gridOrigin: [0, 0, 0],
      minPointsPerSurfel: 1,
    });
    expect(left.count).toBe(right.count);
    expect(Array.from(left.radii)).toEqual(Array.from(right.radii));
  });

  it('keeps linear clusters world-oriented under the restored anisotropy rule', () => {
    const positions = new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3]);
    const colors = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: 4,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0.1, maxY: 0.1, maxZ: 3 },
      cellSize: 4,
      gridOrigin: [0, 0, 0],
      minPointsPerSurfel: 1,
    });
    expect(surfels.count).toBe(1);
    expect(surfels.flags[0] & ANALYTIC_SURFEL_SCREEN_ALIGNED).toBe(0);
  });

  it('keeps 2-point cells world-oriented when anisotropy is strong', () => {
    const positions = new Float32Array([0, 0, 0, 0, 0, 0]);
    const colors = new Uint8Array([255, 255, 255, 255, 255, 255]);
    const surfels = deriveAnalyticSurfels({
      positions: new Float32Array([0, 0, 0, 0, 0, 1]),
      colors,
      pointCount: 2,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0.1, maxY: 0.1, maxZ: 1 },
      cellSize: 2,
      minPointsPerSurfel: 1,
    });
    expect(surfels.count).toBe(1);
    expect(surfels.flags[0] & ANALYTIC_SURFEL_SCREEN_ALIGNED).toBe(0);
  });

  it('billboards genuinely isotropic blobs', () => {
    const positions = new Float32Array([
      -1, 0, 0,
      1, 0, 0,
      0, -1, 0,
      0, 1, 0,
      0, 0, -1,
      0, 0, 1,
    ]);
    const colors = new Uint8Array(new Array(18).fill(255));
    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: 6,
      bounds: { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 },
      cellSize: 4,
      minPointsPerSurfel: 1,
    });
    expect(surfels.count).toBe(1);
    expect(surfels.flags[0] & ANALYTIC_SURFEL_SCREEN_ALIGNED).toBe(ANALYTIC_SURFEL_SCREEN_ALIGNED);
  });

  it('uses the restored radius coefficients', () => {
    const positions = new Float32Array([
      -1, 0, 0,
      1, 0, 0,
      0, -1, 0,
      0, 1, 0,
    ]);
    const colors = new Uint8Array(new Array(12).fill(255));
    const cellSize = 4;
    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: 4,
      bounds: { minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 0 },
      cellSize,
      minPointsPerSurfel: 1,
    });

    const lambda2 = surfels.eigenvalues[1] ?? 0;
    const lambda3 = surfels.eigenvalues[2] ?? 0;
    const expected = Math.max(
      cellSize * 0.85,
      Math.sqrt(Math.max(lambda2 + lambda3, 0) * 0.5) * 1.5,
      cellSize * 0.35,
    );

    expect(surfels.count).toBe(1);
    expect(surfels.radii[0]).toBeCloseTo(expected, 6);
  });

  it('bounds restored radius floors by observed spacing instead of coarse geometry', () => {
    const positions = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      1, 1, 0,
    ]);
    const colors = new Uint8Array(new Array(12).fill(255));
    const observedPointSpacing = 2;
    const coarseRadiusCellSize = 200;
    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: 4,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 200, maxY: 200, maxZ: 40 },
      cellSize: coarseRadiusCellSize,
      observedPointSpacing,
      minPointsPerSurfel: 1,
    });

    const lambda2 = surfels.eigenvalues[1] ?? 0;
    const lambda3 = surfels.eigenvalues[2] ?? 0;
    const floorBasis = observedPointSpacing * RADIUS_FLOOR_SPACING_MULTIPLIER;
    const expected = Math.max(
      floorBasis * 0.85,
      Math.sqrt(Math.max(lambda2 + lambda3, 0) * 0.5) * 1.5,
      floorBasis * 0.35,
    );

    expect(surfels.count).toBe(1);
    expect(surfels.radii[0]).toBeCloseTo(expected, 6);
    expect(surfels.radii[0]).toBeLessThan(coarseRadiusCellSize * 0.2);
  });
});

describe('surfel merging', () => {
  it('merges a flat plane at arbitrary z into large discs', () => {
    const cellSize = 1;
    const cellsX = 2;
    const cellsY = 2;
    const totalCells = cellsX * cellsY;
    const ptsPerCell = 16;
    const totalPoints = totalCells * ptsPerCell;
    const positions = new Float32Array(totalPoints * 3);
    const colors = new Uint8Array(totalPoints * 3);
    colors.fill(255);
    const zBase = 3.7;

    makePlanarPoints(positions, colors, cellSize, cellsX, cellsY, zBase, 0.001, [0, 0]);

    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: totalPoints,
      bounds: { minX: 0, minY: 0, minZ: zBase - 0.1, maxX: 2, maxY: 2, maxZ: zBase + 0.1 },
      cellSize,
      gridOrigin: [0, 0, zBase - 1],
      minPointsPerSurfel: 2,
    });

    expect(surfels.count).toBe(1);
  });

  it('a curb step halts vertical merging', () => {
    const cellSize = 1;
    const cellsPerDim = 2;
    const totalCells = cellsPerDim * cellsPerDim * cellsPerDim;
    const totalPoints = totalCells * 4;
    const positions = new Float32Array(totalPoints * 3);
    const colors = new Uint8Array(totalPoints * 3);
    colors.fill(255);
    const stepHeight = 0.3;

    let idx = 0;
    for (let ix = 0; ix < cellsPerDim; ix++) {
      for (let iy = 0; iy < cellsPerDim; iy++) {
        for (let iz = 0; iz < cellsPerDim; iz++) {
          const zBase = iz === 0 ? 1 - SENSOR_NOISE_FLOOR * 0.1 : 1 + stepHeight;
          idx = fillPointsInCell2D(positions, colors, idx, ix, iy, iz, cellSize, zBase, SENSOR_NOISE_FLOOR * 0.05);
        }
      }
    }

    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: totalPoints,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 },
      cellSize,
      gridOrigin: [0, 0, 0],
      minPointsPerSurfel: 2,
    });

    expect(surfels.count).toBeGreaterThanOrEqual(2);
  });

  it('a sparse plane with singleton holes still merges', () => {
    const cellSize = 1;
    const cellsX = 2;
    const cellsY = 2;
    const totalCells = cellsX * cellsY;
    const totalPoints = totalCells * 4;
    const positions = new Float32Array(totalPoints * 3);
    const colors = new Uint8Array(totalPoints * 3);
    colors.fill(255);
    const zBase = 0.5;

    const ptsPerCell = 4;
    let idx = 0;
    for (let ix = 0; ix < cellsX; ix++) {
      for (let iy = 0; iy < cellsY; iy++) {
        for (let p = 0; p < ptsPerCell; p++) {
          positions[idx * 3] = ix * cellSize + (0.2 + p * 0.2) * cellSize;
          positions[idx * 3 + 1] = iy * cellSize + (0.2 + p * 0.2) * cellSize;
          positions[idx * 3 + 2] = zBase + (Math.random() - 0.5) * 0.001;
          colors[idx * 3] = 255;
          colors[idx * 3 + 1] = 128;
          colors[idx * 3 + 2] = 64;
          idx++;
        }
      }
    }

    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: totalPoints,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 1 },
      cellSize,
      gridOrigin: [0, 0, 0],
      minPointsPerSurfel: 2,
    });

    expect(surfels.count).toBe(1);
  });

  it('caps flat-plane merges at two doublings by default', () => {
    const cellSize = 1;
    const cellsX = 8;
    const cellsY = 8;
    const totalCells = cellsX * cellsY;
    const ptsPerCell = 16;
    const totalPoints = totalCells * ptsPerCell;
    const positions = new Float32Array(totalPoints * 3);
    const colors = new Uint8Array(totalPoints * 3);
    colors.fill(255);
    const zBase = 4.25;

    makePlanarPoints(positions, colors, cellSize, cellsX, cellsY, zBase, 0.001, [0, 0]);

    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: totalPoints,
      bounds: { minX: 0, minY: 0, minZ: zBase - 0.1, maxX: 8, maxY: 8, maxZ: zBase + 0.1 },
      cellSize,
      gridOrigin: [0, 0, zBase - 1],
      minPointsPerSurfel: 2,
    });

    expect(MAX_ACCEPTED_MERGE_DOUBLINGS).toBe(2);
    expect(surfels.count).toBe(4);
    expect(surfels.mergeMetrics?.levelHistogram[2]).toBe(4);
    expect(surfels.mergeMetrics?.levelHistogram.slice(3).every((count) => count === 0)).toBe(true);
  });

  it('merge accumulators sum second moments exactly', () => {
    const a: CellAccumulator = {
      count: 2, sumX: 1, sumY: 2, sumZ: 3,
      sumR: 100, sumG: 100, sumB: 100,
      sumXX: 4, sumXY: 5, sumXZ: 6,
      sumYY: 7, sumYZ: 8, sumZZ: 9,
    };
    const b: CellAccumulator = {
      count: 3, sumX: 10, sumY: 20, sumZ: 30,
      sumR: 200, sumG: 200, sumB: 200,
      sumXX: 40, sumXY: 50, sumXZ: 60,
      sumYY: 70, sumYZ: 80, sumZZ: 90,
    };
    const merged = mergeAccumulators([a, b]);
    expect(merged.count).toBe(5);
    expect(merged.sumX).toBe(11);
    expect(merged.sumY).toBe(22);
    expect(merged.sumZ).toBe(33);
    expect(merged.sumR).toBe(300);
    expect(merged.sumXX).toBe(44);
    expect(merged.sumXY).toBe(55);
    expect(merged.sumXZ).toBe(66);
    expect(merged.sumYY).toBe(77);
    expect(merged.sumYZ).toBe(88);
    expect(merged.sumZZ).toBe(99);
  });

  it('stops sparse isolated cells after the early provisional doublings', () => {
    const fineCells = new Map<string, CellAccumulator>();
    fineCells.set('0|0|0', {
      count: 4, sumX: 2, sumY: 2, sumZ: 2,
      sumR: 400, sumG: 400, sumB: 400,
      sumXX: 4, sumXY: 4, sumXZ: 4,
      sumYY: 4, sumYZ: 4, sumZZ: 4,
    });
    fineCells.set('10|10|10', {
      count: 4, sumX: 42, sumY: 42, sumZ: 42,
      sumR: 400, sumG: 400, sumB: 400,
      sumXX: 4, sumXY: 4, sumXZ: 4,
      sumYY: 4, sumYZ: 4, sumZZ: 4,
    });

    const farCells = new Map<string, CellAccumulator>();
    farCells.set('0|0|0', {
      count: 4, sumX: 2, sumY: 2, sumZ: 2,
      sumR: 400, sumG: 400, sumB: 400,
      sumXX: 4, sumXY: 4, sumXZ: 4,
      sumYY: 4, sumYZ: 4, sumZZ: 4,
    });

    const merged = mergeCellsBottomUp(fineCells, 1, 2);
    expect(merged.cells.length).toBeGreaterThanOrEqual(1);
    expect(merged.metrics.levelHistogram.length).toBeGreaterThan(0);

    const single = mergeCellsBottomUp(farCells, 1, 2);
    expect(single.cells.length).toBe(1);
  });

  it('reports merge metrics', () => {
    const cellSize = 1;
    const cellsX = 2;
    const cellsY = 2;
    const totalCells = cellsX * cellsY;
    const ptsPerCell = 16;
    const totalPoints = totalCells * ptsPerCell;
    const positions = new Float32Array(totalPoints * 3);
    const colors = new Uint8Array(totalPoints * 3);
    colors.fill(255);

    makePlanarPoints(positions, colors, cellSize, cellsX, cellsY, 0.5, 0.001, [0, 0]);

    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: totalPoints,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 1 },
      cellSize,
      minPointsPerSurfel: 2,
    });

    expect(surfels.mergeMetrics).toBeDefined();
    expect(surfels.mergeMetrics!.levelHistogram.length).toBeGreaterThan(0);
    expect(surfels.mergeMetrics!.singletonDropped).toBeGreaterThanOrEqual(0);
    expect(surfels.mergeMetrics!.rejectionReasons.occupancy).toBeGreaterThanOrEqual(0);
    expect(surfels.mergeMetrics!.rejectionReasons.planarity).toBeGreaterThanOrEqual(0);
    expect(surfels.mergeMetrics!.rejectionReasons.residual).toBeGreaterThanOrEqual(0);
  });

  it('keeps isolated outlier radii near fine-cell scale beside a distant plane', () => {
    const cellSize = 1;
    const planePoints = 64;
    const totalPoints = planePoints + 1;
    const positions = new Float32Array(totalPoints * 3);
    const colors = new Uint8Array(totalPoints * 3);
    colors.fill(255);

    makePlanarPoints(positions, colors, cellSize, 2, 2, 0.25, 0.001, [0, 0]);
    positions[planePoints * 3] = 48;
    positions[planePoints * 3 + 1] = 48;
    positions[planePoints * 3 + 2] = 12;

    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: totalPoints,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 49, maxY: 49, maxZ: 13 },
      cellSize,
      gridOrigin: [0, 0, 0],
      minPointsPerSurfel: 1,
    });

    let isolatedIndex = -1;
    for (let i = 0; i < surfels.count; i++) {
      const x = surfels.positions[i * 3] ?? 0;
      const y = surfels.positions[i * 3 + 1] ?? 0;
      if (Math.abs(x - 48) < 0.01 && Math.abs(y - 48) < 0.01) {
        isolatedIndex = i;
        break;
      }
    }

    expect(isolatedIndex).toBeGreaterThanOrEqual(0);
    expect(surfels.radii[isolatedIndex]).toBeLessThanOrEqual(cellSize * 3);
  });
});

describe('surfel tile format round-trip', () => {
  let tmpDir: string;

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes and reads eigenvalues in v2 format', async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'surfel-rtt-'));

    const surfelCount = 4;
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    const colors = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
    const radii = new Float32Array([0.5, 0.6, 0.7, 0.8]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const confidence = new Float32Array([0.9, 0.8, 0.7, 0.6]);
    const flags = new Uint8Array([0, 1, 0, 1]);
    const eigenvalues = new Float32Array([
      0.01, 0.5, 0.5, 0.02, 0.6, 0.6, 0.03, 0.7, 0.7, 0.04, 0.8, 0.8,
    ]);

    await writeAnalyticSurfelTile(tmpDir, 'test.sftile', {
      surfelCount, positions, colors, radii, normals, confidence, flags, eigenvalues,
    });

    const decoded = await readAnalyticSurfelTile(tmpDir, 'test.sftile');

    expect(decoded.surfelCount).toBe(surfelCount);
    expect(Array.from(decoded.positions)).toEqual(Array.from(positions));
    expect(Array.from(decoded.colors)).toEqual(Array.from(colors));
    expect(Array.from(decoded.radii)).toEqual(Array.from(radii));
    expect(Array.from(decoded.normals)).toEqual(Array.from(normals));
    expect(Array.from(decoded.confidence)).toEqual(Array.from(confidence));
    expect(Array.from(decoded.flags)).toEqual(Array.from(flags));
    expect(decoded.eigenvalues.length).toBe(eigenvalues.length);
    expect(Array.from(decoded.eigenvalues)).toEqual(Array.from(eigenvalues));
  });

  it('reads v1 tiles (no eigenvalues) as empty eigenvalues array', async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'surfel-rtt-'));

    const { gzipSync } = await import('node:zlib');
    const { writeFile } = await import('node:fs/promises');

    const surfelCount = 1;
    const pos = new Float32Array([0, 0, 0]);
    const col = new Uint8Array([255, 255, 255]);
    const rad = new Float32Array([0.5]);
    const nor = new Float32Array([0, 0, 1]);
    const conf = new Float32Array([1]);
    const flg = new Uint8Array([0]);

    const headerBytes = 4;
    const layoutBytes = 6 * 4;
    const sizes = [pos.byteLength, col.byteLength, rad.byteLength, nor.byteLength, conf.byteLength, flg.byteLength];
    const total = headerBytes + layoutBytes + sizes.reduce((a, b) => a + b, 0);
    const buf = Buffer.allocUnsafe(total);
    let off = 0;
    buf.writeUInt32LE(surfelCount, off); off += 4;
    for (const s of sizes) { buf.writeUInt32LE(s, off); off += 4; }
    const arrays: (Float32Array | Uint8Array)[] = [pos, col, rad, nor, conf, flg];
    for (const arr of arrays) {
      Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).copy(buf, off);
      off += arr.byteLength;
    }

    await writeFile(path.join(tmpDir, 'v1-test.sftile'), gzipSync(buf));

    const decoded = await readAnalyticSurfelTile(tmpDir, 'v1-test.sftile');
    expect(decoded.surfelCount).toBe(1);
    expect(decoded.eigenvalues).toBeDefined();
    expect(decoded.eigenvalues.length).toBe(0);
  });
});

describe('surfel version', () => {
  it('is version 2', () => {
    expect(ANALYTIC_SURFEL_VERSION).toBe(2);
  });
});

describe('surfel eigenvalue output', () => {
  it('includes per-surfel eigenvalues in output buffers', () => {
    const positions = new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0.1, 0.1, 0]);
    const colors = new Uint8Array([255, 0, 0, 255, 10, 0, 250, 0, 0, 255, 5, 0]);
    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: 4,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 0.1 },
      cellSize: 0.5,
      minPointsPerSurfel: 2,
    });
    expect(surfels.eigenvalues).toBeInstanceOf(Float32Array);
    expect(surfels.eigenvalues.length).toBe(surfels.count * 3);
    expect(surfels.eigenvalues[0]).toBeGreaterThanOrEqual(0);
    expect(surfels.eigenvalues[1]).toBeGreaterThanOrEqual(0);
    expect(surfels.eigenvalues[2]).toBeGreaterThan(0);
  });
});

describe('per-level cell size law', () => {
  it('coarse node produces larger cells than leaf node', () => {
    const coarsePositions = new Float32Array(100 * 3);
    const coarseColors = new Uint8Array(100 * 3);
    coarseColors.fill(255);
    for (let i = 0; i < 100; i++) {
      coarsePositions[i * 3] = Math.random() * 1000;
      coarsePositions[i * 3 + 1] = Math.random() * 1000;
      coarsePositions[i * 3 + 2] = 0;
    }

    const finePositions = new Float32Array(100 * 3);
    const fineColors = new Uint8Array(100 * 3);
    fineColors.fill(255);
    for (let i = 0; i < 100; i++) {
      finePositions[i * 3] = Math.random();
      finePositions[i * 3 + 1] = Math.random();
      finePositions[i * 3 + 2] = 0;
    }

    const coarse = deriveAnalyticSurfels({
      positions: coarsePositions,
      colors: coarseColors,
      pointCount: 100,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1000, maxY: 1000, maxZ: 1 },
      cellSize: 10,
      minPointsPerSurfel: 2,
    });

    const fine = deriveAnalyticSurfels({
      positions: finePositions,
      colors: fineColors,
      pointCount: 100,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      cellSize: 0.2,
      minPointsPerSurfel: 2,
    });

    const coarseAvgRadius = Array.from(coarse.radii).reduce((a, b) => a + b, 0) / coarse.count;
    const fineAvgRadius = Array.from(fine.radii).reduce((a, b) => a + b, 0) / fine.count;

    expect(coarseAvgRadius).toBeGreaterThan(fineAvgRadius * 2);
  });
});
