// B3 perf/memory gate: 100 MB synthetic LandXML parses streamed without exceeding
// ~3× file size peak memory. Skippable with SKIP_PERF=1 (CI fast lane).
//
// "Main-thread wrapper never blocks" is satisfied by construction: all parsing runs
// inside the Worker (src/workers/parse.worker.ts); the main thread only posts a File
// and receives transferables. This test exercises the same streaming path in Node.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { SurfaceModel } from '../src/core/contract';
import { parseLandXML } from '../src/core/landxml/parse';
// @ts-expect-error — plain .mjs generator script, intentionally untyped
import { generateLargeLandXML } from './fixtures/generate-large-landxml.mjs';

const TARGET = 100 * 1024 * 1024;
const PATH = join(tmpdir(), 'gunters-synthetic-100mb.xml');

const maybe = process.env.SKIP_PERF ? describe.skip : describe;

maybe('100 MB synthetic LandXML (perf/memory gate)', () => {
  it('parses streamed within ~3× file-size peak memory and matches generated counts', async () => {
    interface GenMeta { points: number; faces: number; bytes: number }
    let meta: GenMeta;
    if (existsSync(PATH) && existsSync(PATH + '.meta.json') && statSync(PATH).size > 90e6) {
      meta = JSON.parse(readFileSync(PATH + '.meta.json', 'utf8')) as GenMeta;
    } else {
      meta = (await generateLargeLandXML(PATH, TARGET)) as GenMeta;
    }
    const fileSize = statSync(PATH).size;
    expect(fileSize).toBeGreaterThan(90e6); // it really is ~100 MB

    (globalThis as { gc?: () => void }).gc?.();
    const baseRss = process.memoryUsage().rss;
    let peakRss = baseRss;
    const sampler = setInterval(() => {
      const r = process.memoryUsage().rss;
      if (r > peakRss) peakRss = r;
    }, 25);

    const stream = Readable.toWeb(
      createReadStream(PATH, { highWaterMark: 1 << 20 }),
    ) as unknown as ReadableStream<Uint8Array>;

    let progressEvents = 0;
    const t0 = performance.now();
    const { surfaces } = await parseLandXML(stream, {
      fileName: 'synthetic-100mb.xml',
      bytesTotal: fileSize,
      onProgress: () => progressEvents++,
    });
    const elapsed = performance.now() - t0;
    clearInterval(sampler);
    const r = process.memoryUsage().rss;
    if (r > peakRss) peakRss = r;

    const s = surfaces[0] as SurfaceModel;
    expect(surfaces).toHaveLength(1);
    expect(s.report.counts['points']).toBe(meta.points);
    expect(s.report.counts['faces']).toBe(meta.faces);
    expect(s.report.triangulationPreserved).toBe(true);
    expect(s.positions).toHaveLength(meta.points * 3);

    const peakDelta = peakRss - baseRss;
    // eslint-disable-next-line no-console
    console.log(
      `[perf] file ${(fileSize / 1e6).toFixed(1)} MB · ${meta.points} pts · ${meta.faces} faces · ` +
        `parse ${(elapsed / 1000).toFixed(1)} s · peak ΔRSS ${(peakDelta / 1e6).toFixed(0)} MB ` +
        `(budget ${((3 * fileSize) / 1e6).toFixed(0)} MB)`,
    );
    expect(peakDelta).toBeLessThan(3 * fileSize);

    // D3 granularity gate: ≥4 progress events per second of parse time
    // (1 MB chunks ⇒ ~116 events for this file, comfortably above the bar).
    const requiredEvents = Math.max(4, Math.ceil((elapsed / 1000) * 4));
    // eslint-disable-next-line no-console
    console.log(`[perf] progress events ${progressEvents} (required ≥ ${requiredEvents})`);
    expect(progressEvents).toBeGreaterThanOrEqual(requiredEvents);
  }, 240_000);
});
