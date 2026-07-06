import { describe, expect, it } from 'vitest';
import {
  boxDistance,
  formatIndexedFullDisclosure,
  isSettled,
  nodeGeometricError,
  planEviction,
  projScaleFromPerspective,
  screenSpaceError,
  selectStreamingNodes,
  staleRequestKeys,
  type StreamNode,
} from '../src/viewer/pointCloudStreaming';

// A 3-level chain octree: root(0..8) → child(0..4) → grandchild(0..2), 100 pts each.
function chainHierarchy(): Map<string, StreamNode> {
  const nodes: StreamNode[] = [
    { key: '0-0-0-0', level: 0, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 8, maxY: 8, maxZ: 8 }, pointCount: 100, childKeys: ['1-0-0-0'] },
    { key: '1-0-0-0', level: 1, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 4, maxZ: 4 }, pointCount: 100, childKeys: ['2-0-0-0'] },
    { key: '2-0-0-0', level: 2, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 }, pointCount: 100, childKeys: [] },
  ];
  return new Map(nodes.map((n) => [n.key, n]));
}

const NEAR = { position: [4, 4, 20] as [number, number, number], projScale: 1000 };
const FAR = { position: [4, 4, 5000] as [number, number, number], projScale: 1000 };

describe('SSE math', () => {
  it('distance is zero inside the box and positive outside', () => {
    const b = { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 };
    expect(boxDistance(b, [5, 5, 5])).toBe(0);
    expect(boxDistance(b, [5, 5, 20])).toBe(10);
  });

  it('geometric error is the cube diagonal', () => {
    expect(nodeGeometricError({ minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 })).toBeCloseTo(Math.sqrt(12), 5);
  });

  it('screen-space error falls with distance and is infinite at zero distance', () => {
    expect(screenSpaceError(10, 100, 1000)).toBeCloseTo(100, 5);
    expect(screenSpaceError(10, 10, 1000)).toBeGreaterThan(screenSpaceError(10, 100, 1000));
    expect(screenSpaceError(10, 0, 1000)).toBe(Infinity);
  });

  it('derives projScale from viewport height and vertical fov', () => {
    expect(projScaleFromPerspective(1080, Math.PI / 3)).toBeCloseTo(1080 / (2 * Math.tan(Math.PI / 6)), 5);
  });
});

describe('selectStreamingNodes', () => {
  it('selects only the root when the view is far (low SSE)', () => {
    const sel = selectStreamingNodes(chainHierarchy(), '0-0-0-0', FAR, { sseThreshold: 16, budgetMax: 5_000_000 });
    expect(sel.keys).toEqual(new Set(['0-0-0-0']));
    expect(sel.budgetLimited).toBe(false);
  });

  it('refines deeper as the camera approaches', () => {
    const near = selectStreamingNodes(chainHierarchy(), '0-0-0-0', NEAR, { sseThreshold: 300, budgetMax: 5_000_000 });
    const far = selectStreamingNodes(chainHierarchy(), '0-0-0-0', FAR, { sseThreshold: 300, budgetMax: 5_000_000 });
    expect(near.keys.size).toBeGreaterThan(far.keys.size);
    expect(near.keys.has('0-0-0-0')).toBe(true);
  });

  it('returns nodes in most-erroneous-first (root-first) fetch order', () => {
    const sel = selectStreamingNodes(chainHierarchy(), '0-0-0-0', NEAR, { sseThreshold: 50, budgetMax: 5_000_000 });
    expect(sel.nodes[0]!.key).toBe('0-0-0-0');
    for (let i = 1; i < sel.nodes.length; i++) {
      expect(sel.nodes[i - 1]!.sse).toBeGreaterThanOrEqual(sel.nodes[i]!.sse);
    }
  });

  it('respects the budget and reports when it limits refinement', () => {
    const sel = selectStreamingNodes(chainHierarchy(), '0-0-0-0', NEAR, { sseThreshold: 1, budgetMax: 150 });
    expect(sel.estimatedPoints).toBeLessThanOrEqual(150);
    expect(sel.keys.has('0-0-0-0')).toBe(true); // coarse coverage always kept
    expect(sel.budgetLimited).toBe(true);
  });

  it('returns nothing for an unknown root key', () => {
    const sel = selectStreamingNodes(chainHierarchy(), 'missing', NEAR, { sseThreshold: 1, budgetMax: 1_000_000 });
    expect(sel.nodes).toEqual([]);
  });
});

describe('planEviction', () => {
  it('evicts non-selected nodes least-recently-used first until within budget', () => {
    const loaded = [
      { key: 'a', pointCount: 100, lastUsedTick: 30 },
      { key: 'b', pointCount: 100, lastUsedTick: 10 },
      { key: 'c', pointCount: 100, lastUsedTick: 20 },
    ];
    const evict = planEviction(loaded, new Set(['a']), 150);
    expect(evict).toEqual(['b', 'c']); // b (oldest) then c
  });

  it('never evicts selected nodes and no-ops when within budget', () => {
    const loaded = [
      { key: 'a', pointCount: 100, lastUsedTick: 1 },
      { key: 'b', pointCount: 100, lastUsedTick: 2 },
    ];
    expect(planEviction(loaded, new Set(['a', 'b']), 150)).toEqual([]); // can't evict selected → stays over, returns []
    expect(planEviction(loaded, new Set(), 500)).toEqual([]); // under budget
  });
});

describe('stale request cancellation', () => {
  it('cancels in-flight requests whose nodes are no longer selected', () => {
    expect(staleRequestKeys(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['b']);
    expect(staleRequestKeys(['a'], new Set(['a']))).toEqual([]);
  });
});

describe('settled state + disclosure', () => {
  it('is settled only when all selected nodes are loaded', () => {
    expect(isSettled(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBe(true);
    expect(isSettled(new Set(['a', 'b']), new Set(['a']))).toBe(false);
  });

  it('formats indexed-full disclosure with refining/settled state', () => {
    expect(formatIndexedFullDisclosure(1_200_000, 381_812_261, false)).toMatch(/Indexed-full/);
    expect(formatIndexedFullDisclosure(1_200_000, 381_812_261, false)).toMatch(/refining/);
    expect(formatIndexedFullDisclosure(381_812_261, 381_812_261, true)).toMatch(/settled/);
  });
});
