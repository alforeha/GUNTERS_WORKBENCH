import * as THREE from 'three';
import type { PointCloudNodePayload } from '../core/contract';
import type { Vec3 } from './geometry';
import {
  GeotiffOverviewSampler,
  POINT_BUDGET_MAX,
  defaultFilterState,
  pointPasses,
  terrainColor,
  type FilterState,
  type PointDisplayMode,
} from './pointCloudLod';
import {
  deriveFinestVisibleLevels,
  formatIndexedFullDisclosure,
  isSettled,
  planEviction,
  planRegionSectors,
  projScaleFromPerspective,
  selectRegionNodes,
  selectStreamingNodes,
  staleRequestKeys,
  type RegionXY,
  type StreamBounds,
  type StreamCameraView,
  type StreamNode,
} from './pointCloudStreaming';
import { applyIsolateClip, createIsolateClipUniforms, setIsolateClipPolygon } from './isolateClip';
import { estimateLowPercentileGroundZ, type GroundEstimate } from './walkSurface';

/** Fetches decoded, origin-relative tile payloads for the given node keys (IPC-backed in-app). */
export type TileFetcher = (keys: string[]) => Promise<{ key: string; payload: PointCloudNodePayload }[]>;

/** The subset of a built WPI index this renderer needs (structurally a PointCloudIndexHierarchy). */
export interface StreamingHierarchy {
  root: string;
  origin: [number, number, number];
  bounds: StreamBounds;
  units: string;
  hasRgb: boolean;
  totalPoints: number;
  nodes: StreamNode[];
}

/** Refine a node while its screen-space error (px) exceeds this. Tunable; see metrics report. */
export const DEFAULT_SSE_THRESHOLD = 400;
/** Cap tile requests issued per update so a fast camera can't flood IPC; the rest come next frame. */
const MAX_FETCH_PER_UPDATE = 6;
const PINNED_BASE_LEVEL = 2;

interface LoadedStreamNode {
  key: string;
  node: StreamNode;
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  payload: PointCloudNodePayload;
  lastUsedTick: number;
  colorEpoch: number;
  builtStride: number;
  materialLevel: number;
}

/**
 * Renderer for a WPI indexed-full point cloud. Streams tiles keyed by camera via screen-space-error
 * selection over the index hierarchy, builds/evicts THREE geometry against the render budget, and
 * discloses its loaded-vs-total streaming state. The point math lives in pointCloudStreaming.ts; this
 * class owns geometry, coloring, and IO orchestration. Tiles arrive already rebased to the index
 * origin (int32→world→origin-relative f32 happens in main), so there is no survey-coordinate jitter.
 */
export class StreamingPointCloud {
  readonly handle: string;
  readonly group = new THREE.Group();

  private readonly nodesByKey = new Map<string, StreamNode>();
  private readonly rootKey: string;
  private readonly origin: [number, number, number];
  private readonly sceneOrigin: Vec3;
  private readonly totalPoints: number;
  private readonly hasRgb: boolean;
  private readonly units: string;
  private readonly zRange: [number, number];
  private readonly worldBounds: StreamBounds;
  private readonly levelStats = new Map<number, { edge: number; averagePointCount: number }>();
  private readonly levelMaterials = new Map<number, THREE.PointsMaterial>();
  private readonly isolateClip = createIsolateClipUniforms();
  private readonly pinnedKeys = new Set<string>();
  private readonly fetchTiles: TileFetcher;
  private readonly onChanged?: () => void;

  private readonly loaded = new Map<string, LoadedStreamNode>();
  private readonly inFlight = new Set<string>();
  private readonly dropped = new Set<string>();

  private visibleAll = true;
  private pointSize = 2;
  private focusRegion: RegionXY | null = null;
  private displayMode: PointDisplayMode;
  private filter: FilterState = defaultFilterState();
  private overviewSampler: GeotiffOverviewSampler | null = null;
  private colorEpoch = 0;
  private tick = 0;
  private sseThreshold = DEFAULT_SSE_THRESHOLD;
  private budgetMax = POINT_BUDGET_MAX;
  private loadedPointCount = 0;
  private selectionKeys = new Set<string>();
  private finestVisibleLevels = new Map<string, number>();
  private settled = false;

