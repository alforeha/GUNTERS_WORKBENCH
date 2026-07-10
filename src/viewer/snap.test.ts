// src/viewer/snap.test.ts - pure snap resolution: pixel tolerance, nearest-of-
// multiple, authored-over-cloud precedence, the surfel exclusion backstop, and
// the placement -> evidence mapping (validated against the real schema).

import { describe, expect, it } from 'vitest';
import { evidenceRefSchema } from '../shared/manifest-schema';
import {
  DEFAULT_SNAP_TOLERANCE_PX,
  SNAP_PRECEDENCE,
  closestPointOnScreenSegment,
  evidenceForPlacement,
  resolvePlacement,
  resolveSnap,
  type SnapCandidate,
  type SnapQuery,
} from './snap';

const POINTER = { x: 400, y: 300 };

function cloudPoint(dxPx: number, overrides: Partial<SnapCandidate> = {}): SnapCandidate {
  return {
    sourceKind: 'cloud-point',
    world: [1000 + dxPx, 2000, 30],
    screen: { x: POINTER.x + dxPx, y: POINTER.y },
    assetId: 'asset-cloud-1',
    ...overrides,
  };
}

function query(candidates: SnapCandidate[], overrides: Partial<SnapQuery> = {}): SnapQuery {
  return { pointer: POINTER, candidates, tolerancePx: DEFAULT_SNAP_TOLERANCE_PX, ...overrides };
}

describe('resolveSnap', () => {
  it('snaps within tolerance and refuses outside it', () => {
    expect(resolveSnap(query([cloudPoint(10)]))?.distancePx).toBe(10);
    expect(resolveSnap(query([cloudPoint(15)]))).toBeNull();
  })

  it('picks the nearest of multiple candidates of one kind', () => {
    const hit = resolveSnap(query([cloudPoint(12), cloudPoint(3), cloudPoint(-7)]));
    expect(hit?.candidate.screen.x).toBe(POINTER.x + 3);
    expect(hit?.distancePx).toBe(3);
  })

  it('prefers authored geometry over a NEARER cloud point (watertight boundaries)', () => {
    const authoredVertex: SnapCandidate = {
      sourceKind: 'authored-vertex',
      world: [1010, 2000, 30],
      screen: { x: POINTER.x + 10, y: POINTER.y },
      featureId: 'feat-region-1',
    };
    const hit = resolveSnap(query([cloudPoint(2), authoredVertex]));
    expect(hit?.candidate.sourceKind).toBe('authored-vertex');

    const authoredEdge: SnapCandidate = { ...authoredVertex, sourceKind: 'authored-edge' };
    expect(resolveSnap(query([cloudPoint(2), authoredEdge]))?.candidate.sourceKind).toBe('authored-edge');
  })

  it('ranks authored-vertex above authored-edge above cloud-point in the precedence table', () => {
    const order = (kind: string) => SNAP_PRECEDENCE.indexOf(kind as (typeof SNAP_PRECEDENCE)[number]);
    expect(order('authored-vertex')).toBeLessThan(order('authored-edge'));
    expect(order('authored-edge')).toBeLessThan(order('cloud-point'));
  })

  it('never snaps to an excluded (surfel) asset, even when it is the only candidate in range', () => {
    const surfelBacked = cloudPoint(2, { assetId: 'asset-surfel-1' });
    const excluded = new Set(['asset-surfel-1']);
    expect(resolveSnap(query([surfelBacked], { excludedAssetIds: excluded }))).toBeNull();

    // A legitimate cloud point still wins with the exclusion active.
    const hit = resolveSnap(query([surfelBacked, cloudPoint(9)], { excludedAssetIds: excluded }));
    expect(hit?.candidate.assetId).toBe('asset-cloud-1');
  })
})

