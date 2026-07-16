// src/viewer/utilityGenerators.test.ts - procedural utility display: geometry
// readers, above/below-ground pin behavior, tube runs, and the stub's
// deliberately incomplete look.

import { describe, expect, it } from 'vitest';
import type { FeatureRecord } from '../shared/workbench-types';
import type { Vec3 } from './geometry';
import {
  buildUtilityDisplay,
  buildUtilityDisplayEntry,
  dashPolyline,
  utilityDisplayColor,
  utilityLineGeometryFromFeature,
  utilityOriginFromFeature,
  utilityPointGeometryFromFeature,
} from './utilityGenerators';

function makeUtility(templateId: string, geometry: Record<string, unknown>, parameters: Record<string, unknown> = {}): FeatureRecord {
  const subtype = templateId.split('.')[1]!;
  return {
    id: `feat-${subtype}`,
    simulationId: 'sim-1',
    type: geometry.vertices ? 'polyline' : 'marker',
    name: subtype,
    geometry,
    createdAt: '2026-07-13T00:00:00.000Z',
    modifiedAt: '2026-07-13T00:00:00.000Z',
    family: 'utility',
    templateId,
    subtype,
    parameters,
    display: { visible: true },
    metadata: {},
  };
}

function zExtent(display: NonNullable<ReturnType<typeof buildUtilityDisplay>>): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const positions = display.fill?.positions ?? new Float64Array(0);
  for (let i = 2; i < positions.length; i += 3) {
    min = Math.min(min, positions[i]!);
    max = Math.max(max, positions[i]!);
  }
  for (const line of display.lines) {
    for (const [, , z] of line) {
      min = Math.min(min, z);
      max = Math.max(max, z);
    }
  }
  return { min, max };
}

describe('utility geometry readers', () => {
  it('reads point and line geometry only from utility features', () => {
    const point = makeUtility('utility.storm-manhole', { point: [10, 20, 100] });
    expect(utilityPointGeometryFromFeature(point)).toEqual({ point: [10, 20, 100] });
    expect(utilityLineGeometryFromFeature(point)).toBeNull();

    const line = makeUtility('utility.storm-pipe', { vertices: [[0, 0, 90], [50, 0, 89]] });
    expect(utilityLineGeometryFromFeature(line)).toEqual({ vertices: [[0, 0, 90], [50, 0, 89]] });
    expect(utilityPointGeometryFromFeature(line)).toBeNull();

    const notUtility = { ...point, family: 'object' as const };
    expect(utilityPointGeometryFromFeature(notUtility)).toBeNull();
  });

  it('resolves the origin pin: the point, or the start of a run', () => {
    expect(utilityOriginFromFeature(makeUtility('utility.generic-pole', { point: [1, 2, 3] }))).toEqual([1, 2, 3]);
    expect(utilityOriginFromFeature(makeUtility('utility.storm-pipe', { vertices: [[5, 6, 7], [8, 9, 10]] }))).toEqual([5, 6, 7]);
    expect(utilityOriginFromFeature(makeUtility('utility.storm-pipe', { vertices: [[5, 6, 7]] }))).toBeNull();
  });
});

describe('point-class displays', () => {
  it('extends a manhole DOWN from the rim pin (below-ground, pin at center top)', () => {
    const feature = makeUtility('utility.storm-manhole', { point: [0, 0, 100] }, { diameter: 4, depth: 8 });
    const display = buildUtilityDisplay(feature);
    expect(display?.fill).toBeDefined();
    const extent = zExtent(display!);
    expect(extent.min).toBeCloseTo(92, 5);
    // The lid bump sits just above the rim; the barrel must not rise past it.
    expect(extent.max).toBeLessThanOrEqual(100.2 + 1e-6);
  });

  it('extends a pole UP from the base pin (above-ground, pin at center bottom)', () => {
    const feature = makeUtility('utility.generic-pole', { point: [0, 0, 50] }, { diameter: 1, height: 20 });
    const display = buildUtilityDisplay(feature);
    const extent = zExtent(display!);
    expect(extent.min).toBeCloseTo(50, 5);
    expect(extent.max).toBeCloseTo(70, 5);
  });

  it('draws inlet grate bars across the top face', () => {
    const feature = makeUtility('utility.storm-inlet', { point: [0, 0, 10] }, { width: 3, length: 3, depth: 4 });
    const display = buildUtilityDisplay(feature);
    expect(display?.fill).toBeDefined();
    const barLines = display!.lines.filter((line) => line.length === 2 && line.every(([, , z]) => Math.abs(z - 10) < 1e-9));
    expect(barLines.length).toBeGreaterThanOrEqual(3);
  });

  it('returns null when the class geometry is missing or wrong-shaped', () => {
    expect(buildUtilityDisplay(makeUtility('utility.storm-manhole', { vertices: [[0, 0, 0], [1, 1, 1]] }))).toBeNull();
    expect(buildUtilityDisplay(makeUtility('utility.storm-pipe', { point: [0, 0, 0] }))).toBeNull();
  });
});

