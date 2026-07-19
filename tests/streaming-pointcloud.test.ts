import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { StreamingPointCloud, type TileFetcher } from '../src/viewer/StreamingPointCloud';
import type { PointCloudNodePayload } from '../src/core/contract';
import type { PointCloudIndexHierarchy } from '../src/shared/workbench-types';
import { defaultFilterState } from '../src/viewer/pointCloudLod';
import { DEFAULT_POINT_APPEARANCE } from '../src/viewer/pointCloudAppearance';

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

  it('keeps loading walk data while hidden when a walk target is active', async () => {
    const spc = new StreamingPointCloud('pc', hierarchy(), SCENE_ORIGIN, immediateFetcher());

    spc.setDisplay(false, 2);
    spc.setWalkDataActive(true);
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y);
    await flush();
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y);

    expect(spc.group.visible).toBe(false);
    expect(spc.group.children.every((child) => !child.visible)).toBe(true);
    expect(spc.getLoadedPointCount()).toBe(240_000);
    expect(spc.isSettledState()).toBe(true);
    expect(spc.estimateGroundZ(0, 0, spc.walkGroundRadius(), 0.1, 12)?.z).toBe(0);
  });
});

// ── Appearance (shared model with RenderPointCloud) ───────────────────────────

describe('StreamingPointCloud appearance', () => {
  const auto = { ...DEFAULT_POINT_APPEARANCE };

  async function loadedCloud(): Promise<StreamingPointCloud> {
    const spc = new StreamingPointCloud('pc', hierarchy(), SCENE_ORIGIN, immediateFetcher());
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y);
    await flush();
    spc.update(camAt(5000), VIEWPORT_H, FOV_Y);
    return spc;
  }

  function materialSizes(spc: StreamingPointCloud): number[] {
    return spc.group.children.map(
      (child) => ((child as THREE.Points).material as THREE.PointsMaterial).size,
    );
  }

  it('applies a fixed 0.12 ft radius as one 0.24 world diameter across all level materials', async () => {
    const spc = await loadedCloud();
    spc.setAppearance({ ...auto, radiusMode: 'fixed', fixedRadiusFt: 0.12 });
    for (const size of materialSizes(spc)) expect(size).toBeCloseTo(0.24, 9);
    // Legacy slider changes must not override the fixed radius.
    spc.setDisplay(true, 5);
    for (const size of materialSizes(spc)) expect(size).toBeCloseTo(0.24, 9);
  });

  it('scales the per-level auto sizing with the quick-scale factor', async () => {
    const spc = await loadedCloud();
    const autoSizes = materialSizes(spc);
    spc.setAppearance({ ...auto, radiusScale: 2 });
    materialSizes(spc).forEach((size, i) => expect(size).toBeCloseTo(autoSizes[i]! * 2, 9));
    spc.setAppearance({ ...auto, radiusScale: 1 });
    materialSizes(spc).forEach((size, i) => expect(size).toBeCloseTo(autoSizes[i]!, 9));
  });

  it('sets and clears the camera range clip in world units', async () => {
    const spc = await loadedCloud();
    expect(spc.getRangeClipWorld()).toBeNull();
    spc.setAppearance({ ...auto, rangeClipFt: 50 });
    expect(spc.getRangeClipWorld()).toBe(50); // usSurveyFoot world: feet are world units
    spc.setAppearance({ ...auto, rangeClipFt: null });
    expect(spc.getRangeClipWorld()).toBeNull();
  });
});

// ── Isolate load-all + accounting ─────────────────────────────────────────────

/** Scene origin ≠ index origin so render-local and survey spaces are distinct. */
const OFFSET_SCENE_ORIGIN: [number, number, number] = [10, 0, 4];

/** Root payload with known survey XY points; other nodes use the default all-at-origin payload. */
function surveyPointsFetcher(rootPoints: { x: number; y: number; cls?: number }[]): TileFetcher {
  const rootPayload = (): PointCloudNodePayload => {
    const count = rootPoints.length;
    const positions = new Float32Array(count * 3);
    const classifications = new Uint8Array(count).fill(1);
    for (let i = 0; i < count; i++) {
      // survey → index-origin-relative (origin is [4, 4, 4])
      positions[i * 3] = rootPoints[i]!.x - 4;
      positions[i * 3 + 1] = rootPoints[i]!.y - 4;
      if (rootPoints[i]!.cls !== undefined) classifications[i] = rootPoints[i]!.cls!;
    }
    return { ...payloadFor(count), positions, classifications };
  };
  return (keys) =>
    Promise.resolve(keys.map((key) => ({ key, payload: key === '0-0-0-0' ? rootPayload() : payloadFor() })));
}

/** Survey square x∈[0,2] y∈[0,2] as a render-local polygon for OFFSET_SCENE_ORIGIN. */
const ISOLATE_POLYGON = [
  { x: 0 - OFFSET_SCENE_ORIGIN[0], y: 0 },
  { x: 2 - OFFSET_SCENE_ORIGIN[0], y: 0 },
  { x: 2 - OFFSET_SCENE_ORIGIN[0], y: 2 },
  { x: 0 - OFFSET_SCENE_ORIGIN[0], y: 2 },
];
const ISOLATE_REGION = { minX: 0, minY: 0, maxX: 2, maxY: 2 };

function farCamOffset(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100000);
  // survey [4, 4, 5000] in render-local coordinates
  cam.position.set(4 - OFFSET_SCENE_ORIGIN[0], 4, 5000 - OFFSET_SCENE_ORIGIN[2]);
  return cam;
}