  constructor(
    handle: string,
    hierarchy: StreamingHierarchy,
    sceneOrigin: Vec3,
    fetchTiles: TileFetcher,
    onChanged?: () => void,
  ) {
    this.handle = handle;
    this.rootKey = hierarchy.root;
    this.origin = hierarchy.origin;
    this.sceneOrigin = sceneOrigin;
    this.totalPoints = hierarchy.totalPoints;
    this.hasRgb = hierarchy.hasRgb;
    this.units = hierarchy.units;
    this.worldBounds = hierarchy.bounds;
    this.zRange = [hierarchy.bounds.minZ, hierarchy.bounds.maxZ];
    this.fetchTiles = fetchTiles;
    this.onChanged = onChanged;
    const levelAcc = new Map<number, { edge: number; pointCountSum: number; nodeCount: number }>();
    for (const node of hierarchy.nodes) {
      this.nodesByKey.set(node.key, {
        key: node.key,
        level: node.level,
        bounds: node.bounds,
        pointCount: node.pointCount,
        childKeys: node.childKeys,
      });
      if (node.level <= PINNED_BASE_LEVEL) this.pinnedKeys.add(node.key);
      const edge = node.bounds.maxX - node.bounds.minX;
      const stat = levelAcc.get(node.level) ?? { edge, pointCountSum: 0, nodeCount: 0 };
      stat.edge = edge;
      stat.pointCountSum += node.pointCount;
      stat.nodeCount++;
      levelAcc.set(node.level, stat);
    }
    for (const [level, stat] of levelAcc) {
      this.levelStats.set(level, { edge: stat.edge, averagePointCount: stat.pointCountSum / Math.max(stat.nodeCount, 1) });
    }
    this.displayMode = hierarchy.hasRgb ? 'rgb' : 'elevation';
    this.group.name = `point-cloud-index:${handle}`;
    this.group.position.set(
      this.origin[0] - sceneOrigin[0],
      this.origin[1] - sceneOrigin[1],
      this.origin[2] - sceneOrigin[2],
    );
  }

  get bounds(): THREE.Box3 {
    const box = new THREE.Box3();
    if (!this.group.visible) return box.makeEmpty();
    return box.set(
      new THREE.Vector3(
        this.worldBounds.minX - this.sceneOrigin[0],
        this.worldBounds.minY - this.sceneOrigin[1],
        this.worldBounds.minZ - this.sceneOrigin[2],
      ),
      new THREE.Vector3(
        this.worldBounds.maxX - this.sceneOrigin[0],
        this.worldBounds.maxY - this.sceneOrigin[1],
        this.worldBounds.maxZ - this.sceneOrigin[2],
      ),
    );
  }

  setDisplay(visible: boolean, pointSize: number): void {
    this.visibleAll = visible;
    this.pointSize = THREE.MathUtils.clamp(pointSize, 1, 5);
    this.group.visible = visible;
    for (const [level, material] of this.levelMaterials) {
      material.size = this.materialSizeForLevel(level);
      material.needsUpdate = true;
    }
  }

  setDisplayMode(mode: PointDisplayMode): void {
    if (this.displayMode === mode) return;
    this.displayMode = mode;
    this.colorEpoch++;
  }

  /** Isolate focus: render-local XY polygon outside which points are hidden; null restores all. */
  setIsolateClip(polygonXY: { x: number; y: number }[] | null): void {
    setIsolateClipPolygon(this.isolateClip, polygonXY);
  }

  /**
   * Full-density load region (survey XY) for isolate load-all: every index
   * node intersecting it streams in alongside normal SSE selection; null
   * restores SSE-only streaming.
   */
  setFocusLoadRegion(region: RegionXY | null): void {
    this.focusRegion = region;
  }

  /** Sector plan for a region that may exceed the render budget (survey XY). */
  planRegionSectors(region: RegionXY): RegionXY[] {
    return planRegionSectors(this.nodesByKey, this.rootKey, region, this.budgetMax);
  }

  setFilter(filter: FilterState): void {
    this.filter = filter;
    this.colorEpoch++;
  }

  setOverviewSampler(sampler: GeotiffOverviewSampler | null): void {
    this.overviewSampler = sampler;
    if (this.displayMode === 'geotiff') this.colorEpoch++;
  }

  /** Adjust the loaded-point budget ceiling (stays within the 2–5M work-order window). */
  setStreamingBudget(max: number): void {
    this.budgetMax = Math.max(100_000, Math.round(max));
  }

  /** Adjust the screen-space-error refinement threshold in pixels. */
  setSseThreshold(px: number): void {
    this.sseThreshold = Math.max(1, px);
  }

  get displayModeValue(): PointDisplayMode {
    return this.displayMode;
  }

  getLoadedPointCount(): number {
    return this.loadedPointCount;
  }

  isSettledState(): boolean {
    return this.settled;
  }

  getDisclosure(): string {
    return formatIndexedFullDisclosure(this.loadedPointCount, this.totalPoints, this.settled);
  }

