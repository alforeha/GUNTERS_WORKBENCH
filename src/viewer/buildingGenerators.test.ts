// src/viewer/buildingGenerators.test.ts - beta Buildings geometry: the
// deterministic plane fit from selected evidence, the face frame/extents it
// produces, the metadata component readers, and the procedural display
// (envelope outline, face quads, hosted-feature primitives).

import { describe, expect, it } from 'vitest';
import type { BuildingFaceFeatureRecord, BuildingFaceRecord } from '../shared/building-catalog';
import type { FeatureRecord } from '../shared/workbench-types';
import type { Vec3 } from './geometry';
import {
  buildBuildingComponentDisplayEntries,
  buildFaceFeatureDisplay,
  buildingComponentsFromFeature,
  buildingEnvelopeFromFeature,
  faceCorners,
  faceFitPreviewLines,
  fitFaceFromEvidence,
  fitPlaneToPoints,
  focusBoundaryFromFeature,
  isEnvelopeBuilding,
  nextFaceName,
  representativeEvidence,
  roofSlopeInfo,
} from './buildingGenerators';

const ENVELOPE: Vec3[] = [
  [0, 0, 100],
  [40, 0, 100],
  [40, 30, 100],
  [0, 30, 100],
];

function makeBuilding(metadata: Record<string, unknown> = {}, subtype = 'envelope'): FeatureRecord {
  return {
    id: 'feat-bldg-1',
    simulationId: 'sim-1',
    type: 'polyline',
    name: 'Building 1 (envelope)',
    geometry: { footprint: ENVELOPE },
    createdAt: '2026-07-16T00:00:00.000Z',
    modifiedAt: '2026-07-16T00:00:00.000Z',
    family: 'building',
    templateId: 'building.envelope',
    subtype,
    parameters: {},
    display: { visible: true },
    metadata,
  };
}

/** Points on the vertical wall plane x=50: y spans 30, z spans 10. */
const WALL_POINTS: Vec3[] = [
  [50, 0, 100],
  [50, 30, 100],
  [50, 30, 110],
  [50, 0, 110],
  [50, 15, 105],
];

/** Points on the sloped roof plane z = 100 + 0.5y (rises toward +y). */
const ROOF_POINTS: Vec3[] = [
  [0, 0, 100],
  [40, 0, 100],
  [0, 20, 110],
  [40, 20, 110],
  [20, 10, 105],
];

