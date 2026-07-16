// src/viewer/RenderFeatures.ts - authored-feature display. Converts pure
// generator output (survey coordinates) into rebased Three objects: one
// translucent fill mesh + line loops per feature, plus the in-flight
// authoring draft preview. The group parents under the engine contentGroup
// so vertical exaggeration stays ONE Z-scale matrix. Display only: nothing
// here is persisted; everything regenerates from stored feature primitives.

import * as THREE from 'three';
import { rebasePositions, type Vec3 } from './geometry';

export interface FeatureDisplayEntry {
  featureId: string;
  /** Triangulated fill in survey coordinates; omitted for outline-only features. */
  fill?: { positions: Float64Array; indices: Uint32Array };
  /** Polylines (outline, breaklines) in survey coordinates. */
  lines: Vec3[][];
  /** Point markers in survey coordinates (surface points, evidence cues). */
  markers?: { points: Vec3[]; color: number; size: number; name: string }[];
  fillColor: number;
  lineColor: number;
}

/** Authored geometry the snap collector may use as authored-vertex/edge sources. */
export interface AuthoredSnapGeometry {
  vertices: { featureId: string; world: Vec3 }[];
  edges: { featureId: string; a: Vec3; b: Vec3 }[];
}

export interface SnapPreview {
  point: Vec3;
  size: number;
  kind: 'index' | 'preview' | 'feature' | 'free';
}

/**
 * Focus emphasis for the feature currently open in the detail panel: the
 * user-drawn isolate boundary (context only, never evidence), the explicit
 * evidence refs, and the object origin. Display only; nothing here persists.
 */
export interface FeatureFocusOverlay {
  boundary: Vec3[] | null;
  evidence: Vec3[];
  origin: Vec3 | null;
  /** Active load-all sector (survey XY rect at boundary height), when the isolate area streams in parts. */
  sectorRect?: { minX: number; minY: number; maxX: number; maxY: number; z: number } | null;
}

const DRAFT_LINE_COLOR = 0xffc857;
const DRAFT_VERTEX_COLOR = 0xffe3a3;

export class RenderFeatures {
  readonly group = new THREE.Group();
  private readonly origin: Vec3;
  private readonly featureRoot = new THREE.Group();
  private readonly draftRoot = new THREE.Group();
  private readonly snapRoot = new THREE.Group();
  private readonly focusRoot = new THREE.Group();
  private snapGeometry: AuthoredSnapGeometry = { vertices: [], edges: [] };

  constructor(origin: Vec3) {
    this.origin = origin;
    this.group.name = 'authored-features';
    this.group.add(this.featureRoot);
    this.group.add(this.draftRoot);
    this.group.add(this.snapRoot);
    this.group.add(this.focusRoot);
  }

  setFeatures(entries: FeatureDisplayEntry[]): void {
    disposeChildren(this.featureRoot);
    const vertices: AuthoredSnapGeometry['vertices'] = [];
    const edges: AuthoredSnapGeometry['edges'] = [];

    for (const entry of entries) {
      if (entry.fill && entry.fill.indices.length > 0) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(rebasePositions(entry.fill.positions, this.origin), 3));
        geometry.setIndex(new THREE.BufferAttribute(entry.fill.indices.slice(), 1));
        const material = new THREE.MeshBasicMaterial({
          color: entry.fillColor,
          transparent: true,
          opacity: 0.48,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `feature-fill:${entry.featureId}`;
        mesh.renderOrder = 2;
        this.featureRoot.add(mesh);
      }
      for (const line of entry.lines) {
        if (line.length < 2) continue;
        this.featureRoot.add(buildLine(line, this.origin, entry.lineColor, `feature-line:${entry.featureId}`));
        for (let i = 0; i < line.length; i++) {
          vertices.push({ featureId: entry.featureId, world: line[i]! });
          if (i > 0) edges.push({ featureId: entry.featureId, a: line[i - 1]!, b: line[i]! });
        }
      }
      for (const marker of entry.markers ?? []) {
        if (marker.points.length === 0) continue;
        this.featureRoot.add(buildScreenPoints(marker.points, this.origin, marker.color, marker.size, marker.name));
      }
    }
    this.snapGeometry = { vertices, edges };
  }

  /** Authored vertices/edges for the engine snap collector. */
  getSnapGeometry(): AuthoredSnapGeometry {
    return this.snapGeometry;
  }

