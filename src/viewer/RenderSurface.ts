// src/viewer/RenderSurface.ts — derived render state for one SurfaceModel (contract item 3).
// Owns the Float32 rebased buffers; regenerable at any time from model.positions + SceneOrigin.
// SurfaceModel.positions are never mutated here.
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import type { SurfaceModel } from '../core/contract';
import { boundaryEdges, boundaryLoops } from '../core/derivedBoundary';
import { buildUniqueEdges, rebasePositions, type Vec3 } from './geometry';
import {
  buildEdgeFaceMap,
  buildVertexFaceAdjacency,
  computeVertexNormals,
  edgeKey,
  recomputeAffectedVertexNormals,
  wouldFlipIncidentTriangles,
} from './editing';
import { LabelPool, type LabelRefreshStatus } from './labels';

// Enable BVH-accelerated raycasting globally (O(log n) picking; required for cursor readout
// to stay cheap on multi-million-triangle meshes — risk R3).
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

export type OverlayKind = 'faces' | 'edges' | 'vertices' | 'breaklines' | 'boundary';

/** Per-element resolved state — the UI layer has already ANDed master gates + per-surface
 *  settings + mute (07 Phase 3/5). The viewer just applies it. */
export interface ResolvedElement {
  on: boolean;
  color: string;
  opacity: number;
}

export interface ResolvedDisplay {
  visible: boolean;
  /** desaturate + 0.4 opacity, depthWrite stays on (00 §4, 04 §3) */
  muted: boolean;
  faces: ResolvedElement;
  edges: ResolvedElement;
  breaklines: ResolvedElement;
  /** derived outer boundary + file-defined boundaries (docs/08 Phase 1) */
  boundary: ResolvedElement;
  vertices: ResolvedElement & { size: number };
  labels: ResolvedElement & { content: 'z' | 'nez' };
}

const SURFACE_COLOR = 0x7d8f6e; // muted terrain green
const EDGE_COLOR = 0x53c7c0;
const VERTEX_COLOR = 0xe0b54a;
const BREAKLINE_COLOR = 0xd97757; // distinct default — terracotta, reads against the green
const BOUNDARY_COLOR = 0xe84f8a; // derived boundary — magenta, distinct from every other overlay
const LABEL_COLOR = 0xe8e2d0;

const toHex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
export const DEFAULT_SURFACE_COLOR = toHex(SURFACE_COLOR);
export const DEFAULT_EDGE_COLOR = toHex(EDGE_COLOR);
export const DEFAULT_VERTEX_COLOR = toHex(VERTEX_COLOR);
export const DEFAULT_BREAKLINE_COLOR = toHex(BREAKLINE_COLOR);
export const DEFAULT_BOUNDARY_COLOR = toHex(BOUNDARY_COLOR);
export const DEFAULT_LABEL_COLOR = toHex(LABEL_COLOR);

const MUTE_OPACITY = 0.4;
const MUTE_SATURATION = 0.25;

/** Hue-rotate a '#rrggbb' color by `deg` — used to differentiate file-defined boundaries
 *  from the derived rim while both follow the user's boundary color setting (08 Phase 1). */
function hueRotate(hex: string, deg: number): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL((hsl.h + deg / 360) % 1, Math.max(hsl.s, 0.4), hsl.l);
  return `#${c.getHexString()}`;
}

/** Muting desaturates (HSL S × 0.25) — color identity survives, surface recedes. */
function effectiveColor(hex: string, muted: boolean): THREE.Color {
  const c = new THREE.Color(hex);
  if (muted) {
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    c.setHSL(hsl.h, hsl.s * MUTE_SATURATION, hsl.l * 0.85);
  }
  return c;
}

function applyMaterial(
  mat: THREE.MeshLambertMaterial | THREE.LineBasicMaterial | THREE.PointsMaterial,
  el: ResolvedElement,
  muted: boolean,
): void {
  mat.color.copy(effectiveColor(el.color, muted));
  const opacity = el.opacity * (muted ? MUTE_OPACITY : 1);
  mat.opacity = opacity;
  mat.transparent = opacity < 1;
  // depthWrite stays ON even when transparent (04 §3) — muted surfaces still occlude.
  mat.depthWrite = true;
  mat.needsUpdate = true;
}

export class RenderSurface {
  readonly handle: string;
  readonly model: SurfaceModel;
  readonly group = new THREE.Group();

