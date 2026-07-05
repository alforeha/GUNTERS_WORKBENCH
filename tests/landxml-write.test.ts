import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Boundary, Breakline, Polyline3D, SurfaceModel } from '../src/core/contract';
import { parseLandXML } from '../src/core/landxml/parse';
import { writeLandXML } from '../src/core/landxml/write';
import { RenderSurface } from '../src/viewer/RenderSurface';
import { refPath } from './refs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFS = join(HERE, '..', '_REFS');
const FIXTURES = join(HERE, 'fixtures');

async function parseFixture(name: string): Promise<SurfaceModel[]> {
  const text = readFileSync(join(FIXTURES, name), 'utf8');
  return (await parseLandXML(text, { fileName: name })).surfaces;
}

function comparePolylines(actual: Polyline3D[] | undefined, expected: Polyline3D[] | undefined): void {
  expect(actual?.length ?? 0).toBe(expected?.length ?? 0);
  for (let i = 0; i < (expected?.length ?? 0); i++) {
    expect(Array.from(actual?.[i]?.pts ?? [])).toEqual(Array.from(expected?.[i]?.pts ?? []));
  }
}

function compareBreaklines(actual: Breakline[], expected: Breakline[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]?.sourceSpelling).toBe(expected[i]?.sourceSpelling);
    expect(Array.from(actual[i]?.pts ?? [])).toEqual(Array.from(expected[i]?.pts ?? []));
  }
}

function compareBoundaries(actual: Boundary[], expected: Boundary[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]?.kind).toBe(expected[i]?.kind);
    expect(Array.from(actual[i]?.pts ?? [])).toEqual(Array.from(expected[i]?.pts ?? []));
  }
}

describe('writeLandXML', () => {
  it('round-trips the Carlson sample value-identically for geometry and source metadata', async () => {
    const text = readFileSync(refPath('CO23012_TOPO.XML'), 'utf8');
    const original = (await parseLandXML(text, { fileName: 'CO23012_TOPO.XML' })).surfaces[0]!;
    const { xml } = writeLandXML(original, {
      surfaceSummaries: { [original.id]: { modifiedVertexCount: 0, modified: false } },
    });
    const reparsed = (await parseLandXML(xml, { fileName: 'CO23012_TOPO_roundtrip.xml' })).surfaces[0]!;

    expect(reparsed.name).toBe(original.name);
    expect(reparsed.precisionHint).toBe(original.precisionHint);
    expect(reparsed.meta.units).toEqual(original.meta.units);
    expect(Array.from(reparsed.sourcePointIds)).toEqual(Array.from(original.sourcePointIds));
    expect(Array.from(reparsed.positions)).toEqual(Array.from(original.positions));
    expect(Array.from(reparsed.indices ?? [])).toEqual(Array.from(original.indices ?? []));
    expect(Array.from(reparsed.faceVisibility ?? [])).toEqual(Array.from(original.faceVisibility ?? []));
    compareBreaklines(reparsed.breaklines, original.breaklines);
    compareBoundaries(reparsed.boundaries, original.boundaries);
    comparePolylines(reparsed.contours, original.contours);
  });

  it('writes edited Z values and provenance comments without changing untouched vertices', async () => {
    const text = readFileSync(refPath('CO23012_TOPO.XML'), 'utf8');
    const original = (await parseLandXML(text, { fileName: 'CO23012_TOPO.XML' })).surfaces[0]!;
    const model: SurfaceModel = {
      ...original,
      positions: original.positions.slice(),
      sourcePointIds: original.sourcePointIds.slice(),
      indices: original.indices?.slice() ?? null,
      faceVisibility: original.faceVisibility?.slice() ?? null,
      breaklines: original.breaklines.map((item) => ({ ...item, pts: item.pts.slice() })),
      boundaries: original.boundaries.map((item) => ({ ...item, pts: item.pts.slice() })),
      contours: original.contours?.map((item) => ({ pts: item.pts.slice() })),
    };
    const render = new RenderSurface('s1', model, [0, 0, 0]);
    const vertexId = 0;
    const originalZ = model.positions[vertexId * 3 + 2]!;
    const nextZ = Number((originalZ + 1.25).toFixed(model.precisionHint));
    const moved = render.applyVertexMove(
      vertexId,
      [model.positions[0]!, model.positions[1]!, nextZ],
      false,
    );
    render.dispose();

    expect(moved.changed).toBe(true);
    model.dirty = true;
    model.provenance = 'modified';

    const { xml } = writeLandXML(model, {
      surfaceSummaries: { [model.id]: { modifiedVertexCount: 1, modified: true } },
    });
    expect(xml).toContain('1 vertex modified');

    const reparsed = (await parseLandXML(xml, { fileName: 'CO23012_TOPO_edited.xml' })).surfaces[0]!;
    expect(reparsed.positions[vertexId * 3 + 2]).toBeCloseTo(nextZ, model.precisionHint);
    for (let i = 0; i < model.positions.length; i++) {
      if (i === vertexId * 3 + 2) continue;
      expect(reparsed.positions[i]).toBe(model.positions[i]);
    }
  });

  it('round-trips synthetic fixtures without crashing, including sparse ids and faceless surfaces', async () => {
    for (const name of ['two-surfaces.xml', 'faceless.xml', 'spec-breaklines.xml', 'contours.xml']) {
      const original = await parseFixture(name);
      const { xml } = writeLandXML(
        original,
        {
          surfaceSummaries: Object.fromEntries(
            original.map((surface) => [surface.id, { modifiedVertexCount: 0, modified: false }]),
          ),
        },
      );
      const reparsed = (await parseLandXML(xml, { fileName: `${name}.roundtrip.xml` })).surfaces;
      expect(reparsed).toHaveLength(original.length);
    }
  });
});
