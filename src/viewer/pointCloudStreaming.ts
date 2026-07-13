// src/viewer/pointCloudStreaming.ts — pure, THREE-free math for camera-keyed streaming of a
// WPI point-cloud index. Screen-space-error node selection over the index hierarchy, fetch
// prioritization, budget-bounded LRU eviction, and stale-request cancellation live here so the
// policy is Node-testable without a WebGL context (same pattern as pointCloudLod.ts). The THREE
// renderer/loader consumes these decisions; it owns geometry and IO, not the math.

export interface StreamBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** One node of the WPI hierarchy, in survey (world) coordinates as stored in index.json. */
export interface StreamNode {
  key: string;
  level: number;
  bounds: StreamBounds;
  pointCount: number;
  childKeys: string[];
}

export interface StreamCameraView {
  /** Camera position in survey (world) coordinates. */
  position: [number, number, number];
  /**
   * Pixels of screen error per unit of (world geometric error / distance):
   * `viewportHeightPx / (2 * tan(fovY / 2))`. See projScaleFromPerspective.
   */
  projScale: number;
}

export interface StreamSelectionParams {
  /** Refine a node (also load its children) while its screen-space error exceeds this (px). */
  sseThreshold: number;
  /** Upper bound on total points across selected nodes (the 2–5M render budget ceiling). */
  budgetMax: number;
}

export interface SelectedStreamNode {
  key: string;
  sse: number;
  distance: number;
  pointCount: number;
}

export interface StreamSelection {
  /** Selected nodes ordered most-erroneous (and nearest) first — the fetch priority order. */
  nodes: SelectedStreamNode[];
  keys: Set<string>;
  estimatedPoints: number;
  /** True when the budget stopped refinement short of the SSE target somewhere. */
  budgetLimited: boolean;
}

/** Perspective projection scale for SSE: screen pixels per (worldError / distance). */
export function projScaleFromPerspective(viewportHeightPx: number, fovYRadians: number): number {
  const t = Math.tan(fovYRadians / 2);
  if (t <= 0) return 0;
  return viewportHeightPx / (2 * t);
}

/** Euclidean distance from a point to the nearest surface/interior of an AABB (0 when inside). */
export function boxDistance(bounds: StreamBounds, p: readonly [number, number, number]): number {
  const dx = Math.max(bounds.minX - p[0], 0, p[0] - bounds.maxX);
  const dy = Math.max(bounds.minY - p[1], 0, p[1] - bounds.maxY);
  const dz = Math.max(bounds.minZ - p[2], 0, p[2] - bounds.maxZ);
  return Math.hypot(dx, dy, dz);
}

/** Geometric error proxy for an octree node = the world-space diagonal of its cube. */
export function nodeGeometricError(bounds: StreamBounds): number {
  return Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
}

/** Screen-space error in pixels. Infinite when the camera sits on/inside the node. */
export function screenSpaceError(geometricError: number, distance: number, projScale: number): number {
  if (distance <= 1e-6) return Infinity;
  return (geometricError * projScale) / distance;
}

function scoreNode(node: StreamNode, camera: StreamCameraView): SelectedStreamNode {
  const distance = boxDistance(node.bounds, camera.position);
  const sse = screenSpaceError(nodeGeometricError(node.bounds), distance, camera.projScale);
  return { key: node.key, sse, distance, pointCount: node.pointCount };
}

function popMaxSse(frontier: SelectedStreamNode[]): SelectedStreamNode {
  let maxI = 0;
  for (let i = 1; i < frontier.length; i++) {
    if (frontier[i]!.sse > frontier[maxI]!.sse) maxI = i;
  }
  return frontier.splice(maxI, 1)[0]!;
}

/**
 * Select which index nodes to load for a camera view. Starting at the root, a node is included
 * and — while its SSE exceeds the threshold and the budget allows — its children are queued for
 * refinement. Nodes are processed most-erroneous first so the budget funds the highest-impact
 * detail; the returned order is the fetch priority order (root loads first → fast first view).
 *
 * The owner-partition index stores different points at every level, so the *union* of selected
 * nodes is what renders; a node whose refinement doesn't fit the budget is simply not added and
 * its coarser ancestor keeps covering that region (coverage over holes).
 */
