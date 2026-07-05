// src/viewer/labels.ts — vertex elevation labels v1 (07 Phase 6, 04 §3).
// troika-three-text instances, POOLED (created once, recycled), frustum + distance culled,
// hard visible cap, auto-off above cap (caller surfaces a status note).
// Labels live OUTSIDE the exaggeration-scaled content group (text must never be Z-stretched);
// positions compensate (z = localZ × exaggeration) and the text shows TRUE elevation.
import * as THREE from 'three';
import { Text } from 'troika-three-text';

export const LABEL_CAP = 500;
const Z_NUDGE = 0.4; // world units above the vertex so text doesn't z-fight the surface

export type LabelRefreshStatus = 'off' | 'ok' | 'paused';

export interface LabelStyle {
  color: string;
  opacity: number;
  /** label content (docs/08 Phase 6): 'z' = elevation only (default), 'nez' = N, E, Z */
  content: 'z' | 'nez';
}

export class LabelPool {
  /** Engine adds this group to the UNSCALED scene root. */
  readonly group = new THREE.Group();
  private pool: Text[] = [];
  /** Rebased Float32 local positions (shared, read-only) + original Float64 (true Z source). */
  private localPositions: Float32Array;
  private sourcePositions: Float64Array;

  constructor(localPositions: Float32Array, sourcePositions: Float64Array, name: string) {
    this.localPositions = localPositions;
    this.sourcePositions = sourcePositions;
    this.group.name = `labels:${name}`;
    this.group.visible = false;
  }

  hide(): void {
    this.group.visible = false;
  }

  /**
   * Repopulate the pool for the current camera. Candidates = vertices inside the frustum
   * AND within maxDist of the camera. Over the cap → everything hides ('paused').
   */
  refresh(
    camera: THREE.Camera,
    exaggeration: number,
    maxDist: number,
    style: LabelStyle,
  ): LabelRefreshStatus {
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const maxDistSq = maxDist * maxDist;
    const p = new THREE.Vector3();

    // Pass 1: collect candidate vertex indices, bail early past the cap.
    const candidates: number[] = [];
    const n = this.localPositions.length / 3;
    for (let i = 0; i < n; i++) {
      p.set(
        this.localPositions[i * 3]!,
        this.localPositions[i * 3 + 1]!,
        this.localPositions[i * 3 + 2]! * exaggeration,
      );
      if (p.distanceToSquared(camPos) > maxDistSq) continue;
      if (!frustum.containsPoint(p)) continue;
      candidates.push(i);
      if (candidates.length > LABEL_CAP) {
        this.group.visible = false;
        return 'paused'; // auto-off above cap (07 Phase 6)
      }
    }
    if (candidates.length === 0) {
      this.group.visible = false;
      return 'ok';
    }

    // Text size scales with view scale so labels stay legible at any zoom.
    const viewScale = Math.max(camPos.distanceTo(p.set(0, 0, 0).copy(this.centerOf(candidates, exaggeration))), 1);
    const fontSize = THREE.MathUtils.clamp(viewScale / 60, 0.3, 25);

    for (let k = 0; k < candidates.length; k++) {
      const i = candidates[k]!;
      const label = this.pool[k] ?? this.makeLabel();
      // sourcePositions are x=E, y=N, z=Z — display order is the survey convention N, E, Z.
      const trueE = this.sourcePositions[i * 3]!;
      const trueN = this.sourcePositions[i * 3 + 1]!;
      const trueZ = this.sourcePositions[i * 3 + 2]!;
      label.text =
        style.content === 'nez'
          ? `${trueN.toFixed(2)}, ${trueE.toFixed(2)}, ${trueZ.toFixed(2)}`
          : trueZ.toFixed(2);
      label.fontSize = fontSize;
      label.color = style.color;
      label.fillOpacity = style.opacity;
      label.outlineOpacity = style.opacity;
      label.position.set(
        this.localPositions[i * 3]!,
        this.localPositions[i * 3 + 1]!,
        this.localPositions[i * 3 + 2]! * exaggeration + Z_NUDGE,
      );
      label.quaternion.copy((camera as THREE.PerspectiveCamera).quaternion); // billboard at rest
      label.visible = true;
      label.sync();
    }
    for (let k = candidates.length; k < this.pool.length; k++) this.pool[k]!.visible = false;
    this.group.visible = true;
    return 'ok';
  }

  private centerOf(candidates: number[], exaggeration: number): THREE.Vector3 {
    const mid = candidates[Math.floor(candidates.length / 2)]!;
    return new THREE.Vector3(
      this.localPositions[mid * 3]!,
      this.localPositions[mid * 3 + 1]!,
      this.localPositions[mid * 3 + 2]! * exaggeration,
    );
  }

  private makeLabel(): Text {
    const t = new Text();
    t.anchorX = 'center';
    t.anchorY = 'bottom';
    t.outlineWidth = '8%';
    t.outlineColor = '#000000';
    t.material.depthTest = true;
    this.pool.push(t);
    this.group.add(t);
    return t;
  }

  dispose(): void {
    for (const t of this.pool) t.dispose();
    this.pool = [];
    this.group.removeFromParent();
  }
}
