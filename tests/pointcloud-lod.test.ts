import { describe, expect, it } from 'vitest';

import {
  GeotiffOverviewSampler,
  classLabel,
  defaultFilterState,
  estimateDrawn,
  pointPasses,
  returnRole,
  selectLod,
  terrainColor,
  type NodeScore,
} from '../src/viewer/pointCloudLod';
import { handleLasRequest } from '../src/workers/las.worker';

// ── LOD selection ─────────────────────────────────────────────────────────────
describe('point-cloud LOD selection', () => {
  it('gives the nearest nodes full density (stride 1)', () => {
    const scores: NodeScore[] = [
      { index: 0, distance: 10, sampleCount: 50_000 },
      { index: 1, distance: 500, sampleCount: 50_000 },
      { index: 2, distance: 2000, sampleCount: 50_000 },
    ];
    const lod = selectLod(scores);
    const nearest = lod.find((r) => r.index === 0)!;
    expect(nearest.stride).toBe(1);
  });

  it('thins distant nodes so the drawn total stays within the 2–5M budget', () => {
    // 200 nodes × 50k = 10M raw samples → must be capped.
    const scores: NodeScore[] = Array.from({ length: 200 }, (_, i) => ({
      index: i,
      distance: i * 25,
      sampleCount: 50_000,
    }));
    const lod = selectLod(scores);
    const drawn = estimateDrawn(scores, lod);
    expect(drawn).toBeLessThanOrEqual(5_000_000);
    expect(drawn).toBeGreaterThanOrEqual(2_000_000);
    // distant nodes are strided more coarsely than near ones (stride 0 = dropped entirely,
    // which is coarser than any positive stride — treat it as "infinity" for comparison).
    const near = lod.find((r) => r.index === 0)!;
    const far = lod.find((r) => r.index === 199)!;
    const farEffective = far.stride === 0 ? Infinity : far.stride;
    expect(farEffective).toBeGreaterThanOrEqual(near.stride);
  });

  it('keeps small scenes fully dense (no thinning under budget)', () => {
    const scores: NodeScore[] = [
      { index: 0, distance: 10, sampleCount: 40_000 },
      { index: 1, distance: 20, sampleCount: 40_000 },
    ];
    const lod = selectLod(scores);
    expect(lod.every((r) => r.stride === 1)).toBe(true);
  });
});

// ── classification + returns filtering ────────────────────────────────────────
describe('point-cloud filtering', () => {
  it('drops points whose class is toggled off', () => {
    const filter = defaultFilterState();
    filter.classes[2] = false; // hide ground
    expect(pointPasses(2, 1, 1, filter)).toBe(false);
    expect(pointPasses(1, 1, 1, filter)).toBe(true);
  });

  it('classifies return roles correctly', () => {
    expect(returnRole(1, 3)).toBe('first');
    expect(returnRole(2, 3)).toBe('intermediate');
    expect(returnRole(3, 3)).toBe('last');
    expect(returnRole(1, 1)).toBe('first');
  });

  it('drops points whose return role is toggled off', () => {
    const filter = defaultFilterState();
    filter.returns.last = false;
    expect(pointPasses(1, 3, 3, filter)).toBe(false); // last return hidden
    expect(pointPasses(1, 1, 3, filter)).toBe(true); // first return kept
  });
});

// ── LAS class names ───────────────────────────────────────────────────────────
describe('LAS classification labels', () => {
  it('uses spec names for known classes and falls back otherwise', () => {
    expect(classLabel(1)).toBe('Unclassified');
    expect(classLabel(2)).toBe('Ground');
    expect(classLabel(6)).toBe('Building');
    expect(classLabel(200)).toBe('Class 200');
  });
});

// ── elevation ramp ────────────────────────────────────────────────────────────
describe('terrain elevation ramp', () => {
  it('runs blue → green → yellow → red', () => {
    expect(terrainColor(0)).toEqual([0, 0, 255]);
    expect(terrainColor(1)).toEqual([255, 0, 0]);
    const mid = terrainColor(0.5);
    expect(mid[1]).toBeGreaterThan(100); // greenish-yellow in the middle
  });

  it('clamps out-of-range input', () => {
    expect(terrainColor(-1)).toEqual([0, 0, 255]);
    expect(terrainColor(5)).toEqual([255, 0, 0]);
  });
});

// ── GeoTIFF overview sampler ───────────────────────────────────────────────────
describe('GeoTIFF overview sampler', () => {
  it('samples by world XY and flips V so row 0 is the north edge', () => {
    // 2×2 raster: top row red/green, bottom row blue/white.
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, // row 0 (north)
      0, 0, 255, 255, 255, 255, 255, 255, // row 1 (south)
    ]);
    const sampler = new GeotiffOverviewSampler(2, 2, rgba, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(sampler.sample(1, 9)).toEqual([255, 0, 0]); // NW → red
    expect(sampler.sample(9, 9)).toEqual([0, 255, 0]); // NE → green
    expect(sampler.sample(1, 1)).toEqual([0, 0, 255]); // SW → blue
  });

  it('returns null outside the raster extent', () => {
    const rgba = new Uint8Array([1, 2, 3, 255]);
    const sampler = new GeotiffOverviewSampler(1, 1, rgba, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    expect(sampler.sample(5, 5)).toBeNull();
  });
});

