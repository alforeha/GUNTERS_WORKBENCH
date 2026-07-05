import { describe, expect, it } from 'vitest';

import { parseLasMetadata } from '../src/core/las/metadata';
import { handleLasRequest } from '../src/workers/las.worker';

function syntheticLasHeader(pointCount = 2): ArrayBuffer {
  const buffer = new ArrayBuffer(375);
  const view = new DataView(buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, 'LASF');
  view.setUint8(24, 1);
  view.setUint8(25, 4);
  view.setUint16(94, 375, true);
  view.setUint32(96, 375, true);
  view.setUint32(100, 0, true);
  view.setUint8(104, 7);
  view.setUint16(105, 36, true);
  view.setBigUint64(247, BigInt(pointCount), true);
  view.setFloat64(131, 0.01, true);
  view.setFloat64(139, 0.01, true);
  view.setFloat64(147, 0.01, true);
  view.setFloat64(155, 1000, true);
  view.setFloat64(163, 2000, true);
  view.setFloat64(171, 3000, true);
  view.setFloat64(179, 1010, true);
  view.setFloat64(187, 1000, true);
  view.setFloat64(195, 2020, true);
  view.setFloat64(203, 2000, true);
  view.setFloat64(211, 3030, true);
  view.setFloat64(219, 3000, true);
  return buffer;
}

function syntheticPointSample(): ArrayBuffer {
  const buffer = new ArrayBuffer(72);
  const view = new DataView(buffer);
  const point = (offset: number, classification: number, intensity: number, rgb: [number, number, number]) => {
    view.setUint16(offset + 12, intensity, true);
    view.setUint8(offset + 14, 0x11);
    view.setUint8(offset + 16, classification);
    view.setUint16(offset + 30, rgb[0], true);
    view.setUint16(offset + 32, rgb[1], true);
    view.setUint16(offset + 34, rgb[2], true);
  };
  point(0, 1, 100, [256, 512, 768]);
  point(36, 2, 900, [1024, 1280, 1536]);
  return buffer;
}

describe('LAS metadata parser', () => {
  it('parses LAS 1.4 point-format-7 header and sampled attributes', () => {
    const dataset = parseLasMetadata({
      fileName: 'sample.las',
      fileSize: 447,
      header: syntheticLasHeader(),
      sample: syntheticPointSample(),
    });
    expect(dataset.meta.format).toBe('las');
    expect(dataset.lasVersion).toBe('1.4');
    expect(dataset.pointFormat).toBe(7);
    expect(dataset.pointCount).toBe(2);
    expect(dataset.bounds).toMatchObject({ minX: 1000, maxX: 1010, minY: 2000, maxY: 2020 });
    expect(dataset.pointDensityPerSqFt).toBeCloseTo(0.01);
    expect(dataset.attributes.hasRgb).toBe(true);
    expect(dataset.attributes.intensityRange).toEqual([100, 900]);
    expect(dataset.attributes.rgbRange).toEqual([
      [256, 512, 768],
      [1024, 1280, 1536],
    ]);
    expect(dataset.attributes.classificationCounts).toEqual({ '1': 1, '2': 1 });
  });

  it('worker handler returns a point cloud dataset', async () => {
    const header = syntheticLasHeader();
    const sample = syntheticPointSample();
    const payload = new Blob([header, sample]);
    const response = await handleLasRequest({ id: 1, fileName: 'sample.las', payload });
    expect(response.type).toBe('result');
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.dataset.pointCount).toBe(2);
  });
});