function makeFace(overrides: Partial<BuildingFaceRecord> = {}): BuildingFaceRecord {
  const fitted = fitFaceFromEvidence(WALL_POINTS)!;
  return {
    id: 'face-1',
    name: 'Wall 1',
    kind: 'wall',
    plane: fitted.plane,
    extents: fitted.extents,
    fitRms: fitted.fitRms,
    evidence: { count: WALL_POINTS.length, representative: WALL_POINTS },
    visible: true,
    createdAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeHosted(overrides: Partial<BuildingFaceFeatureRecord> = {}): BuildingFaceFeatureRecord {
  return {
    id: 'bfeat-1',
    faceId: 'face-1',
    name: 'Door 1',
    type: 'door',
    offsetU: 5,
    offsetV: 0,
    width: 3,
    height: 7,
    depth: 0.5,
    visible: true,
    createdAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('fitPlaneToPoints', () => {
  it('fits a horizontal plane exactly with zero rms', () => {
    const fit = fitPlaneToPoints([
      [0, 0, 100],
      [10, 0, 100],
      [10, 10, 100],
      [0, 10, 100],
    ]);
    expect(fit).not.toBeNull();
    expect(Math.abs(fit!.normal[2])).toBeCloseTo(1, 9);
    expect(fit!.rms).toBeCloseTo(0, 9);
    expect(fit!.origin).toEqual([5, 5, 100]);
  });

  it('orients deterministically: up-facing normals, +x for vertical planes', () => {
    const roof = fitPlaneToPoints(ROOF_POINTS)!;
    expect(roof.normal[2]).toBeGreaterThan(0);
    const wall = fitPlaneToPoints(WALL_POINTS)!;
    expect(wall.normal[0]).toBeCloseTo(1, 6);
  });

  it('reports the residual spread as rms', () => {
    const fit = fitPlaneToPoints([
      [0, 0, 99],
      [10, 0, 101],
      [10, 10, 99],
      [0, 10, 101],
      [5, 5, 100],
    ])!;
    expect(fit.rms).toBeGreaterThan(0.5);
  });

  it('returns null for degenerate input: too few, collinear, or coincident points', () => {
    expect(fitPlaneToPoints([[0, 0, 0], [1, 1, 1]])).toBeNull();
    expect(
      fitPlaneToPoints([
        [0, 0, 0],
        [1, 1, 1],
        [2, 2, 2],
        [3, 3, 3],
      ]),
    ).toBeNull();
    expect(
      fitPlaneToPoints([
        [5, 5, 5],
        [5, 5, 5],
        [5, 5, 5],
      ]),
    ).toBeNull();
  });
});

describe('fitFaceFromEvidence', () => {
  it('frames a wall: horizontal length, vertical height, wall suggested', () => {
    const fitted = fitFaceFromEvidence(WALL_POINTS)!;
    expect(fitted.length).toBeCloseTo(30, 5);
    expect(fitted.height).toBeCloseTo(10, 5);
    expect(fitted.area).toBeCloseTo(300, 4);
    expect(fitted.suggestedKind).toBe('wall');
    // yAxis is straight up on a vertical wall.
    expect(fitted.plane.yAxis[2]).toBeCloseTo(1, 6);
    expect(fitted.fitRms).toBeCloseTo(0, 9);
  });

  it('frames a roof plane: along-strike length, slope distance height, slope/aspect derived', () => {
    const fitted = fitFaceFromEvidence(ROOF_POINTS)!;
    expect(fitted.suggestedKind).toBe('roof');
    expect(fitted.length).toBeCloseTo(40, 5);
    // 20 ft plan run rising 10 ft => 22.36 slope distance.
    expect(fitted.height).toBeCloseTo(Math.hypot(20, 10), 4);
    expect(fitted.slope.slopeDeg).toBeCloseTo(26.565, 2);
    // Rises toward +y, so downhill faces south.
    expect(fitted.slope.aspectLabel).toBe('S');
  });

  it('returns null when no unique plane exists', () => {
    expect(fitFaceFromEvidence([[0, 0, 0], [10, 10, 0]])).toBeNull();
  });
});

describe('roofSlopeInfo and evidence sampling', () => {
  it('reads a flat plane as slope 0 with no aspect', () => {
    const info = roofSlopeInfo([0, 0, 1]);
    expect(info.slopeDeg).toBeCloseTo(0, 6);
    expect(info.aspectDeg).toBeNull();
    expect(info.aspectLabel).toBeNull();
  });

  it('caps the representative sample and keeps first/last points', () => {
    const points: Vec3[] = Array.from({ length: 100 }, (_, i) => [i, 0, 0] as Vec3);
    const sample = representativeEvidence(points, 8);
    expect(sample).toHaveLength(8);
    expect(sample[0]).toEqual([0, 0, 0]);
    expect(sample[7]).toEqual([99, 0, 0]);
    expect(representativeEvidence(points.slice(0, 3), 8)).toHaveLength(3);
  });
});

describe('component readers', () => {
  it('recognizes envelope buildings and reads the envelope polygon', () => {
    const feature = makeBuilding();
    expect(isEnvelopeBuilding(feature)).toBe(true);
    expect(isEnvelopeBuilding({ ...feature, subtype: 'gable' })).toBe(false);
    expect(buildingEnvelopeFromFeature(feature)).toEqual(ENVELOPE);
    expect(buildingEnvelopeFromFeature({ ...feature, geometry: { footprint: [[0, 0, 0]] } })).toBeNull();
  });

  it('reads components, skipping malformed faces and orphaned hosted features', () => {
    const face = makeFace();
    const hosted = makeHosted();
    const orphan = makeHosted({ id: 'bfeat-orphan', faceId: 'face-missing' });
    const feature = makeBuilding({
      building: { faces: [face, { id: 'broken' }], faceFeatures: [hosted, orphan, { id: 'also-broken' }] },
    });
    const components = buildingComponentsFromFeature(feature);
    expect(components.faces).toHaveLength(1);
    expect(components.faces[0]!.id).toBe('face-1');
    expect(components.faceFeatures).toHaveLength(1);
    expect(components.faceFeatures[0]!.id).toBe('bfeat-1');
    expect(buildingComponentsFromFeature(makeBuilding())).toEqual({ faces: [], faceFeatures: [] });
  });

  it('resolves the focus boundary: override wins, else the envelope, never optional', () => {
    const feature = makeBuilding();
    // No override: the envelope IS the boundary.
    expect(focusBoundaryFromFeature(feature)).toEqual(ENVELOPE);
    // A drawn boundary overrides the envelope.
    const custom: Vec3[] = [
      [10, 10, 100],
      [20, 10, 100],
      [20, 20, 100],
    ];
    expect(focusBoundaryFromFeature(makeBuilding({ isolateBoundary: { polygon: custom } }))).toEqual(custom);
    // Legacy buildings and other families keep the optional behavior.
    expect(focusBoundaryFromFeature(makeBuilding({}, 'gable'))).toBeNull();
    expect(focusBoundaryFromFeature({ ...feature, family: 'object' })).toBeNull();
  });

  it('numbers new faces per kind', () => {
    const components = { faces: [makeFace(), makeFace({ id: 'face-2', kind: 'roof' })], faceFeatures: [] };
    expect(nextFaceName(components, 'wall')).toBe('Wall 2');
    expect(nextFaceName(components, 'roof')).toBe('Roof plane 2');
    expect(nextFaceName(components, 'generic')).toBe('Generic face 1');
  });
});

describe('display', () => {
  it('renders an envelope-only building as one closed outline entry', () => {
    const entries = buildBuildingComponentDisplayEntries(makeBuilding());
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fill).toBeUndefined();
    const outline = entries[0]!.lines[0]!;
    expect(outline).toHaveLength(5);
    expect(outline[0]).toEqual(outline[4]);
  });

  it('renders visible faces as quads and hosted features on their face', () => {
    const feature = makeBuilding({ building: { faces: [makeFace()], faceFeatures: [makeHosted()] } });
    const entries = buildBuildingComponentDisplayEntries(feature);
    expect(entries).toHaveLength(3); // envelope + face + door
    const faceEntry = entries[1]!;
    expect(faceEntry.fill?.indices).toHaveLength(6);
    const doorEntry = entries[2]!;
    expect(doorEntry.fill).toBeDefined();
    // Door sits on the wall plane x=50 (plus a small anti-z-fight lift).
    const xs: number[] = [];
    for (let i = 0; i < doorEntry.fill!.positions.length; i += 3) xs.push(doorEntry.fill!.positions[i]!);
    for (const x of xs) expect(x).toBeCloseTo(50.08, 1);
  });

  it('skips hidden faces AND the features they host', () => {
    const feature = makeBuilding({
      building: { faces: [makeFace({ visible: false })], faceFeatures: [makeHosted()] },
    });
    const entries = buildBuildingComponentDisplayEntries(feature);
    expect(entries).toHaveLength(1); // envelope only
    const shownFaceHiddenFeature = makeBuilding({
      building: { faces: [makeFace()], faceFeatures: [makeHosted({ visible: false })] },
    });
    expect(buildBuildingComponentDisplayEntries(shownFaceHiddenFeature)).toHaveLength(2);
  });

  it('raises chimneys vertically off a sloped roof plane', () => {
    const fitted = fitFaceFromEvidence(ROOF_POINTS)!;
    const roofFace = makeFace({ id: 'face-roof', kind: 'roof', plane: fitted.plane, extents: fitted.extents });
    const chimney = makeHosted({ id: 'bfeat-chimney', faceId: 'face-roof', type: 'chimney', width: 2, height: 2, depth: 4 });
    const display = buildFaceFeatureDisplay(roofFace, chimney);
    const positions = display.fill!.positions;
    // 8 corners: base ring then top ring exactly 4 ft higher (world vertical).
    expect(positions).toHaveLength(24);
    for (let i = 0; i < 4; i++) {
      const baseZ = positions[i * 3 + 2]!;
      const topZ = positions[(i + 4) * 3 + 2]!;
      expect(topZ - baseZ).toBeCloseTo(4, 6);
      expect(positions[(i + 4) * 3]! - positions[i * 3]!).toBeCloseTo(0, 6); // no x drift
    }
  });

  it('previews a pending fit as outline plus diagonals', () => {
    const fitted = fitFaceFromEvidence(WALL_POINTS)!;
    const lines = faceFitPreviewLines(fitted);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveLength(5);
    const corners = faceCorners(fitted.plane, fitted.extents);
    expect(lines[1]).toEqual([corners[0], corners[2]]);
  });
});
