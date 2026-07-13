import { describe, expect, it } from 'vitest';
import {
  boxDistance,
  deriveFinestVisibleLevels,
  estimateRegionPoints,
  formatIndexedFullDisclosure,
  isSettled,
  nodeGeometricError,
  planEviction,
  planRegionSectors,
  projScaleFromPerspective,
  screenSpaceError,
  selectRegionNodes,
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

// Root spanning 0..8 with two spatially disjoint children (small gap so seam
// touches don't double-count in assertions), 100 pts per node.
function splitHierarchy(): Map<string, StreamNode> {
  const nodes: StreamNode[] = [
    { key: 'root', level: 0, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 8, maxY: 8, maxZ: 8 }, pointCount: 100, childKeys: ['a', 'b'] },
    { key: 'a', level: 1, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 3.9, maxY: 8, maxZ: 8 }, pointCount: 100, childKeys: [] },
    { key: 'b', level: 1, bounds: { minX: 4.1, minY: 0, minZ: 0, maxX: 8, maxY: 8, maxZ: 8 }, pointCount: 100, childKeys: [] },
  ];
  return new Map(nodes.map((n) => [n.key, n]));
}

describe('selectRegionNodes / estimateRegionPoints', () => {
  it('selects every level intersecting the region, coarse first', () => {
    const sel = selectRegionNodes(splitHierarchy(), 'root', { minX: 0, minY: 0, maxX: 8, maxY: 8 }, 5_000_000);
    expect(sel.keys).toEqual(new Set(['root', 'a', 'b']));
    expect(sel.nodes[0]!.key).toBe('root');
    expect(sel.estimatedPoints).toBe(300);
    expect(sel.budgetLimited).toBe(false);
  });

  it('excludes branches outside the region XY', () => {
    const sel = selectRegionNodes(splitHierarchy(), 'root', { minX: 5, minY: 0, maxX: 8, maxY: 8 }, 5_000_000);
    expect(sel.keys).toEqual(new Set(['root', 'b']));
    expect(estimateRegionPoints(splitHierarchy(), 'root', { minX: 5, minY: 0, maxX: 8, maxY: 8 })).toBe(200);
  });

  it('caps at the budget coarse-coverage-first and reports it', () => {
    const sel = selectRegionNodes(splitHierarchy(), 'root', { minX: 0, minY: 0, maxX: 8, maxY: 8 }, 150);
    expect(sel.keys).toEqual(new Set(['root']));
    expect(sel.budgetLimited).toBe(true);
  });
});

describe('planRegionSectors', () => {
  const REGION = { minX: 0, minY: 0, maxX: 8, maxY: 8 };

  it('keeps one sector when the region fits the budget', () => {
    expect(planRegionSectors(splitHierarchy(), 'root', REGION, 400)).toEqual([REGION]);
  });

  it('splits an over-budget region into balanced adjacent sectors that fit', () => {
    const sectors = planRegionSectors(splitHierarchy(), 'root', REGION, 250);
    expect(sectors).toHaveLength(2);
    expect(sectors[0]!.maxX).toBe(sectors[1]!.minX); // adjacent halves along the split axis
    for (const sector of sectors) {
      expect(estimateRegionPoints(splitHierarchy(), 'root', sector)).toBeLessThanOrEqual(250);
    }
  });

  it('stops splitting when subdivision cannot help (root weight everywhere)', () => {
    // Budget below the root's own count: every sector always includes the root,
    // so the plan bottoms out at maxSectors instead of recursing forever.
    const sectors = planRegionSectors(splitHierarchy(), 'root', REGION, 50, 4);
    expect(sectors.length).toBeLessThanOrEqual(4);
    expect(sectors.length).toBeGreaterThan(1);
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

  it('never evicts pinned base-layer nodes', () => {
    const loaded = [
      { key: 'root', pointCount: 100, lastUsedTick: 1 },
      { key: 'child', pointCount: 100, lastUsedTick: 2 },
      { key: 'leaf', pointCount: 100, lastUsedTick: 3 },
    ];
    expect(planEviction(loaded, new Set(), 150, new Set(['root', 'child']))).toEqual(['leaf']);
  });
});

describe('deriveFinestVisibleLevels', () => {
  it('propagates the deepest visible level up a refined branch', () => {
    const levels = deriveFinestVisibleLevels(
      chainHierarchy(),
      new Set(['0-0-0-0', '1-0-0-0', '2-0-0-0']),
    );
    expect(levels.get('0-0-0-0')).toBe(2);
    expect(levels.get('1-0-0-0')).toBe(2);
    expect(levels.get('2-0-0-0')).toBe(2);
  });

  it('keeps unrelated branches at their own finest loaded level', () => {
    const branched = new Map<string, StreamNode>([
      ['0', { key: '0', level: 0, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 8, maxY: 8, maxZ: 8 }, pointCount: 100, childKeys: ['1a', '1b'] }],
      ['1a', { key: '1a', level: 1, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 4, maxZ: 4 }, pointCount: 100, childKeys: ['2a'] }],
      ['2a', { key: '2a', level: 2, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 }, pointCount: 100, childKeys: [] }],
      ['1b', { key: '1b', level: 1, bounds: { minX: 4, minY: 4, minZ: 4, maxX: 8, maxY: 8, maxZ: 8 }, pointCount: 100, childKeys: [] }],
    ]);
    const levels = deriveFinestVisibleLevels(branched, new Set(['0', '1a', '2a', '1b']));
    expect(levels.get('1a')).toBe(2);
    expect(levels.get('1b')).toBe(1);
    expect(levels.get('0')).toBe(2);
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