  walkGroundRadius(): number {
    return this.units === 'meter' ? 1.25 : 4;
  }

  fallbackGroundZ(): number {
    return this.worldBounds.minZ - this.sceneOrigin[2];
  }

  estimateGroundZ(renderX: number, renderY: number, radius: number, percentile = 0.1, minPoints = 12): GroundEstimate | null {
    const surveyX = renderX + this.sceneOrigin[0];
    const surveyY = renderY + this.sceneOrigin[1];
    const radiusSq = radius * radius;
    const zSamples: number[] = [];
    for (const ln of this.loaded.values()) {
      const { bounds } = ln.node;
      if (
        surveyX < bounds.minX - radius ||
        surveyX > bounds.maxX + radius ||
        surveyY < bounds.minY - radius ||
        surveyY > bounds.maxY + radius
      ) {
        continue;
      }
      for (let i = 0; i < ln.payload.pointCount; i++) {
        const cls = ln.payload.classifications[i] ?? 0;
        const rn = ln.payload.returnNumbers[i] ?? 1;
        const nr = ln.payload.numberOfReturns[i] ?? 1;
        if (!pointPasses(cls, rn, nr, this.filter)) continue;
        const base = i * 3;
        const x = (ln.payload.positions[base] ?? 0) + this.group.position.x;
        const y = (ln.payload.positions[base + 1] ?? 0) + this.group.position.y;
        const dx = x - renderX;
        const dy = y - renderY;
        if (dx * dx + dy * dy > radiusSq) continue;
        zSamples.push((ln.payload.positions[base + 2] ?? 0) + this.group.position.z);
      }
    }
    return estimateLowPercentileGroundZ(zSamples, percentile, minPoints);
  }

  /**
   * Reconcile loaded tiles to the current camera: select nodes by SSE, show/hide, enqueue fetches
   * for missing nodes (priority order, throttled), drop stale in-flight loads, and evict against
   * the point budget. Returns true when the visible set changed this frame.
   */
  update(camera: THREE.Camera, viewportHeightPx: number, fovYRadians: number): boolean {
    this.tick++;
    this.group.visible = this.visibleAll;
    if (!this.visibleAll) {
      let changed = false;
      for (const ln of this.loaded.values()) {
        if (ln.points.visible) {
          ln.points.visible = false;
          changed = true;
        }
      }
      this.selectionKeys = new Set();
      this.settled = this.inFlight.size === 0;
      return changed;
    }

    const camView: StreamCameraView = {
      position: [
        camera.position.x + this.sceneOrigin[0],
        camera.position.y + this.sceneOrigin[1],
        camera.position.z + this.sceneOrigin[2],
      ],
      projScale: projScaleFromPerspective(viewportHeightPx, fovYRadians),
    };
    // Isolate load-all: the focus region streams at full density and takes
    // budget priority; SSE keeps at least a slice for coverage elsewhere
    // (mostly clipped invisible while isolate focus is on anyway).
    const regionSelection = this.focusRegion
      ? selectRegionNodes(this.nodesByKey, this.rootKey, this.focusRegion, this.budgetMax)
      : null;
    const sseBudget = regionSelection
      ? Math.max(this.budgetMax - regionSelection.estimatedPoints, Math.floor(this.budgetMax * 0.2))
      : this.budgetMax;
    const selection = selectStreamingNodes(this.nodesByKey, this.rootKey, camView, {
      sseThreshold: this.sseThreshold,
      budgetMax: sseBudget,
    });
    this.selectionKeys = new Set([...selection.keys, ...(regionSelection?.keys ?? []), ...this.pinnedKeys]);
    this.finestVisibleLevels = deriveFinestVisibleLevels(
      this.nodesByKey,
      new Set([...this.loaded.keys()].filter((key) => this.selectionKeys.has(key))),
    );
    let changed = false;

    for (const key of this.selectionKeys) {
      const ln = this.loaded.get(key);
      if (ln) {
        ln.lastUsedTick = this.tick;
        const materialLevel = this.displayLevelForNode(ln);
        if (ln.materialLevel !== materialLevel) {
          ln.points.material = this.materialForLevel(materialLevel);
          ln.materialLevel = materialLevel;
          changed = true;
        }
        if (ln.colorEpoch !== this.colorEpoch) {
          this.packNode(ln);
          changed = true;
        }
        if (!ln.points.visible) {
          ln.points.visible = true;
          changed = true;
        }
      }
    }
    for (const [key, ln] of this.loaded) {
      if (!this.selectionKeys.has(key) && ln.points.visible) {
        ln.points.visible = false;
        changed = true;
      }
    }

    for (const key of staleRequestKeys(this.inFlight, this.selectionKeys)) this.dropped.add(key);

    const toFetch: string[] = [];
    const queued = new Set<string>();
    for (const key of [...this.pinnedKeys].sort()) {
      if (this.loaded.has(key) || this.inFlight.has(key) || queued.has(key)) continue;
      toFetch.push(key);
      queued.add(key);
      if (toFetch.length >= MAX_FETCH_PER_UPDATE) break;
    }
    // Region tiles fetch ahead of SSE refinement: the tech asked for this area.
    for (const scored of [...(regionSelection?.nodes ?? []), ...selection.nodes]) {
      if (toFetch.length >= MAX_FETCH_PER_UPDATE) break;
      if (this.loaded.has(scored.key) || this.inFlight.has(scored.key) || queued.has(scored.key)) continue;
      toFetch.push(scored.key);
      queued.add(scored.key);
    }
    if (toFetch.length > 0) void this.dispatchFetch(toFetch);

    const evictKeys = planEviction(
      [...this.loaded.values()].map((ln) => ({ key: ln.key, pointCount: ln.payload.pointCount, lastUsedTick: ln.lastUsedTick })),
      this.selectionKeys,
      this.budgetMax,
      this.pinnedKeys,
    );
    for (const key of evictKeys) this.evict(key);
    if (evictKeys.length > 0) changed = true;

    this.settled = this.inFlight.size === 0 && isSettled(this.selectionKeys, new Set(this.loaded.keys()));
    return changed;
  }

