// tests/fixtures/generate-large-landxml.mjs — synthetic large-LandXML generator (B3 perf gate).
// Grid TIN at survey-magnitude coordinates (~N 1.5e6 / E 3.5e6) with full faces section.
// Usage as script:   node tests/fixtures/generate-large-landxml.mjs <outPath> [targetMB]
// Usage from tests:  import { generateLargeLandXML } from './generate-large-landxml.mjs'

import { createWriteStream, writeFileSync } from 'node:fs';

/**
 * @param {string} outPath
 * @param {number} targetBytes
 * @returns {Promise<{points:number, faces:number, cols:number, rows:number, bytes:number}>}
 */
export async function generateLargeLandXML(outPath, targetBytes = 100 * 1024 * 1024) {
  const cols = 1000;

  const pointLine = (id, r, c) => {
    const n = (1500000 + r * 2.0 + Math.sin(c * 0.21) * 0.37).toFixed(8);
    const e = (3500000 + c * 2.0 + Math.cos(r * 0.17) * 0.41).toFixed(8);
    const z = (4185 + Math.sin(r * 0.05) * 4 + Math.cos(c * 0.07) * 3).toFixed(6);
    return `<P id="${id}">${n} ${e} ${z}</P>\n`; // N E Z order, like Carlson output
  };

  // estimate bytes per grid row (points + ~2 faces per cell) from a sample row
  let sample = '';
  for (let c = 0; c < cols; c++) sample += pointLine(123456, 500, c);
  const faceBytesPerRow = (cols - 1) * 2 * 22; // "<F>a b c</F>\n" with 7-digit ids
  const rowBytes = sample.length + faceBytesPerRow;
  const rows = Math.max(2, Math.ceil(targetBytes / rowBytes));

  const out = createWriteStream(outPath, { highWaterMark: 1 << 22 });
  const write = (s) =>
    out.write(s) ? Promise.resolve() : new Promise((res) => out.once('drain', res));

  await write(
    `<?xml version="1.0"?>\n<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">\n` +
      `<Application name="gunters synthetic generator" version="1.0"/>\n` +
      `<Units><Imperial areaUnit="squareFoot" linearUnit="USSurveyFoot" volumeUnit="cubicFeet"/></Units>\n` +
      `<Surfaces>\n<Surface name="SYNTHETIC_LARGE">\n<Definition surfType="TIN">\n<Pnts>\n`,
  );

  let buf = '';
  let id = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      buf += pointLine(++id, r, c);
    }
    if (buf.length > 1 << 20) { await write(buf); buf = ''; }
  }
  await write(buf + '</Pnts>\n<Faces>\n');
  buf = '';

  let faces = 0;
  for (let r = 0; r < rows - 1; r++) {
    const base = r * cols + 1;
    for (let c = 0; c < cols - 1; c++) {
      const a = base + c, b = a + 1, d = a + cols, e2 = d + 1;
      buf += `<F>${a} ${b} ${d}</F>\n<F>${b} ${e2} ${d}</F>\n`;
      faces += 2;
    }
    if (buf.length > 1 << 20) { await write(buf); buf = ''; }
  }
  await write(buf + '</Faces>\n</Definition>\n</Surface>\n</Surfaces>\n</LandXML>\n');
  await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));

  const meta = { points: rows * cols, faces, cols, rows, bytes: out.bytesWritten };
  writeFileSync(outPath + '.meta.json', JSON.stringify(meta));
  return meta;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , outPath, mb] = process.argv;
  if (!outPath) {
    console.error('usage: node generate-large-landxml.mjs <outPath> [targetMB]');
    process.exit(1);
  }
  const target = (Number(mb) || 100) * 1024 * 1024;
  generateLargeLandXML(outPath, target).then((m) =>
    console.log(`wrote ${outPath}: ${(m.bytes / 1e6).toFixed(1)} MB, ${m.points} points, ${m.faces} faces`),
  );
}
