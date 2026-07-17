import * as THREE from 'three';
import type { PointCloudDataset, PointCloudNodePayload, PointCloudOctreeNode } from '../core/contract';
import type { Vec3 } from './geometry';
import { applyIsolateClip, createIsolateClipUniforms, setIsolateClipPolygon, setRangeClipDistance } from './isolateClip';
import {
  DEFAULT_POINT_APPEARANCE,
  effectivePointDiameter,
  rangeClipWorld,
  type PointAppearance,
} from './pointCloudAppearance';
import {
  GeotiffOverviewSampler,
  POINT_BUDGET_MAX,
  POINT_BUDGET_MIN,
  defaultFilterState,
  pointPasses,
  selectLod,
  terrainColor,
  type FilterState,
  type NodeScore,
  type PointDisplayMode,
} from './pointCloudLod';

interface RenderNode {
  source: PointCloudOctreeNode;
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null;
  localBounds: THREE.Box3;
  sampleCount: number;
  currentStride: number;
  colorBuiltEpoch: number;
  built: boolean;
  position: Float32Array;
  color: Float32Array;
  dense: PointCloudNodePayload | null;
  densePosition: Float32Array;
  denseColor: Float32Array;
  lastDensifiedUseAt: number;
}

export class RenderPointCloud {
  readonly handle: string;
  readonly dataset: PointCloudDataset;
  readonly group = new THREE.Group();

  private static diskTexture: THREE.Texture | null = null;

  private nodes: RenderNode[] = [];
  private material: THREE.PointsMaterial;
  private readonly isolateClip = createIsolateClipUniforms();
  private visibleAll = true;
  private pointSize = 2;
  private appearance: PointAppearance = DEFAULT_POINT_APPEARANCE;
  private density = 1;
  private originDelta: Vec3;
  private origin: Vec3;
  private displayMode: PointDisplayMode = 'rgb';
  private filter: FilterState = defaultFilterState();
  private overviewSampler: GeotiffOverviewSampler | null = null;
  private colorEpoch = 0;
  private densifiedPointBudget = 1_500_000;
  private densifiedPointCount = 0;
  private lastCameraPosition = new THREE.Vector3();

  constructor(handle: string, dataset: PointCloudDataset, sceneOrigin: Vec3) {
    if (!dataset.octree) throw new Error('Point cloud dataset has no octree');
    this.handle = handle;
    this.dataset = dataset;
    this.origin = dataset.octree.origin;
    this.originDelta = [
      dataset.octree.origin[0] - sceneOrigin[0],
      dataset.octree.origin[1] - sceneOrigin[1],
      dataset.octree.origin[2] - sceneOrigin[2],
    ];
    this.group.name = `point-cloud:${handle}`;
    this.group.position.set(this.originDelta[0], this.originDelta[1], this.originDelta[2]);
    this.material = new THREE.PointsMaterial({
      size: this.effectivePointSize(),
      sizeAttenuation: true,
      vertexColors: true,
      toneMapped: false,
      map: RenderPointCloud.getDiskTexture(),
      alphaTest: 0.35,
      transparent: true,
      fog: true,
    });
    applyIsolateClip(this.material, this.isolateClip);
    this.displayMode = dataset.attributes.hasRgb ? 'rgb' : 'elevation';
    this.nodes = this.flattenNodes(dataset.octree.root);
  }

  get bounds(): THREE.Box3 {
    const box = new THREE.Box3();
    if (!this.group.visible) return box.makeEmpty();
    const worldBounds = this.dataset.bounds;
    box.set(
      new THREE.Vector3(
        worldBounds.minX - this.origin[0] + this.originDelta[0],
        worldBounds.minY - this.origin[1] + this.originDelta[1],
        worldBounds.minZ - this.origin[2] + this.originDelta[2],
      ),
      new THREE.Vector3(
        worldBounds.maxX - this.origin[0] + this.originDelta[0],
        worldBounds.maxY - this.origin[1] + this.originDelta[1],
        worldBounds.maxZ - this.origin[2] + this.originDelta[2],
      ),
    );
    return box;
  }

  setDisplay(visible: boolean, pointSize: number): void {
    this.visibleAll = visible;
    this.pointSize = THREE.MathUtils.clamp(pointSize, 1, 5);
    this.group.visible = visible;
    this.material.size = this.effectivePointSize();
    this.material.needsUpdate = true;
  }

  /** Shared appearance model: fixed/auto radius, quick scale, and range clip. */
  setAppearance(appearance: PointAppearance): void {
    this.appearance = appearance;
    setRangeClipDistance(this.isolateClip, rangeClipWorld(appearance, this.dataset.meta.units.linear));
    this.material.size = this.effectivePointSize();
    this.material.needsUpdate = true;
  }