  private positionAttr: THREE.BufferAttribute;
  private normalAttr: THREE.BufferAttribute | null = null;
  private mesh: THREE.Mesh | null = null;
  private edgeLines: THREE.LineSegments | null = null;
  private points: THREE.Points | null = null;
  private pickPoints: THREE.Points | null = null;
  private breaklineLines: THREE.LineSegments | null = null;
  /** derived rim (+ holes) — shared position buffer, boundary-edge index pairs */
  private derivedBoundaryLines: THREE.LineSegments | null = null;
  /** file-defined <Boundaries> — own rebased buffer, differentiated color */
  private fileBoundaryLines: THREE.LineSegments | null = null;
  /** cached derived-boundary computation (on demand, never stored on the model) */
  private boundaryCache: { edges: Uint32Array; holeCount: number } | null = null;
  private material: THREE.MeshLambertMaterial | null = null;
  private origin: Vec3;
  private disposables: { dispose(): void }[] = [];
  private editAdjacency: Uint32Array[] | null = null;
  private editEdgeFaces: Map<string, { vertices: [number, number]; faces: [number, number] }> | null = null;
  private selectionMarker: THREE.Points;
  private hoverMarker: THREE.Points;
  private hoveredVertexId: number | null = null;
  private selectedVertexId: number | null = null;

  // Labels (07 Phase 6): pool lives OUTSIDE the exaggeration-scaled group — the engine
  // adds labelGroup to the unscaled scene root; positions compensate for exaggeration.
  private labelPool: LabelPool | null = null;
  private display: ResolvedDisplay | null = null;