// ── multi-return worker octree (synthetic fixture) ─────────────────────────────
function multiReturnLasHeader(pointCount: number): ArrayBuffer {
  const buffer = new ArrayBuffer(375);
  const view = new DataView(buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, 'LASF');
  view.setUint8(24, 1);
  view.setUint8(25, 4);
  view.setUint16(94, 375, true);
  view.setUint32(96, 375, true);
  view.setUint32(100, 0, true);
  view.setUint8(104, 7); // point format 7
  view.setUint16(105, 36, true); // record length
  view.setBigUint64(247, BigInt(pointCount), true);
  view.setFloat64(131, 1, true); // scale x
  view.setFloat64(139, 1, true);
  view.setFloat64(147, 1, true);
  view.setFloat64(155, 0, true); // offset x
  view.setFloat64(163, 0, true);
  view.setFloat64(171, 0, true);
  view.setFloat64(179, 100, true); // max x
  view.setFloat64(187, 0, true); // min x
  view.setFloat64(195, 100, true); // max y
  view.setFloat64(203, 0, true); // min y
  view.setFloat64(211, 50, true); // max z
  view.setFloat64(219, 0, true); // min z
  return buffer;
}

/** Build N points: format 7, alternating classes 1/2, with multi-return pulses. */
function multiReturnPoints(n: number): ArrayBuffer {
  const buffer = new ArrayBuffer(n * 36);
  const view = new DataView(buffer);
  for (let i = 0; i < n; i++) {
    const o = i * 36;
    view.setInt32(o, (i % 100), true); // x
    view.setInt32(o + 4, ((i * 7) % 100), true); // y
    view.setInt32(o + 8, (i % 50), true); // z
    view.setUint16(o + 12, (i * 13) % 65535, true); // intensity
    // format 7: byte14 low nibble = return number, byte15 low nibble = num returns
    const returnNumber = (i % 3) + 1; // 1,2,3
    const numReturns = 3;
    view.setUint8(o + 14, returnNumber & 0x0f);
    view.setUint8(o + 15, numReturns & 0x0f);
    // Use block-of-4096 alternation so that each sampled index (stride=4096 at depth 0)
    // hits a different class: points 0–4095 → class 1, points 4096–8191 → class 2, etc.
    view.setUint8(o + 16, Math.floor(i / 4096) % 2 === 0 ? 1 : 2); // classification 1 or 2
    view.setUint16(o + 30, 256, true); // r
    view.setUint16(o + 32, 512, true); // g
    view.setUint16(o + 34, 768, true); // b
  }
  return buffer;
}

describe('LAS worker octree — multi-return / multi-class', () => {
  it('captures present classes, returns, and max return count', async () => {
    const header = multiReturnLasHeader(5000);
    const points = multiReturnPoints(5000);
    const payload = new Blob([header, points]);
    const response = await handleLasRequest({ id: 1, fileName: 'multi.las', payload });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const octree = response.dataset.octree!;
    expect(octree).toBeTruthy();
    expect(octree.presentClasses).toEqual([1, 2]);
    expect(octree.maxReturnCount).toBe(3);
    expect(octree.presentReturns.length).toBeGreaterThan(1);
    // Every sampled node carries return + class arrays matching its sample count.
    const checkNode = (node: typeof octree.root): void => {
      expect(node.returnNumbers.length).toBe(node.sampleCount);
      expect(node.numberOfReturns.length).toBe(node.sampleCount);
      expect(node.classifications.length).toBe(node.sampleCount);
      node.children.forEach(checkNode);
    };
    checkNode(octree.root);
  });

  it('reports single-return files with maxReturnCount 1', async () => {
    const header = multiReturnLasHeader(500);
    // single-return points: byte14 = 1, byte15 = 1
    const buffer = new ArrayBuffer(500 * 36);
    const view = new DataView(buffer);
    for (let i = 0; i < 500; i++) {
      const o = i * 36;
      view.setInt32(o, i % 100, true);
      view.setInt32(o + 4, i % 100, true);
      view.setInt32(o + 8, i % 50, true);
      view.setUint8(o + 14, 1);
      view.setUint8(o + 15, 1);
      view.setUint8(o + 16, 2);
    }
    const payload = new Blob([header, buffer]);
    const response = await handleLasRequest({ id: 2, fileName: 'single.las', payload });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.dataset.octree!.maxReturnCount).toBe(1);
  });
});
