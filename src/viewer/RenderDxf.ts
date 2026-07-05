// src/viewer/RenderDxf.ts — derived render state for one DxfDataset (docs/08 Phases 4/5).
//
// BATCHING IS NON-NEGOTIABLE at 20k+ entities (docs/08 Phase 2): geometry is merged into
// per-layer buffers — at most TWO LineSegments per layer (solid on-surface + dashed/dimmed
// off-surface), never one object per entity.
//
// DRAPE MODEL (docs/07 §"answers"): the DXF keeps its source XY forever; the drape is a
// recompute against one chosen target surface — densify each segment to a max edge length,
// then BVH vertical raycast per vertex; hit → z = surface + 0.05 ft offset; miss → keep
// last-known Z, render dimmed + dashed, count per layer. Switching target re-drapes on demand.
import * as THREE from 'three';
import type { DxfDataset, DxfEntity } from '../core/contract';
import { rebasePositions, type Vec3 } from './geometry';
import type { RenderSurface } from './RenderSurface';

export const DEFAULT_DENSIFY_FT = 5; // max edge length before drape (docs/04 §4, exposed in UI)
export const DRAPE_OFFSET_FT = 0.05; // PM-ratified hover offset above the target surface

const MISS_OPACITY_FACTOR = 0.35; // dimmed (PM-ratified off-surface style)
const MISS_DASH = 2.5;
const MISS_GAP = 1.5;

export interface DxfLayerDisplay {
  on: boolean;
  color: string; // '#rrggbb'
  opacity: number;
}

export interface DxfDrapeResult {
  offSurfaceVertices: number;
  totalVertices: number;
  /** layer name → missed-vertex count (for the import notes / row header) */
  perLayerMisses: Record<string, number>;
}

interface LayerBatch {
  layer: string;
  /** densified positions in SOURCE coords (Float64) — drape rewrites only Z */
  sourcePts: Float64Array;
  /** native source Z copy (drape is non-destructive; 'native' mode restores from here) */
  nativeZ: Float64Array;
  /** index pairs into sourcePts for solid (hit) segments */
  hitPairs: Uint32Array;
  /** index pairs for off-surface (missed) segments */
  missPairs: Uint32Array;
  /** per-vertex miss flags from the last drape */
  missFlags: Uint8Array;
  solid: THREE.LineSegments | null;
  dashed: THREE.LineSegments | null;
  positionAttr: THREE.BufferAttribute | null;
}

/** Densify a polyline (x,y,z triplets) so no XY segment exceeds maxEdge. Returns triplets. */
export function densifyPolyline(pts: Float64Array, closed: boolean, maxEdge: number): Float64Array {
  const n = pts.length / 3;
  if (n < 2) return pts.slice();
  const out: number[] = [pts[0]!, pts[1]!, pts[2]!];
  const segCount = closed ? n : n - 1;
  for (let s = 0; s < segCount; s++) {
    const a = s;
    const b = (s + 1) % n;
    const ax = pts[a * 3]!, ay = pts[a * 3 + 1]!, az = pts[a * 3 + 2]!;
    const bx = pts[b * 3]!, by = pts[b * 3 + 1]!, bz = pts[b * 3 + 2]!;
    const len = Math.hypot(bx - ax, by - ay);
    const pieces = maxEdge > 0 ? Math.max(1, Math.ceil(len / maxEdge)) : 1;
    for (let i = 1; i <= pieces; i++) {
      const t = i / pieces;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
    }
  }
  return Float64Array.from(out);
}

export class RenderDxf {
  readonly handle: string;
  readonly dataset: DxfDataset;
  readonly group = new THREE.Group();

  private origin: Vec3;
  private batches = new Map<string, LayerBatch>();
  private densify: number;
  private disposables: { dispose(): void }[] = [];
  /** layer name → current display (cached so re-drape keeps user settings) */
  private layerDisplay = new Map<string, DxfLayerDisplay>();
  private visibleAll = true;

  constructor(handle: string, dataset: DxfDataset, origin: Vec3, densify = DEFAULT_DENSIFY_FT) {
    this.handle = handle;
    this.dataset = dataset;
    this.origin = origin;
    this.densify = densify;
    this.group.name = `dxf:${handle}`;
    this.buildBatches();
  }

