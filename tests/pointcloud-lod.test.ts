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
import { appendMergedSourceRange, computeStride, handleLasRequest, readReturns } from '../src/workers/las.worker';

function returnByteView(byte: number): DataView {
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);
  view.setUint8(14, byte);
  return view;
}

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

  it('thins distant nodes so the drawn total stays within the 2-5M budget', () => {
    const scores: NodeScore[] = Array.from({ length: 200 }, (_, i) => ({
      index: i,
      distance: i * 25,
      sampleCount: 50_000,
    }));
    const lod = selectLod(scores);
    const drawn = estimateDrawn(scores, lod);
    expect(drawn).toBeLessThanOrEqual(5_000_000);
    expect(drawn).toBeGreaterThanOrEqual(2_000_000);
    const near = lod.find((r) => r.index === 0)!;
    const far = lod.find((r) => r.index === 199)!;
    expect(far.stride).toBeGreaterThanOrEqual(near.stride);
  });

  it('keeps small scenes fully dense (no thinning under budget)', () => {
    const scores: NodeScore[] = [
      { index: 0, distance: 10, sampleCount: 40_000 },
      { index: 1, distance: 20, sampleCount: 40_000 },
    ];
    const lod = selectLod(scores);
    expect(lod.every((r) => r.stride === 1)).toBe(true);
  });

  it('keeps every frustum-visible node represented when the budget is exhausted', () => {
    const scores: NodeScore[] = Array.from({ length: 160 }, (_, i) => ({
      index: i,
      distance: i * 50,
      sampleCount: 50_000,
    }));
    const lod = selectLod(scores);
    expect(lod.every((r) => r.stride >= 1)).toBe(true);
    expect(lod.some((r) => r.stride === 8)).toBe(true);
  });

  it('prefers budget overflow to coverage holes when even the coarsest tier is too dense', () => {
    const scores: NodeScore[] = Array.from({ length: 12 }, (_, i) => ({
      index: i,
      distance: i * 100,
      sampleCount: 4_500_000,
    }));
    const lod = selectLod(scores);
    const drawn = estimateDrawn(scores, lod);
    expect(lod.every((r) => r.stride >= 1)).toBe(true);
    expect(drawn).toBeGreaterThan(5_000_000);
  });
});

describe('point-cloud stride sampling', () => {
  it('computes a stride that spans the full file within budget', () => {
    expect(computeStride(0, 1_000_000)).toBe(1);
    expect(computeStride(999_999, 1_000_000)).toBe(1);
    expect(computeStride(1_000_001, 1_000_000)).toBe(2);
    expect(computeStride(381_812_261, 1_000_000)).toBe(382);
  });
});

describe('point-cloud filtering', () => {
  it('drops points whose class is toggled off', () => {
    const filter = defaultFilterState();
    filter.classes[2] = false;
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
    expect(pointPasses(1, 3, 3, filter)).toBe(false);
    expect(pointPasses(1, 1, 3, filter)).toBe(true);
  });
});

describe('readReturns nibble decoding', () => {
  it('splits byte 14 into 3-bit fields for legacy formats (PDRF < 6)', () => {
    // return number 2 (bits 0-2), number of returns 5 (bits 3-5)
    const byte = (2 & 0x07) | ((5 & 0x07) << 3);
    expect(readReturns(returnByteView(byte), 0, 1)).toEqual({ returnNumber: 2, numberOfReturns: 5 });
    expect(readReturns(returnByteView(0x09), 0, 3)).toEqual({ returnNumber: 1, numberOfReturns: 1 });
  });

  it('splits byte 14 into 4-bit fields for PDRF >= 6 (both nibbles in byte 14, not byte 15)', () => {
    // return number 3 (bits 0-3), number of returns 5 (bits 4-7)
    const byte = (3 & 0x0f) | ((5 & 0x0f) << 4);
    expect(readReturns(returnByteView(byte), 0, 7)).toEqual({ returnNumber: 3, numberOfReturns: 5 });
    expect(readReturns(returnByteView(0x11), 0, 6)).toEqual({ returnNumber: 1, numberOfReturns: 1 });
    expect(readReturns(returnByteView(0xf7), 0, 8)).toEqual({ returnNumber: 7, numberOfReturns: 15 });
  });

  it('ignores byte 15 for PDRF >= 6', () => {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    view.setUint8(14, 0x21); // rn 1, nr 2
    view.setUint8(15, 0xff); // classification flags — must not leak into returns
    expect(readReturns(view, 0, 7)).toEqual({ returnNumber: 1, numberOfReturns: 2 });
  });
});

describe('LAS classification labels', () => {
  it('uses spec names for known classes and falls back otherwise', () => {
    expect(classLabel(1)).toBe('Unclassified');
    expect(classLabel(2)).toBe('Ground');
    expect(classLabel(6)).toBe('Building');
    expect(classLabel(200)).toBe('Class 200');
  });
});

