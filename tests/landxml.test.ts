// Work Order B acceptance tests (docs/05 §B3) — parser only, no DOM, no Three.js.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { SurfaceModel } from '../src/core/contract';
import { parseLandXML } from '../src/core/landxml/parse';
import { collectTransferables, handleParseRequest } from '../src/workers/parse.worker';
import { refPath } from './refs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFS = join(HERE, '..', '_REFS');
const FIXTURES = join(HERE, 'fixtures');

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

function chunkedStream(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(pos, Math.min(pos + chunkSize, bytes.length)));
      pos += chunkSize;
    },
  });
}

// ---------------------------------------------------------------------------
// real Carlson sample: _REFS/CO23012_TOPO.XML
// ---------------------------------------------------------------------------

const text = readFileSync(refPath('CO23012_TOPO.XML'), 'utf8');
const { surfaces } = await parseLandXML(text, { fileName: 'CO23012_TOPO.XML' });
const s = surfaces[0] as SurfaceModel;

describe('CO23012_TOPO.XML (Carlson sample)', () => {

  it('parses exactly 1 surface with expected identity + metadata', () => {
    expect(surfaces).toHaveLength(1);
    expect(s.name).toBe('CO23012_NW1_TOPO');
    expect(s.meta.units.linear).toBe('usSurveyFoot');
    expect(s.meta.units.raw).toBe('USSurveyFoot');
    expect(s.meta.producer).toBe('Carlson Survey');
    expect(s.meta.formatVersion).toBe('LandXML-1.2');
    expect(s.meta.format).toBe('landxml');
    expect(s.meta.fileName).toBe('CO23012_TOPO.XML');
  });

  it('has 2,782 points; first point E/N/Z swapped from N E Z source order; ids 1…2782', () => {
    expect(s.sourcePointIds).toHaveLength(2782);
    expect(s.positions).toHaveLength(2782 * 3);
    // source line: <P id="1">1511101.21800000 3510094.28400000 4185.801000</P>  (N E Z)
    expect(s.positions[0]).toBeCloseTo(3510094.284, 9); // x = Easting
    expect(s.positions[1]).toBeCloseTo(1511101.218, 9); // y = Northing
    expect(s.positions[2]).toBeCloseTo(4185.801, 9);    // z = Elevation
    expect(s.sourcePointIds[0]).toBe(1);
    expect(s.sourcePointIds[2781]).toBe(2782);
    for (let i = 0; i < 2782; i++) {
      if (s.sourcePointIds[i] !== i + 1) throw new Error(`id discontinuity at ${i}`);
    }
  });

  it('has 5,020 faces; first face (3, 4, 2) zero-based; faceVisibility === null', () => {
    expect(s.indices).not.toBeNull();
    expect(s.indices).toHaveLength(5020 * 3);
    // source first face: <F>4 5 3</F> (1-based) → (3, 4, 2)
    expect(Array.from(s.indices!.subarray(0, 3))).toEqual([3, 4, 2]);
    expect(s.faceVisibility).toBeNull();
  });

  it('has ZERO breaklines — SourceData/DataPoints is the paginated point inventory (rev 1.2)', () => {
    // Phase 0 correction (docs/08): the 11 PntList3D lists (10×256 + 222 = 2,782 points) are
    // the complete <Pnts> inventory chunked at 256/page, NOT breaklines.
    expect(s.breaklines).toHaveLength(0);
    expect(s.sourceDataPointLists).toEqual({ count: 11, totalPoints: 2782 });
    expect(
      s.report.infos.some((i) => i.includes('11 source-data point lists') && i.includes('2,782')),
    ).toBe(true);
  });

  it('0 boundaries; provenance source-explicit; triangulation preserved; counts populated', () => {
    expect(s.boundaries).toHaveLength(0);
    expect(s.provenance).toBe('source-explicit');
    expect(s.report.triangulationPreserved).toBe(true);
    expect(s.report.counts['points']).toBe(2782);
    expect(s.report.counts['faces']).toBe(5020);
    expect(s.report.counts['breaklines']).toBe(0);
    expect(s.report.counts['sourceDataPointLists']).toBe(11);
    expect(s.report.counts['boundaries']).toBe(0);
    expect(s.edges).toBeNull();
    expect(s.dirty).toBe(false);
  });

  it('captures precisionHint from source decimal places (max 8 in this file)', () => {
    expect(s.precisionHint).toBe(8);
  });

  it('parses identically when streamed in odd-sized byte chunks', async () => {
    const { surfaces: streamed } = await parseLandXML(chunkedStream(text, 1009), {
      fileName: 'CO23012_TOPO.XML',
    });
    const t = streamed[0] as SurfaceModel;
    expect(t.sourcePointIds).toHaveLength(2782);
    expect(t.indices).toHaveLength(5020 * 3);
    expect(t.breaklines).toHaveLength(0);
    expect(t.sourceDataPointLists).toEqual({ count: 11, totalPoints: 2782 });
    expect(t.positions).toEqual(s.positions);
    expect(t.indices).toEqual(s.indices);
  });
});