  constructor(handle: string, model: SurfaceModel, origin: Vec3) {
    this.handle = handle;
    this.model = model;
    this.origin = origin;
    this.group.name = `surface:${handle}`;
    this.selectionMarker = makeMarker(0xfff3a3, 11, `surface-edit-selected:${handle}`);
    this.hoverMarker = makeMarker(0xff8b5c, 8, `surface-edit-hover:${handle}`);
    this.group.add(this.selectionMarker, this.hoverMarker);
    this.selectionMarker.visible = false;
    this.hoverMarker.visible = false;
    this.disposables.push(
      this.selectionMarker.geometry,
      this.selectionMarker.material as THREE.Material,
      this.hoverMarker.geometry,
      this.hoverMarker.material as THREE.Material,
    );

    // Float32 LOCAL coords only — original Float64 stays on the model (risk R1).
    const rebased = rebasePositions(model.positions, origin);
    this.positionAttr = new THREE.BufferAttribute(rebased, 3);

    if (model.indices) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', this.positionAttr);
      geometry.setIndex(new THREE.BufferAttribute(model.indices, 1));
      this.normalAttr = new THREE.BufferAttribute(computeVertexNormals(model.positions, model.indices), 3);
      geometry.setAttribute('normal', this.normalAttr);
      // Flat shading derives per-face normals in-shader — no normal buffer needed,
      // and slope-shaded lighting is exactly the MVP look (04 §3).
      const material = new THREE.MeshLambertMaterial({
        color: SURFACE_COLOR,
        side: THREE.DoubleSide,
        // Push the fill back a hair so line overlays (edges/breaklines) win z-fighting (C5).
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      this.material = material;
      this.mesh = new THREE.Mesh(geometry, material);
      this.mesh.name = `surface-mesh:${handle}`;
      this.pickPoints = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, transparent: true, opacity: 0 }),
      );
      this.pickPoints.name = `surface-pickpoints:${handle}`;
      this.pickPoints.visible = false;
      geometry.computeBoundsTree(); // picking acceleration
      this.group.add(this.mesh);
      this.group.add(this.pickPoints);
      this.disposables.push(geometry, material, this.pickPoints.material as THREE.Material);
    }
    // indices === null ⇒ requiresRebuild path (Sprint 2 concern); show vertices so the
    // data is at least visible rather than rendering nothing.
    if (!model.indices) this.setOverlay('vertices', true);
  }

  /** Mesh used for cursor raycasting (null when the model has no faces). */
  get pickMesh(): THREE.Mesh | null {
    return this.mesh;
  }

  get vertexPickObject(): THREE.Points | null {
    return this.pickPoints;
  }

  sourcePointId(vertexId: number): number {
    return this.model.sourcePointIds[vertexId] ?? vertexId + 1;
  }

  sourceXYZ(vertexId: number): Vec3 {
    return [
      this.model.positions[vertexId * 3]!,
      this.model.positions[vertexId * 3 + 1]!,
      this.model.positions[vertexId * 3 + 2]!,
    ];
  }

  localXYZ(vertexId: number): Vec3 {
    return [
      this.positionAttr.getX(vertexId),
      this.positionAttr.getY(vertexId),
      this.positionAttr.getZ(vertexId),
    ];
  }

  /** Rebased-space bounds for view framing (UNexaggerated — engine scales Z). */
  get bounds(): THREE.Box3 {
    return new THREE.Box3().setFromBufferAttribute(this.positionAttr);
  }

  get hasBreaklines(): boolean {
    return this.model.breaklines.length > 0;
  }

  /** Label group for the engine to parent at the UNSCALED scene root (07 Phase 6). */
  get labelGroup(): THREE.Group | null {
    return this.labelPool?.group ?? null;
  }

  // ── full display application (07 Phase 3/5) ───────────────────────────────

  /** Apply the resolved display state (master gates + per-surface settings + mute,
   *  already combined by the UI layer). Lazily builds overlays on first use. */
  applyDisplay(resolved: ResolvedDisplay): void {
    this.display = resolved;
    this.group.visible = resolved.visible;

    if (this.mesh && this.material) {
      this.mesh.visible = resolved.faces.on;
      applyMaterial(this.material, resolved.faces, resolved.muted);
    }

    this.ensureOverlay('edges', resolved.edges.on);
    if (this.edgeLines) {
      this.edgeLines.visible = resolved.edges.on;
      applyMaterial(this.edgeLines.material as THREE.LineBasicMaterial, resolved.edges, resolved.muted);
    }

    this.ensureOverlay('breaklines', resolved.breaklines.on);
    if (this.breaklineLines) {
      this.breaklineLines.visible = resolved.breaklines.on;
      applyMaterial(
        this.breaklineLines.material as THREE.LineBasicMaterial,
        resolved.breaklines,
        resolved.muted,
      );
    }

    this.ensureOverlay('boundary', resolved.boundary.on);
    if (this.derivedBoundaryLines) {
      this.derivedBoundaryLines.visible = resolved.boundary.on;
      applyMaterial(
        this.derivedBoundaryLines.material as THREE.LineBasicMaterial,
        resolved.boundary,
        resolved.muted,
      );
    }
    if (this.fileBoundaryLines) {
      this.fileBoundaryLines.visible = resolved.boundary.on;
      // File-defined boundaries share the overlay but stay differentiated: hue-rotated
      // from the user's boundary color (08 Phase 1 — "same overlay, differentiated color").
      applyMaterial(
        this.fileBoundaryLines.material as THREE.LineBasicMaterial,
        { ...resolved.boundary, color: hueRotate(resolved.boundary.color, 60) },
        resolved.muted,
      );
    }

    this.ensureOverlay('vertices', resolved.vertices.on);
    if (this.points) {
      this.points.visible = resolved.vertices.on;
      const mat = this.points.material as THREE.PointsMaterial;
      applyMaterial(mat, resolved.vertices, resolved.muted);
      mat.size = resolved.vertices.size;
    }

    if (!resolved.labels.on || !resolved.visible) this.labelPool?.hide();
  }

  /**
   * Refresh the label pool for the current (at-rest) camera. Returns the pool status so the
   * engine can surface the auto-off note. maxDist = distance cull radius (07 Phase 6).
   */
  refreshLabels(camera: THREE.Camera, exaggeration: number, maxDist: number): LabelRefreshStatus {
    const d = this.display;
    if (!d || !d.labels.on || !d.visible) {
      this.labelPool?.hide();
      return 'off';
    }
    if (!this.labelPool) {
      this.labelPool = new LabelPool(
        this.positionAttr.array as Float32Array,
        this.model.positions,
        this.handle,
      );
    }
    const opacity = d.labels.opacity * (d.muted ? MUTE_OPACITY : 1);
    return this.labelPool.refresh(camera, exaggeration, maxDist, {
      color: `#${effectiveColor(d.labels.color, d.muted).getHexString()}`,
      opacity,
      content: d.labels.content, // 'z' | 'nez' (docs/08 Phase 6)
    });
  }

  // ── legacy single-toggle API (faceless auto-vertices + Sprint 2 paths) ────

  /** Single material color for the surface fill (C4 swatch). Accepts '#rrggbb'. */
  setColor(color: string): void {
    this.material?.color.set(color);
  }

  setOverlay(kind: OverlayKind, on: boolean): void {
    if (kind === 'faces') {
      if (this.mesh) this.mesh.visible = on;
      return;
    }
    this.ensureOverlay(kind, on);
    if (kind === 'breaklines' && this.breaklineLines) this.breaklineLines.visible = on;
    if (kind === 'edges' && this.edgeLines) this.edgeLines.visible = on;
    if (kind === 'vertices' && this.points) this.points.visible = on;
    if (kind === 'boundary') {
      if (this.derivedBoundaryLines) this.derivedBoundaryLines.visible = on;
      if (this.fileBoundaryLines) this.fileBoundaryLines.visible = on;
    }
  }

  /** Derived boundary stats (computed on demand + cached): hole count for the expanded row
   *  (08 Phase 1 — quiet setup for the parked fill-hole edit tool). null = no faces. */
  derivedBoundaryInfo(): { holeCount: number } | null {
    return this.ensureBoundaryCache() ? { holeCount: this.boundaryCache!.holeCount } : null;
  }

  setHoverVertex(vertexId: number | null): void {
    this.hoveredVertexId = vertexId;
    updateMarker(this.hoverMarker, this.positionAttr, vertexId);
  }

  setSelectedVertex(vertexId: number | null): void {
    this.selectedVertexId = vertexId;
    updateMarker(this.selectionMarker, this.positionAttr, vertexId);
  }

  applyVertexPosition(vertexId: number, xyz: Vec3): boolean {
    if (!this.mesh || !this.model.indices || !this.normalAttr) return false;
    const offset = vertexId * 3;
    const [x, y, z] = xyz;
    const oldX = this.model.positions[offset]!;
    const oldY = this.model.positions[offset + 1]!;
    const oldZ = this.model.positions[offset + 2]!;
    if (oldX === x && oldY === y && oldZ === z) return false;
    this.model.positions[offset] = x;
    this.model.positions[offset + 1] = y;
    this.model.positions[offset + 2] = z;
    this.positionAttr.setXYZ(offset / 3, x - this.origin[0], y - this.origin[1], z - this.origin[2]);
    this.positionAttr.needsUpdate = true;
    const adjacency =
      this.editAdjacency ?? (this.editAdjacency = buildVertexFaceAdjacency(this.model.indices, this.positionAttr.count));
    recomputeAffectedVertexNormals(
      this.model.positions,
      this.model.indices,
      adjacency,
      this.normalAttr.array as Float32Array,
      vertexId,
    );
    this.normalAttr.needsUpdate = true;
    (this.mesh.geometry as THREE.BufferGeometry).boundsTree?.refit();
    updateMarker(this.hoverMarker, this.positionAttr, this.hoveredVertexId);
    updateMarker(this.selectionMarker, this.positionAttr, this.selectedVertexId);
    return true;
  }

  applyVertexMove(vertexId: number, xyz: Vec3, guardOrientation: boolean): { changed: boolean; blocked: boolean } {
    if (!this.model.indices) return { changed: false, blocked: false };
    const adjacency =
      this.editAdjacency ?? (this.editAdjacency = buildVertexFaceAdjacency(this.model.indices, this.positionAttr.count));
    if (guardOrientation && wouldFlipIncidentTriangles(this.model.positions, this.model.indices, adjacency, vertexId, xyz[0], xyz[1])) {
      return { changed: false, blocked: true };
    }
    return { changed: this.applyVertexPosition(vertexId, xyz), blocked: false };
  }

  swapInteriorEdge(a: number, b: number): {
    ok: boolean;
    message?: string;
    beforeIndices?: [number, number, number, number, number, number];
    afterIndices?: [number, number, number, number, number, number];
  } {
    if (!this.model.indices || !this.mesh || !this.normalAttr) return { ok: false, message: 'surface has no faces' };
    const map = this.editEdgeFaces ?? (this.editEdgeFaces = buildEdgeFaceMap(this.model.indices));
    const edge = map.get(edgeKey(a, b));
    if (!edge || edge.faces[1] < 0) return { ok: false, message: 'boundary edges cannot be swapped' };
    const [faceA, faceB] = edge.faces;
    const triA = readFace(this.model.indices, faceA);
    const triB = readFace(this.model.indices, faceB);
    const otherA = triA.find((id) => id !== a && id !== b);
    const otherB = triB.find((id) => id !== a && id !== b);
    if (otherA === undefined || otherB === undefined || otherA === otherB) {
      return { ok: false, message: 'edge cannot be swapped here' };
    }
    const beforeIndices: [number, number, number, number, number, number] = [...triA, ...triB] as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const nextA = orientTriangle(this.model.positions, otherA, otherB, a);
    const nextB = orientTriangle(this.model.positions, otherB, otherA, b);
    const afterIndices: [number, number, number, number, number, number] = [...nextA, ...nextB] as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    writeFace(this.model.indices, faceA, nextA);
    writeFace(this.model.indices, faceB, nextB);
    const indexAttr = this.mesh.geometry.getIndex()!;
    indexAttr.set(nextA, faceA * 3);
    indexAttr.set(nextB, faceB * 3);
    indexAttr.needsUpdate = true;
    const adjacency =
      this.editAdjacency ?? (this.editAdjacency = buildVertexFaceAdjacency(this.model.indices, this.positionAttr.count));
    const touched = new Set([a, b, otherA, otherB]);
    for (const vertexId of touched) {
      recomputeAffectedVertexNormals(
        this.model.positions,
        this.model.indices,
        adjacency,
        this.normalAttr.array as Float32Array,
        vertexId,
      );
    }
    this.normalAttr.needsUpdate = true;
    this.mesh.geometry.computeBoundsTree();
    this.editEdgeFaces = buildEdgeFaceMap(this.model.indices);
    if (this.edgeLines) {
      this.group.remove(this.edgeLines);
      this.edgeLines.geometry.dispose();
      (this.edgeLines.material as THREE.Material).dispose();
      this.edgeLines = null;
      this.ensureOverlay('edges', true);
    }
    return { ok: true, beforeIndices, afterIndices };
  }

  private ensureBoundaryCache(): boolean {
    if (this.boundaryCache) return true;
    if (!this.model.indices) return false;
    const edges = boundaryEdges(this.model.indices);
    const { holeCount } = boundaryLoops(edges, this.model.positions);
    this.boundaryCache = { edges, holeCount };
    return true;
  }

  /** Lazily build an overlay the first time it's switched on. */
  private ensureOverlay(kind: Exclude<OverlayKind, 'faces'>, on: boolean): void {
    if (!on) return;
    if (kind === 'breaklines' && !this.breaklineLines && this.model.breaklines.length > 0) {
      this.breaklineLines = buildBreaklineSegments(this.model, this.origin, this.handle);
      this.group.add(this.breaklineLines);
      this.disposables.push(this.breaklineLines.geometry, this.breaklineLines.material as THREE.Material);
    }
    if (kind === 'edges' && !this.edgeLines && this.model.indices) {
      // Unique-edge LineSegments — ONE draw call, shared position buffer (04 §3).
      const edgeIndices = buildUniqueEdges(this.model.indices, this.positionAttr.count);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', this.positionAttr);
      geometry.setIndex(new THREE.BufferAttribute(edgeIndices, 1));
      const material = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.55 });
      this.edgeLines = new THREE.LineSegments(geometry, material);
      this.edgeLines.name = `surface-edges:${this.handle}`;
      this.group.add(this.edgeLines);
      this.disposables.push(geometry, material);
    }
    if (kind === 'boundary') {
      // Derived rim: shared position buffer + boundary-edge index pairs — one draw call,
      // zero extra vertex memory. polygonOffset wins z-fighting against the fill.
      if (!this.derivedBoundaryLines && this.ensureBoundaryCache()) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', this.positionAttr);
        geometry.setIndex(new THREE.BufferAttribute(this.boundaryCache!.edges, 1));
        const material = new THREE.LineBasicMaterial({
          color: BOUNDARY_COLOR,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -3,
        });
        this.derivedBoundaryLines = new THREE.LineSegments(geometry, material);
        this.derivedBoundaryLines.name = `surface-boundary-derived:${this.handle}`;
        this.group.add(this.derivedBoundaryLines);
        this.disposables.push(geometry, material);
      }
      // File-defined <Boundaries> render as contract boundaries when present (08 Phase 1).
      if (!this.fileBoundaryLines && this.model.boundaries.length > 0) {
        this.fileBoundaryLines = buildPolylineSegments(
          this.model.boundaries.map((b) => b.pts),
          this.origin,
          new THREE.LineBasicMaterial({
            color: BOUNDARY_COLOR,
            polygonOffset: true,
            polygonOffsetFactor: -3,
            polygonOffsetUnits: -3,
          }),
          `surface-boundary-file:${this.handle}`,
          true, // boundaries are closed loops
        );
        this.group.add(this.fileBoundaryLines);
        this.disposables.push(this.fileBoundaryLines.geometry, this.fileBoundaryLines.material as THREE.Material);
      }
    }
    if (kind === 'vertices' && !this.points) {
      // Points share the position buffer — zero extra vertex memory (04 §3).
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', this.positionAttr);
      const material = new THREE.PointsMaterial({
        color: VERTEX_COLOR,
        size: 3,
        sizeAttenuation: false,
      });
      this.points = new THREE.Points(geometry, material);
      this.points.name = `surface-vertices:${this.handle}`;
      this.group.add(this.points);
      this.disposables.push(geometry, material);
    }
  }

  dispose(): void {
    if (this.mesh) (this.mesh.geometry as THREE.BufferGeometry).disposeBoundsTree?.();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.labelPool?.dispose();
    this.labelPool = null;
    this.group.removeFromParent();
    this.mesh = null;
    this.material = null;
    this.normalAttr = null;
    this.edgeLines = null;
    this.points = null;
    this.pickPoints = null;
    this.breaklineLines = null;
    this.derivedBoundaryLines = null;
    this.fileBoundaryLines = null;
    this.boundaryCache = null;
    this.hoveredVertexId = null;
    this.selectedVertexId = null;
  }
}