describe('terrain elevation ramp', () => {
  it('runs blue -> green -> yellow -> red', () => {
    expect(terrainColor(0)).toEqual([0, 0, 255]);
    expect(terrainColor(1)).toEqual([255, 0, 0]);
    const mid = terrainColor(0.5);
    expect(mid[1]).toBeGreaterThan(100);
  });

  it('clamps out-of-range input', () => {
    expect(terrainColor(-1)).toEqual([0, 0, 255]);
    expect(terrainColor(5)).toEqual([255, 0, 0]);
  });
});

describe('GeoTIFF overview sampler', () => {
  it('samples by world XY and flips V so row 0 is the north edge', () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const sampler = new GeotiffOverviewSampler(2, 2, rgba, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(sampler.sample(1, 9)).toEqual([255, 0, 0]);
    expect(sampler.sample(9, 9)).toEqual([0, 255, 0]);
    expect(sampler.sample(1, 1)).toEqual([0, 0, 255]);
  });

  it('returns null outside the raster extent', () => {
    const rgba = new Uint8Array([1, 2, 3, 255]);
    const sampler = new GeotiffOverviewSampler(1, 1, rgba, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    expect(sampler.sample(5, 5)).toBeNull();
  });
});

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
  view.setUint8(104, 7);
  view.setUint16(105, 36, true);
  view.setBigUint64(247, BigInt(pointCount), true);
  view.setFloat64(131, 1, true);
  view.setFloat64(139, 1, true);
  view.setFloat64(147, 1, true);
  view.setFloat64(155, 0, true);
  view.setFloat64(163, 0, true);
  view.setFloat64(171, 0, true);
  view.setFloat64(179, 100, true);
  view.setFloat64(187, 0, true);
  view.setFloat64(195, 100, true);
  view.setFloat64(203, 0, true);
  view.setFloat64(211, 50, true);
  view.setFloat64(219, 0, true);
  return buffer;
}

function multiReturnPoints(n: number): ArrayBuffer {
  const buffer = new ArrayBuffer(n * 36);
  const view = new DataView(buffer);
  for (let i = 0; i < n; i++) {
    const o = i * 36;
    view.setInt32(o, i % 100, true);
    view.setInt32(o + 4, (i * 7) % 100, true);
    view.setInt32(o + 8, i % 50, true);
    view.setUint16(o + 12, (i * 13) % 65535, true);
    const returnNumber = (i % 3) + 1;
    const numReturns = 3;
    // PDRF 7: return number in byte 14 bits 0-3, number of returns in bits 4-7.
    view.setUint8(o + 14, (returnNumber & 0x0f) | ((numReturns & 0x0f) << 4));
    view.setUint8(o + 16, Math.floor(i / 4096) % 2 === 0 ? 1 : 2);
    view.setUint16(o + 30, 256, true);
    view.setUint16(o + 32, 512, true);
    view.setUint16(o + 34, 768, true);
  }
  return buffer;
}

describe('LAS worker octree - multi-return / multi-class', () => {
  it('captures present classes, returns, and max return count', async () => {
    const ranges: { startIndex: number; pointCount: number }[] = [];
    appendMergedSourceRange(ranges, 10);
    appendMergedSourceRange(ranges, 11);
    appendMergedSourceRange(ranges, 15);
    appendMergedSourceRange(ranges, 16);
    appendMergedSourceRange(ranges, 20);
    expect(ranges).toEqual([
      { startIndex: 10, pointCount: 2 },
      { startIndex: 15, pointCount: 2 },
      { startIndex: 20, pointCount: 1 },
    ]);

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
    const checkNode = (node: typeof octree.root): void => {
      expect(node.returnNumbers.length).toBe(node.sampleCount);
      expect(node.numberOfReturns.length).toBe(node.sampleCount);
      expect(node.classifications.length).toBe(node.sampleCount);
      expect(node.sourceRanges.every((range, index) => index === 0 || node.sourceRanges[index - 1]!.startIndex + node.sourceRanges[index - 1]!.pointCount < range.startIndex)).toBe(true);
      node.children.forEach(checkNode);
    };
    checkNode(octree.root);
  });

  it('reports single-return files with maxReturnCount 1', async () => {
    const header = multiReturnLasHeader(500);
    const buffer = new ArrayBuffer(500 * 36);
    const view = new DataView(buffer);
    for (let i = 0; i < 500; i++) {
      const o = i * 36;
      view.setInt32(o, i % 100, true);
      view.setInt32(o + 4, i % 100, true);
      view.setInt32(o + 8, i % 50, true);
      // PDRF 7 single return: return number 1 (bits 0-3), number of returns 1 (bits 4-7).
      view.setUint8(o + 14, 0x11);
      view.setUint8(o + 16, 2);
    }
    const payload = new Blob([header, buffer]);
    const response = await handleLasRequest({ id: 2, fileName: 'single.las', payload });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.dataset.octree!.maxReturnCount).toBe(1);
  });
});