describe('line-class displays', () => {
  it('builds a round tube along the placed alignment with a centerline', () => {
    const vertices: Vec3[] = [[0, 0, 100], [60, 0, 99]];
    const feature = makeUtility('utility.storm-pipe', { vertices }, { pipeSize: 24, pipeShape: 'round' });
    const display = buildUtilityDisplay(feature);
    expect(display?.fill).toBeDefined();
    expect(display!.fill!.indices.length).toBeGreaterThan(0);
    // Centerline carried through as the last line.
    expect(display!.lines.at(-1)).toEqual(vertices);
    // 24" pipe => 1 ft radius: ring points sit ~1 ft off the axis in the YZ cross plane.
    const ring = display!.lines[0]!;
    const radial = Math.hypot(ring[0]![1] - 0, ring[0]![2] - 100);
    expect(radial).toBeCloseTo(1, 1);
  });

  it('builds an upright rectangular tube for box culverts plus flared end rings', () => {
    const feature = makeUtility(
      'utility.storm-culvert',
      { vertices: [[0, 0, 20], [40, 0, 19]] },
      { pipeShape: 'box', boxSpan: 6, boxRise: 4 },
    );
    const display = buildUtilityDisplay(feature);
    expect(display?.fill).toBeDefined();
    // Box rings close with 5 points (4 corners + repeat).
    expect(display!.lines[0]!.length).toBe(5);
    // Flared end rings (1.4x) extend past the box half-rise of 2.
    const extent = zExtent(display!);
    expect(extent.max).toBeGreaterThan(22);
  });

  it('renders stubs with no fill, dashed lines, and an end cross', () => {
    const vertices: Vec3[] = [[0, 0, 30], [20, 0, 30]];
    const feature = makeUtility('utility.storm-stub', { vertices }, { pipeSize: 15 });
    const display = buildUtilityDisplay(feature);
    expect(display?.fill).toBeUndefined();
    // Dashes: many short 2-point segments rather than one continuous line.
    expect(display!.lines.length).toBeGreaterThan(5);
    expect(display!.lines.every((line) => line.length === 2)).toBe(true);
    // End cross centered on the assumed endpoint.
    const cross = display!.lines.filter(
      (line) => line.some(([x]) => x > 20) && line.some(([x]) => x <= 20),
    );
    expect(cross.length).toBeGreaterThanOrEqual(1);
  });
});

describe('dashes and colors', () => {
  it('splits a segment into dash pieces separated by gaps', () => {
    const dashes = dashPolyline([[0, 0, 0], [10, 0, 0]], 2, 1);
    expect(dashes.length).toBeGreaterThanOrEqual(3);
    for (const [a, b] of dashes.map((dash) => [dash[0]!, dash[1]!])) {
      expect(b[0] - a[0]).toBeLessThanOrEqual(2 + 1e-9);
    }
  });

  it('tints storm green and generic pink, with above-ground lighter than buried', () => {
    const stormPipe = utilityDisplayColor(makeUtility('utility.storm-pipe', { vertices: [[0, 0, 0], [1, 0, 0]] }));
    const genericPole = utilityDisplayColor(makeUtility('utility.generic-pole', { point: [0, 0, 0] }));
    const genericVault = utilityDisplayColor(makeUtility('utility.generic-vault', { point: [0, 0, 0] }));
    expect(stormPipe.fill).toBe(0x3d8b4f);
    expect(genericPole.fill).toBe(0xc98bbf);
    expect(genericVault.fill).toBe(0x9a5f92);
  });

  it('bundles display + colors for the viewer entry path', () => {
    const entry = buildUtilityDisplayEntry(makeUtility('utility.storm-manhole', { point: [0, 0, 10] }));
    expect(entry?.fill).toBeDefined();
    expect(entry?.fillColor).toBe(0x3d8b4f);
    expect(buildUtilityDisplayEntry(makeUtility('utility.storm-manhole', {}))).toBeNull();
  });
});