// ---------------------------------------------------------------------------
// synthetic fixtures
// ---------------------------------------------------------------------------

describe('synthetic fixtures', () => {
  it('metric file: meter units, points, faces, <F i="1"> visibility flag', async () => {
    const { surfaces } = await parseLandXML(fixture('metric.xml'), { fileName: 'metric.xml' });
    const s = surfaces[0] as SurfaceModel;
    expect(surfaces).toHaveLength(1);
    expect(s.meta.units.linear).toBe('meter');
    expect(s.meta.units.raw).toBe('meter');
    expect(s.sourcePointIds).toHaveLength(4);
    expect(Array.from(s.indices!)).toEqual([0, 1, 2, 1, 3, 2]);
    expect(s.faceVisibility).not.toBeNull();
    expect(Array.from(s.faceVisibility!)).toEqual([1, 0]); // second face <F i="1"> = invisible
    expect(s.precisionHint).toBe(3);
  });

  it('two-surface file: sparse non-contiguous ids resolve; per-surface reports', async () => {
    const { surfaces } = await parseLandXML(fixture('two-surfaces.xml'), { fileName: 'two-surfaces.xml' });
    expect(surfaces).toHaveLength(2);
    const [a, b] = surfaces as [SurfaceModel, SurfaceModel];

    expect(a.name).toBe('SPARSE_IDS');
    expect(Array.from(a.sourcePointIds)).toEqual([10, 20, 30]); // preserved for export
    expect(Array.from(a.indices!)).toEqual([0, 1, 2]);          // <F>10 20 30</F> resolved via id map
    expect(a.report.triangulationPreserved).toBe(true);

    expect(b.name).toBe('SECOND_FACELESS');
    expect(b.indices).toBeNull();
    expect(b.report.triangulationPreserved).toBe(false);
    expect(a.meta.units.linear).toBe('usSurveyFoot');
    expect(b.meta.units.linear).toBe('usSurveyFoot');
  });

  it('faceless file: indices null, triangulationPreserved false, rebuild warning', async () => {
    const { surfaces } = await parseLandXML(fixture('faceless.xml'), { fileName: 'faceless.xml' });
    const s = surfaces[0] as SurfaceModel;
    expect(s.indices).toBeNull();
    expect(s.faceVisibility).toBeNull();
    expect(s.report.triangulationPreserved).toBe(false);
    expect(s.report.warnings.some((w) => w.includes('no faces') && w.includes('rebuild'))).toBe(true);
    expect(s.report.counts['faces']).toBe(0);
    expect(s.report.counts['points']).toBe(3);
  });

  it('spec <Breaklines> spelling + boundaries with all three kinds', async () => {
    const { surfaces } = await parseLandXML(fixture('spec-breaklines.xml'), { fileName: 'spec-breaklines.xml' });
    const s = surfaces[0] as SurfaceModel;
    expect(s.breaklines).toHaveLength(2);
    for (const b of s.breaklines) expect(b.sourceSpelling).toBe('spec-breaklines');
    expect(s.breaklines[0]!.pts).toHaveLength(9);
    // N E Z → x=E, y=N, z=Z
    expect(s.breaklines[0]!.pts[0]).toBeCloseTo(200.0, 9);
    expect(s.breaklines[0]!.pts[1]).toBeCloseTo(100.0, 9);
    expect(s.breaklines[0]!.pts[2]).toBeCloseTo(10.0, 9);

    expect(s.boundaries).toHaveLength(3);
    expect(s.boundaries.map((b) => b.kind)).toEqual(['outer', 'inclusion', 'exclusion']);
    // PntList2D boundary → z = 0
    const b2d = s.boundaries[2]!;
    expect(b2d.pts).toHaveLength(9);
    expect(b2d.pts[2]).toBe(0);
    expect(s.report.counts['breaklines']).toBe(2);
    expect(s.report.counts['boundaries']).toBe(3);
  });

  it('junk unknown elements: surface-level counted per surface, file-level in report.fileLevel ONCE', async () => {
    const { surfaces } = await parseLandXML(fixture('junk-unknowns.xml'), { fileName: 'junk-unknowns.xml' });
    const s = surfaces[0] as SurfaceModel;
    expect(s.sourcePointIds).toHaveLength(3);
    expect(s.indices).toHaveLength(3);
    // inside <Surface> → per-surface report
    const u = s.report.unknownElements;
    expect(u['FrobnicatorSettings']).toBe(1);
    expect(u['Frob']).toBe(2);
    expect(u['Telemetry']).toBe(1);
    expect(u['Beacon']).toBe(1);
    expect(u['VendorMagic']).toBeUndefined(); // no longer duplicated onto the surface (rev 1.1)
    // outside any <Surface> → fileLevel on the FIRST surface only
    const fl = s.report.fileLevel;
    expect(fl).toBeDefined();
    expect(fl!.unknownElements['VendorMagic']).toBe(1);
    expect(fl!.unknownElements['Sparkles']).toBe(1);
    expect(fl!.unknownElements['TrailingJunk']).toBe(1);
    expect(fl!.unknownElements['Frob']).toBeUndefined();
  });

  it('contours round into SurfaceModel.contours (stored, counted, info noted) — contract rev 1.1', async () => {
    const { surfaces } = await parseLandXML(fixture('contours.xml'), { fileName: 'contours.xml' });
    const s = surfaces[0] as SurfaceModel;
    expect(s.contours).toBeDefined();
    expect(s.contours).toHaveLength(2);
    // first contour: 3 pts, N E Z source order → stored x=E, y=N, z=Z
    const c0 = s.contours![0]!;
    expect(c0.pts).toHaveLength(9);
    expect(c0.pts[0]).toBeCloseTo(200.0, 9); // E
    expect(c0.pts[1]).toBeCloseTo(100.0, 9); // N
    expect(c0.pts[2]).toBeCloseTo(50.0, 9);  // Z
    // second contour came from PntList2D → z = 0
    expect(s.contours![1]!.pts[2]).toBe(0);
    expect(s.report.counts['contours']).toBe(2);
    expect(s.report.infos.some((i) => i.includes('contour') && i.includes('stored'))).toBe(true);
  });

  it('two-surface file with file-level junk: fileLevel appears on the FIRST surface only', async () => {
    const xml =
      '<?xml version="1.0"?><LandXML version="1.2"><Units><Metric linearUnit="meter"/></Units>' +
      '<MysteryRoot/><Surfaces>' +
      '<Surface name="A"><Definition><Pnts><P id="1">1 2 3</P></Pnts></Definition></Surface>' +
      '<Surface name="B"><Definition><Pnts><P id="1">4 5 6</P></Pnts></Definition></Surface>' +
      '</Surfaces></LandXML>';
    const { surfaces } = await parseLandXML(xml);
    expect(surfaces).toHaveLength(2);
    expect(surfaces[0]!.report.fileLevel?.unknownElements['MysteryRoot']).toBe(1);
    expect(surfaces[1]!.report.fileLevel).toBeUndefined();
  });

  it('namespace prefixes are stripped to local names', async () => {
    const { surfaces } = await parseLandXML(fixture('ns-prefix.xml'), { fileName: 'ns-prefix.xml' });
    const s = surfaces[0] as SurfaceModel;
    expect(surfaces).toHaveLength(1);
    expect(s.name).toBe('PREFIXED');
    expect(s.sourcePointIds).toHaveLength(3);
    expect(Array.from(s.indices!)).toEqual([0, 1, 2]);
    expect(s.meta.units.linear).toBe('meter');
  });
});

