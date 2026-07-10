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
  fillColor: number;
  lineColor: number;
}

/** Authored geometry the snap collector may use as authored-vertex/edge sources. */
export interface AuthoredSnapGeometry {
  vertices: { featureId: string; world: Vec3 }[];
  edges: { featureId: string; a: Vec3; b: Vec3 }[];
}

const DRAFT_LINE_COLOR = 0xffc857;
const DRAFT_VERTEX_COLOR = 0xffe3a3;

export class RenderFeatures {
  readonly group = new THREE.Group();
  private readonly origin: Vec3;
  private readonly featureRoot = new THREE.Group();
  private readonly draftRoot = new THREE.Group();
  private snapGeometry: AuthoredSnapGeometry = { vertices: [], edges: [] };

  constructor(origin: Vec3) {
    this.origin = origin;
    this.group.name = 'authored-features';
    this.group.add(this.featureRoot);
    this.group.add(this.draftRoot);
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
          opacity: 0.35,
          side: THREE.DoubleSide,
          depthWrite: false,
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

  setVisible(visible: boolean): void {
    this.featureRoot.visible = visible;
  }

  dispose(): void {
    disposeChildren(this.featureRoot);
    disposeChildren(this.draftRoot);
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

function buildLine(points: Vec3[], origin: Vec3, color: number, name: string): THREE.Line {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(rebasePositions(flattenVec3(points), origin), 3));
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color }));
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