describe('StreamingPointCloud isolate accounting', () => {
  it('returns null accounting while no isolate focus or load region is active', () => {
    const spc = new StreamingPointCloud('pc', hierarchy(), OFFSET_SCENE_ORIGIN, immediateFetcher());
    expect(spc.getIsolateAccounting()).toBeNull();
  });

  it('counts loaded and drawn points inside a render-local isolate polygon', async () => {
    const spc = new StreamingPointCloud(
      'pc',
      hierarchy(),
      OFFSET_SCENE_ORIGIN,
      surveyPointsFetcher([
        { x: 1, y: 1 }, // inside the isolate square
        { x: 1.5, y: 0.5, cls: 7 }, // inside, but class-filtered below
        { x: 3, y: 3 }, // outside
        { x: 7, y: 7 }, // outside
      ]),
    );
    spc.update(farCamOffset(), VIEWPORT_H, FOV_Y); // pinned base loads
    await flush();
    spc.update(farCamOffset(), VIEWPORT_H, FOV_Y);

    spc.setIsolateClip(ISOLATE_POLYGON);
    const accounting = spc.getIsolateAccounting();
    expect(accounting).not.toBeNull();
    expect(accounting!.focusActive).toBe(true);
    expect(accounting!.regionActive).toBe(false);
    // Every chain node's bounds intersect the survey square → full metadata estimate.
    expect(accounting!.estimatedAreaPoints).toBe(320_000);
    expect(accounting!.loadedInArea).toBe(2);
    expect(accounting!.drawnInArea).toBe(2);

    const filter = defaultFilterState();
    filter.classes[7] = false;
    spc.setFilter(filter);
    const filtered = spc.getIsolateAccounting();
    expect(filtered!.loadedInArea).toBe(2); // still in memory
    expect(filtered!.drawnInArea).toBe(1); // hidden by the class filter
  });

  it('streams region nodes the camera would never select and keeps them while the region is active', async () => {
    const fetched: string[][] = [];
    const fetcher: TileFetcher = (keys) => {
      fetched.push([...keys]);
      return Promise.resolve(keys.map((key) => ({ key, payload: payloadFor() })));
    };
    const spc = new StreamingPointCloud('pc', hierarchy(), OFFSET_SCENE_ORIGIN, fetcher);

    // Far view without a region: SSE never wants the level-3 leaf.
    spc.update(farCamOffset(), VIEWPORT_H, FOV_Y);
    await flush();
    spc.update(farCamOffset(), VIEWPORT_H, FOV_Y);
    expect(fetched.flat()).not.toContain('3-0-0-0');
    expect(spc.getLoadedPointCount()).toBe(240_000);

    // Load-all region over the leaf: it streams in despite the far camera…
    spc.setFocusLoadRegion(ISOLATE_REGION);
    spc.update(farCamOffset(), VIEWPORT_H, FOV_Y);
    await flush();
    spc.update(farCamOffset(), VIEWPORT_H, FOV_Y);
    expect(fetched.flat()).toContain('3-0-0-0');
    expect(spc.getLoadedPointCount()).toBe(320_000);
    const leaf = spc.group.children.find((child) => child.name.includes('3-0-0-0'));
    expect(leaf?.visible).toBe(true);

    const accounting = spc.getIsolateAccounting();
    expect(accounting!.regionActive).toBe(true);
    expect(accounting!.regionSelectedPoints).toBe(320_000);
    expect(accounting!.regionLoadedPoints).toBe(320_000);
    expect(accounting!.regionBudgetLimited).toBe(false);

    // …and survives further updates while the region holds it selected.
    spc.update(farCamOffset(), VIEWPORT_H, FOV_Y);
    expect(spc.getLoadedPointCount()).toBe(320_000);

    // Clearing the region hands the leaf back to SSE + budget: it evicts.
    spc.setFocusLoadRegion(null);
    spc.setStreamingBudget(280_000);
    spc.update(farCamOffset(), VIEWPORT_H, FOV_Y);
    expect(spc.getLoadedPointCount()).toBe(240_000);
  });

  it('reports budget-limited region selection in the accounting', () => {
    const spc = new StreamingPointCloud('pc', hierarchy(), OFFSET_SCENE_ORIGIN, immediateFetcher());
    spc.setStreamingBudget(280_000); // chain total is 320K → leaf cannot fit
    spc.setFocusLoadRegion(ISOLATE_REGION);
    const accounting = spc.getIsolateAccounting();
    expect(accounting!.regionActive).toBe(true);
    expect(accounting!.regionBudgetLimited).toBe(true);
    expect(accounting!.regionSelectedPoints).toBe(240_000);
    expect(accounting!.estimatedAreaPoints).toBe(320_000); // estimate stays uncapped
  });

  it('accounts against the region rectangle when load-all runs without a clip polygon', async () => {
    const spc = new StreamingPointCloud(
      'pc',
      hierarchy(),
      OFFSET_SCENE_ORIGIN,
      surveyPointsFetcher([
        { x: 1, y: 1 }, // inside the region
        { x: 5, y: 5 }, // outside
      ]),
    );
    spc.setFocusLoadRegion(ISOLATE_REGION);
    spc.update(farCamOffset(), VIEWPORT_H, FOV_Y);
    await flush();
    spc.update(farCamOffset(), VIEWPORT_H, FOV_Y);

    const accounting = spc.getIsolateAccounting();
    expect(accounting!.focusActive).toBe(false);
    expect(accounting!.regionActive).toBe(true);
    expect(accounting!.loadedInArea).toBe(1);
  });
});
