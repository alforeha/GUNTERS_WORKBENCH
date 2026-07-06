import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { StreamingPointCloud, type TileFetcher } from '../src/viewer/StreamingPointCloud';
import type { PointCloudNodePayload } from '../src/core/contract';
import type { PointCloudIndexHierarchy } from '../src/shared/workbench-types';

// 4-level chain hierarchy: levels 0..2 are pinned base, level 3 refines on zoom.
function hierarchy(): PointCloudIndexHierarchy {
  return {
    assetId: 'pc',
    indexAssetId: 'pc-index',
    root: '0-0-0-0',
    origin: [4, 4, 4],
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 8, maxY: 8, maxZ: 8 },
    scale: [1, 1, 1],
    offset: [0, 0, 0],
    units: 'usSurveyFoot',
    pointFormat: 7,
    hasRgb: true,
    totalPoints: 320_000,
    nodes: [
      { key: '0-0-0-0', level: 0, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 8, maxY: 8, maxZ: 8 }, pointCount: 80_000, childKeys: ['1-0-0-0'] },
      { key: '1-0-0-0', level: 1, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 4, maxZ: 4 }, pointCount: 80_000, childKeys: ['2-0-0-0'] },
      { key: '2-0-0-0', level: 2, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 }, pointCount: 80_000, childKeys: ['3-0-0-0'] },
      { key: '3-0-0-0', level: 3, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }, pointCount: 80_000, childKeys: [] },
    ],
  };
}

function payloadFor(count = 80_000): PointCloudNodePayload {
  return {
    pointCount: count,
    positions: new Float32Array(count * 3), // origin-relative, all at the index center
    colors: new Uint8Array(count * 3).fill(255), // white
    intensities: new Float32Array(count).fill(0.5),
    classifications: new Uint8Array(count).fill(1),
    returnNumbers: new Uint8Array(count).fill(1),
    numberOfReturns: new Uint8Array(count).fill(1),
  };
}

function immediateFetcher(): TileFetcher {
  return (keys) => Promise.resolve(keys.map((key) => ({ key, payload: payloadFor() })));
}

// scene origin == index origin, so camera.position + origin == world position
const SCENE_ORIGIN: [number, number, number] = [4, 4, 4];
const VIEWPORT_H = 1000;
const FOV_Y = Math.PI / 3;

function camAt(worldZ: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100000);
  cam.position.set(0, 0, worldZ - SCENE_ORIGIN[2]); // origin-relative
  return cam;
}

function camInLeaf(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100000);
  cam.position.set(-3.5, -3.5, -3.5); // world [0.5, 0.5, 0.5] inside level-3 node
  return cam;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('StreamingPointCloud', () => {
  it('loads the root first, becomes settled, and discloses loaded-of-total', async () => {
    const spc = new StreamingPointCloud('pc', hierarchy(), SCENE_ORIGIN, immediateFetcher());
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y); // far → pinned base loads even if only root is selected
    await flush();
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y); // root now loaded

    expect(spc.getLoadedPointCount()).toBe(240_000);
    expect(spc.isSettledState()).toBe(true);
    expect(spc.getDisclosure()).toMatch(/Indexed-full/);
    expect(spc.getDisclosure()).toMatch(/settled/);
    expect(spc.group.children.length).toBe(3);
    expect(spc.group.children.every((child) => child.visible)).toBe(true);
  });

  it('refines to more nodes as the camera approaches', async () => {
    const spc = new StreamingPointCloud('pc', hierarchy(), SCENE_ORIGIN, immediateFetcher());
    spc.setSseThreshold(1);
    spc.update(camInLeaf(), VIEWPORT_H, FOV_Y); // inside the leaf → deepest node selected
    await flush();
    spc.update(camInLeaf(), VIEWPORT_H, FOV_Y);
    expect(spc.getLoadedPointCount()).toBe(320_000);
    expect(spc.group.children.length).toBe(4);
  });

  it('evicts non-selected nodes when over the budget', async () => {
    const spc = new StreamingPointCloud('pc', hierarchy(), SCENE_ORIGIN, immediateFetcher());
    spc.setSseThreshold(1);
    spc.update(camInLeaf(), VIEWPORT_H, FOV_Y); // load pinned base + leaf
    await flush();
    spc.update(camInLeaf(), VIEWPORT_H, FOV_Y);
    expect(spc.getLoadedPointCount()).toBe(320_000);

    spc.setStreamingBudget(280_000); // pinned base (240k) remains; level-3 is evictable
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y); // far → level-3 no longer selected and may evict
    expect(spc.getLoadedPointCount()).toBe(240_000);
    expect(spc.group.children.length).toBe(3);
  });

  it('drops a stale in-flight tile when the camera moves off it', async () => {
    let release!: () => void;
    const deferred = new Promise<void>((res) => {
      release = res;
    });
    const fetcher: TileFetcher = (keys) => deferred.then(() => keys.map((key) => ({ key, payload: payloadFor() })));

    const spc = new StreamingPointCloud('pc', hierarchy(), SCENE_ORIGIN, fetcher);
    spc.update(camAt(20), VIEWPORT_H, FOV_Y); // near → dispatch fetch for pinned base + leaf (in flight)
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y); // far → level-3 no longer selected → marked stale
    release();
    await flush();

    // pinned base built, level-3 dropped as stale
    expect(spc.getLoadedPointCount()).toBe(240_000);
    expect(spc.group.children.length).toBe(3);
    expect(spc.group.children.every((child) => !child.name.includes('3-0-0-0'))).toBe(true);
  });

  it('uses smaller materials when all children are loaded and visible', async () => {
    const spc = new StreamingPointCloud('pc', hierarchy(), SCENE_ORIGIN, immediateFetcher());
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y);
    await flush();
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y);

    const grandchildBefore = spc.group.children.find((child) => child.name.includes('2-0-0-0')) as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
    const beforeMaterial = grandchildBefore.material;

    spc.setSseThreshold(1);
    spc.update(camInLeaf(), VIEWPORT_H, FOV_Y);
    await flush();
    spc.update(camInLeaf(), VIEWPORT_H, FOV_Y);

    const grandchildAfter = spc.group.children.find((child) => child.name.includes('2-0-0-0')) as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
    expect(grandchildAfter.material).not.toBe(beforeMaterial);
  });

  it('recolors loaded nodes when the display mode changes (display parity)', async () => {
    const spc = new StreamingPointCloud('pc', hierarchy(), SCENE_ORIGIN, immediateFetcher());
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y);
    await flush();
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y);

    const colorAttr = () =>
      (spc.group.children[0] as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>).geometry.getAttribute('color') as THREE.BufferAttribute;
    const rgbRed = (colorAttr().array as Float32Array)[0];
    expect(rgbRed).toBeCloseTo(1, 5); // white rgb

    spc.setDisplayMode('elevation');
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y); // repack under new mode
    const elevRed = (colorAttr().array as Float32Array)[0];
    expect(elevRed).not.toBeCloseTo(1, 5); // terrain ramp, not white
    expect(spc.displayModeValue).toBe('elevation');
  });

  it('hides everything and reports empty when display is toggled off', async () => {
    const spc = new StreamingPointCloud('pc', hierarchy(), SCENE_ORIGIN, immediateFetcher());
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y);
    await flush();
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y);
    expect(spc.group.children[0]!.visible).toBe(true);

    spc.setDisplay(false, 2);
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y);
    expect(spc.group.visible).toBe(false);
    expect(spc.group.children[0]!.visible).toBe(false);
  });
});
