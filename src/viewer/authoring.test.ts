// src/viewer/authoring.test.ts - the pure authoring state machine: the
// idle -> placing -> addingVertex -> closing -> complete/cancel flow per
// geometry mode, strict rejection of invalid transitions, evidence capture
// on every placement, and the surfel-exclusion path (excluded snap source
// degrades to flagged free placement, never asset evidence).

import { describe, expect, it } from 'vitest';
import { AuthoringMachine, defaultGeometryMode } from './authoring';
import { resolvePlacement, type PlacementResolution, type SnapCandidate } from './snap';

const POINTER = { x: 100, y: 100 };

function snappedPlacement(world: [number, number, number] = [10, 20, 3]): PlacementResolution {
  const candidate: SnapCandidate = {
    sourceKind: 'cloud-point',
    world,
    screen: POINTER,
    assetId: 'asset-cloud-1',
  };
  return { snapped: true, candidate, distancePx: 2 };
}

function freePlacement(world: [number, number, number] = [11, 21, 4]): PlacementResolution {
  return { snapped: false, world };
}

describe('defaultGeometryMode', () => {
  it('maps families to their authoring geometry', () => {
    expect(defaultGeometryMode('marker')).toBe('point');
    expect(defaultGeometryMode('object')).toBe('point');
    expect(defaultGeometryMode('measurement')).toBe('point');
    expect(defaultGeometryMode('line')).toBe('polyline');
    expect(defaultGeometryMode('utility')).toBe('polyline');
    expect(defaultGeometryMode('region')).toBe('polygon');
    expect(defaultGeometryMode('building')).toBe('polygon');
  })
})

describe('point flow (marker/object)', () => {
  it('completes on a single placement and records evidence', () => {
    const machine = new AuthoringMachine();
    expect(machine.start('marker', 'marker.generic')).toBe(true);
    expect(machine.snapshot().state).toBe('placing');

    expect(machine.place(snappedPlacement())).toBe(true);
    const { state, draft } = machine.snapshot();
    expect(state).toBe('complete');
    expect(draft?.vertices).toHaveLength(1);
    expect(draft?.vertices[0]).toEqual({
      world: [10, 20, 3],
      snapped: true,
      evidence: { kind: 'asset-point', coordinate: [10, 20, 3], assetId: 'asset-cloud-1' },
    });
  })
})

describe('polyline flow (line)', () => {
  it('walks placing -> addingVertex -> closing -> complete without closing the ring', () => {
    const machine = new AuthoringMachine();
    machine.start('line', 'line.curb');

    expect(machine.place(snappedPlacement([0, 0, 0]))).toBe(true);
    expect(machine.snapshot().state).toBe('addingVertex');
    expect(machine.requestClose()).toBe(false); // 1 vertex < polyline minimum of 2

    expect(machine.place(freePlacement([5, 0, 0]))).toBe(true);
    expect(machine.requestClose()).toBe(true);
    expect(machine.snapshot().state).toBe('closing');
    expect(machine.confirm()).toBe(true);

    const { state, draft } = machine.snapshot();
    expect(state).toBe('complete');
    expect(draft?.closed).toBe(false);
    expect(draft?.vertices.map((vertex) => vertex.snapped)).toEqual([true, false]);
  })
})

describe('polygon flow (region/building)', () => {
  it('requires 3 vertices, then closes the ring on confirm', () => {
    const machine = new AuthoringMachine();
    machine.start('region', 'region.grass');

    machine.place(snappedPlacement([0, 0, 0]));
    machine.place(snappedPlacement([10, 0, 0]));
    expect(machine.requestClose()).toBe(false); // 2 vertices < polygon minimum of 3
    machine.place(snappedPlacement([10, 10, 0]));
    expect(machine.requestClose()).toBe(true);
    expect(machine.confirm()).toBe(true);

    const { state, draft } = machine.snapshot();
    expect(state).toBe('complete');
    expect(draft?.closed).toBe(true);
    expect(draft?.family).toBe('region');
    expect(draft?.templateId).toBe('region.grass');
  })
})