  /**
   * In-flight authoring preview: every already-collected polyline (closed
   * border ring, finished breaklines) plus vertex points on the active line.
   */
  setDraft(draft: { lines: Vec3[][]; activeVertices: Vec3[] } | null): void {
    disposeChildren(this.draftRoot);
    if (!draft) return;
    for (const line of draft.lines) {
      if (line.length >= 2) this.draftRoot.add(buildLine(line, this.origin, DRAFT_LINE_COLOR, 'authoring-draft-line'));
    }
    if (draft.activeVertices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(rebasePositions(flattenVec3(draft.activeVertices), this.origin), 3),
    );
    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ color: DRAFT_VERTEX_COLOR, size: 7, sizeAttenuation: false, depthTest: false }),
    );
    points.name = 'authoring-draft-vertices';
    points.renderOrder = 4;
    this.draftRoot.add(points);
  }

  setSnapPreview(preview: SnapPreview | null): void {
    disposeChildren(this.snapRoot);
    if (!preview) return;
    const colorByKind: Record<SnapPreview['kind'], number> = {
      index: 0x53c7ff,
      preview: 0x5fd4c3,
      feature: 0xffc857,
      free: 0xb7c0cc,
    };
    // Engine sizes the preview at the marker's depth (~tolerance px on screen);
    // the floor only guards a degenerate zero-size loop.
    const half = Math.max(preview.size * 0.5, 0.005);
    const [x, y, z] = preview.point;
    const loop: Vec3[] = [
      [x - half, y - half, z],
      [x + half, y - half, z],
      [x + half, y + half, z],
      [x - half, y + half, z],
      [x - half, y - half, z],
    ];
    const crossA: Vec3[] = [
      [x - half, y, z],
      [x + half, y, z],
    ];
    const crossB: Vec3[] = [
      [x, y - half, z],
      [x, y + half, z],
    ];
    this.snapRoot.add(buildLine(loop, this.origin, colorByKind[preview.kind], 'snap-preview-loop'));
    this.snapRoot.add(buildLine(crossA, this.origin, colorByKind[preview.kind], 'snap-preview-cross-a'));
    this.snapRoot.add(buildLine(crossB, this.origin, colorByKind[preview.kind], 'snap-preview-cross-b'));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(rebasePositions(Float64Array.from([x, y, z]), this.origin), 3));
    const point = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ color: colorByKind[preview.kind], size: 8, sizeAttenuation: false, depthTest: false }),
    );
    point.name = 'snap-preview-point';
    point.renderOrder = 5;
    this.snapRoot.add(point);
  }

  setFocusOverlay(overlay: FeatureFocusOverlay | null): void {
    disposeChildren(this.focusRoot);
    if (!overlay) return;
    if (overlay.boundary && overlay.boundary.length >= 3) {
      const loop = [...overlay.boundary, overlay.boundary[0]!];
      this.focusRoot.add(buildLine(loop, this.origin, 0x8ab4ff, 'focus-isolate-boundary'));
    }
    if (overlay.sectorRect) {
      const { minX, minY, maxX, maxY, z } = overlay.sectorRect;
      const rect: Vec3[] = [
        [minX, minY, z],
        [maxX, minY, z],
        [maxX, maxY, z],
        [minX, maxY, z],
        [minX, minY, z],
      ];
      this.focusRoot.add(buildLine(rect, this.origin, 0xffe3a3, 'focus-load-sector'));
    }
    if (overlay.evidence.length > 0) {
      this.focusRoot.add(buildScreenPoints(overlay.evidence, this.origin, 0x53c7ff, 9, 'focus-evidence-points'));
    }
    if (overlay.origin) {
      this.focusRoot.add(buildScreenPoints([overlay.origin], this.origin, 0xffc857, 10, 'focus-object-origin'));
    }
  }

  setVisible(visible: boolean): void {
    this.featureRoot.visible = visible;
  }

  dispose(): void {
    disposeChildren(this.featureRoot);
    disposeChildren(this.draftRoot);
    disposeChildren(this.snapRoot);
    disposeChildren(this.focusRoot);
    this.group.removeFromParent();
  }
}

function flattenVec3(points: Vec3[]): Float64Array {
  const out = new Float64Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i]![0];
    out[i * 3 + 1] = points[i]![1];
    out[i * 3 + 2] = points[i]![2];
  }
  return out;
}

function buildScreenPoints(points: Vec3[], origin: Vec3, color: number, sizePx: number, name: string): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(rebasePositions(flattenVec3(points), origin), 3));
  const object = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ color, size: sizePx, sizeAttenuation: false, depthTest: false }),
  );
  object.name = name;
  object.renderOrder = 5;
  return object;
}

function buildLine(points: Vec3[], origin: Vec3, color: number, name: string): THREE.Line {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(rebasePositions(flattenVec3(points), origin), 3));
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.96 }),
  );
  line.name = name;
  line.renderOrder = 3;
  return line;
}

function disposeChildren(root: THREE.Object3D): void {
  for (const child of [...root.children]) {
    child.removeFromParent();
    const mesh = child as Partial<THREE.Mesh>;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else if (material) material.dispose();
  }
}