export function selectStreamingNodes(
  nodesByKey: Map<string, StreamNode>,
  rootKey: string,
  camera: StreamCameraView,
  params: StreamSelectionParams,
): StreamSelection {
  const keys = new Set<string>();
  const nodes: SelectedStreamNode[] = [];
  let estimatedPoints = 0;
  let budgetLimited = false;

  const root = nodesByKey.get(rootKey);
  if (!root) return { nodes, keys, estimatedPoints, budgetLimited };

  const frontier: SelectedStreamNode[] = [scoreNode(root, camera)];
  while (frontier.length > 0) {
    const entry = popMaxSse(frontier);
    if (keys.has(entry.key)) continue;
    if (estimatedPoints + entry.pointCount > params.budgetMax) {
      budgetLimited = true;
      continue; // skip this node (and its subtree); its ancestor still covers the region
    }
    keys.add(entry.key);
    nodes.push(entry);
    estimatedPoints += entry.pointCount;
    if (entry.sse > params.sseThreshold) {
      const node = nodesByKey.get(entry.key)!;
      for (const childKey of node.childKeys) {
        const child = nodesByKey.get(childKey);
        if (child) frontier.push(scoreNode(child, camera));
      }
    }
  }

  return { nodes, keys, estimatedPoints, budgetLimited };
}

/** XY rectangle in survey coordinates (matches StreamNode bounds space). */
export interface RegionXY {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function nodeIntersectsRegionXY(bounds: StreamBounds, region: RegionXY): boolean {
  return (
    bounds.minX <= region.maxX &&
    bounds.maxX >= region.minX &&
    bounds.minY <= region.maxY &&
    bounds.maxY >= region.minY
  );
}

/**
 * Full-density selection for an isolate work area: every node - all levels,
 * down to the leaves - whose XY bounds intersect the region. Because the
 * owner-partition index stores disjoint points per level, this union IS the
 * complete survey data for the area. Coarse-first order (fetch priority),
 * budget-capped with budgetLimited raised when the cap cut it short.
 */
export function selectRegionNodes(
  nodesByKey: Map<string, StreamNode>,
  rootKey: string,
  region: RegionXY,
  budgetMax: number,
): StreamSelection {
  const keys = new Set<string>();
  const nodes: SelectedStreamNode[] = [];
  let estimatedPoints = 0;
  let budgetLimited = false;

  const root = nodesByKey.get(rootKey);
  if (!root) return { nodes, keys, estimatedPoints, budgetLimited };

  const queue: StreamNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (!nodeIntersectsRegionXY(node.bounds, region)) continue;
    if (estimatedPoints + node.pointCount > budgetMax) {
      budgetLimited = true;
      continue; // deeper levels of this branch are skipped too (children queue after)
    }
    keys.add(node.key);
    nodes.push({ key: node.key, sse: Infinity, distance: 0, pointCount: node.pointCount });
    estimatedPoints += node.pointCount;
    for (const childKey of node.childKeys) {
      const child = nodesByKey.get(childKey);
      if (child) queue.push(child);
    }
  }

  return { nodes, keys, estimatedPoints, budgetLimited };
}

/** Total index points intersecting the region (all levels); free from node metadata. */
export function estimateRegionPoints(
  nodesByKey: Map<string, StreamNode>,
  rootKey: string,
  region: RegionXY,
): number {
  let total = 0;
  const root = nodesByKey.get(rootKey);
  if (!root) return 0;
  const queue: StreamNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (!nodeIntersectsRegionXY(node.bounds, region)) continue;
    total += node.pointCount;
    for (const childKey of node.childKeys) {
      const child = nodesByKey.get(childKey);
      if (child) queue.push(child);
    }
  }
  return total;
}

/**
 * The over-capacity catch: when a region's full-density total exceeds the
 * budget, split it into sectors the viewer can show one at a time. Each split
 * halves the region along its longer axis at the point-weighted median of the
 * intersecting node centers (balanced halves even for skewed data), recursing
 * until every sector fits the budget or maxSectors is reached.
 */
export function planRegionSectors(
  nodesByKey: Map<string, StreamNode>,
  rootKey: string,
  region: RegionXY,
  budgetMax: number,
  maxSectors = 16,
): RegionXY[] {
  const fits = (candidate: RegionXY): boolean =>
    estimateRegionPoints(nodesByKey, rootKey, candidate) <= budgetMax;
  const sectors: RegionXY[] = [];

  const subdivide = (candidate: RegionXY, depthLeft: number): void => {
    if (depthLeft <= 0 || fits(candidate)) {
      sectors.push(candidate);
      return;
    }
    const splitX = candidate.maxX - candidate.minX >= candidate.maxY - candidate.minY;
    const split = weightedMedianSplit(nodesByKey, rootKey, candidate, splitX);
    if (split === null) {
      sectors.push(candidate); // no separable weight - splitting cannot help
      return;
    }
    const [a, b] = split;
    subdivide(a, depthLeft - 1);
    subdivide(b, depthLeft - 1);
  };

  subdivide(region, Math.ceil(Math.log2(Math.max(maxSectors, 1))));
  return sectors;
}

