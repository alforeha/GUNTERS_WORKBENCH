// src/viewer/pointCloudLod.ts — pure, THREE-free helpers for point-cloud LOD, display
// modes, and class/return filtering. Kept out of RenderPointCloud so the math is
// Node-testable without a WebGL context (same pattern as geometry.ts).

export type PointDisplayMode = 'rgb' | 'intensity' | 'elevation' | 'geotiff';

/** Total rendered-point target window across all active nodes (work order: 2–5M). */
export const POINT_BUDGET_MIN = 2_000_000;
export const POINT_BUDGET_MAX = 5_000_000;

/** Density tiers expressed as a sample stride: tier 0 draws every point, tier 1 every
 * 2nd, tier 2 every 4th, tier 3 every 8th. Nearest nodes get tier 0. */
export const LOD_STRIDES = [1, 2, 4, 8] as const;

export interface NodeScore {
  /** index back into the caller's node array */
  index: number;
  /** camera→node-center distance in render units */
  distance: number;
  /** full (unfiltered, unthinned) sample count for this node */
  sampleCount: number;
}

export interface NodeLodResult {
  index: number;
  /** sample stride to apply (1 = full density). */
  stride: number;
}

/**
 * Distance-based LOD selection. Nodes are sorted nearest-first; the nearest get full
 * density (stride 1) and farther nodes are progressively thinned so the *estimated*
 * drawn-point total stays near [min,max] without ever dropping a frustum-visible node
 * entirely. If even the coarsest stride still exceeds budgetMax, coverage wins and the
 * estimate is allowed to overflow the budget instead of leaving holes.
 *
 * The estimate uses sampleCount/stride; callers apply per-class/return filtering on top,
 * which only ever reduces the real drawn count, so the budget is an upper bound.
 */
export function selectLod(
  scores: NodeScore[],
  _budgetMin = POINT_BUDGET_MIN,
  budgetMax = POINT_BUDGET_MAX,
): NodeLodResult[] {
  const ordered = [...scores].sort((a, b) => a.distance - b.distance);
  const coarsest = LOD_STRIDES[LOD_STRIDES.length - 1];
  const results = ordered.map<NodeLodResult>((node) => ({
    index: node.index,
    stride: coarsest,
  }));
  let drawn = ordered.reduce((sum, node) => sum + Math.ceil(node.sampleCount / coarsest), 0);

  // Coverage floor alone already exceeds the hard ceiling: keep every visible node at the
  // coarsest tier and accept the overflow rather than blanking far geometry.
  if (drawn > budgetMax) {
    return results;
  }

  for (let i = 0; i < ordered.length; i++) {
    const node = ordered[i]!;
    if (node.sampleCount === 0) continue;
    let stride = coarsest;
    for (let candidateIndex = LOD_STRIDES.length - 2; candidateIndex >= 0; candidateIndex--) {
      const candidate = LOD_STRIDES[candidateIndex]!;
      const delta = Math.ceil(node.sampleCount / candidate) - Math.ceil(node.sampleCount / stride);
      if (drawn + delta > budgetMax) continue;
      drawn += delta;
      stride = candidate;
      results[i] = { index: node.index, stride };
    }
  }
  return results;
}

/** Estimate the drawn-point total a LOD result implies (for tests / diagnostics). */
export function estimateDrawn(scores: NodeScore[], lod: NodeLodResult[]): number {
  const byIndex = new Map(scores.map((s) => [s.index, s.sampleCount]));
  let total = 0;
  for (const r of lod) {
    if (r.stride === 0) continue;
    total += Math.ceil((byIndex.get(r.index) ?? 0) / r.stride);
  }
  return total;
}

export interface FilterState {
  /** classification code → enabled. Missing key = enabled. */
  classes: Record<number, boolean>;
  /** 'first' | 'last' | 'intermediate' → enabled. Empty = all enabled. */
  returns: { first: boolean; last: boolean; intermediate: boolean };
}

