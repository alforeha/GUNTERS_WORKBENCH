import * as THREE from 'three';
import type { PointCloudDataset, PointCloudOctreeNode } from '../core/contract';
import type { Vec3 } from './geometry';
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
  /** full sample count for this node (octree-sampled). */
  sampleCount: number;
  /** stride the node is currently drawn at (1 = every sample). 0 = not selected this pass. */
  currentStride: number;
  /** colorEpoch the node's color buffer was last computed at. */
  colorBuiltEpoch: number;
  /** whether the node currently has a usable packed buffer (drawRange may still be 0). */
  built: boolean;
  /** reusable packed position buffer (xyz), sized to sampleCount. */
  position: Float32Array;
  /** reusable packed color buffer (rgb 0–1), sized to sampleCount. */
  color: Float32Array;
}

/**
 * Renders one LAS point cloud from its octree.
 *
 * Invariant that keeps RGB rock-solid: every visible node always has a fully-populated
 * position + color buffer. The first time a node is selected it is packed once (positions +
 * colors for the active display mode). After that, only three cheap things ever happen:
 *   • visibility flips (frustum in/out),
 *   • a draw-range change (LOD stride),
 *   • a color recompute (display mode / filter / GeoTIFF overview changed).
 * Nothing about rendering is gated on the camera being "settled" — settle only decides when
 * we *re-thin* an already-drawn node to a coarser/finer LOD tier, so RGB shows on first paint.
 */
export class RenderPointCloud {
  readonly handle: string;
  readonly dataset: PointCloudDataset;
  readonly group = new THREE.Group();

  private nodes: RenderNode[] = [];
  private material: THREE.PointsMaterial;
  private visibleAll = true;
  private pointSize = 2;
  private density = 1;
  private originDelta: Vec3;
  private origin: Vec3;

