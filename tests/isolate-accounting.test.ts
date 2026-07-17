import { describe, expect, it } from 'vitest';
import type { PointCloudNodePayload } from '../src/core/contract';
import {
  countPayloadPointsInPolygon,
  formatIsolateDisclosure,
  polygonBoundsXY,
  regionToRenderPolygon,
  renderPolygonToSurveyRegion,
  type IsolateAccounting,
} from '../src/viewer/isolateAccounting';
import { defaultFilterState } from '../src/viewer/pointCloudLod';

function payloadAt(points: { x: number; y: number; cls?: number }[]): PointCloudNodePayload {
  const count = points.length;
  const positions = new Float32Array(count * 3);
  const classifications = new Uint8Array(count).fill(1);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = points[i]!.x;
    positions[i * 3 + 1] = points[i]!.y;
    if (points[i]!.cls !== undefined) classifications[i] = points[i]!.cls!;
  }
  return {
    pointCount: count,
    positions,
    colors: new Uint8Array(count * 3),
    intensities: new Float32Array(count),
    classifications,
    returnNumbers: new Uint8Array(count).fill(1),
    numberOfReturns: new Uint8Array(count).fill(1),
  };
}

// Unit square polygon in render-local XY.
const SQUARE = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 2 },
  { x: 0, y: 2 },
];

describe('polygon/region coordinate conversion', () => {
  it('computes polygon XY bounds', () => {
    expect(polygonBoundsXY(SQUARE)).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 2 });
  });

  it('round-trips a survey region through render-local space and back', () => {
    const sceneOrigin: [number, number, number] = [100, 200, 50];
    const region = { minX: 104, minY: 208, maxX: 112, maxY: 216 };
    const polygon = regionToRenderPolygon(region, sceneOrigin);
    // Render-local: survey minus scene origin.
    expect(polygonBoundsXY(polygon)).toEqual({ minX: 4, minY: 8, maxX: 12, maxY: 16 });
    expect(renderPolygonToSurveyRegion(polygon, sceneOrigin)).toEqual(region);
  });
});

describe('countPayloadPointsInPolygon', () => {
  it('counts only points inside the polygon', () => {
    const payload = payloadAt([
      { x: 1, y: 1 }, // inside
      { x: 0.5, y: 1.5 }, // inside
      { x: 3, y: 1 }, // outside x
      { x: 1, y: -1 }, // outside y
    ]);
    const counts = countPayloadPointsInPolygon(payload, 0, 0, SQUARE, defaultFilterState());
    expect(counts).toEqual({ inside: 2, insideFiltered: 2 });
  });

  it('applies the tile offset before testing (payloads are index-origin-relative)', () => {
    // Point stored at payload [-3, -3]; tile group sits at [4, 4] → render [1, 1] (inside).
    const payload = payloadAt([
      { x: -3, y: -3 },
      { x: 3, y: 3 }, // render [7, 7] → outside
    ]);
    const counts = countPayloadPointsInPolygon(payload, 4, 4, SQUARE, defaultFilterState());
    expect(counts).toEqual({ inside: 1, insideFiltered: 1 });
  });

  it('splits loaded-in-memory from drawable when a class filter hides points', () => {
    const payload = payloadAt([
      { x: 1, y: 1, cls: 2 },
      { x: 1.5, y: 1.5, cls: 7 }, // filtered out below
    ]);
    const filter = defaultFilterState();
    filter.classes[7] = false;
    const counts = countPayloadPointsInPolygon(payload, 0, 0, SQUARE, filter);
    expect(counts).toEqual({ inside: 2, insideFiltered: 1 });
  });
});

function accounting(overrides: Partial<IsolateAccounting> = {}): IsolateAccounting {
  return {
    focusActive: true,
    regionActive: false,
    estimatedAreaPoints: 10_000,
    regionSelectedPoints: 0,
    regionLoadedPoints: 0,
    regionBudgetLimited: false,
    loadedInArea: 842,
    drawnInArea: 842,
    ...overrides,
  };
}

describe('formatIsolateDisclosure', () => {
  it('says so when the index has no points near the area', () => {
    expect(formatIsolateDisclosure(accounting({ estimatedAreaPoints: 0 }))).toBe(
      'Isolate: no indexed points found in area',
    );
  });

  it('discloses focus-only state with the area estimate and a Load All hint', () => {
    const text = formatIsolateDisclosure(accounting());
    expect(text).toContain('842 pts in area');
    expect(text).toContain('view-density streaming only');
    expect(text).toContain('Load All');
    expect(text).toContain('~10K indexed near area');
  });

  it('separates drawn from loaded when a filter hides points', () => {
    const text = formatIsolateDisclosure(accounting({ drawnInArea: 300, loadedInArea: 842 }));
    expect(text).toContain('300 drawn / 842 loaded in area');
  });

  it('discloses load-all streaming progress', () => {
    const text = formatIsolateDisclosure(
      accounting({ regionActive: true, regionSelectedPoints: 7_400_000, regionLoadedPoints: 1_900_000 }),
    );
    expect(text).toContain('Load All loading 1.9M of 7.4M tile pts');
  });

  it('discloses load-all completion with the sector position', () => {
    const text = formatIsolateDisclosure(
      accounting({ regionActive: true, regionSelectedPoints: 120_000, regionLoadedPoints: 120_000 }),
      { index: 0, count: 4 },
    );
    expect(text).toContain('Load All full data loaded (120K tile pts)');
    expect(text).toContain('sector 1 of 4');
  });

  it('discloses when the budget cut the region selection short', () => {
    const text = formatIsolateDisclosure(
      accounting({ regionActive: true, regionSelectedPoints: 5_000_000, regionLoadedPoints: 5_000_000, regionBudgetLimited: true }),
    );
    expect(text).toContain('budget-limited');
  });

  it('omits the sector label for a single-sector plan', () => {
    const text = formatIsolateDisclosure(
      accounting({ regionActive: true, regionSelectedPoints: 100, regionLoadedPoints: 100 }),
      { index: 0, count: 1 },
    );
    expect(text).not.toContain('sector');
  });
});
