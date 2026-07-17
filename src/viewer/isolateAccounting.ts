// src/viewer/isolateAccounting.ts - pure, THREE-free isolate-area point
// accounting. While an isolate focus and/or load-all region is active, the
// disclosure banner must answer "how many points are actually in my area?"
// separately from the global streaming count (which sits pinned at the render
// budget and never reflects the isolate). Counting, coordinate conversion
// between render-local polygons and survey regions, and the disclosure text
// live here so they are Node-testable (same pattern as pointCloudStreaming.ts).

import type { PointCloudNodePayload } from '../core/contract';
import { pointInPolygonXY } from './isolateClip';
import { pointPasses, type FilterState } from './pointCloudLod';
import { compactPoints, type RegionXY } from './pointCloudStreaming';

/** XY vertex of an isolate polygon in render-local coordinates (survey - sceneOrigin). */
export interface PolygonVertexXY {
  x: number;
  y: number;
}

/** Point counts for one tile payload against an isolate polygon. */
export interface AreaPointCounts {
  /** Points whose XY falls inside the polygon (loaded in memory). */
  inside: number;
  /** Inside points that also pass the active class/return filter (drawable). */
  insideFiltered: number;
}

/** Everything the disclosure needs to account for an active isolate area. */
export interface IsolateAccounting {
  /** True while an isolate clip polygon is hiding points outside the area. */
  focusActive: boolean;
  /** True while a load-all region is streaming full density. */
  regionActive: boolean;
  /**
   * Index-metadata estimate of points near the area: the sum of node counts
   * whose XY bounds intersect the area's survey bounding box. An upper bound -
   * coarse nodes overlap far beyond a small polygon.
   */
  estimatedAreaPoints: number;
  /** Load-all only: total points of the region-selected nodes (budget-capped). */
  regionSelectedPoints: number;
  /** Load-all only: points of region-selected nodes already loaded. */
  regionLoadedPoints: number;
  /** True when the render budget cut the region selection short of the leaves. */
  regionBudgetLimited: boolean;
  /** Loaded points whose XY falls inside the isolate area. */
  loadedInArea: number;
  /** Loaded, filter-passing points inside the area on currently drawn tiles. */
  drawnInArea: number;
}

/** Active load-all sector position, when the area split across sectors. */
export interface IsolateSectorInfo {
  index: number;
  count: number;
}

/** XY bounding box of a polygon, as a RegionXY in the polygon's own space. */
export function polygonBoundsXY(polygon: PolygonVertexXY[]): RegionXY {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const vertex of polygon) {
    minX = Math.min(minX, vertex.x);
    minY = Math.min(minY, vertex.y);
    maxX = Math.max(maxX, vertex.x);
    maxY = Math.max(maxY, vertex.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Survey-space bounding box of a render-local polygon (adds the scene origin back). */
export function renderPolygonToSurveyRegion(
  polygon: PolygonVertexXY[],
  sceneOrigin: readonly [number, number, number],
): RegionXY {
  const bounds = polygonBoundsXY(polygon);
  return {
    minX: bounds.minX + sceneOrigin[0],
    minY: bounds.minY + sceneOrigin[1],
    maxX: bounds.maxX + sceneOrigin[0],
    maxY: bounds.maxY + sceneOrigin[1],
  };
}

/** Render-local rectangle polygon for a survey region (subtracts the scene origin). */
export function regionToRenderPolygon(
  region: RegionXY,
  sceneOrigin: readonly [number, number, number],
): PolygonVertexXY[] {
  const [ox, oy] = sceneOrigin;
  return [
    { x: region.minX - ox, y: region.minY - oy },
    { x: region.maxX - ox, y: region.minY - oy },
    { x: region.maxX - ox, y: region.maxY - oy },
    { x: region.minX - ox, y: region.maxY - oy },
  ];
}

/**
 * Counts a tile payload's points inside an isolate polygon. Payload positions
 * are index-origin-relative; offsetX/offsetY shift them into the polygon's
 * render-local space (the tile group's position = origin - sceneOrigin), so
 * the test runs in exactly the coordinate space the GPU clip discards in.
 */
export function countPayloadPointsInPolygon(
  payload: PointCloudNodePayload,
  offsetX: number,
  offsetY: number,
  polygon: PolygonVertexXY[],
  filter: FilterState,
): AreaPointCounts {
  const bounds = polygonBoundsXY(polygon);
  let inside = 0;
  let insideFiltered = 0;
  for (let i = 0; i < payload.pointCount; i++) {
    const x = (payload.positions[i * 3] ?? 0) + offsetX;
    if (x < bounds.minX || x > bounds.maxX) continue;
    const y = (payload.positions[i * 3 + 1] ?? 0) + offsetY;
    if (y < bounds.minY || y > bounds.maxY) continue;
    if (!pointInPolygonXY(x, y, polygon)) continue;
    inside++;
    const cls = payload.classifications[i] ?? 0;
    const rn = payload.returnNumbers[i] ?? 1;
    const nr = payload.numberOfReturns[i] ?? 1;
    if (pointPasses(cls, rn, nr, filter)) insideFiltered++;
  }
  return { inside, insideFiltered };
}

/**
 * Disclosure line for an active isolate area, shown alongside (never instead
 * of) the global indexed-full line. Answers, in order: how many points are
 * actually in the area right now, whether load-all has the area's full data,
 * and whether sectors/budget limit it.
 */
export function formatIsolateDisclosure(
  accounting: IsolateAccounting,
  sector: IsolateSectorInfo | null = null,
): string {
  const sectorLabel = sector && sector.count > 1 ? ` · sector ${sector.index + 1} of ${sector.count}` : '';
  if (accounting.estimatedAreaPoints === 0) {
    return `Isolate: no indexed points found in area${sectorLabel}`;
  }
  const areaCounts =
    accounting.drawnInArea === accounting.loadedInArea
      ? `${compactPoints(accounting.drawnInArea)} pts in area`
      : `${compactPoints(accounting.drawnInArea)} drawn / ${compactPoints(accounting.loadedInArea)} loaded in area`;
  if (!accounting.regionActive) {
    return (
      `Isolate: ${areaCounts} · view-density streaming only — ` +
      `Load All for full data (~${compactPoints(accounting.estimatedAreaPoints)} indexed near area)`
    );
  }
  const budgetLabel = accounting.regionBudgetLimited ? ' · budget-limited: sector exceeds display budget' : '';
  const progress =
    accounting.regionLoadedPoints >= accounting.regionSelectedPoints
      ? `full data loaded (${compactPoints(accounting.regionSelectedPoints)} tile pts)`
      : `loading ${compactPoints(accounting.regionLoadedPoints)} of ${compactPoints(accounting.regionSelectedPoints)} tile pts`;
  return `Isolate: ${areaCounts} · Load All ${progress}${sectorLabel}${budgetLabel}`;
}
