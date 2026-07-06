import { describe, expect, it } from 'vitest';
import {
  ANALYTIC_SURFEL_SCREEN_ALIGNED,
  deriveAnalyticSurfels,
  estimatePointSpacing,
  estimateSurfaceNormal,
} from '../src/core/pointcloud/analytic-surfels';

describe('analytic surfels', () => {
  it('estimates point spacing from occupied volume', () => {
    const spacing = estimatePointSpacing(
      {
        minX: 0,
        minY: 0,
        minZ: 0,
        maxX: 8,
        maxY: 8,
        maxZ: 8,
      },
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

  it('aggregates nearby points into surfels with normals', () => {
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
      255, 0, 0,
      255, 10, 0,
      250, 0, 0,
      255, 5, 0,
      0, 255, 0,
      0, 250, 0,
      10, 255, 0,
      0, 255, 10,
    ]);
    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: 8,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2.2, maxY: 2.2, maxZ: 0.1 },
      cellSize: 0.5,
      minPointsPerSurfel: 2,
    });
    expect(surfels.count).toBe(2);
    expect(surfels.radii[0]).toBeGreaterThan(0);
    expect(Math.abs(surfels.normals[2])).toBeGreaterThan(0.99);
    expect(surfels.confidence[0]).toBeGreaterThan(0.2);
    expect(surfels.flags[0] & ANALYTIC_SURFEL_SCREEN_ALIGNED).toBe(0);
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

  it('routes linear clusters to the screen-aligned path', () => {
    const positions = new Float32Array([
      0, 0, 0,
      0, 0, 1,
      0, 0, 2,
      0, 0, 3,
    ]);
    const colors = new Uint8Array([
      255, 255, 255,
      255, 255, 255,
      255, 255, 255,
      255, 255, 255,
    ]);
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
    expect(surfels.flags[0] & ANALYTIC_SURFEL_SCREEN_ALIGNED).toBe(ANALYTIC_SURFEL_SCREEN_ALIGNED);
  });

  it('marks weak neighborhoods as screen aligned', () => {
    const positions = new Float32Array([
      0, 0, 0,
      0, 0, 0,
    ]);
    const colors = new Uint8Array([
      255, 255, 255,
      255, 255, 255,
    ]);
    const surfels = deriveAnalyticSurfels({
      positions,
      colors,
      pointCount: 2,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0.01, maxY: 0.01, maxZ: 0.01 },
      cellSize: 0.1,
      minPointsPerSurfel: 1,
    });
    expect(surfels.count).toBe(1);
    expect(surfels.flags[0] & ANALYTIC_SURFEL_SCREEN_ALIGNED).toBe(ANALYTIC_SURFEL_SCREEN_ALIGNED);
  });
});