  /** Rebuild the densified per-layer buffers (called on construction and densify change). */
  private buildBatches(): void {
    this.clearObjects();
    this.batches.clear();

    // bucket entities per layer
    const byLayer = new Map<string, DxfEntity[]>();
    for (const e of this.dataset.entities) {
      const list = byLayer.get(e.layer);
      if (list) list.push(e);
      else byLayer.set(e.layer, [e]);
    }

    for (const [layer, list] of byLayer) {
      // densify every polyline, then merge into one buffer + one segment-pair index
      let totalPts = 0;
      const densified: { pts: Float64Array; closed: boolean }[] = [];
      for (const e of list) {
        const d = densifyPolyline(e.pts, e.closed, this.densify);
        densified.push({ pts: d, closed: e.closed });
        totalPts += d.length / 3;
      }
      const sourcePts = new Float64Array(totalPts * 3);
      const pairs: number[] = [];
      let base = 0;
      for (const d of densified) {
        sourcePts.set(d.pts, base * 3);
        const n = d.pts.length / 3;
        for (let i = 0; i < n - 1; i++) pairs.push(base + i, base + i + 1);
        // densifyPolyline already walked the closing segment for closed entities
        base += n;
      }
      const nativeZ = new Float64Array(totalPts);
      for (let i = 0; i < totalPts; i++) nativeZ[i] = sourcePts[i * 3 + 2]!;
      this.batches.set(layer, {
        layer,
        sourcePts,
        nativeZ,
        hitPairs: Uint32Array.from(pairs), // before any drape: everything renders solid
        missPairs: new Uint32Array(0),
        missFlags: new Uint8Array(totalPts),
        solid: null,
        dashed: null,
        positionAttr: null,
      });
    }
    this.rebuildObjects();
  }

