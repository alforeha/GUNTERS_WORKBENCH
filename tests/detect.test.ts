// Work Order D2 acceptance tests (docs/06): sniffFormat - content-first, extension fallback.
// Exercises every branch in src/core/detect.ts against all five _REFS files + junk.
import { closeSync, openSync, readSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SNIFF_BYTES, SNIFF_RULES, sniffFormat, type DetectedFormat } from '../src/core/detect';
import { refPath } from './refs';

function head(path: string): Uint8Array {
  const buf = Buffer.alloc(SNIFF_BYTES);
  const fd = openSync(path, 'r');
  const n = readSync(fd, buf, 0, SNIFF_BYTES, 0);
  closeSync(fd);
  return new Uint8Array(buf.subarray(0, n));
}

const refCase = (name: string): { name: string; firstBytes: Uint8Array } => ({
  name,
  firstBytes: head(refPath(name)),
});

describe('sniffFormat - all five _REFS files (content-first)', () => {
  const expectations: Array<[string, DetectedFormat]> = [
    ['CO23012_TOPO.XML', 'landxml'],
    ['CO23012_NW1_TOPO.tin', 'carlson-dtm'],
    ['CO23012_NW1_ELEMENT240719-DXF AUTOCAD.dxf', 'dxf'],
    ['CO23012_NW1_ELEMENT240719-DXF CARLSON.dxf', 'dxf'],
    ['CO23012_NW1_ELEMENT240719.dwg', 'dwg'],
    ['A-BASIN TOPO-REVISED.pdf', 'pdf'],
  ];
  for (const [name, expected] of expectations) {
    it(`${name} -> ${expected}`, () => {
      expect(sniffFormat(refCase(name))).toBe(expected);
    });
  }
});

describe('sniffFormat - content beats extension', () => {
  it('LandXML content with a misleading .dwg name -> landxml', () => {
    expect(sniffFormat({ name: 'renamed.dwg', firstBytes: '<?xml?><LandXML version="1.2">' })).toBe('landxml');
  });
  it('Carlson DTM magic with .dat name -> carlson-dtm', () => {
    expect(sniffFormat({ name: 'export.dat', firstBytes: '\0\xff#Carlson DTM $Revision: 24603 $' })).toBe('carlson-dtm');
  });
  it('binary "AutoCAD Binary DXF" header -> dxf', () => {
    expect(sniffFormat({ name: 'b.bin', firstBytes: 'AutoCAD Binary DXF\r\n\x1a\0' })).toBe('dxf');
  });
  it('text DXF sentinel with CRLF and leading spaces -> dxf', () => {
    expect(sniffFormat({ name: 'b.bin', firstBytes: '  0\r\nSECTION\r\n  2\r\nHEADER' })).toBe('dxf');
  });
  it('AC10xx magic with no extension -> dwg', () => {
    expect(sniffFormat({ name: 'drawing', firstBytes: 'AC1027\0\0\0' })).toBe('dwg');
  });
  it('TIFF magic with .bin name -> geotiff', () => {
    expect(sniffFormat({ name: 'image.bin', firstBytes: 'II*\0rest' })).toBe('geotiff');
    expect(sniffFormat({ name: 'image.bin', firstBytes: 'MM\0*rest' })).toBe('geotiff');
  });
  it('PDF magic with .bin name -> pdf', () => {
    expect(sniffFormat({ name: 'sheet.bin', firstBytes: '%PDF-1.7 rest' })).toBe('pdf');
  });
  it('LAS signature with .bin name -> las', () => {
    expect(sniffFormat({ name: 'points.bin', firstBytes: 'LASFrest' })).toBe('las');
  });
});

describe('sniffFormat - extension fallback for content that matches nothing', () => {
  const junk = 'totally unrecognizable bytes 1234';
  it('.xml -> landxml', () => expect(sniffFormat({ name: 'x.xml', firstBytes: junk })).toBe('landxml'));
  it('.tin -> carlson-dtm', () => expect(sniffFormat({ name: 'x.TIN', firstBytes: junk })).toBe('carlson-dtm'));
  it('.dxf -> dxf', () => expect(sniffFormat({ name: 'x.dxf', firstBytes: junk })).toBe('dxf'));
  it('.dwg -> dwg', () => expect(sniffFormat({ name: 'x.dwg', firstBytes: junk })).toBe('dwg'));
  it('.tif/.tiff -> geotiff', () => {
    expect(sniffFormat({ name: 'x.tif', firstBytes: junk })).toBe('geotiff');
    expect(sniffFormat({ name: 'x.TIFF', firstBytes: junk })).toBe('geotiff');
  });
  it('.pdf -> pdf', () => expect(sniffFormat({ name: 'x.PDF', firstBytes: junk })).toBe('pdf'));
  it('.las -> las', () => expect(sniffFormat({ name: 'x.las', firstBytes: junk })).toBe('las'));
  it('anything else -> unknown', () => {
    expect(sniffFormat({ name: 'x.txt', firstBytes: junk })).toBe('unknown');
    expect(sniffFormat({ name: 'noextension', firstBytes: junk })).toBe('unknown');
    expect(sniffFormat({ name: 'empty.bin', firstBytes: new Uint8Array(0) })).toBe('unknown');
  });
});

describe('sniffFormat - misc', () => {
  it('string firstBytes longer than 4 KB are truncated (landmark past 4 KB is ignored)', () => {
    const far = ' '.repeat(SNIFF_BYTES + 10) + '<LandXML';
    expect(sniffFormat({ name: 'x.bin', firstBytes: far })).toBe('unknown');
  });
  it('SNIFF_RULES enumerates what we looked for (consumed by the unknown-file dialog)', () => {
    expect(SNIFF_RULES.map((r) => r.format)).toEqual(['landxml', 'carlson-dtm', 'dxf', 'dwg', 'geotiff', 'pdf', 'las']);
    for (const r of SNIFF_RULES) expect(r.lookedFor.length).toBeGreaterThan(0);
  });
  it('File input resolves asynchronously (browser path)', async () => {
    if (typeof File === 'undefined') return;
    const f = new File(['<?xml?>\n<LandXML version="1.2">'], 'sample.XML');
    await expect(sniffFormat(f)).resolves.toBe('landxml');
  });
});