  private displayMode: PointDisplayMode = 'rgb';
  private filter: FilterState = defaultFilterState();
  private overviewSampler: GeotiffOverviewSampler | null = null;
  /** bumps whenever color inputs (mode / filter / overview) change. */
  private colorEpoch = 0;

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
      size: this.pointSize,
      sizeAttenuation: false,
      vertexColors: true,
      toneMapped: false,
    });
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
    this.material.size = this.pointSize;
    this.material.needsUpdate = true;
  }

  setDensity(density: number): void {
    this.density = THREE.MathUtils.clamp(density, 0.1, 1);
  }

  setDisplayMode(mode: PointDisplayMode): void {
    if (this.displayMode === mode) return;
    this.displayMode = mode;
    this.colorEpoch++;
  }

  setFilter(filter: FilterState): void {
    this.filter = filter;
    this.colorEpoch++;
  }

  setOverviewSampler(sampler: GeotiffOverviewSampler | null): void {
    this.overviewSampler = sampler;
    if (this.displayMode === 'geotiff') this.colorEpoch++;
  }

  get displayModeValue(): PointDisplayMode {
    return this.displayMode;
  }

  updateVisible(camera: THREE.Camera, exaggeration: number, cameraSettled: boolean): boolean {
    this.group.visible = this.visibleAll;
    if (!this.group.visible) {
      let changed = false;
      for (const node of this.nodes) changed = this.hideNode(node) || changed;
      return changed;
    }

    const projScreen = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(projScreen);

    // Score every frustum-visible node by camera distance.
    const scores: NodeScore[] = [];
    const nodeByIndex: RenderNode[] = [];
    for (const node of this.nodes) {
      if (!node.points || node.sampleCount === 0) continue;
      const testBox = this.renderedBounds(node.localBounds, exaggeration);
      if (!frustum.intersectsBox(testBox)) continue;
      const index = nodeByIndex.length;
      nodeByIndex.push(node);
      scores.push({
        index,
        distance: camera.position.distanceTo(testBox.getCenter(new THREE.Vector3())),
        sampleCount: node.sampleCount,
      });
    }

    const lod = selectLod(scores, POINT_BUDGET_MIN, POINT_BUDGET_MAX);
    const selected = new Set<RenderNode>();
    let changed = false;

    for (const result of lod) {
      const node = nodeByIndex[result.index]!;
      selected.add(node);

      // Budget-dropped: keep hidden, do not repack. Must come before !node.built check.
      if (result.stride === 0) {
        // Beyond budget: only drop the node once motion stops, never blank it mid-orbit.
        if (cameraSettled) changed = this.hideNode(node, true) || changed;
        continue;
      }

      const targetStride = this.densityAdjustedStride(result.stride);
      const colorsStale = node.colorBuiltEpoch !== this.colorEpoch;

      if (!node.built || colorsStale || node.currentStride !== targetStride) {
        // First paint for this node, or display mode / filter changed → (re)pack immediately.
        // This is what makes RGB appear on load with no settle dependency.
        if (cameraSettled || !node.built || colorsStale) {
          this.packNode(node, targetStride);
          changed = true;
        } else if (!node.points!.visible) {
          node.points!.visible = true;
          changed = true;
        }
      } else if (!node.points!.visible) {
        node.points!.visible = true;
        changed = true;
      }
    }

    // Nodes no longer in the frustum: hide right away (off-screen).
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
      if (source.sampleCount > 0) {
        position = new Float32Array(source.sampleCount * 3);
        color = new Float32Array(source.sampleCount * 3);
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
        color, // Float32Array, values 0–1
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

  /**
   * Pack a node's drawable points: walk the sampled points at the given stride, apply the
   * active class/return filter, write a contiguous prefix of positions + colors, and set the
   * draw range. No re-parse, no reallocation — reuses the node's buffers.
   */
  private packNode(node: RenderNode, stride: number): void {
    if (!node.points) return;
    const src = node.source;
    const positionAttr = node.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colorAttr = node.points.geometry.getAttribute('color') as THREE.BufferAttribute;
    const pos = node.position;
    const col = node.color;
    // Defensive: octree.zRange + per-point return arrays are Milestone-3 additions. If an older
    // worker build produced an octree without them, fall back to dataset bounds / "single return"
    // so packing NEVER throws and RGB still renders.
    const zRange = this.dataset.octree?.zRange;
    const zMin = zRange ? zRange[0] : this.dataset.bounds.minZ;
    const zMax = zRange ? zRange[1] : this.dataset.bounds.maxZ;
    const zSpan = zMax - zMin || 1;
    const classifications = src.classifications;
    const returnNumbers = src.returnNumbers;
    const numberOfReturns = src.numberOfReturns;
    const step = Math.max(1, stride);

    let written = 0;
    for (let i = 0; i < node.sampleCount; i += step) {
      const cls = classifications ? (classifications[i] ?? 0) : 0;
      const rn = returnNumbers ? (returnNumbers[i] ?? 1) : 1;
      const nr = numberOfReturns ? (numberOfReturns[i] ?? 1) : 1;
      if (!pointPasses(cls, rn, nr, this.filter)) continue;

      const sx = src.positions[i * 3] ?? 0;
      const sy = src.positions[i * 3 + 1] ?? 0;
      const sz = src.positions[i * 3 + 2] ?? 0;
      const o = written * 3;
      pos[o] = sx;
      pos[o + 1] = sy;
      pos[o + 2] = sz;

      const c = this.colorFor(src, i, sx, sy, sz, zMin, zSpan);
      col[o] = c[0];
      col[o + 1] = c[1];
      col[o + 2] = c[2];
      written++;
    }

    positionAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
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

  /**
   * Returns a [r, g, b] triple with values in the range 0–1 for use in the Float32
   * color attribute. All LAS source colors (0–255 uint8) are divided by 255 here.
   */
  private colorFor(
    src: PointCloudOctreeNode,
    i: number,
    localX: number,
    localY: number,
    localZ: number,
    zMin: number,
    zSpan: number,
  ): [number, number, number] {
    switch (this.displayMode) {
      case 'intensity': {
        const g = THREE.MathUtils.clamp(src.intensities[i] ?? 0, 0, 1);
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
        // No overview yet / outside coverage → fall back to the point's real RGB, not black.
        return [
          (src.colors[i * 3] ?? 200) / 255,
          (src.colors[i * 3 + 1] ?? 200) / 255,
          (src.colors[i * 3 + 2] ?? 200) / 255,
        ];
      }
      case 'rgb':
      default:
        return [
          (src.colors[i * 3] ?? 255) / 255,
          (src.colors[i * 3 + 1] ?? 255) / 255,
          (src.colors[i * 3 + 2] ?? 255) / 255,
        ];
    }
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
    // Mark unbuilt so a node re-entering the frustum repacks immediately (no settle wait).
    if (!keepBuilt) node.built = false;
    return true;
  }
}
