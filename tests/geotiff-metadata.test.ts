import { describe, expect, it } from 'vitest';

import { boundsFromTransform, buildGeotiffDataset, parseWorldFile } from '../src/core/geotiff/metadata';

describe('GeoTIFF metadata helpers', () => {
  it('parses a six-line world file', () => {
    const parsed = parseWorldFile(
      [
        '0.02135097738318988',
        '0.0',
        '0.0',
        '-0.021351065317252435',
        '2894617.897090778',
        '1659432.4873155528',
      ].join('\n'),
    );

    expect(parsed.scaleX).toBeCloseTo(0.02135097738318988);
    expect(parsed.scaleY).toBeCloseTo(-0.021351065317252435);
    expect(parsed.originX).toBeCloseTo(2894617.897090778);
    expect(parsed.originY).toBeCloseTo(1659432.4873155528);
  });

  it('computes bounds from origin and pixel scale', () => {
    const bounds = boundsFromTransform(16000, 8818, {
      origin: [2894617.897090778, 1659432.4873155528],
      pixelScale: [0.02135097738318988, -0.021351065317252435],
    });

    expect(bounds.minX).toBeCloseTo(2894617.897090778);
    expect(bounds.maxX).toBeCloseTo(2894959.512728909);
    expect(bounds.minY).toBeCloseTo(1659244.2136215852);
    expect(bounds.maxY).toBeCloseTo(1659432.4873155528);
  });

  it('prefers embedded transforms over the world file when both exist', () => {
    const dataset = buildGeotiffDataset({
      fileName: 'ortho.tif',
      width: 10,
      height: 10,
      samplesPerPixel: 4,
      bitsPerSample: [8, 8, 8, 8],
      tileWidth: 512,
      tileHeight: 512,
      isTiled: true,
      crsText: 'NAD83(2011) / Colorado Central (ftUS)|',
      embeddedTransform: {
        pixelScale: [2, -2],
        origin: [100, 200],
        tiepoint: [0, 0, 0, 100, 200, 0],
        source: 'embedded',
      },
      worldFileTransform: {
        pixelScale: [3, -3],
        origin: [1, 2],
        tiepoint: null,
        source: 'world-file',
      },
    });

    expect(dataset.geoTransform?.source).toBe('embedded');
    expect(dataset.worldBounds).toEqual({
      minX: 100,
      minY: 180,
      maxX: 120,
      maxY: 200,
    });
    expect(dataset.meta.units.linear).toBe('usSurveyFoot');
  });
});
