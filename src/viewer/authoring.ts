// src/viewer/authoring.ts - pure authoring state machine for Create Sim:
// idle -> placing -> addingVertex -> closing -> complete | cancelled.
// Emits draft geometry + evidence refs. No Three.js imports; the engine
// bridge feeds resolved placements (see snap.ts) and reads snapshots.

import type { EvidenceRef, FeatureFamily } from '../shared/workbench-types';
import type { Vec3 } from './geometry';
import { evidenceForPlacement, type PlacementResolution } from './snap';

export type AuthoringGeometryMode = 'point' | 'polyline' | 'polygon';

export type AuthoringState = 'idle' | 'placing' | 'addingVertex' | 'closing' | 'complete' | 'cancelled';

/** Vertex minimums enforced before a draft may close. */
const MIN_VERTICES: Record<AuthoringGeometryMode, number> = {
  point: 1,
  polyline: 2,
  polygon: 3,
};

export function defaultGeometryMode(family: FeatureFamily): AuthoringGeometryMode {
  switch (family) {
    case 'marker':
    case 'object':
    case 'measurement':
      return 'point';
    case 'line':
    case 'utility':
      return 'polyline';
    case 'region':
    case 'building':
      return 'polygon';
  }
}

export interface AuthoringVertex {
  world: Vec3;
  /** Distinguishes snapped placement from deliberate free placement. */
  snapped: boolean;
  evidence: EvidenceRef;
}

export interface AuthoringDraft {
  family: FeatureFamily;
  templateId: string | null;
  geometryMode: AuthoringGeometryMode;
  vertices: AuthoringVertex[];
  /** True only for polygon drafts confirmed through the closing state. */
  closed: boolean;
}

export interface AuthoringSnapshot {
  state: AuthoringState;
  draft: AuthoringDraft | null;
}

/**
 * The machine is deliberately strict: every transition method returns whether
 * it applied, and invalid calls leave state untouched so the UI can no-op on
 * stale events instead of corrupting a draft.
 */
export class AuthoringMachine {
  private state: AuthoringState = 'idle';
  private draft: AuthoringDraft | null = null;

  /** Starts a new draft. Valid from idle or either terminal state. */
  start(family: FeatureFamily, templateId: string | null, geometryMode = defaultGeometryMode(family)): boolean {
    if (this.state !== 'idle' && this.state !== 'complete' && this.state !== 'cancelled') return false;
    this.state = 'placing';
    this.draft = { family, templateId, geometryMode, vertices: [], closed: false };
    return true;
  }

  /**
   * Records one resolved placement. Point drafts complete on their single
   * placement; polyline/polygon drafts move to addingVertex and accumulate.
   */
  place(placement: PlacementResolution): boolean {
    if (!this.draft || (this.state !== 'placing' && this.state !== 'addingVertex')) return false;
    const world: Vec3 = placement.snapped ? placement.candidate.world : placement.world;
    this.draft.vertices.push({
      world: [world[0], world[1], world[2]],
      snapped: placement.snapped,
      evidence: evidenceForPlacement(placement),
    });
    this.state = this.draft.geometryMode === 'point' ? 'complete' : 'addingVertex';
    return true;
  }

  /** addingVertex -> closing, once the mode's vertex minimum is met. */
  requestClose(): boolean {
    if (!this.draft || this.state !== 'addingVertex') return false;
    if (this.draft.vertices.length < MIN_VERTICES[this.draft.geometryMode]) return false;
    this.state = 'closing';
    return true;
  }

  /** closing -> complete; polygon drafts become closed rings. */
  confirm(): boolean {
    if (!this.draft || this.state !== 'closing') return false;
    if (this.draft.geometryMode === 'polygon') this.draft.closed = true;
    this.state = 'complete';
    return true;
  }

  /** Aborts the in-flight draft from any active state; the draft is dropped. */
  cancel(): boolean {
    if (this.state !== 'placing' && this.state !== 'addingVertex' && this.state !== 'closing') return false;
    this.state = 'cancelled';
    this.draft = null;
    return true;
  }

  snapshot(): AuthoringSnapshot {
    return structuredClone({ state: this.state, draft: this.draft });
  }
}