// ---------------------------------------------------------------------------
// inline edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  const wrap = (inner: string): string =>
    `<?xml version="1.0"?><LandXML version="1.2"><Units><Metric linearUnit="meter"/></Units>` +
    `<Surfaces><Surface name="T"><Definition surfType="TIN">${inner}</Definition></Surface></Surfaces></LandXML>`;

  it('<P> without id: sequential ids assigned with a warning', async () => {
    const { surfaces } = await parseLandXML(
      wrap('<Pnts><P>1.0 2.0 3.0</P><P>4.0 5.0 6.0</P></Pnts>'),
    );
    const s = surfaces[0] as SurfaceModel;
    expect(Array.from(s.sourcePointIds)).toEqual([1, 2]);
    expect(s.report.warnings.some((w) => w.includes('without id'))).toBe(true);
  });

  it('face referencing unknown point id is skipped with a warning, not thrown', async () => {
    const { surfaces } = await parseLandXML(
      wrap('<Pnts><P id="1">1.0 2.0 3.0</P><P id="2">4.0 5.0 6.0</P><P id="3">7.0 8.0 9.0</P></Pnts>' +
           '<Faces><F>1 2 3</F><F>1 2 99</F></Faces>'),
    );
    const s = surfaces[0] as SurfaceModel;
    expect(s.indices).toHaveLength(3);
    expect(s.report.counts['skippedFaces']).toBe(1);
    expect(s.report.warnings.some((w) => w.includes('unknown point id'))).toBe(true);
  });

  it('survives a stream split at every interesting boundary (3-byte chunks)', async () => {
    const xml = wrap(
      '<Pnts><P id="1">1511101.218 3510094.284 4185.801</P><P id="2">4.0 5.0 6.0</P>' +
      '<P id="3">7.0 8.0 9.0</P></Pnts><Faces><F>1 2 3</F></Faces>',
    );
    const { surfaces } = await parseLandXML(chunkedStream(xml, 3));
    const s = surfaces[0] as SurfaceModel;
    expect(s.sourcePointIds).toHaveLength(3);
    expect(s.positions[0]).toBeCloseTo(3510094.284, 9);
    expect(s.positions[1]).toBeCloseTo(1511101.218, 9);
    expect(Array.from(s.indices!)).toEqual([0, 1, 2]);
  });

  it('whole file with no <Units>: defaults to meter with warning', async () => {
    const xml = '<?xml version="1.0"?><LandXML version="1.2"><Surfaces><Surface name="U">' +
      '<Definition><Pnts><P id="1">1.0 2.0 3.0</P></Pnts></Definition></Surface></Surfaces></LandXML>';
    const { surfaces } = await parseLandXML(xml);
    const s = surfaces[0] as SurfaceModel;
    expect(s.meta.units.linear).toBe('meter');
    expect(s.report.warnings.some((w) => w.includes('no <Units>'))).toBe(true);
  });

  it('garbage input yields zero surfaces, no throw', async () => {
    const { surfaces } = await parseLandXML('this is < not > xml & certainly <not LandXML');
    expect(surfaces).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// worker wrapper (Node-testable plumbing)
// ---------------------------------------------------------------------------

describe('parse.worker handler', () => {
  it('Blob payload → surfaces + deduplicated transferables', async () => {
    const text = readFileSync(refPath('CO23012_TOPO.XML'), 'utf8');
    const { response, transfer } = await handleParseRequest({
      id: 42,
      fileName: 'CO23012_TOPO.XML',
      payload: new Blob([text]),
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.id).toBe(42);
    expect(response.surfaces).toHaveLength(1);
    const s = response.surfaces[0] as SurfaceModel;
    expect(s.report.counts['points']).toBe(2782);
    // transfer list contains every owned buffer exactly once
    expect(transfer).toContain(s.positions.buffer);
    expect(transfer).toContain(s.sourcePointIds.buffer);
    expect(transfer).toContain(s.indices!.buffer);
    expect(new Set(transfer).size).toBe(transfer.length);
  });

  it('collectTransferables skips null members and dedupes', async () => {
    const { surfaces } = await parseLandXML(fixture('faceless.xml'), { fileName: 'faceless.xml' });
    const t = collectTransferables(surfaces);
    expect(t).toContain((surfaces[0] as SurfaceModel).positions.buffer);
    expect(t).toHaveLength(2); // positions + sourcePointIds only
  });

  it('collectTransferables includes contour buffers (rev 1.1)', async () => {
    const { surfaces } = await parseLandXML(fixture('contours.xml'), { fileName: 'contours.xml' });
    const t = collectTransferables(surfaces);
    for (const c of (surfaces[0] as SurfaceModel).contours ?? []) expect(t).toContain(c.pts.buffer);
  });
});

// ---------------------------------------------------------------------------
// progress events (docs/06 D3) — Node-testable via the onProgress callback
// ---------------------------------------------------------------------------

describe('parse progress (D3)', () => {
  it('string input: reading → parsing… → building, bytes monotonic to total', async () => {
    const events: { phase: string; bytesProcessed: number; bytesTotal: number }[] = [];
    await parseLandXML(text, { fileName: 'CO23012_TOPO.XML', onProgress: (p) => events.push(p) });
    expect(events[0]!.phase).toBe('reading');
    expect(events[events.length - 1]!.phase).toBe('building');
    expect(events.some((e) => e.phase === 'parsing')).toBe(true);
    let last = 0;
    for (const e of events) {
      expect(e.bytesTotal).toBe(text.length);
      expect(e.bytesProcessed).toBeGreaterThanOrEqual(last);
      last = e.bytesProcessed;
    }
    expect(last).toBe(text.length);
  });

  it('stream input: one parsing event per chunk; bytesTotal honored when provided', async () => {
    const events: { phase: string; bytesProcessed: number; bytesTotal: number }[] = [];
    const bytes = new TextEncoder().encode(text).length;
    await parseLandXML(chunkedStream(text, 64 * 1024), {
      onProgress: (p) => events.push(p),
      bytesTotal: bytes,
    });
    const parsing = events.filter((e) => e.phase === 'parsing');
    expect(parsing.length).toBeGreaterThanOrEqual(Math.floor(bytes / (64 * 1024)));
    expect(events[events.length - 1]!.bytesProcessed).toBe(bytes);
    expect(events.every((e) => e.bytesTotal === bytes)).toBe(true);
  });

  it('stream input without a total reports bytesTotal 0 (unknown)', async () => {
    const events: { bytesTotal: number }[] = [];
    await parseLandXML(chunkedStream('<LandXML></LandXML>', 4), { onProgress: (p) => events.push(p) });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.bytesTotal === 0)).toBe(true);
  });

  it('worker handler relays progress with the Blob size as bytesTotal', async () => {
    const events: { phase: string; bytesProcessed: number; bytesTotal: number }[] = [];
    const blob = new Blob([text]);
    const { response } = await handleParseRequest(
      { id: 7, fileName: 'CO23012_TOPO.XML', payload: blob },
      (p) => events.push(p),
    );
    expect(response.ok).toBe(true);
    expect(response.type).toBe('result');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.bytesTotal === blob.size)).toBe(true);
    expect(events[events.length - 1]!.phase).toBe('building');
  });
});

// ---------------------------------------------------------------------------
// convention check: Carlson-specific interpretation is flagged in code (B3 grep check)
// ---------------------------------------------------------------------------

describe('CARLSON-ASSUMPTION convention', () => {
  it('parser source carries CARLSON-ASSUMPTION comments at each Carlson-specific spot', () => {
    const src = readFileSync(join(HERE, '..', 'src', 'core', 'landxml', 'parse.ts'), 'utf8');
    const count = (src.match(/CARLSON-ASSUMPTION/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3); // N-E-Z order, SourceData breaklines, DataPoints=breakline
  });
});
