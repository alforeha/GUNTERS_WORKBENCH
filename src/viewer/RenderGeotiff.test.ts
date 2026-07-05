import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { chooseGeotiffLodDivisor, geotiffTileFrustumBox, geotiffUvForWorldPoint } from './RenderGeotiff';
import type { SurfaceModel } from '../core/contract';
import { RenderSurface } from './RenderSurface';

describe('geotiffUvForWorldPoint', () => {
  const dataset = {
    width: 16000,
    height: 8818,
    geoTransform: {
      pixelScale: [0.02135097738318988, -0.021351065317252435] as [number, number],
      origin: [2894617.897090778, 1659432.4873155528] as [number, number],
      tiepoint: null,
      source: 'embedded' as const,
    },
  };

  it('maps the GeoTIFF origin to UV 0,0', () => {
    expect(
      geotiffUvForWorldPoint(dataset.geoTransform.origin[0], dataset.geoTransform.origin[1], dataset),
    ).toEqual({ u: 0, v: 0 });
  });

  it('maps the opposite corner to UV 1,1 even when Y pixel scale is negative', () => {
    const worldX = dataset.geoTransform.origin[0] + dataset.geoTransform.pixelScale[0] * dataset.width;
    const worldY = dataset.geoTransform.origin[1] + dataset.geoTransform.pixelScale[1] * dataset.height;
    const mapped = geotiffUvForWorldPoint(worldX, worldY, dataset);
    expect(mapped.u).toBeCloseTo(1, 10);
    expect(mapped.v).toBeCloseTo(1, 10);
  });
});

describe('chooseGeotiffLodDivisor', () => {
  it('uses coarse detail when far away', () => {
    expect(chooseGeotiffLodDivisor(2000, false)).toBe(4);
  });

  it('uses mid detail at moderate orbit distance', () => {
    expect(chooseGeotiffLodDivisor(400, false)).toBe(2);
  });

  it('uses full detail when close', () => {
    expect(chooseGeotiffLodDivisor(100, false)).toBe(1);
  });

  it('keeps hover mode in full detail a bit farther out', () => {
    expect(chooseGeotiffLodDivisor(220, true)).toBe(1);
  });
});

describe('overlap coordinate spaces', () => {
  it('keeps source surface positions in world coordinates while local bounds are rebased', () => {
    const model: SurfaceModel = {
      id: 's-world',
      name: 'world-space-surface',
      meta: {
        fileName: 'world.xml',
        format: 'synthetic',
        units: { linear: 'usSurveyFoot', raw: 'usSurveyFoot' },
      },
      positions: new Float64Array([
        2_894_700, 1_659_300, 10,
        2_894_900, 1_659_300, 10,
        2_894_900, 1_659_500, 10,
        2_894_700, 1_659_500, 10,
      ]),
      precisionHint: 2,
      sourcePointIds: new Uint32Array([1, 2, 3, 4]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      faceVisibility: null,
      edges: null,
      breaklines: [],
      boundaries: [],
      report: { counts: { points: 4, faces: 2 }, triangulationPreserved: true, warnings: [], infos: [], unknownElements: {} },
      provenance: 'source-explicit',
      dirty: false,
    };
    const origin: [number, number, number] = [2_894_800, 1_659_400, 0];
    const render = new RenderSurface('s-world', model, origin);

    expect(Array.from(model.positions.slice(0, 6))).toEqual([
      2_894_700, 1_659_300, 10,
      2_894_900, 1_659_300, 10,
    ]);
    expect(render.bounds.min.x).toBeCloseTo(-100, 6);
    expect(render.bounds.max.x).toBeCloseTo(100, 6);
    expect(render.bounds.min.y).toBeCloseTo(-100, 6);
    expect(render.bounds.max.y).toBeCloseTo(100, 6);

    render.dispose();
  });
});

describe('geotiffTileFrustumBox', () => {
  it('builds the frustum test box directly in rendered Z space', () => {
    const localBounds = new THREE.Box3(
      new THREE.Vector3(-50, -25, 0),
      new THREE.Vector3(50, 25, 0),
    );
    const surfaceBounds = new THREE.Box3(
      new THREE.Vector3(-100, -100, 10),
      new THREE.Vector3(100, 100, 30),
    );

    const box = geotiffTileFrustumBox(localBounds, surfaceBounds, 2);
    expect(box.min.x).toBe(-50);
    expect(box.max.x).toBe(50);
    expect(box.min.y).toBe(-25);
    expect(box.max.y).toBe(25);
    expect(box.min.z).toBe(20);
    expect(box.max.z).toBe(60);
  });
});
