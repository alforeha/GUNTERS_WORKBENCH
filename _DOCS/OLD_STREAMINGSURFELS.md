import * as THREE from 'three';
import type { AnalyticSurfelTilePayload } from '../shared/workbench-types';
import type { Vec3 } from './geometry';
import {
  isSettled,
  planEviction,
  projScaleFromPerspective,
  selectStreamingNodes,
  staleRequestKeys,
  type StreamBounds,
  type StreamCameraView,
  type StreamNode,
} from './pointCloudStreaming';

export type SurfelTileFetcher = (keys: string[]) => Promise<{ key: string; payload: AnalyticSurfelTilePayload }[]>;

export interface SurfelHierarchy {
  root: string;
  origin: [number, number, number];
  bounds: StreamBounds;
  totalSurfels: number;
  nodes: Array<StreamNode>;
}

export const DEFAULT_SURFEL_SSE_THRESHOLD = 320;
const MAX_FETCH_PER_UPDATE = 6;

interface LoadedSurfelNode {
  key: string;
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  payload: AnalyticSurfelTilePayload;
  lastUsedTick: number;
}

export class StreamingSurfels {
  readonly handle: string;
  readonly group = new THREE.Group();

  private readonly nodesByKey = new Map<string, StreamNode>();
  private readonly rootKey: string;
  private readonly origin: [number, number, number];
  private readonly sceneOrigin: Vec3;
  private readonly worldBounds: StreamBounds;
  private readonly totalSurfels: number;
  private readonly fetchTiles: SurfelTileFetcher;
  private readonly onChanged?: () => void;
  private readonly material: THREE.ShaderMaterial;

  private readonly loaded = new Map<string, LoadedSurfelNode>();
  private readonly inFlight = new Set<string>();
  private readonly dropped = new Set<string>();
  private visibleAll = true;
  private sizeScale = 1;
  private tick = 0;
  private sseThreshold = DEFAULT_SURFEL_SSE_THRESHOLD;
  private budgetMax = 2_500_000;
  private loadedSurfelCount = 0;
  private selectionKeys = new Set<string>();
  private settled = false;