  /** Recreate the THREE objects from current batch buffers (drape/densify/native switches). */
  private rebuildObjects(): void {
    this.clearObjects();
    for (const batch of this.batches.values()) {
      const rebased = rebasePositions(batch.sourcePts, this.origin);
      const attr = new THREE.BufferAttribute(rebased, 3);
      batch.positionAttr = attr;

      if (batch.hitPairs.length > 0) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', attr);
        geometry.setIndex(new THREE.BufferAttribute(batch.hitPairs, 1));
        const material = new THREE.LineBasicMaterial({
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        batch.solid = new THREE.LineSegments(geometry, material);
        batch.solid.name = `dxf-layer:${this.handle}:${batch.layer}`;
        this.group.add(batch.solid);
        this.disposables.push(geometry, material);
      }
      if (batch.missPairs.length > 0) {
        // Off-surface style (PM-ratified): dimmed + dashed. LineDashedMaterial needs
        // per-vertex line distances — built once per rebuild on a NON-shared geometry.
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(batch.missPairs.length * 3);
        const distances = new Float32Array(batch.missPairs.length);
        for (let i = 0; i + 1 < batch.missPairs.length; i += 2) {
          const a = batch.missPairs[i]! * 3;
          const b = batch.missPairs[i + 1]! * 3;
          positions.set([rebased[a]!, rebased[a + 1]!, rebased[a + 2]!], i * 3);
          positions.set([rebased[b]!, rebased[b + 1]!, rebased[b + 2]!], i * 3 + 3);
          const len = Math.hypot(rebased[b]! - rebased[a]!, rebased[b + 1]! - rebased[a + 1]!);
          distances[i] = 0;
          distances[i + 1] = len;
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('lineDistance', new THREE.BufferAttribute(distances, 1));
        const material = new THREE.LineDashedMaterial({
          dashSize: MISS_DASH,
          gapSize: MISS_GAP,
          transparent: true,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        batch.dashed = new THREE.LineSegments(geometry, material);
        batch.dashed.name = `dxf-layer-miss:${this.handle}:${batch.layer}`;
        this.group.add(batch.dashed);
        this.disposables.push(geometry, material);
      }
    }
    this.applyCachedDisplay();
  }

  private clearObjects(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    for (const batch of this.batches.values()) {
      batch.solid?.removeFromParent();
      batch.dashed?.removeFromParent();
      batch.solid = null;
      batch.dashed = null;
      batch.positionAttr = null;
    }
  }

  /** Change the densification max-edge (ft) — re-densifies; caller re-drapes after. */
  setDensify(maxEdge: number): void {
    if (maxEdge === this.densify) return;
    this.densify = maxEdge;
    this.buildBatches();
  }

  get densifyValue(): number {
    return this.densify;
  }

  /** Restore native source elevations (the "keep entity elevations" choice / no target). */
  applyNativeZ(): void {
    for (const batch of this.batches.values()) {
      const n = batch.nativeZ.length;
      for (let i = 0; i < n; i++) batch.sourcePts[i * 3 + 2] = batch.nativeZ[i]!;
      batch.missFlags.fill(0);
      this.splitPairs(batch);
    }
    this.rebuildObjects();
  }

  /**
   * Drape every densified vertex onto the target surface via BVH vertical raycast.
   * Hit → z = surface + DRAPE_OFFSET_FT (both live in the exaggeration-scaled content group,
   * so the offset stays glued to the surface at any exaggeration). Miss → keep last-known Z
   * (native Z until a previous hit exists), flagged for the dimmed+dashed style.
   */
  drape(target: RenderSurface): DxfDrapeResult {
    const mesh = target.pickMesh;
    const result: DxfDrapeResult = { offSurfaceVertices: 0, totalVertices: 0, perLayerMisses: {} };
    if (!mesh) return result; // faceless target — nothing to drape onto (caller warns)

    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true; // three-mesh-bvh fast path
    const down = new THREE.Vector3(0, 0, -1);
    const origin = new THREE.Vector3();
    // ray casting happens in the surface's LOCAL (rebased, unexaggerated) frame: both the
    // mesh geometry and our rebased XY share that frame, so no matrix juggling is needed.
    const bounds = target.bounds;
    const zTop = bounds.max.z + 100;
    const [ox, oy, oz] = this.origin;

    mesh.updateMatrixWorld();
    for (const batch of this.batches.values()) {
      const n = batch.sourcePts.length / 3;
      result.totalVertices += n;
      let misses = 0;
      let lastZ: number | null = null;
      for (let i = 0; i < n; i++) {
        const sx = batch.sourcePts[i * 3]!;
        const sy = batch.sourcePts[i * 3 + 1]!;
        origin.set(sx - ox, sy - oy, zTop);
        raycaster.set(origin, down);
        raycaster.far = Infinity;
        const hit = raycaster.intersectObject(mesh, false)[0];
        if (hit) {
          const z = hit.point.z + oz + DRAPE_OFFSET_FT; // back to source-frame Z
          batch.sourcePts[i * 3 + 2] = z;
          batch.missFlags[i] = 0;
          lastZ = z;
        } else {
          // miss: keep last-known Z (PM-ratified) — native Z when nothing known yet
          batch.sourcePts[i * 3 + 2] = lastZ ?? batch.nativeZ[i]!;
          batch.missFlags[i] = 1;
          misses++;
        }
      }
      if (misses > 0) result.perLayerMisses[batch.layer] = misses;
      result.offSurfaceVertices += misses;
      this.splitPairs(batch);
    }
    this.rebuildObjects();
    return result;
  }

  /** Split the merged segment index into solid (both ends hit) vs dashed (any end missed). */
  private splitPairs(batch: LayerBatch): void {
    const all: number[] = [];
    const nPts = batch.sourcePts.length / 3;
    // reconstruct the full pair list from hit+miss (they always partition the original)
    for (const src of [batch.hitPairs, batch.missPairs]) {
      for (let i = 0; i < src.length; i++) all.push(src[i]!);
    }
    const hits: number[] = [];
    const misses: number[] = [];
    for (let i = 0; i + 1 < all.length; i += 2) {
      const a = all[i]!;
      const b = all[i + 1]!;
      if (a >= nPts || b >= nPts) continue;
      if (batch.missFlags[a] || batch.missFlags[b]) misses.push(a, b);
      else hits.push(a, b);
    }
    batch.hitPairs = Uint32Array.from(hits);
    batch.missPairs = Uint32Array.from(misses);
  }

  // ── display ───────────────────────────────────────────────────────────────

  /** Apply per-layer display (visibility gate ANDed by the caller). */
  applyDisplay(visible: boolean, layers: Map<string, DxfLayerDisplay>): void {
    this.visibleAll = visible;
    this.layerDisplay = layers;
    this.applyCachedDisplay();
  }

  private applyCachedDisplay(): void {
    this.group.visible = this.visibleAll;
    for (const batch of this.batches.values()) {
      const d = this.layerDisplay.get(batch.layer);
      const on = d?.on ?? true;
      const color = d?.color ?? '#ffffff';
      const opacity = d?.opacity ?? 1;
      if (batch.solid) {
        batch.solid.visible = on;
        const m = batch.solid.material as THREE.LineBasicMaterial;
        m.color.set(color);
        m.opacity = opacity;
        m.transparent = opacity < 1;
      }
      if (batch.dashed) {
        batch.dashed.visible = on;
        const m = batch.dashed.material as THREE.LineDashedMaterial;
        m.color.set(color);
        m.opacity = opacity * MISS_OPACITY_FACTOR; // dimmed
      }
    }
  }

  /** Rebased-space bounds (XY from source; Z whatever the current drape produced). */
  get bounds(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const batch of this.batches.values()) {
      if (batch.positionAttr) box.union(new THREE.Box3().setFromBufferAttribute(batch.positionAttr));
    }
    return box;
  }

  dispose(): void {
    this.clearObjects();
    this.batches.clear();
    this.group.removeFromParent();
  }
}
