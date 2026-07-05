import * as THREE from 'three';
import type { GeotiffDataset } from '../core/contract';
import type {
  GeotiffDecodeTileRequest,
  GeotiffOpenRequest,
  GeotiffOverviewRequest,
  GeotiffWorkerMessage,
} from '../workers/geotiff.worker';
import type { RenderSurface } from './RenderSurface';
import type { Vec3 } from './geometry';
import { DRAPE_OFFSET_FT } from './RenderDxf';
import { GeotiffOverviewSampler } from './pointCloudLod';

const OVERVIEW_MAX_DIMENSION = 1024;

const TILE_SIZE_PX = 1024;
const MIN_SEGMENTS = 8;
const MAX_SEGMENTS = 24;
const SEGMENT_SPACING_FT = 1.5;
const COARSE_SCALE_DIVISOR = 4;
const MID_SCALE_DIVISOR = 2;
const FULL_SCALE_DIVISOR = 1;
const FULL_RES_DISTANCE_FT = 180;
const HALF_RES_DISTANCE_FT = 650;
const HOVER_FULL_RES_DISTANCE_FT = 250;
const HOVER_HALF_RES_DISTANCE_FT = 900;
const MAX_CONCURRENT_TILE_DECODES = 4;

interface TileState {
  id: string;
  window: [number, number, number, number];
  worldBounds: { minX: number; minY: number; maxX: number; maxY: number };
  localBounds: THREE.Box3;
  loaded: boolean;
  loading: boolean;
  loadingScaleDivisor: 1 | 2 | 4 | null;
  loadedScaleDivisor: 1 | 2 | 4 | null;
  requestToken: number;
  mesh: THREE.Mesh | null;
  texture: THREE.DataTexture | null;
  bounds: THREE.Box3;
}

export function geotiffTileFrustumBox(
  localBounds: THREE.Box3,
  surfaceBounds: THREE.Box3,
  exaggeration: number,
): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(localBounds.min.x, localBounds.min.y, surfaceBounds.min.z * exaggeration),
    new THREE.Vector3(localBounds.max.x, localBounds.max.y, surfaceBounds.max.z * exaggeration),
  );
}

export function geotiffUvForWorldPoint(
  worldX: number,
  worldY: number,
  dataset: Pick<GeotiffDataset, 'width' | 'height' | 'geoTransform'>,
): { u: number; v: number } {
  const transform = dataset.geoTransform;
  if (!transform) return { u: 0, v: 0 };
  const widthWorld = transform.pixelScale[0] * dataset.width;
  const heightWorld = transform.pixelScale[1] * dataset.height;
  const rawU = widthWorld === 0 ? 0 : (worldX - transform.origin[0]) / widthWorld;
  const rawV = heightWorld === 0 ? 0 : (worldY - transform.origin[1]) / heightWorld;
  return {
    u: THREE.MathUtils.clamp(rawU, 0, 1),
    v: THREE.MathUtils.clamp(rawV, 0, 1),
  };
}

export function chooseGeotiffLodDivisor(distanceFt: number, hoverMode: boolean): 1 | 2 | 4 {
  const fullThreshold = hoverMode ? HOVER_FULL_RES_DISTANCE_FT : FULL_RES_DISTANCE_FT;
  const halfThreshold = hoverMode ? HOVER_HALF_RES_DISTANCE_FT : HALF_RES_DISTANCE_FT;
  if (distanceFt <= fullThreshold) return FULL_SCALE_DIVISOR;
  if (distanceFt <= halfThreshold) return MID_SCALE_DIVISOR;
  return COARSE_SCALE_DIVISOR;
}

export class RenderGeotiff {
  readonly handle: string;
  readonly dataset: GeotiffDataset;
  readonly group = new THREE.Group();

  private origin: Vec3;
  private visibleAll = true;
  private opacity = 1;
  private tiles: TileState[] = [];
  private worker: Worker;
  private workerReady = false;
  private target: RenderSurface | null = null;
  private nextMessageId = 0;
  private pending = new Map<number, (msg: GeotiffWorkerMessage) => void>();
  private requestRender: () => void;
  private notifyBoundsChanged: () => void;
  private maxAnisotropy: number;
  private overlap = false;
  private lastRejectedTargetHandle: string | null = null;
  private warnedDecodeFailure = false;
  private warnedMissingPickMesh = false;
  private currentExaggeration = 1;
  private overviewPromise: Promise<GeotiffOverviewSampler | null> | null = null;
  private disposedFlag = false;