export function defaultFilterState(): FilterState {
  return { classes: {}, returns: { first: true, last: true, intermediate: true } };
}

/** Classify a point's return as first / last / intermediate for the returns filter. */
export function returnRole(returnNumber: number, numberOfReturns: number): 'first' | 'last' | 'intermediate' {
  if (returnNumber <= 1) return 'first';
  if (returnNumber >= numberOfReturns) return 'last';
  return 'intermediate';
}

/** Whether a sampled point passes the active class + return filters. */
export function pointPasses(
  classification: number,
  returnNumber: number,
  numberOfReturns: number,
  filter: FilterState,
): boolean {
  if (filter.classes[classification] === false) return false;
  const role = returnRole(returnNumber, numberOfReturns);
  return filter.returns[role] !== false;
}

// ── LAS 1.4 classification names (table 17) ───────────────────────────────────
const LAS_CLASS_NAMES: Record<number, string> = {
  0: 'Created, never classified',
  1: 'Unclassified',
  2: 'Ground',
  3: 'Low Vegetation',
  4: 'Medium Vegetation',
  5: 'High Vegetation',
  6: 'Building',
  7: 'Low Point (noise)',
  8: 'Reserved',
  9: 'Water',
  10: 'Rail',
  11: 'Road Surface',
  12: 'Reserved',
  13: 'Wire – Guard (Shield)',
  14: 'Wire – Conductor (Phase)',
  15: 'Transmission Tower',
  16: 'Wire-structure Connector',
  17: 'Bridge Deck',
  18: 'High Noise',
  19: 'Overhead Structure',
  20: 'Ignored Ground',
  21: 'Snow',
  22: 'Temporal Exclusion',
};

export function classLabel(code: number): string {
  return LAS_CLASS_NAMES[code] ?? `Class ${code}`;
}

// ── Elevation terrain ramp (blue → green → yellow → red) ──────────────────────
const TERRAIN_STOPS: [number, [number, number, number]][] = [
  [0.0, [0, 0, 255]],
  [0.33, [0, 200, 0]],
  [0.66, [255, 255, 0]],
  [1.0, [255, 0, 0]],
];

// ── GeoTIFF coarse-overview CPU sampler ───────────────────────────────────────
// Holds one low-res RGBA buffer of a GeoTIFF's full extent so point clouds can be
// recolored by XY without touching the GPU tile textures. Sampling is nearest-pixel.

export interface OverviewWorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class GeotiffOverviewSampler {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly rgba: Uint8Array,
    readonly bounds: OverviewWorldBounds,
  ) {}

  /** Sample the overview at a world XY. Returns null if outside the raster extent. */
  sample(worldX: number, worldY: number): [number, number, number] | null {
    const { minX, minY, maxX, maxY } = this.bounds;
    if (worldX < minX || worldX > maxX || worldY < minY || worldY > maxY) return null;
    const u = maxX === minX ? 0 : (worldX - minX) / (maxX - minX);
    // Image rows run top (maxY) → bottom (minY); flip V so row 0 is the north edge.
    const v = maxY === minY ? 0 : (maxY - worldY) / (maxY - minY);
    const px = Math.min(this.width - 1, Math.max(0, Math.floor(u * this.width)));
    const py = Math.min(this.height - 1, Math.max(0, Math.floor(v * this.height)));
    const idx = (py * this.width + px) * 4;
    return [this.rgba[idx] ?? 0, this.rgba[idx + 1] ?? 0, this.rgba[idx + 2] ?? 0];
  }
}

/** Map a normalized 0–1 value to an 8-bit RGB terrain color. */
export function terrainColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < TERRAIN_STOPS.length - 1; i++) {
    const [t0, c0] = TERRAIN_STOPS[i]!;
    const [t1, c1] = TERRAIN_STOPS[i + 1]!;
    if (x <= t1) {
      const f = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return TERRAIN_STOPS[TERRAIN_STOPS.length - 1]![1];
}