describe('closestPointOnScreenSegment', () => {
  it('projects onto the segment interior with the right t parameter', () => {
    const closest = closestPointOnScreenSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(closest).toEqual({ t: 0.5, x: 5, y: 0 });
  })

  it('clamps to the endpoints beyond the segment', () => {
    expect(closestPointOnScreenSegment({ x: -4, y: 1 }, { x: 0, y: 0 }, { x: 10, y: 0 }).t).toBe(0);
    expect(closestPointOnScreenSegment({ x: 99, y: 1 }, { x: 0, y: 0 }, { x: 10, y: 0 }).t).toBe(1);
  })

  it('handles a zero-length segment', () => {
    expect(closestPointOnScreenSegment({ x: 3, y: 4 }, { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual({ t: 0, x: 1, y: 1 });
  })
})

describe('resolvePlacement', () => {
  it('falls back to flagged free placement when nothing snaps', () => {
    const placement = resolvePlacement(query([]), [500, 600, 70]);
    expect(placement).toEqual({ snapped: false, world: [500, 600, 70] });
  })

  it('returns null when nothing snaps and there is no free-world hit', () => {
    expect(resolvePlacement(query([]), null)).toBeNull();
  })

  it('keeps snapped and free placements distinguishable', () => {
    const snapped = resolvePlacement(query([cloudPoint(1)]), [500, 600, 70]);
    expect(snapped?.snapped).toBe(true);
  })
})

describe('evidenceForPlacement', () => {
  it('maps a cloud snap to asset-point evidence with source detail', () => {
    const placement = resolvePlacement(
      query([cloudPoint(1, { sourceClass: 2, sourceRGB: [120, 90, 60] })]),
      null,
    )!;
    const evidence = evidenceForPlacement(placement);
    expect(evidence).toEqual({
      kind: 'asset-point',
      coordinate: [1001, 2000, 30],
      assetId: 'asset-cloud-1',
      sourceClass: 2,
      sourceRGB: [120, 90, 60],
    });
  })

  it('maps authored vertex/edge snaps to asset-vertex/asset-edge with featureId', () => {
    const base: SnapCandidate = {
      sourceKind: 'authored-vertex',
      world: [1, 2, 3],
      screen: POINTER,
      featureId: 'feat-1',
    };
    expect(evidenceForPlacement({ snapped: true, candidate: base, distancePx: 0 })).toEqual({
      kind: 'asset-vertex',
      coordinate: [1, 2, 3],
      featureId: 'feat-1',
    });
    expect(
      evidenceForPlacement({ snapped: true, candidate: { ...base, sourceKind: 'authored-edge' }, distancePx: 0 }),
    ).toEqual({ kind: 'asset-edge', coordinate: [1, 2, 3], featureId: 'feat-1' });
  })

  it('maps free placement to picked-coordinate', () => {
    expect(evidenceForPlacement({ snapped: false, world: [9, 8, 7] })).toEqual({
      kind: 'picked-coordinate',
      coordinate: [9, 8, 7],
    });
  })

  it('maps the dwg/tin/surface seams to their evidence kinds', () => {
    const dwg: SnapCandidate = {
      sourceKind: 'dwg-vertex',
      world: [1, 2, 3],
      screen: POINTER,
      assetId: 'asset-dwg-1',
      assetLayerId: 'layer-7',
    };
    expect(evidenceForPlacement({ snapped: true, candidate: dwg, distancePx: 0 })).toEqual({
      kind: 'asset-vertex',
      coordinate: [1, 2, 3],
      assetId: 'asset-dwg-1',
      assetLayerId: 'layer-7',
    });
    expect(
      evidenceForPlacement({
        snapped: true,
        candidate: { sourceKind: 'surface-hit', world: [1, 2, 3], screen: POINTER, assetId: 'asset-surf-1' },
        distancePx: 0,
      }),
    ).toEqual({ kind: 'surface-hit', coordinate: [1, 2, 3], assetId: 'asset-surf-1' });
  })

  it('produces evidence the manifest schema accepts, for every placement shape', () => {
    const placements = [
      resolvePlacement(query([cloudPoint(1, { sourceClass: 2, sourceRGB: [1, 2, 3] })]), null)!,
      resolvePlacement(query([]), [5, 6, 7])!,
      {
        snapped: true as const,
        candidate: {
          sourceKind: 'authored-vertex' as const,
          world: [1, 2, 3] as [number, number, number],
          screen: POINTER,
          featureId: 'feat-1',
        },
        distancePx: 0,
      },
    ];
    for (const placement of placements) {
      expect(evidenceRefSchema.safeParse(evidenceForPlacement(placement)).success).toBe(true);
    }
  })
})