  constructor(
    handle: string,
    dataset: GeotiffDataset,
    file: File,
    origin: Vec3,
    renderer: THREE.WebGLRenderer,
    requestRender: () => void,
    notifyBoundsChanged: () => void,
  ) {
    this.handle = handle;
    this.dataset = dataset;
    this.origin = origin;
    this.maxAnisotropy = Math.max(1, renderer.capabilities.getMaxAnisotropy());
    this.requestRender = requestRender;
    this.notifyBoundsChanged = notifyBoundsChanged;
    this.group.name = `geotiff:${handle}`;

    this.tiles = this.buildTileIndex();
    this.worker = new Worker(new URL('../workers/geotiff.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<GeotiffWorkerMessage>) => {
      const resolver = this.pending.get(e.data.id);
      if (!resolver) return;
      resolver(e.data);
    };
    this.worker.onerror = (e) => {
      console.warn(`[GeoTIFF] worker error for "${this.dataset.name}":`, e.message);
    };
    this.openWorker(file);
  }

  get bounds(): THREE.Box3 {
    const box = new THREE.Box3();
    if (!this.group.visible || !this.target || !this.overlap) return box.makeEmpty();
    for (const tile of this.tiles) {
      if (tile.mesh) box.union(tile.bounds);
    }
    return box;
  }

  setTarget(target: RenderSurface | null): void {
    if (this.target === target) return;
    this.target = target;
    this.overlap = this.computeOverlap();
    this.warnIfRejectedByOverlap();
    this.clearLoadedTiles();
    this.notifyBoundsChanged();
    this.requestRender();
  }

  setDisplay(visible: boolean, opacity: number): void {
    this.visibleAll = visible;
    this.opacity = opacity;
    this.group.visible = visible;
    for (const tile of this.tiles) {
      if (!tile.mesh) continue;
      const material = tile.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = opacity;
      material.transparent = true;
      material.needsUpdate = true;
    }
    this.requestRender();
  }

  updateVisible(camera: THREE.Camera, exaggeration: number, cameraSettled: boolean, hoverMode: boolean): boolean {
    this.currentExaggeration = exaggeration;
    this.group.visible = this.visibleAll && !!this.target && this.overlap;
    if (!this.group.visible || !this.target || !this.workerReady) {
      let changed = false;
      for (const tile of this.tiles) {
        if (tile.mesh) {
          this.disposeTile(tile);
          changed = true;
        }
      }
      if (changed) this.notifyBoundsChanged();
      return changed;
    }

    const projScreen = new THREE.Matrix4().multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    const frustum = new THREE.Frustum().setFromProjectionMatrix(projScreen);
    this.group.updateMatrixWorld(true);
    const surfaceBounds = this.target.bounds;

    let changed = false;
    const decodeCandidates: { tile: TileState; scaleDivisor: 1 | 2 | 4; reload: boolean; distance: number }[] = [];

    for (const tile of this.tiles) {
      const testBox = geotiffTileFrustumBox(tile.localBounds, surfaceBounds, exaggeration);
      const shouldShow = frustum.intersectsBox(testBox);
      if (shouldShow) {
        const desiredScaleDivisor = cameraSettled
          ? this.pickScaleDivisor(camera, tile, surfaceBounds, hoverMode)
          : tile.loadedScaleDivisor ?? COARSE_SCALE_DIVISOR;
        if (!tile.loaded && !tile.loading) {
          decodeCandidates.push({
            tile,
            scaleDivisor: desiredScaleDivisor,
            reload: false,
            distance: this.tileDistance(camera, tile, surfaceBounds),
          });
        } else if (
          cameraSettled &&
          tile.loaded &&
          tile.loadedScaleDivisor !== desiredScaleDivisor &&
          !tile.loading
        ) {
          decodeCandidates.push({
            tile,
            scaleDivisor: desiredScaleDivisor,
            reload: true,
            distance: this.tileDistance(camera, tile, surfaceBounds),
          });
        }
      } else if (tile.mesh) {
        this.disposeTile(tile);
        changed = true;
      }
    }
    decodeCandidates.sort((a, b) => a.distance - b.distance);
    let activeDecodes = this.tiles.reduce((count, tile) => count + (tile.loading ? 1 : 0), 0);
    for (const candidate of decodeCandidates) {
      if (activeDecodes >= MAX_CONCURRENT_TILE_DECODES) break;
      void this.decodeTile(candidate.tile, candidate.scaleDivisor);
      activeDecodes++;
    }
    return changed;
  }

  dispose(): void {
    this.disposedFlag = true;
    this.clearLoadedTiles();
    this.pending.clear();
    this.worker.terminate();
    this.group.removeFromParent();
  }

  /**
   * Decode (once, cached) a coarse full-extent overview of this GeoTIFF and resolve a
   * CPU sampler for point-cloud recolor. Resolves null if no geotransform / decode fails.
   */
  requestOverview(): Promise<GeotiffOverviewSampler | null> {
    if (this.overviewPromise) return this.overviewPromise;
    this.overviewPromise = (async (): Promise<GeotiffOverviewSampler | null> => {
      const transform = this.dataset.geoTransform;
      if (!transform || !this.dataset.worldBounds) return null;
      await this.waitForWorkerReady();
      const messageId = ++this.nextMessageId;
      const req: GeotiffOverviewRequest = { kind: 'overview', id: messageId, maxDimension: OVERVIEW_MAX_DIMENSION };
      const response = await new Promise<GeotiffWorkerMessage>((resolve) => {
        this.pending.set(messageId, (msg) => {
          this.pending.delete(messageId);
          resolve(msg);
        });
        this.worker.postMessage(req);
      });
      if (response.type !== 'overview' || !response.ok) {
        this.overviewPromise = null; // allow retry later
        return null;
      }
      const wb = this.dataset.worldBounds;
      return new GeotiffOverviewSampler(response.overview.width, response.overview.height, response.overview.rgba, {
        minX: wb.minX,
        minY: wb.minY,
        maxX: wb.maxX,
        maxY: wb.maxY,
      });
    })();
    return this.overviewPromise;
  }

  private waitForWorkerReady(): Promise<void> {
    if (this.workerReady) return Promise.resolve();
    return new Promise((resolve) => {
      const tick = () => {
        if (this.workerReady || this.disposedFlag) resolve();
        else setTimeout(tick, 30);
      };
      tick();
    });
  }

  private openWorker(file: File): void {
    const messageId = ++this.nextMessageId;
    const req: GeotiffOpenRequest = {
      kind: 'open',
      id: messageId,
      fileName: file.name,
      payload: file,
    };
    this.pending.set(messageId, (msg) => {
      if (msg.type === 'progress') return;
      this.pending.delete(messageId);
      if (msg.type === 'opened' && msg.ok) {
        this.workerReady = true;
      } else if (msg.type === 'result' && !msg.ok) {
        console.warn(`[GeoTIFF] worker open failed for "${this.dataset.name}":`, msg.error);
      }
      this.requestRender();
    });
    this.worker.postMessage(req);
  }

  private buildTileIndex(): TileState[] {
    const transform = this.dataset.geoTransform;
    if (!transform) return [];
    const tiles: TileState[] = [];
    for (let y = 0; y < this.dataset.height; y += TILE_SIZE_PX) {
      for (let x = 0; x < this.dataset.width; x += TILE_SIZE_PX) {
        const x1 = Math.min(this.dataset.width, x + TILE_SIZE_PX);
        const y1 = Math.min(this.dataset.height, y + TILE_SIZE_PX);
        const wx0 = transform.origin[0] + transform.pixelScale[0] * x;
        const wx1 = transform.origin[0] + transform.pixelScale[0] * x1;
        const wy0 = transform.origin[1] + transform.pixelScale[1] * y;
        const wy1 = transform.origin[1] + transform.pixelScale[1] * y1;
        const minX = Math.min(wx0, wx1);
        const maxX = Math.max(wx0, wx1);
        const minY = Math.min(wy0, wy1);
        const maxY = Math.max(wy0, wy1);
        const localBounds = new THREE.Box3(
          new THREE.Vector3(minX - this.origin[0], minY - this.origin[1], 0),
          new THREE.Vector3(maxX - this.origin[0], maxY - this.origin[1], 0),
        );
        tiles.push({
          id: `${x}:${y}`,
          window: [x, y, x1, y1],
          worldBounds: { minX, minY, maxX, maxY },
          localBounds,
          loaded: false,
          loading: false,
          loadingScaleDivisor: null,
          loadedScaleDivisor: null,
          requestToken: 0,
          mesh: null,
          texture: null,
          bounds: new THREE.Box3(),
        });
      }
    }
    return tiles;
  }

  private async decodeTile(tile: TileState, scaleDivisor: 1 | 2 | 4): Promise<void> {
    const requestToken = ++tile.requestToken;
    tile.loading = true;
    tile.loadingScaleDivisor = scaleDivisor;
    const messageId = ++this.nextMessageId;
    const req: GeotiffDecodeTileRequest = {
      kind: 'decodeTile',
      id: messageId,
      window: tile.window,
      scaleDivisor,
    };
    const response = await new Promise<GeotiffWorkerMessage>((resolve) => {
      this.pending.set(messageId, (msg) => {
        this.pending.delete(messageId);
        resolve(msg);
      });
      this.worker.postMessage(req);
    });
    if (requestToken !== tile.requestToken) return;
    tile.loading = false;
    tile.loadingScaleDivisor = null;
    if (response.type !== 'tile' || !response.ok || !this.target || !this.group.visible) {
      if (response.type === 'result' && !response.ok && !this.warnedDecodeFailure) {
        this.warnedDecodeFailure = true;
        console.warn(`[GeoTIFF] tile decode failed for "${this.dataset.name}":`, response.error);
      }
      return;
    }
    this.buildTileMesh(tile, response.tile.width, response.tile.height, response.tile.rgba);
    tile.loaded = true;
    tile.loadedScaleDivisor = response.tile.scaleDivisor;
    this.notifyBoundsChanged();
    this.requestRender();
  }

  private buildTileMesh(tile: TileState, width: number, height: number, rgba: Uint8Array): void {
    if (!this.target?.pickMesh) {
      if (!this.warnedMissingPickMesh) {
        this.warnedMissingPickMesh = true;
        console.warn(`[GeoTIFF] "${this.dataset.name}" cannot drape because the target surface has no mesh.`);
      }
      return;
    }
    const pixels = new Uint8Array(rgba.length);
    pixels.set(rgba);
    const sizeX = tile.worldBounds.maxX - tile.worldBounds.minX;
    const sizeY = tile.worldBounds.maxY - tile.worldBounds.minY;
    const segments = THREE.MathUtils.clamp(
      Math.ceil(Math.max(sizeX, sizeY) / SEGMENT_SPACING_FT),
      MIN_SEGMENTS,
      MAX_SEGMENTS,
    );
    const geometry = new THREE.PlaneGeometry(sizeX, sizeY, segments, segments);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    const down = new THREE.Vector3(0, 0, -1);
    const origin = new THREE.Vector3();
    const surfaceBounds = this.target.bounds;
    const exaggeration = Math.max(this.currentExaggeration, 1e-6);
    const zTopRendered = (surfaceBounds.max.z + 100) * exaggeration;
    const xCenter = (tile.worldBounds.minX + tile.worldBounds.maxX) * 0.5 - this.origin[0];
    const yCenter = (tile.worldBounds.minY + tile.worldBounds.maxY) * 0.5 - this.origin[1];
    const tileWidthWorld = tile.worldBounds.maxX - tile.worldBounds.minX;
    const tileHeightWorld = tile.worldBounds.maxY - tile.worldBounds.minY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < position.count; i++) {
      const localX = xCenter + position.getX(i);
      const localY = yCenter + position.getY(i);
      const worldX = localX + this.origin[0];
      const worldY = localY + this.origin[1];
      origin.set(localX, localY, zTopRendered);
      raycaster.set(origin, down);
      raycaster.far = Infinity;
      const hit = raycaster.intersectObject(this.target.pickMesh, false)[0];
      const z = hit ? hit.point.z / exaggeration + DRAPE_OFFSET_FT : surfaceBounds.min.z;
      position.setXYZ(i, localX, localY, z);
      const u = tileWidthWorld === 0 ? 0 : (worldX - tile.worldBounds.minX) / tileWidthWorld;
      const v = tileHeightWorld === 0 ? 0 : (worldY - tile.worldBounds.minY) / tileHeightWorld;
      uv.setXY(i, THREE.MathUtils.clamp(u, 0, 1), THREE.MathUtils.clamp(v, 0, 1));
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    position.needsUpdate = true;
    uv.needsUpdate = true;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = true;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = this.maxAnisotropy;
    texture.needsUpdate = true;

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: this.opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `geotiff-tile:${this.handle}:${tile.id}`;
    mesh.renderOrder = 20;

    this.disposeTileMesh(tile);
    this.group.add(mesh);
    tile.mesh = mesh;
    tile.texture = texture;
    tile.bounds = new THREE.Box3(
      new THREE.Vector3(tile.localBounds.min.x, tile.localBounds.min.y, minZ),
      new THREE.Vector3(tile.localBounds.max.x, tile.localBounds.max.y, maxZ),
    );
  }

  private disposeTile(tile: TileState): void {
    tile.requestToken++;
    tile.loaded = false;
    tile.loading = false;
    tile.loadingScaleDivisor = null;
    tile.loadedScaleDivisor = null;
    this.disposeTileMesh(tile);
    tile.bounds.makeEmpty();
  }

  private disposeTileMesh(tile: TileState): void {
    tile.mesh?.removeFromParent();
    tile.mesh?.geometry.dispose();
    (tile.mesh?.material as THREE.Material | undefined)?.dispose();
    tile.texture?.dispose();
    tile.mesh = null;
    tile.texture = null;
  }

  private clearLoadedTiles(): void {
    for (const tile of this.tiles) {
      tile.requestToken++;
      tile.loading = false;
      tile.loadingScaleDivisor = null;
      tile.loadedScaleDivisor = null;
      if (tile.mesh) this.disposeTile(tile);
    }
  }

  private computeOverlap(): boolean {
    if (!this.target || !this.dataset.worldBounds) return false;
    const surfaceBounds = this.target.model.positions;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < surfaceBounds.length; i += 3) {
      const x = surfaceBounds[i]!;
      const y = surfaceBounds[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return !(
      this.dataset.worldBounds.maxX < minX ||
      this.dataset.worldBounds.minX > maxX ||
      this.dataset.worldBounds.maxY < minY ||
      this.dataset.worldBounds.minY > maxY
    );
  }

  private warnIfRejectedByOverlap(): void {
    if (!this.target || this.overlap || !this.dataset.worldBounds) {
      this.lastRejectedTargetHandle = null;
      return;
    }
    if (this.lastRejectedTargetHandle === this.target.handle) return;
    this.lastRejectedTargetHandle = this.target.handle;
    console.warn(
      `[GeoTIFF] "${this.dataset.name}" not shown: bounds do not overlap target surface "${this.target.model.name}".`,
      {
        geotiffBounds: this.dataset.worldBounds,
        targetSurface: this.target.handle,
      },
    );
  }

  private pickScaleDivisor(
    camera: THREE.Camera,
    tile: TileState,
    surfaceBounds: THREE.Box3,
    hoverMode: boolean,
  ): 1 | 2 | 4 {
    return chooseGeotiffLodDivisor(this.tileDistance(camera, tile, surfaceBounds), hoverMode);
  }

  private tileDistance(camera: THREE.Camera, tile: TileState, surfaceBounds: THREE.Box3): number {
    const center = new THREE.Vector3(
      (tile.localBounds.min.x + tile.localBounds.max.x) * 0.5,
      (tile.localBounds.min.y + tile.localBounds.max.y) * 0.5,
      (surfaceBounds.min.z + surfaceBounds.max.z) * 0.5,
    );
    return camera.position.distanceTo(center);
  }
}
