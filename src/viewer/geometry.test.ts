// Unit tests for the origin-rebasing path (risk R1) and unique-edge builder (04 §3).
import { describe, expect, it } from 'vitest';
import { buildUniqueEdges, computeBBox, rebasePositions } from './geometry';

describe('computeBBox', () => {
  it('finds min/max/center of an interleaved buffer', () => {
    // prettier-ignore
    const pos = new Float64Array([
      10, 100, 5,
      20, 300, 1,
      30, 200, 9,
    ]);
    const box = computeBBox(pos);
    expect(box.min).toEqual([10, 100, 1]);
    expect(box.max).toEqual([30, 300, 9]);
    expect(box.center).toEqual([20, 200, 5]);
  });

  it('throws on an empty buffer', () => {
    expect(() => computeBBox(new Float64Array(0))).toThrow();
  });
});

describe('rebasePositions (risk R1 — survey-magnitude precision)', () => {
  it('preserves sub-millifoot deltas at survey magnitudes after Float32 narrowing', () => {
    // Two points 0.001 ft apart at E≈3.51M / N≈1.51M — raw Float32 would collapse them
    // (Float32 resolution at 3.5e6 is ~0.25 ft).
    const a = [3_510_094.284, 1_511_101.218, 4_185.801] as const;
    const b = [3_510_094.285, 1_511_101.219, 4_185.802] as const;
    const positions = new Float64Array([...a, ...b]);
    const origin = computeBBox(positions).center;
    const rebased = rebasePositions(positions, origin);

    // Sanity: raw Float32 storage WOULD have destroyed the delta.
    expect(Math.fround(a[0])).toBe(Math.fround(b[0]));

    // Rebased Float32 keeps the points distinct to ~1e-4 ft.
    for (let axis = 0; axis < 3; axis++) {
      const delta = rebased[3 + axis]! - rebased[axis]!;
      expect(delta).toBeGreaterThan(0);
      expect(Math.abs(delta - 0.001)).toBeLessThan(1e-4);
    }
    // And round-trips back to original coordinates within 1e-4 ft.
    for (let i = 0; i < 6; i++) {
      const original = positions[i]!;
      const restored = rebased[i]! + origin[i % 3]!;
      expect(Math.abs(restored - original)).toBeLessThan(1e-4);
    }
  });

  it('values entering the Float32 buffer are small (local), never survey-magnitude', () => {
    const positions = new Float64Array([
      3_510_000, 1_511_000, 4_190, 3_512_500, 1_513_500, 4_300,
    ]);
    const origin = computeBBox(positions).center;
    const rebased = rebasePositions(positions, origin);
    for (const v of rebased) expect(Math.abs(v)).toBeLessThan(10_000);
  });
});

describe('buildUniqueEdges', () => {
  it('deduplicates the shared diagonal of two triangles', () => {
    // Quad split into two tris sharing edge 0-2.
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const edges = buildUniqueEdges(indices, 4);
    expect(edges.length).toBe(10); // 5 unique edges × 2 endpoints
    const pairs = new Set<string>();
    for (let i = 0; i < edges.length; i += 2) pairs.add(`${edges[i]}-${edges[i + 1]}`);
    expect(pairs).toEqual(new Set(['0-1', '0-2', '1-2', '2-3', '0-3']));
  });

  it('matches the closed-form unique edge count for a grid mesh', () => {
    // 3×3 vertex grid → 8 tris; unique edges = horizontal 6 + vertical 6 + diagonals 4 = 16.
    const side = 3;
    const tri: number[] = [];
    for (let r = 0; r < side - 1; r++)
      for (let c = 0; c < side - 1; c++) {
        const a = r * side + c;
        tri.push(a, a + 1, a + side + 1, a, a + side + 1, a + side);
      }
    const edges = buildUniqueEdges(Uint32Array.from(tri), side * side);
    expect(edges.length / 2).toBe(16);
  });
});