  dispose(): void {
    for (const ln of this.loaded.values()) {
      ln.points.geometry.dispose();
      ln.points.removeFromParent();
    }
    this.loaded.clear();
    this.inFlight.clear();
    this.dropped.clear();
    this.loadedPointCount = 0;
    for (const material of this.levelMaterials.values()) material.dispose();
    this.levelMaterials.clear();
    this.group.removeFromParent();
  }

  private async dispatchFetch(keys: string[]): Promise<void> {
    for (const key of keys) this.inFlight.add(key);
    let tiles: { key: string; payload: PointCloudNodePayload }[];
    try {
      tiles = await this.fetchTiles(keys);
    } catch {
      for (const key of keys) this.inFlight.delete(key);
      return;
    }
    let built = false;
    for (const { key, payload } of tiles) {
      this.inFlight.delete(key);
      if (this.dropped.delete(key)) continue; // camera moved off this node — drop the stale load
      if (this.loaded.has(key)) continue;
      const node = this.nodesByKey.get(key);
      if (!node) continue;
      this.buildNode(node, payload);
      built = true;
    }
    for (const key of keys) this.inFlight.delete(key); // clear any keys the fetch didn't return
    if (built) this.onChanged?.();
  }

  private buildNode(node: StreamNode, payload: PointCloudNodePayload): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(payload.pointCount * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(payload.pointCount * 3), 3));
    geometry.setDrawRange(0, 0);
    const points = new THREE.Points(geometry, this.materialForLevel(node.level));
    points.name = `point-cloud-index-node:${this.handle}:${node.key}`;
    points.frustumCulled = false;
    this.group.add(points);
    const ln: LoadedStreamNode = {
      key: node.key,
      node,
      points,
      payload,
      lastUsedTick: this.tick,
      colorEpoch: -1,
      builtStride: 1,
      materialLevel: node.level,
    };
    this.loaded.set(node.key, ln);
    this.loadedPointCount += payload.pointCount;
    this.packNode(ln);
  }

  private packNode(ln: LoadedStreamNode): void {
    const payload = ln.payload;
    const positionAttr = ln.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colorAttr = ln.points.geometry.getAttribute('color') as THREE.BufferAttribute;
    const pos = positionAttr.array as Float32Array;
    const col = colorAttr.array as Float32Array;
    const zSpan = this.zRange[1] - this.zRange[0] || 1;
    let written = 0;
    for (let i = 0; i < payload.pointCount; i++) {
      const cls = payload.classifications[i] ?? 0;
      const rn = payload.returnNumbers[i] ?? 1;
      const nr = payload.numberOfReturns[i] ?? 1;
      if (!pointPasses(cls, rn, nr, this.filter)) continue;
      const sx = payload.positions[i * 3] ?? 0;
      const sy = payload.positions[i * 3 + 1] ?? 0;
      const sz = payload.positions[i * 3 + 2] ?? 0;
      const o = written * 3;
      pos[o] = sx;
      pos[o + 1] = sy;
      pos[o + 2] = sz;
      const c = this.colorFor(payload, i, sx, sy, sz, this.zRange[0], zSpan);
      col[o] = c[0];
      col[o + 1] = c[1];
      col[o + 2] = c[2];
      written++;
    }
    positionAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    ln.points.geometry.setDrawRange(0, written);
    ln.points.geometry.computeBoundingSphere();
    ln.points.visible = written > 0 && this.selectionKeys.has(ln.key);
    ln.colorEpoch = this.colorEpoch;
  }

  private colorFor(
    payload: PointCloudNodePayload,
    i: number,
    localX: number,
    localY: number,
    localZ: number,
    zMin: number,
    zSpan: number,
  ): [number, number, number] {
    switch (this.displayMode) {
      case 'intensity': {
        const g = THREE.MathUtils.clamp(payload.intensities[i] ?? 0, 0, 1);
        return [g, g, g];
      }
      case 'elevation': {
        const worldZ = localZ + this.origin[2];
        const rgb = terrainColor((worldZ - zMin) / zSpan);
        return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
      }
      case 'geotiff': {
        if (this.overviewSampler) {
          const sampled = this.overviewSampler.sample(localX + this.origin[0], localY + this.origin[1]);
          if (sampled) return [sampled[0] / 255, sampled[1] / 255, sampled[2] / 255];
        }
        return this.rgbColor(payload, i, 200);
      }
      case 'rgb':
      default:
        return this.rgbColor(payload, i, 255);
    }
  }

  private rgbColor(payload: PointCloudNodePayload, i: number, fallback: number): [number, number, number] {
    if (!this.hasRgb) {
      const f = fallback / 255;
      return [f, f, f];
    }
    return [
      (payload.colors[i * 3] ?? fallback) / 255,
      (payload.colors[i * 3 + 1] ?? fallback) / 255,
      (payload.colors[i * 3 + 2] ?? fallback) / 255,
    ];
  }

  private evict(key: string): void {
    const ln = this.loaded.get(key);
    if (!ln) return;
    ln.points.geometry.dispose();
    ln.points.removeFromParent();
    this.loaded.delete(key);
    this.loadedPointCount -= ln.payload.pointCount;
  }

  private displayLevelForNode(node: LoadedStreamNode): number {
    return this.finestVisibleLevels.get(node.key) ?? node.node.level;
  }

  private materialForLevel(level: number): THREE.PointsMaterial {
    const existing = this.levelMaterials.get(level);
    if (existing) return existing;
    const material = new THREE.PointsMaterial({
      size: this.materialSizeForLevel(level),
      sizeAttenuation: true,
      vertexColors: true,
      toneMapped: false,
      map: StreamingPointCloud.getDiskTexture(),
      alphaTest: 0.35,
      transparent: true,
      fog: true,
    });
    applyIsolateClip(material, this.isolateClip);
    this.levelMaterials.set(level, material);
    return material;
  }

  private materialSizeForLevel(level: number): number {
    const stat = this.levelStats.get(level);
    if (!stat) return this.worldPointDiameter(1);
    const minRadius = THREE.MathUtils.lerp(this.inchesToUnits(1), this.inchesToUnits(2), (this.pointSize - 1) / 4);
    const fillRadius = 0.7 * stat.edge / Math.sqrt(Math.max(stat.averagePointCount, 1));
    const maxRadius = stat.edge * 0.05;
    const radius = Math.max(minRadius, Math.min(fillRadius, maxRadius));
    return radius * 2;
  }

  private inchesToUnits(inches: number): number {
    switch (this.units) {
      case 'meter':
        return inches * 0.0254;
      case 'foot':
      case 'usSurveyFoot':
      default:
        return inches / 12;
    }
  }

  private worldPointDiameter(multiplier: number): number {
    return THREE.MathUtils.lerp(0.08, 0.34, (THREE.MathUtils.clamp(multiplier, 1, 5) - 1) / 4);
  }

  private static diskTexture: THREE.Texture | null = null;
  private static getDiskTexture(): THREE.Texture | null {
    if (typeof document === 'undefined') return null; // headless (tests): no canvas texture
    if (StreamingPointCloud.diskTexture) return StreamingPointCloud.diskTexture;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      StreamingPointCloud.diskTexture = new THREE.Texture();
      return StreamingPointCloud.diskTexture;
    }
    const gradient = ctx.createRadialGradient(32, 32, 5, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.72, 'rgba(255,255,255,1)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(32, 32, 32, 0, Math.PI * 2);
    ctx.fill();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    StreamingPointCloud.diskTexture = texture;
    return texture;
  }
}
