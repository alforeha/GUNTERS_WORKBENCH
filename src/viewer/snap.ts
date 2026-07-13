// src/viewer/snap.ts - pure snap-target resolution for feature authoring.
// No Three.js imports: the engine bridge owns raycasting and projection and
// hands this module already-projected screen candidates plus survey-space
// world coordinates. Reuses pickClosestScreenPoint from editing.ts.

import type { EvidenceRef } from '../shared/workbench-types';
import { pickClosestScreenPoint } from './editing';
import type { Vec3 } from './geometry';

export type SnapSourceKind =
  | 'cloud-point' // implemented: preview + indexed point-cloud points
  | 'authored-vertex' // implemented: vertices of already-authored features
  | 'authored-edge' // implemented: nearest point on authored feature edges
  | 'dwg-vertex' // provider seam only in v1 (no DWG snap yet)
  | 'tin-vertex' // provider seam only in v1 (no imported-TIN snap yet)
  | 'surface-hit'; // provider seam only in v1

export const IMPLEMENTED_SNAP_SOURCES: readonly SnapSourceKind[] = [
  'cloud-point',
  'authored-vertex',
  'authored-edge',
];

/** Same 14px radius the surface-edit hover pick uses; one feel across tools. */
export const DEFAULT_SNAP_TOLERANCE_PX = 14;

/**
 * Highest precedence first. Authored geometry outranks cloud points so shared
 * region borders snap watertight even inside a dense cloud; the seam-only
 * kinds already hold their intended slots so enabling a provider later does
 * not reshuffle behavior.
 */
export const SNAP_PRECEDENCE: readonly SnapSourceKind[] = [
  'authored-vertex',
  'authored-edge',
  'dwg-vertex',
  'tin-vertex',
  'cloud-point',
  'surface-hit',
];

export interface SnapCandidate {
  sourceKind: SnapSourceKind;
  cloudSource?: 'preview' | 'index';
  /** Survey-space coordinate the placement snaps to. */
  world: Vec3;
  /** Projected viewport position in pixels. */
  screen: { x: number; y: number };
  assetId?: string;
  assetLayerId?: string;
  /** Owning feature for authored-vertex / authored-edge candidates. */
  featureId?: string;
  sourceClass?: number;
  sourceRGB?: [number, number, number];
}

export interface SnapQuery {
  pointer: { x: number; y: number };
  candidates: SnapCandidate[];
  tolerancePx: number;
  /**
   * Assets that must never act as snap sources. The engine never collects
   * candidates from surfel display entries in the first place; this is the
   * pure-core backstop so the rule holds even for a misbehaving collector.
   */
  excludedAssetIds?: ReadonlySet<string>;
}

export interface SnapHit {
  snapped: true;
  candidate: SnapCandidate;
  distancePx: number;
}

export interface FreePlacement {
  snapped: false;
  world: Vec3;
}

export type PlacementResolution = SnapHit | FreePlacement;

/**
 * Closest point on the 2D screen segment a-b to the pointer, with its
 * interpolation parameter t in [0,1]. The engine bridge uses t to lerp the
 * matching world-space point on an authored edge.
 */
export function closestPointOnScreenSegment(
  pointer: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): { t: number; x: number; y: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((pointer.x - a.x) * abx + (pointer.y - a.y) * aby) / lengthSq));
  return { t, x: a.x + abx * t, y: a.y + aby * t };
}

/**
 * Nearest candidate of the highest-precedence source kind that has any
 * candidate inside the pixel tolerance; null when nothing is in range.
 */
export function resolveSnap(query: SnapQuery): SnapHit | null {
  const excluded = query.excludedAssetIds;
  for (const kind of SNAP_PRECEDENCE) {
    const pool = query.candidates.filter(
      (candidate) =>
        candidate.sourceKind === kind && !(candidate.assetId && excluded?.has(candidate.assetId)),
    );
    if (pool.length === 0) continue;
    const winner = pickClosestScreenPoint(
      query.pointer,
      pool.map((candidate, index) => ({ id: index, x: candidate.screen.x, y: candidate.screen.y })),
      query.tolerancePx,
    );
    if (winner === null) continue;
    const candidate = pool[winner]!;
    return {
      snapped: true,
      candidate,
      distancePx: Math.hypot(candidate.screen.x - query.pointer.x, candidate.screen.y - query.pointer.y),
    };
  }
  return null;
}

/**
 * Snap when possible, otherwise fall back to free placement at freeWorld
 * (typically the surface/plane hit under the pointer). Free placement is a
 * deliberate, flagged state - never silently conflated with a snap.
 */
export function resolvePlacement(query: SnapQuery, freeWorld: Vec3 | null): PlacementResolution | null {
  const hit = resolveSnap(query);
  if (hit) return hit;
  if (!freeWorld) return null;
  return { snapped: false, world: [freeWorld[0], freeWorld[1], freeWorld[2]] };
}

/**
 * Maps a resolved placement to the evidence record persisted on the feature.
 * Free placement is picked-coordinate; snapped placements carry their source
 * linkage. Surfels can never reach here: they are excluded at collection AND
 * in resolveSnap, and the manifest schema rejects them as a final backstop.
 */
export function evidenceForPlacement(placement: PlacementResolution): EvidenceRef {
  if (!placement.snapped) {
    return { kind: 'picked-coordinate', coordinate: [...placement.world] };
  }
  const candidate = placement.candidate;
  const coordinate: [number, number, number] = [...candidate.world];
  switch (candidate.sourceKind) {
    case 'cloud-point':
      return {
        kind: 'asset-point',
        coordinate,
        ...(candidate.assetId ? { assetId: candidate.assetId } : {}),
        ...(candidate.sourceClass !== undefined ? { sourceClass: candidate.sourceClass } : {}),
        ...(candidate.sourceRGB ? { sourceRGB: candidate.sourceRGB } : {}),
      };
    case 'authored-vertex':
      return { kind: 'asset-vertex', coordinate, ...(candidate.featureId ? { featureId: candidate.featureId } : {}) };
    case 'authored-edge':
      return { kind: 'asset-edge', coordinate, ...(candidate.featureId ? { featureId: candidate.featureId } : {}) };
    case 'dwg-vertex':
    case 'tin-vertex':
      return {
        kind: 'asset-vertex',
        coordinate,
        ...(candidate.assetId ? { assetId: candidate.assetId } : {}),
        ...(candidate.assetLayerId ? { assetLayerId: candidate.assetLayerId } : {}),
      };
    case 'surface-hit':
      return { kind: 'surface-hit', coordinate, ...(candidate.assetId ? { assetId: candidate.assetId } : {}) };
  }
}
