// src/viewer/generators.test.ts - the pure region patch generator: correct
// triangulation (convex + concave), area preservation, drape at authored Z,
// open/degenerate handling, breakline/spot-elevation pass-through, and
// byte-identical determinism (the regeneration guarantee).

import { describe, expect, it } from 'vitest';
import type { FeatureRecord } from '../shared/workbench-types';
import type { Vec3 } from './geometry';
import {
  buildBuildingDisplay,
  buildLineDisplay,
  buildObjectDisplay,
  buildPointPrimitiveDisplay,
  buildRegionPatch,
  buildingGeometryFromFeature,
  lineGeometryFromFeature,
  pointPrimitiveGeometryFromFeature,
  regionGeometryFromFeature,
  signedAreaXY,
} from './generators';

const SQUARE: Vec3[] = [
  [0, 0, 10],
  [10, 0, 11],
  [10, 10, 12],
  [0, 10, 13],
];

// L-shape: 2x2 square with the top-right 1x1 quadrant removed (area 3).
const L_SHAPE: Vec3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [2, 1, 0],
  [1, 1, 0],
  [1, 2, 0],
  [0, 2, 0],
];

function triangulatedAreaXY(display: { positions: Float64Array; indices: Uint32Array }): number {
  let area = 0;
  for (let i = 0; i < display.indices.length; i += 3) {
    const [a, b, c] = [display.indices[i]!, display.indices[i + 1]!, display.indices[i + 2]!];
    const ax = display.positions[a * 3]!;
    const ay = display.positions[a * 3 + 1]!;
    const bx = display.positions[b * 3]!;
    const by = display.positions[b * 3 + 1]!;
    const cx = display.positions[c * 3]!;
    const cy = display.positions[c * 3 + 1]!;
    area += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  return area;
}

describe('buildRegionPatch', () => {
  it('triangulates a closed square into n-2 triangles preserving area and authored Z', () => {
    const patch = buildRegionPatch({ border: SQUARE, closed: true });
    expect(patch.indices.length).toBe(2 * 3);
    expect(patch.areaXY).toBe(100);
    expect(triangulatedAreaXY(patch)).toBeCloseTo(100, 9);
    // Drape: authored elevations survive untouched.
    expect([patch.positions[2], patch.positions[5], patch.positions[8], patch.positions[11]]).toEqual([10, 11, 12, 13]);
    // Outline closes the ring.
    expect(patch.outline).toHaveLength(5);
    expect(patch.outline[0]).toEqual(patch.outline[4]);
  })

  it('triangulates a concave L-shape correctly (n-2 triangles, area preserved)', () => {
    const patch = buildRegionPatch({ border: L_SHAPE, closed: true });
    expect(patch.indices.length).toBe(4 * 3);
    expect(patch.areaXY).toBe(3);
    expect(triangulatedAreaXY(patch)).toBeCloseTo(3, 9);
  })

  it('normalizes winding: a clockwise ring produces the same area and triangle count', () => {
    const clockwise = [...SQUARE].reverse();
    expect(signedAreaXY(clockwise)).toBeLessThan(0);
    const patch = buildRegionPatch({ border: clockwise, closed: true });
    expect(patch.indices.length).toBe(6);
    expect(patch.areaXY).toBe(100);
    expect(triangulatedAreaXY(patch)).toBeCloseTo(100, 9);
  })

  it('produces outline-only display for an open border', () => {
    const patch = buildRegionPatch({ border: SQUARE, closed: false });
    expect(patch.indices.length).toBe(0);
    expect(patch.positions.length).toBe(0);
    expect(patch.areaXY).toBe(0);
    expect(patch.outline).toHaveLength(4); // open: first vertex not repeated
  })

  it('handles degenerate borders (fewer than 3 vertices) without throwing', () => {
    const patch = buildRegionPatch({ border: [SQUARE[0]!, SQUARE[1]!], closed: true });
    expect(patch.indices.length).toBe(0);
    expect(patch.areaXY).toBe(0);
  })

  it('carries breaklines through and accepts spot elevations without deforming the patch', () => {
    const breakline: Vec3[] = [
      [1, 1, 10.5],
      [9, 9, 11.5],
    ];
    const withConstraints = buildRegionPatch({
      border: SQUARE,
      closed: true,
      breaklines: [breakline],
      spotElevations: [[5, 5, 99]],
    });
    expect(withConstraints.breaklines).toEqual([breakline]);
    // v1: spot elevations are accepted (future ground compiler input) but inert.
    const without = buildRegionPatch({ border: SQUARE, closed: true, breaklines: [breakline] });
    expect(withConstraints.positions).toEqual(without.positions);
    expect(withConstraints.indices).toEqual(without.indices);
  })

  it('is deterministic: identical input regenerates byte-identical geometry', () => {
    const first = buildRegionPatch({ border: L_SHAPE, closed: true, breaklines: [[L_SHAPE[0]!, L_SHAPE[3]!]] });
    const second = buildRegionPatch({ border: L_SHAPE, closed: true, breaklines: [[L_SHAPE[0]!, L_SHAPE[3]!]] });
    expect(second.positions).toEqual(first.positions);
    expect(second.indices).toEqual(first.indices);
    expect(second.outline).toEqual(first.outline);
    expect(second.areaXY).toBe(first.areaXY);
  })
})

describe('regionGeometryFromFeature', () => {
  const base: FeatureRecord = {
    id: 'feat-1',
    simulationId: 'sim-1',
    type: 'polyline',
    name: 'Region 1',
    geometry: { border: SQUARE, closed: true, breaklines: [[SQUARE[0]!, SQUARE[2]!]] },
    createdAt: '2026-07-09T00:00:00.000Z',
    modifiedAt: '2026-07-09T00:00:00.000Z',
    family: 'region',
  };

  it('reads stored primitives off a region record', () => {
    const geometry = regionGeometryFromFeature(base);
    expect(geometry).not.toBeNull();
    expect(geometry?.border).toEqual(SQUARE);
    expect(geometry?.closed).toBe(true);
    expect(geometry?.breaklines).toHaveLength(1);
  })

  it('returns null for non-region families and malformed payloads', () => {
    expect(regionGeometryFromFeature({ ...base, family: 'line' })).toBeNull();
    expect(regionGeometryFromFeature({ ...base, geometry: {} })).toBeNull();
    expect(regionGeometryFromFeature({ ...base, geometry: { border: [[1, 2]], closed: true } })).toBeNull();
  })

  it('drops malformed breakline entries but keeps valid ones', () => {
    const geometry = regionGeometryFromFeature({
      ...base,
      geometry: { border: SQUARE, closed: true, breaklines: [[[1, 1, 1], [2, 2, 2]], 'junk'] },
    });
    expect(geometry?.breaklines).toEqual([[[1, 1, 1], [2, 2, 2]]]);
  })
})

describe('buildBuildingDisplay', () => {
  const FOOTPRINT: Vec3[] = [
    [0, 0, 100],
    [40, 0, 100],
    [40, 20, 100],
    [0, 20, 100],
  ];

  it('generates a square gable mass with inferred ridge and eave/roof line sets', () => {
    const display = buildBuildingDisplay({
      footprint: FOOTPRINT,
      height: 12,
      roofType: 'gable',
      roofPitchDeg: 30,
      overhang: 2,
    });
    expect(display.positions.length).toBeGreaterThan(0);
    expect(display.indices.length).toBeGreaterThan(0);
    expect(display.lines.footprint).toEqual([...FOOTPRINT, FOOTPRINT[0]]);
    expect(display.lines.roof).toHaveLength(5);
    expect(display.lines.overhang).toHaveLength(5);
    expect(display.lines.ridge).toHaveLength(2);
    expect(display.lines.ridge[0]).toEqual([0, 10, 112 + 10 * Math.tan(Math.PI / 6)]);
    expect(display.lines.ridge[1]).toEqual([40, 10, 112 + 10 * Math.tan(Math.PI / 6)]);
  })

  it('keeps flat roofs ridge-free and still produces a top face', () => {
    const display = buildBuildingDisplay({ footprint: FOOTPRINT, height: 10, roofType: 'flat' });
    expect(display.lines.ridge).toEqual([]);
    expect(display.indices.length).toBeGreaterThanOrEqual(2 * 3);
  })

  it('reads building primitives off a feature record', () => {
    const feature: FeatureRecord = {
      id: 'feat-building-1',
      simulationId: 'sim-1',
      type: 'polyline',
      name: 'Building 1',
      geometry: { footprint: FOOTPRINT, roofType: 'gable' },
      createdAt: '2026-07-09T00:00:00.000Z',
      modifiedAt: '2026-07-09T00:00:00.000Z',
      family: 'building',
    };
    expect(buildingGeometryFromFeature(feature)).toEqual({ footprint: FOOTPRINT, roofType: 'gable' });
    expect(buildingGeometryFromFeature({ ...feature, family: 'region' })).toBeNull();
    expect(buildingGeometryFromFeature({ ...feature, geometry: { footprint: FOOTPRINT, roofType: 'shed' } })).toBeNull();
  })
})

describe('IMP-5 primitive displays', () => {
  it('generates a point-anchored primitive as crosshair plus vertical stem', () => {
    const display = buildPointPrimitiveDisplay({ point: [10, 20, 5], size: 4, height: 8 });
    expect(display.lines).toEqual([
      [
        [8, 20, 5],
        [12, 20, 5],
      ],
      [
        [10, 18, 5],
        [10, 22, 5],
      ],
      [
        [10, 20, 5],
        [10, 20, 13],
      ],
    ]);
  })

  it('builds a centered box object mesh and outline', () => {
    const feature: FeatureRecord = {
      id: 'feat-object-box',
      simulationId: 'sim-1',
      type: 'marker',
      name: 'Box 1',
      geometry: { point: [10, 20, 5] },
      createdAt: '2026-07-12T00:00:00.000Z',
      modifiedAt: '2026-07-12T00:00:00.000Z',
      family: 'object',
      templateId: 'object.box',
      subtype: 'box',
      parameters: { width: 4, depth: 6, height: 8, rotationYaw: 0 },
    };
    const display = buildObjectDisplay(feature);

    expect(display?.fill?.indices.length).toBeGreaterThan(0);
    expect(display?.lines).toHaveLength(6);
    expect(display?.lines[0]?.[0]).toEqual([8, 17, 1]);
    expect(display?.lines[1]?.[0]).toEqual([8, 17, 9]);
  })

  it('builds a sign from a base-origin post and sign face', () => {
    const feature: FeatureRecord = {
      id: 'feat-object-sign',
      simulationId: 'sim-1',
      type: 'marker',
      name: 'Sign 1',
      geometry: { point: [0, 0, 0] },
      createdAt: '2026-07-12T00:00:00.000Z',
      modifiedAt: '2026-07-12T00:00:00.000Z',
      family: 'object',
      templateId: 'object.sign',
      subtype: 'sign',
      parameters: { postHeight: 8, signWidth: 4, signHeight: 2, numberOfFaces: 2, rotationYaw: 0 },
    };
    const display = buildObjectDisplay(feature);

    expect(display?.fill?.indices.length).toBeGreaterThan(0);
    expect(display?.lines.some((line) => line.some((point) => point[2] >= 8))).toBe(true);
  })

  it('passes authored line vertices through and computes plan length', () => {
    const line = buildLineDisplay({ vertices: [[0, 0, 0], [3, 4, 1], [6, 4, 1]] });
    expect(line.lines).toEqual([[[0, 0, 0], [3, 4, 1], [6, 4, 1]]]);
    expect(line.lengthXY).toBe(8);
  })

  it('reads object, marker, and line primitives from feature records', () => {
    const objectFeature: FeatureRecord = {
      id: 'feat-object-1',
      simulationId: 'sim-1',
      type: 'marker',
      name: 'Object',
      geometry: { point: [1, 2, 3] },
      createdAt: '2026-07-09T00:00:00.000Z',
      modifiedAt: '2026-07-09T00:00:00.000Z',
      family: 'object',
      templateId: 'object.box',
    };
    const markerFeature = { ...objectFeature, id: 'feat-marker-1', family: 'marker' as const };
    const lineFeature: FeatureRecord = {
      ...objectFeature,
      id: 'feat-line-1',
      type: 'polyline',
      family: 'line',
      geometry: { vertices: [[0, 0, 0], [1, 1, 0]] },
    };
    expect(pointPrimitiveGeometryFromFeature(objectFeature)).toEqual({ point: [1, 2, 3] });
    expect(pointPrimitiveGeometryFromFeature(markerFeature)).toEqual({ point: [1, 2, 3] });
    expect(lineGeometryFromFeature(lineFeature)).toEqual({ vertices: [[0, 0, 0], [1, 1, 0]] });
    expect(pointPrimitiveGeometryFromFeature(lineFeature)).toBeNull();
    expect(lineGeometryFromFeature(objectFeature)).toBeNull();
  })
})