/** Point-weighted median split of a region along one axis; null when degenerate. */
function weightedMedianSplit(
  nodesByKey: Map<string, StreamNode>,
  rootKey: string,
  region: RegionXY,
  alongX: boolean,
): [RegionXY, RegionXY] | null {
  const root = nodesByKey.get(rootKey);
  if (!root) return null;
  const samples: { center: number; weight: number }[] = [];
  const queue: StreamNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (!nodeIntersectsRegionXY(node.bounds, region)) continue;
    samples.push({
      center: alongX ? (node.bounds.minX + node.bounds.maxX) / 2 : (node.bounds.minY + node.bounds.maxY) / 2,
      weight: node.pointCount,
    });
    for (const childKey of node.childKeys) {
      const child = nodesByKey.get(childKey);
      if (child) queue.push(child);
    }
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => a.center - b.center);
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  let acc = 0;
  let cut = samples[samples.length - 1]!.center;
  for (const sample of samples) {
    acc += sample.weight;
    if (acc >= totalWeight / 2) {
      cut = sample.center;
      break;
    }
  }
  const lo = alongX ? region.minX : region.minY;
  const hi = alongX ? region.maxX : region.maxY;
  const clamped = Math.min(Math.max(cut, lo + (hi - lo) * 0.05), hi - (hi - lo) * 0.05);
  if (!(clamped > lo && clamped < hi)) return null;
  return alongX
    ? [
        { ...region, maxX: clamped },
        { ...region, minX: clamped },
      ]
    : [
        { ...region, maxY: clamped },
        { ...region, minY: clamped },
      ];
}

export interface LoadedStreamEntry {
  key: string;
  pointCount: number;
  lastUsedTick: number;
}

/**
 * For each visible loaded node, compute the finest visible descendant level in its branch.
 * Ancestors inherit the deepest visible level below them so a refined region renders one
 * consistent splat size instead of mixing per-level sizes within the same branch.
 */
export function deriveFinestVisibleLevels(
  nodesByKey: Map<string, StreamNode>,
  loadedVisibleKeys: Set<string>,
): Map<string, number> {
  const memo = new Map<string, number>();

  const visit = (key: string): number | null => {
    if (memo.has(key)) return memo.get(key)!;
    const node = nodesByKey.get(key);
    if (!node) return null;

    let finest = loadedVisibleKeys.has(key) ? node.level : null;
    for (const childKey of node.childKeys) {
      const childFinest = visit(childKey);
      if (childFinest === null) continue;
      finest = finest === null ? childFinest : Math.max(finest, childFinest);
    }

    if (finest !== null) memo.set(key, finest);
    return finest;
  };

  for (const key of loadedVisibleKeys) visit(key);
  return memo;
}

/**
 * Decide which loaded nodes to evict to stay within budget. Only nodes not in the current
 * selection are eligible, least-recently-used first; selected nodes are never evicted (if the
 * selection alone exceeds budget it was already capped, so this returns within-budget results).
 */
export function planEviction(
  loaded: LoadedStreamEntry[],
  selectedKeys: Set<string>,
  budgetMax: number,
  pinnedKeys: Set<string> = new Set(),
): string[] {
  let total = 0;
  for (const entry of loaded) total += entry.pointCount;
  if (total <= budgetMax) return [];

  const evictable = loaded
    .filter((entry) => !selectedKeys.has(entry.key) && !pinnedKeys.has(entry.key))
    .sort((a, b) => a.lastUsedTick - b.lastUsedTick);
  const evict: string[] = [];
  for (const entry of evictable) {
    if (total <= budgetMax) break;
    evict.push(entry.key);
    total -= entry.pointCount;
  }
  return evict;
}

/** In-flight tile requests whose nodes are no longer selected — cancel these on camera move. */
export function staleRequestKeys(inFlightKeys: Iterable<string>, selectedKeys: Set<string>): string[] {
  const stale: string[] = [];
  for (const key of inFlightKeys) {
    if (!selectedKeys.has(key)) stale.push(key);
  }
  return stale;
}

/** Whether every selected node is already loaded (nothing pending) — the "settled" state. */
export function isSettled(selectedKeys: Set<string>, loadedKeys: Set<string>): boolean {
  for (const key of selectedKeys) {
    if (!loadedKeys.has(key)) return false;
  }
  return true;
}

/** Compact number formatter for disclosure banners (e.g. 1.2M). */
function compact(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** Disclosure text for the indexed-full streaming state, distinct from preview/densification. */
export function formatIndexedFullDisclosure(loadedPoints: number, totalPoints: number, settled: boolean): string {
  const state = settled ? 'settled' : 'refining';
  return `Indexed-full — streaming ${compact(loadedPoints)} of ${compact(totalPoints)} points · ${state}`;
}