describe('invalid transitions leave state untouched', () => {
  it('rejects place/close/confirm from idle and confirm before closing', () => {
    const machine = new AuthoringMachine();
    expect(machine.place(freePlacement())).toBe(false);
    expect(machine.requestClose()).toBe(false);
    expect(machine.confirm()).toBe(false);
    expect(machine.cancel()).toBe(false);
    expect(machine.snapshot()).toEqual({ state: 'idle', draft: null });

    machine.start('line', null);
    expect(machine.confirm()).toBe(false); // not in closing
    expect(machine.snapshot().state).toBe('placing');
  })

  it('rejects start while a draft is active and place while closing', () => {
    const machine = new AuthoringMachine();
    machine.start('region', null);
    expect(machine.start('line', null)).toBe(false);

    machine.place(freePlacement([0, 0, 0]));
    machine.place(freePlacement([1, 0, 0]));
    machine.place(freePlacement([1, 1, 0]));
    machine.requestClose();
    expect(machine.place(freePlacement([9, 9, 9]))).toBe(false);
    expect(machine.snapshot().draft?.vertices).toHaveLength(3);
  })
})

describe('cancel', () => {
  it('drops the draft from any active state and allows a fresh start', () => {
    const machine = new AuthoringMachine();
    machine.start('region', null);
    machine.place(freePlacement());
    expect(machine.cancel()).toBe(true);
    expect(machine.snapshot()).toEqual({ state: 'cancelled', draft: null });

    expect(machine.start('marker', null)).toBe(true);
    expect(machine.snapshot().state).toBe('placing');
  })
})

describe('evidence capture', () => {
  it('distinguishes snapped from free placement at the record level', () => {
    const machine = new AuthoringMachine();
    machine.start('line', null);
    machine.place(snappedPlacement());
    machine.place(freePlacement());
    const vertices = machine.snapshot().draft!.vertices;
    expect(vertices[0]!.snapped).toBe(true);
    expect(vertices[0]!.evidence.kind).toBe('asset-point');
    expect(vertices[1]!.snapped).toBe(false);
    expect(vertices[1]!.evidence.kind).toBe('picked-coordinate');
  })

  it('records only picked-coordinate evidence when the sole snap source is an excluded surfel asset', () => {
    // End-to-end pure path: a surfel-backed candidate is in range, but the
    // exclusion set removes it, so placement degrades to flagged free
    // placement - no asset evidence is ever minted from a surfel.
    const surfelCandidate: SnapCandidate = {
      sourceKind: 'cloud-point',
      world: [50, 60, 7],
      screen: { x: POINTER.x + 1, y: POINTER.y },
      assetId: 'asset-surfel-1',
    };
    const placement = resolvePlacement(
      {
        pointer: POINTER,
        candidates: [surfelCandidate],
        tolerancePx: 14,
        excludedAssetIds: new Set(['asset-surfel-1']),
      },
      [50, 60, 7],
    )!;

    const machine = new AuthoringMachine();
    machine.start('marker', null);
    machine.place(placement);
    const vertex = machine.snapshot().draft!.vertices[0]!;
    expect(vertex.snapped).toBe(false);
    expect(vertex.evidence).toEqual({ kind: 'picked-coordinate', coordinate: [50, 60, 7] });
  })
})

describe('snapshot isolation', () => {
  it('returns a deep copy the caller cannot use to corrupt the draft', () => {
    const machine = new AuthoringMachine();
    machine.start('region', null);
    machine.place(freePlacement([1, 2, 3]));

    const snapshot = machine.snapshot();
    snapshot.draft!.vertices[0]!.world[0] = 999;
    snapshot.draft!.vertices.push(snapshot.draft!.vertices[0]!);

    const fresh = machine.snapshot();
    expect(fresh.draft!.vertices).toHaveLength(1);
    expect(fresh.draft!.vertices[0]!.world).toEqual([1, 2, 3]);
  })
})
