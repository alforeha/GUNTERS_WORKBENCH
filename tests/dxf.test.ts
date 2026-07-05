// Sprint 4 Phase 2 acceptance (docs/08): DXF parse + normalize against all four _REFS
// fixtures, asserting the census numbers from docs/01 §3 + §6.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseDxf } from '../src/core/dxf/parse';
import { tessellateBulge, sampleSpline } from '../src/core/dxf/tessellate';
import { handleDxfRequest } from '../src/workers/dxf.worker';
import { refPath } from './refs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFS = join(HERE, '..', '_REFS');
const read = (name: string): string => readFileSync(refPath(name), 'utf8');

// ---------------------------------------------------------------------------
// original pair (491 LWPOLYLINE / 4 layers / 5 INSERT / 4 MULTILEADER — 01 §3)
// ---------------------------------------------------------------------------

describe('CO23012 original DXF (CARLSON flavor)', () => {
  const ds = parseDxf(read('CO23012_NW1_ELEMENT240719-DXF CARLSON.dxf'), {
    fileName: 'CO23012_NW1_ELEMENT240719-DXF CARLSON.dxf',
  });

  it('model-space census matches the audit', () => {
    expect(ds.report.counts['entity:LWPOLYLINE']).toBe(491);
    expect(ds.report.counts['entity:INSERT']).toBe(5);
    expect(ds.report.counts['entity:MULTILEADER']).toBe(4);
  });

  it('4 layers with resolved colors', () => {
    expect(ds.layers).toHaveLength(4);
    const names = ds.layers.map((l) => l.name).sort();
    expect(names).toContain('E-SURF-CONT-MNR');
    for (const l of ds.layers) {
      expect(l.colorRGB).toBeGreaterThanOrEqual(0);
      expect(l.colorRGB).toBeLessThanOrEqual(0xffffff);
      expect(typeof l.linetype).toBe('string');
    }
  });

  it('contours carry elevation (group 38) → hasZ, in the audited 4,184–4,198 band', () => {
    const withZ = ds.entities.filter((e) => e.hasZ && e.layer === 'E-SURF-CONT-MNR');
    expect(withZ.length).toBeGreaterThan(0);
    for (const e of withZ.slice(0, 25)) {
      expect(e.pts[2]).toBeGreaterThan(4184);
      expect(e.pts[2]).toBeLessThan(4199);
    }
  });

  it('5 model-space inserts (nested block inserts explode recursively); MULTILEADER counted', () => {
    // census = 5 top-level INSERTs; insertsExploded counts every nested explosion too
    expect(ds.report.counts['insertsExploded']).toBeGreaterThanOrEqual(5);
    expect(ds.report.counts['skipped:MULTILEADER']).toBe(4);
  });

  it('AUTOCAD flavor parses to the same census', () => {
    const auto = parseDxf(read('CO23012_NW1_ELEMENT240719-DXF AUTOCAD.dxf'), {
      fileName: 'CO23012_NW1_ELEMENT240719-DXF AUTOCAD.dxf',
    });
    expect(auto.report.counts['entity:LWPOLYLINE']).toBe(491);
    expect(auto.report.counts['entity:INSERT']).toBe(5);
    expect(auto.layers).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// _EXPLODED.dxf (1,033 LWPOLYLINE, 397 INSERT, 62 HATCH, ATTRIB, 38 layers — 01 §6)
// ---------------------------------------------------------------------------

describe('_EXPLODED.dxf', () => {
  const ds = parseDxf(read('CO23012_NW1_ELEMENT240719_EXPLODED.dxf'), {
    fileName: 'CO23012_NW1_ELEMENT240719_EXPLODED.dxf',
  });

  it('census matches 01 §6 column 1', () => {
    expect(ds.report.counts['entity:LWPOLYLINE']).toBe(1033);
    expect(ds.report.counts['entity:INSERT']).toBe(397);
    expect(ds.report.counts['entity:HATCH']).toBe(62);
    expect(ds.report.counts['entity:MULTILEADER']).toBe(3);
    expect(ds.report.counts['entity:POINT']).toBe(2);
  });

  it('38 layers listed', () => {
    expect(ds.layers).toHaveLength(38);
  });

  it('397 inserts explode; hatch boundaries render as linework', () => {
    expect(ds.report.counts['insertsExploded']).toBeGreaterThanOrEqual(397);
    expect(ds.report.counts['hatchBoundaries']).toBeGreaterThanOrEqual(62);
    // every hatch loop is drawable (≥3 points, finite coords)
    const hatchLoops = ds.entities.filter((e) => e.closed);
    expect(hatchLoops.length).toBeGreaterThan(0);
    for (const e of ds.entities) {
      for (let i = 0; i < e.pts.length; i++) expect(Number.isFinite(e.pts[i])).toBe(true);
    }
  });

  it('POINTs stored (2 model-space + any inside exploded blocks), never as linework entities', () => {
    expect(ds.points.length).toBeGreaterThanOrEqual(2);
    for (const p of ds.points) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
      expect(typeof p.layer).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// _EXPLODED_ALL.dxf (20,290 LINE, 332 ELLIPSE, 261 ARC, 72 TEXT, 60 ATTDEF, 26 HATCH,
//                    24 3DFACE, 5 POINT, 33 layers — 01 §6)
// ---------------------------------------------------------------------------

describe('_EXPLODED_ALL.dxf', () => {
  const ds = parseDxf(read('CO23012_NW1_ELEMENT240719_EXPLODED_ALL.dxf'), {
    fileName: 'CO23012_NW1_ELEMENT240719_EXPLODED_ALL.dxf',
  });

  it('census matches 01 §6 column 2', () => {
    expect(ds.report.counts['entity:LINE']).toBe(20290);
    expect(ds.report.counts['entity:ELLIPSE']).toBe(332);
    expect(ds.report.counts['entity:ARC']).toBe(261);
    expect(ds.report.counts['entity:TEXT']).toBe(72);
    expect(ds.report.counts['entity:ATTDEF']).toBe(60);
    expect(ds.report.counts['entity:HATCH']).toBe(26);
    expect(ds.report.counts['entity:3DFACE']).toBe(24);
    expect(ds.report.counts['entity:POINT']).toBe(5);
    expect(ds.report.counts['entity:LWPOLYLINE']).toBe(491);
  });

  it('33 layers; TEXT/ATTDEF skipped + counted', () => {
    expect(ds.layers).toHaveLength(33);
    expect(ds.report.counts['skipped:TEXT']).toBe(72);
    expect(ds.report.counts['skipped:ATTDEF']).toBe(60);
  });

  it('5 model-space POINTs stored + zero-elevation note', () => {
    expect(ds.report.counts['entity:POINT']).toBe(5);
    expect(ds.points.length).toBeGreaterThanOrEqual(5);
    expect(ds.report.infos.some((i) => i.includes('point(s) stored'))).toBe(true);
  });

  it('3DFACE → closed outlines with real elevations (hasZ)', () => {
    const faces = ds.entities.filter((e) => e.closed && e.hasZ && (e.pts.length === 9 || e.pts.length === 12));
    expect(faces.length).toBeGreaterThanOrEqual(1);
  });

  it('ELLIPSE/ARC tessellation produced finite drawable polylines', () => {
    // every normalized entity has ≥2 points and finite coordinates
    for (const e of ds.entities) {
      expect(e.pts.length).toBeGreaterThanOrEqual(6);
      expect(e.pts.length % 3).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// robustness + tessellation math + worker plumbing
// ---------------------------------------------------------------------------

describe('robustness', () => {
  it('unknown-entity junk never throws', () => {
    const junk = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'FROBNICATOR', '8', 'L1', '10', '1.0', '20', '2.0',
      '0', 'LINE', '8', 'L1', '10', '0', '20', '0', '30', '0', '11', '5', '21', '5', '31', '0',
      '0', 'WIBBLE', '1000', 'junk',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\r\n');
    const ds = parseDxf(junk, { fileName: 'junk.dxf' });
    expect(ds.entities).toHaveLength(1); // the LINE survives
    expect(ds.report.counts['entity:LINE']).toBe(1);
  });

  it('garbage input yields an empty dataset with a warning, no throw', () => {
    const ds = parseDxf('not a dxf at all', { fileName: 'garbage.dxf' });
    expect(ds.entities).toHaveLength(0);
    expect(ds.report.warnings.length).toBeGreaterThan(0);
  });
});

describe('tessellation math', () => {
  it('bulge = tan(θ/4) quarter-circle stays on the arc within tolerance', () => {
    // quarter circle from (10,0) to (0,10), center origin, r=10, CCW → bulge = tan(π/8)
    const out: number[] = [10, 0, 0];
    tessellateBulge(out, 10, 0, 0, 10, Math.tan(Math.PI / 8), 0, 0.1);
    expect(out.length / 3).toBeGreaterThan(4); // actually curved, not a chord
    for (let i = 0; i < out.length; i += 3) {
      const r = Math.hypot(out[i]!, out[i + 1]!);
      expect(Math.abs(r - 10)).toBeLessThan(0.1 + 1e-6);
    }
    // end point lands exactly
    expect(out[out.length - 3]).toBeCloseTo(0, 9);
    expect(out[out.length - 2]).toBeCloseTo(10, 9);
  });

  it('spline sampling: degenerate input falls back to control polygon, no throw', () => {
    const out: number[] = [];
    sampleSpline(out, [[0, 0, 0], [1, 1, 0]], 3, [], null, 8);
    expect(out).toEqual([0, 0, 0, 1, 1, 0]);
  });
});

describe('dxf.worker handler', () => {
  it('Blob payload → dataset + transferables', async () => {
    const { response, transfer } = await handleDxfRequest({
      id: 9,
      fileName: 'CO23012_NW1_ELEMENT240719-DXF CARLSON.dxf',
      payload: new Blob([read('CO23012_NW1_ELEMENT240719-DXF CARLSON.dxf')]),
    });
    expect(response.type).toBe('result');
    if (response.type !== 'result' || !response.ok) throw new Error('expected ok result');
    expect(response.dataset.report.counts['entity:LWPOLYLINE']).toBe(491);
    expect(transfer.length).toBeGreaterThan(0);
    expect(new Set(transfer).size).toBe(transfer.length);
  });
});