/**
 * One LineSegments for a set of polylines: rebased Float32 positions, consecutive-pair
 * indices (plus a closing pair when `closed`), single draw call.
 */
function buildPolylineSegments(
  polys: Float64Array[],
  origin: Vec3,
  material: THREE.LineBasicMaterial,
  name: string,
  closed: boolean,
): THREE.LineSegments {
  let totalPts = 0;
  for (const pts of polys) totalPts += pts.length / 3;
  const positions = new Float32Array(totalPts * 3);
  const indices: number[] = [];
  let base = 0;
  for (const pts of polys) {
    positions.set(rebasePositions(pts, origin), base * 3);
    const n = pts.length / 3;
    for (let i = 0; i < n - 1; i++) indices.push(base + i, base + i + 1);
    if (closed && n > 2) indices.push(base + n - 1, base);
    base += n;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = name;
  return lines;
}

/**
 * One LineSegments for ALL breaklines of a surface (C5): rebased Float32 positions,
 * consecutive-pair indices per polyline, single draw call. polygonOffset pulls the
 * lines toward the camera (the mesh fill is also pushed back) to win z-fighting.
 */
function buildBreaklineSegments(model: SurfaceModel, origin: Vec3, handle: string): THREE.LineSegments {
  let totalPts = 0;
  for (const b of model.breaklines) totalPts += b.pts.length / 3;
  const positions = new Float32Array(totalPts * 3);
  const indices: number[] = [];
  let base = 0;
  for (const b of model.breaklines) {
    const rebased = rebasePositions(b.pts, origin);
    positions.set(rebased, base * 3);
    const n = b.pts.length / 3;
    for (let i = 0; i < n - 1; i++) indices.push(base + i, base + i + 1);
    base += n;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const material = new THREE.LineBasicMaterial({
    color: BREAKLINE_COLOR,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = `surface-breaklines:${handle}`;
  return lines;
}

function makeMarker(color: number, size: number, name: string): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const material = new THREE.PointsMaterial({
    color,
    size,
    sizeAttenuation: false,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.name = name;
  return points;
}

function updateMarker(marker: THREE.Points, positions: THREE.BufferAttribute, vertexId: number | null): void {
  marker.visible = vertexId !== null;
  if (vertexId === null) return;
  const attr = marker.geometry.getAttribute('position') as THREE.BufferAttribute;
  attr.setXYZ(0, positions.getX(vertexId), positions.getY(vertexId), positions.getZ(vertexId));
  attr.needsUpdate = true;
}

function readFace(indices: Uint32Array, faceIndex: number): [number, number, number] {
  const base = faceIndex * 3;
  return [indices[base]!, indices[base + 1]!, indices[base + 2]!];
}

function writeFace(indices: Uint32Array, faceIndex: number, tri: [number, number, number]): void {
  const base = faceIndex * 3;
  indices[base] = tri[0];
  indices[base + 1] = tri[1];
  indices[base + 2] = tri[2];
}

function orientTriangle(
  positions: Float64Array,
  a: number,
  b: number,
  c: number,
): [number, number, number] {
  const ax = positions[a * 3]!;
  const ay = positions[a * 3 + 1]!;
  const bx = positions[b * 3]!;
  const by = positions[b * 3 + 1]!;
  const cx = positions[c * 3]!;
  const cy = positions[c * 3 + 1]!;
  const sign = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return sign >= 0 ? [a, b, c] : [a, c, b];
}