  constructor(
    handle: string,
    hierarchy: SurfelHierarchy,
    sceneOrigin: Vec3,
    fetchTiles: SurfelTileFetcher,
    onChanged?: () => void,
  ) {
    this.handle = handle;
    this.rootKey = hierarchy.root;
    this.origin = hierarchy.origin;
    this.sceneOrigin = sceneOrigin;
    this.worldBounds = hierarchy.bounds;
    this.totalSurfels = hierarchy.totalSurfels;
    this.fetchTiles = fetchTiles;
    this.onChanged = onChanged;
    for (const node of hierarchy.nodes) this.nodesByKey.set(node.key, node);
    this.group.name = `analytic-surfels:${handle}`;
    this.group.position.set(
      this.origin[0] - sceneOrigin[0],
      this.origin[1] - sceneOrigin[1],
      this.origin[2] - sceneOrigin[2],
    );
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        sizeScale: { value: 1 },
        cameraRight: { value: new THREE.Vector3(1, 0, 0) },
        cameraUp: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: `
        uniform float sizeScale;
        uniform vec3 cameraRight;
        uniform vec3 cameraUp;
        attribute vec3 instanceCenter;
        attribute vec3 instanceNormal;
        attribute vec3 instanceColor;
        attribute float instanceRadius;
        attribute float instanceConfidence;
        attribute float instanceFlags;
        varying vec2 vCorner;
        varying vec3 vColor;
        varying float vConfidence;
        void main() {
          vec2 corner = position.xy;
          bool screenAligned = mod(instanceFlags, 2.0) >= 1.0;
          vec3 normal = normalize(instanceNormal);
          vec3 tangent;
          vec3 bitangent;
          if (screenAligned) {
            tangent = normalize(cameraRight);
            bitangent = normalize(cameraUp);
          } else {
            vec3 guide = abs(normal.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
            tangent = normalize(cross(guide, normal));
            bitangent = normalize(cross(normal, tangent));
          }
          vec3 worldPos = instanceCenter + (tangent * corner.x + bitangent * corner.y) * instanceRadius * sizeScale;
          vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          vCorner = corner;
          vColor = instanceColor;
          vConfidence = instanceConfidence;
        }
      `,
      fragmentShader: `
        varying vec2 vCorner;
        varying vec3 vColor;
        varying float vConfidence;
        void main() {
          float dist = dot(vCorner, vCorner);
          if (dist > 1.0) discard;
          float edge = smoothstep(1.0, 0.7, 1.0 - dist);
          float alpha = mix(0.55, 0.95, clamp(vConfidence, 0.0, 1.0)) * edge;
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
      transparent: true,
      alphaTest: 0.12,
      depthWrite: true,
      toneMapped: false,
      side: THREE.DoubleSide,
      fog: true,
    });
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

  setDisplay(visible: boolean, sizeScale: number): void {
    this.visibleAll = visible;
    this.sizeScale = THREE.MathUtils.lerp(0.7, 1.7, (THREE.MathUtils.clamp(sizeScale, 1, 5) - 1) / 4);
    this.group.visible = visible;
    this.material.uniforms['sizeScale'].value = this.sizeScale;
  }

  getDisclosure(): string {
    const state = this.settled ? 'settled' : 'refining';
    return `Analytic surfel render (derived) - streaming ${compact(this.loadedSurfelCount)} of ${compact(this.totalSurfels)} surfels · ${state} · not measured points`;
  }

  update(camera: THREE.Camera, viewportHeightPx: number, fovYRadians: number): boolean {
    this.tick++;
    this.group.visible = this.visibleAll;
    if (!this.visibleAll) {
      let changed = false;
      for (const loaded of this.loaded.values()) {
        if (loaded.mesh.visible) {
          loaded.mesh.visible = false;
          changed = true;
        }
      }
      this.selectionKeys = new Set();
      this.settled = this.inFlight.size === 0;
      return changed;
    }

    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    this.material.uniforms['cameraRight'].value.copy(right);
    this.material.uniforms['cameraUp'].value.copy(up);

    const camView: StreamCameraView = {
      position: [camera.position.x + this.sceneOrigin[0], camera.position.y + this.sceneOrigin[1], camera.position.z + this.sceneOrigin[2]],
      projScale: projScaleFromPerspective(viewportHeightPx, fovYRadians),
    };
    const selection = selectStreamingNodes(this.nodesByKey, this.rootKey, camView, {
      sseThreshold: this.sseThreshold,
      budgetMax: this.budgetMax,
    });
    this.selectionKeys = selection.keys;
    let changed = false;

    for (const key of selection.keys) {
      const loaded = this.loaded.get(key);
      if (loaded) {
        loaded.lastUsedTick = this.tick;
        if (!loaded.mesh.visible) {
          loaded.mesh.visible = true;
          changed = true;
        }
      }
    }
    for (const [key, loaded] of this.loaded) {
      if (!selection.keys.has(key) && loaded.mesh.visible) {
        loaded.mesh.visible = false;
        changed = true;
      }
    }

    for (const key of staleRequestKeys(this.inFlight, selection.keys)) this.dropped.add(key);

    const toFetch: string[] = [];
    for (const scored of selection.nodes) {
      if (this.loaded.has(scored.key) || this.inFlight.has(scored.key)) continue;
      toFetch.push(scored.key);
      if (toFetch.length >= MAX_FETCH_PER_UPDATE) break;
    }
    if (toFetch.length > 0) void this.dispatchFetch(toFetch);

    const evictKeys = planEviction(
      [...this.loaded.values()].map((loaded) => ({ key: loaded.key, pointCount: loaded.payload.surfelCount, lastUsedTick: loaded.lastUsedTick })),
      selection.keys,
      this.budgetMax,
    );
    for (const key of evictKeys) this.evict(key);
    if (evictKeys.length > 0) changed = true;

    this.settled = this.inFlight.size === 0 && isSettled(selection.keys, new Set(this.loaded.keys()));
    return changed;
  }

  dispose(): void {
    for (const loaded of this.loaded.values()) {
      loaded.mesh.geometry.dispose();
      loaded.mesh.removeFromParent();
    }
    this.loaded.clear();
    this.inFlight.clear();
    this.dropped.clear();
    this.loadedSurfelCount = 0;
    this.material.dispose();
    this.group.removeFromParent();
  }

  private async dispatchFetch(keys: string[]): Promise<void> {
    for (const key of keys) this.inFlight.add(key);
    let tiles: { key: string; payload: AnalyticSurfelTilePayload }[];
    try {
      tiles = await this.fetchTiles(keys);
    } catch {
      for (const key of keys) this.inFlight.delete(key);
      return;
    }
    let built = false;
    for (const { key, payload } of tiles) {
      this.inFlight.delete(key);
      if (this.dropped.delete(key)) continue;
      if (this.loaded.has(key)) continue;
      this.buildNode(key, payload);
      built = true;
    }
    for (const key of keys) this.inFlight.delete(key);
    if (built) this.onChanged?.();
  }

  private buildNode(key: string, payload: AnalyticSurfelTilePayload): void {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3),
    );
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    geometry.setAttribute('instanceCenter', new THREE.InstancedBufferAttribute(payload.positions, 3));
    geometry.setAttribute('instanceNormal', new THREE.InstancedBufferAttribute(payload.normals, 3));
    geometry.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(payload.colors, 3, true));
    geometry.setAttribute('instanceRadius', new THREE.InstancedBufferAttribute(payload.radii, 1));
    geometry.setAttribute('instanceConfidence', new THREE.InstancedBufferAttribute(payload.confidence, 1));
    geometry.setAttribute('instanceFlags', new THREE.InstancedBufferAttribute(payload.flags, 1));
    geometry.instanceCount = payload.surfelCount;
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    mesh.visible = this.selectionKeys.has(key);
    mesh.name = `analytic-surfel-node:${this.handle}:${key}`;
    this.group.add(mesh);
    this.loaded.set(key, { key, mesh, payload, lastUsedTick: this.tick });
    this.loadedSurfelCount += payload.surfelCount;
  }

  private evict(key: string): void {
    const loaded = this.loaded.get(key);
    if (!loaded) return;
    this.loadedSurfelCount -= loaded.payload.surfelCount;
    loaded.mesh.geometry.dispose();
    loaded.mesh.removeFromParent();
    this.loaded.delete(key);
  }
}

function compact(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}