  /** Active camera-range clip in world units (null = off); picking parity uses this. */
  getRangeClipWorld(): number | null {
    return this.isolateClip.rangeClip.value > 0 ? this.isolateClip.rangeClip.value : null;
  }

  /** Current world-space point diameter (PointsMaterial.size); exposed for tests. */
  get pointDiameterWorld(): number {
    return this.material.size;
  }

  private effectivePointSize(): number {
    return effectivePointDiameter(this.appearance, this.dataset.meta.units.linear, this.worldPointSize(this.pointSize));
  }

  setDensity(density: number): void {
    this.density = THREE.MathUtils.clamp(density, 0.1, 1);
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

  setFilter(filter: FilterState): void {
    this.filter = filter;
    this.colorEpoch++;
  }

  setOverviewSampler(sampler: GeotiffOverviewSampler | null): void {
    this.overviewSampler = sampler;
    if (this.displayMode === 'geotiff') this.colorEpoch++;
  }

  setDensifiedPointBudget(pointBudget: number): void {
    this.densifiedPointBudget = Math.max(100_000, Math.round(pointBudget));
    this.evictDensifiedNodes();
  }

  get displayModeValue(): PointDisplayMode {
    return this.displayMode;
  }

  hasDensifiedPoints(): boolean {
    return this.densifiedPointCount > 0;
  }

  getDensifiedPointCount(): number {
    return this.densifiedPointCount;
  }

  applyDensifiedNode(nodeId: number, payload: PointCloudNodePayload): boolean {
    const node = this.nodes.find((candidate) => candidate.source.id === nodeId);
    if (!node || !node.points) return false;
    if (node.dense) this.densifiedPointCount -= node.dense.pointCount;
    node.dense = payload;
    node.densePosition = new Float32Array(payload.pointCount * 3);
    node.denseColor = new Float32Array(payload.pointCount * 3);
    node.built = false;
    node.currentStride = 0;
    node.lastDensifiedUseAt = performance.now();
    this.densifiedPointCount += payload.pointCount;
    this.evictDensifiedNodes(nodeId);
    return true;
  }

  releaseDensifiedNode(nodeId: number): boolean {
    const node = this.nodes.find((candidate) => candidate.source.id === nodeId);
    if (!node?.dense) return false;
    this.densifiedPointCount -= node.dense.pointCount;
    node.dense = null;
    node.densePosition = new Float32Array(0);
    node.denseColor = new Float32Array(0);
    node.built = false;
    node.currentStride = 0;
    return true;
  }

  nearestLeafNodeIds(camera: THREE.Camera, exaggeration: number, limit = 2): number[] {
    const center = new THREE.Vector3();
    return this.nodes
      .filter((node) => node.source.children.length === 0 && node.source.sourceRanges.length > 0)
      .map((node) => ({
        id: node.source.id,
        distance: camera.position.distanceTo(this.renderedBounds(node.localBounds, exaggeration).getCenter(center.clone())),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit)
      .map((entry) => entry.id);
  }

  updateVisible(camera: THREE.Camera, exaggeration: number, cameraSettled: boolean): boolean {
    this.lastCameraPosition.copy(camera.position);
    this.group.visible = this.visibleAll;
    if (!this.group.visible) {
      let changed = false;
      for (const node of this.nodes) changed = this.hideNode(node) || changed;
      return changed;
    }

    const projScreen = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(projScreen);
    const scores: NodeScore[] = [];
    const nodeByIndex: RenderNode[] = [];
    const center = new THREE.Vector3();
    for (const node of this.nodes) {
      if (!node.points) continue;
      const candidateCount = node.dense?.pointCount ?? node.sampleCount;
      if (candidateCount === 0) continue;
      const testBox = this.renderedBounds(node.localBounds, exaggeration);
      if (!frustum.intersectsBox(testBox)) continue;
      const index = nodeByIndex.length;
      nodeByIndex.push(node);
      scores.push({
        index,
        distance: camera.position.distanceTo(testBox.getCenter(center.clone())),
        sampleCount: candidateCount,
      });
    }

    const lod = selectLod(scores, POINT_BUDGET_MIN, POINT_BUDGET_MAX);
    const selected = new Set<RenderNode>();
    let changed = false;
    for (const result of lod) {
      const node = nodeByIndex[result.index]!;
      selected.add(node);
      if (node.dense) node.lastDensifiedUseAt = performance.now();
      const targetStride = node.dense ? 1 : this.densityAdjustedStride(result.stride);
      const colorsStale = node.colorBuiltEpoch !== this.colorEpoch;
      if (!node.built || colorsStale || node.currentStride !== targetStride) {
        if (cameraSettled || !node.built || colorsStale) {
          this.packNode(node, targetStride);
          changed = true;
        } else if (node.points && !node.points.visible) {
          node.points.visible = true;
          changed = true;
        }
      } else if (node.points && !node.points.visible) {
        node.points.visible = true;
        changed = true;
      }
    }

    for (const node of this.nodes) {
      if (!selected.has(node)) changed = this.hideNode(node) || changed;
    }
    return changed;
  }

  dispose(): void {
    for (const node of this.nodes) {
      node.points?.geometry.dispose();
      node.points?.removeFromParent();
    }
    this.nodes = [];
    this.material.dispose();
    this.group.removeFromParent();
  }

  private flattenNodes(root: PointCloudOctreeNode): RenderNode[] {
    const out: RenderNode[] = [];
    const visit = (source: PointCloudOctreeNode) => {
      let points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
      let position = new Float32Array(0);
      let color = new Float32Array(0);
      if (source.sampleCount > 0 || source.sourceRanges.length > 0) {
        position = new Float32Array(Math.max(source.sampleCount, 1) * 3);
        color = new Float32Array(Math.max(source.sampleCount, 1) * 3);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
        geometry.setDrawRange(0, 0);
        points = new THREE.Points(geometry, this.material);
        points.name = `point-cloud-node:${this.handle}:${source.id}`;
        points.frustumCulled = false;
        points.visible = false;
        this.group.add(points);
      }
      out.push({
        source,
        points,
        sampleCount: source.sampleCount,
        currentStride: 0,
        colorBuiltEpoch: -1,
        built: false,
        position,
        color,
        dense: null,
        densePosition: new Float32Array(0),
        denseColor: new Float32Array(0),
        lastDensifiedUseAt: 0,
        localBounds: new THREE.Box3(
          new THREE.Vector3(source.localBounds.minX, source.localBounds.minY, source.localBounds.minZ),
          new THREE.Vector3(source.localBounds.maxX, source.localBounds.maxY, source.localBounds.maxZ),
        ),
      });
      for (const child of source.children) visit(child);
    };
    visit(root);
    return out;
  }

  private packNode(node: RenderNode, stride: number): void {
    if (!node.points) return;
    const src = node.source;
    const dense = node.dense;
    const count = dense?.pointCount ?? node.sampleCount;
    const positionAttr = node.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const pos = dense ? node.densePosition : node.position;
    const col = dense ? node.denseColor : node.color;
    const zRange = this.dataset.octree?.zRange;
    const zMin = zRange ? zRange[0] : this.dataset.bounds.minZ;
    const zMax = zRange ? zRange[1] : this.dataset.bounds.maxZ;
    const zSpan = zMax - zMin || 1;
    const classifications = dense?.classifications ?? src.classifications;
    const returnNumbers = dense?.returnNumbers ?? src.returnNumbers;
    const numberOfReturns = dense?.numberOfReturns ?? src.numberOfReturns;
    const step = Math.max(1, stride);

    if (dense && positionAttr.array !== node.densePosition) {
      node.points.geometry.setAttribute('position', new THREE.BufferAttribute(node.densePosition, 3));
      node.points.geometry.setAttribute('color', new THREE.BufferAttribute(node.denseColor, 3));
    } else if (!dense && positionAttr.array !== node.position) {
      node.points.geometry.setAttribute('position', new THREE.BufferAttribute(node.position, 3));
      node.points.geometry.setAttribute('color', new THREE.BufferAttribute(node.color, 3));
    }
    const livePositionAttr = node.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const liveColorAttr = node.points.geometry.getAttribute('color') as THREE.BufferAttribute;

    let written = 0;
    for (let i = 0; i < count; i += step) {
      const cls = classifications[i] ?? 0;
      const rn = returnNumbers[i] ?? 1;
      const nr = numberOfReturns[i] ?? 1;
      if (!pointPasses(cls, rn, nr, this.filter)) continue;
      const sx = dense?.positions[i * 3] ?? src.positions[i * 3] ?? 0;
      const sy = dense?.positions[i * 3 + 1] ?? src.positions[i * 3 + 1] ?? 0;
      const sz = dense?.positions[i * 3 + 2] ?? src.positions[i * 3 + 2] ?? 0;
      const o = written * 3;
      pos[o] = sx;
      pos[o + 1] = sy;
      pos[o + 2] = sz;
      const c = this.colorFor(src, dense, i, sx, sy, sz, zMin, zSpan);
      col[o] = c[0];
      col[o + 1] = c[1];
      col[o + 2] = c[2];
      written++;
    }

    livePositionAttr.needsUpdate = true;
    liveColorAttr.needsUpdate = true;
    node.points.geometry.setDrawRange(0, written);
    node.points.geometry.computeBoundingSphere();
    node.points.visible = written > 0;
    node.currentStride = step;
    node.colorBuiltEpoch = this.colorEpoch;
    node.built = true;
  }

  private densityAdjustedStride(stride: number): number {
    return Math.max(1, Math.round(stride / this.density));
  }

  private colorFor(
    src: PointCloudOctreeNode,
    dense: PointCloudNodePayload | null,
    i: number,
    localX: number,
    localY: number,
    localZ: number,
    zMin: number,
    zSpan: number,
  ): [number, number, number] {
    switch (this.displayMode) {
      case 'intensity': {
        const intensity = dense?.intensities[i] ?? src.intensities[i] ?? 0;
        const g = THREE.MathUtils.clamp(intensity, 0, 1);
        return [g, g, g];
      }
      case 'elevation': {
        const worldZ = localZ + this.origin[2];
        const rgb255 = terrainColor((worldZ - zMin) / zSpan);
        return [rgb255[0] / 255, rgb255[1] / 255, rgb255[2] / 255];
      }
      case 'geotiff': {
        if (this.overviewSampler) {
          const sampled = this.overviewSampler.sample(localX + this.origin[0], localY + this.origin[1]);
          if (sampled) return [sampled[0] / 255, sampled[1] / 255, sampled[2] / 255];
        }
        return this.rgbColor(src, dense, i, 200);
      }
      case 'rgb':
      default:
        return this.rgbColor(src, dense, i, 255);
    }
  }

  private rgbColor(
    src: PointCloudOctreeNode,
    dense: PointCloudNodePayload | null,
    i: number,
    fallback: number,
  ): [number, number, number] {
    const colors = dense?.colors ?? src.colors;
    return [
      (colors[i * 3] ?? fallback) / 255,
      (colors[i * 3 + 1] ?? fallback) / 255,
      (colors[i * 3 + 2] ?? fallback) / 255,
    ];
  }

  private renderedBounds(localBounds: THREE.Box3, exaggeration: number): THREE.Box3 {
    return new THREE.Box3(
      new THREE.Vector3(
        localBounds.min.x + this.originDelta[0],
        localBounds.min.y + this.originDelta[1],
        (localBounds.min.z + this.originDelta[2]) * exaggeration,
      ),
      new THREE.Vector3(
        localBounds.max.x + this.originDelta[0],
        localBounds.max.y + this.originDelta[1],
        (localBounds.max.z + this.originDelta[2]) * exaggeration,
      ),
    );
  }

  private hideNode(node: RenderNode, keepBuilt = false): boolean {
    if (!node.points) return false;
    if (!node.points.visible && node.currentStride === 0 && !node.built) return false;
    node.points.geometry.setDrawRange(0, 0);
    node.points.visible = false;
    node.currentStride = 0;
    if (!keepBuilt) node.built = false;
    return true;
  }

  private evictDensifiedNodes(protectedNodeId?: number): void {
    if (this.densifiedPointCount <= this.densifiedPointBudget) return;
    const center = new THREE.Vector3();
    const evictable = this.nodes
      .filter((node) => node.dense && node.source.id !== protectedNodeId)
      .map((node) => ({
        node,
        distance: this.lastCameraPosition.distanceTo(this.renderedBounds(node.localBounds, 1).getCenter(center.clone())),
      }))
      .sort((a, b) => {
        if (a.node.lastDensifiedUseAt !== b.node.lastDensifiedUseAt) {
          return a.node.lastDensifiedUseAt - b.node.lastDensifiedUseAt;
        }
        return b.distance - a.distance;
      });
    for (const entry of evictable) {
      if (this.densifiedPointCount <= this.densifiedPointBudget) break;
      this.releaseDensifiedNode(entry.node.source.id);
    }
  }

  private worldPointSize(multiplier: number): number {
    return THREE.MathUtils.lerp(0.04, 0.18, (THREE.MathUtils.clamp(multiplier, 1, 5) - 1) / 4);
  }

  private static getDiskTexture(): THREE.Texture | null {
    if (typeof document === 'undefined') return null; // headless (tests): no canvas texture
    if (RenderPointCloud.diskTexture) return RenderPointCloud.diskTexture;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      RenderPointCloud.diskTexture = new THREE.Texture();
      return RenderPointCloud.diskTexture;
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
    RenderPointCloud.diskTexture = texture;
    return texture;
  }
}
