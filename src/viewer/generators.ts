// src/viewer/generators.ts - pure parametric feature generators for Create
// Sim. Display geometry ONLY: outputs are regenerated from stored feature
// primitives + params on every load and are never persisted. No Three.js
// imports; Node-testable like geometry.ts / editing.ts.
//
// The region patch is the surface-patch input of the future ground compiler:
// it already accepts its breaklines and spot-elevation constraints, but v1
// deliberately builds NO TIN/stitch engine - the patch is the border ring
// triangulated at its authored elevations, with breaklines carried through as
// draped display polylines and spot elevations accepted-but-inert.

import type { FeatureRecord } from '../shared/workbench-types';
import type { Vec3 } from './geometry';

export interface RegionPatchInput {
  /** Ordered border ring in survey coordinates; last vertex NOT repeated. */
  border: Vec3[];
  /** Open borders produce outline-only display (no fill, no area). */
  closed: boolean;
  breaklines?: Vec3[][];
  /**
   * Spot-elevation constraints the future ground compiler must honor. v1
   * accepts them (signature stability) but does not deform the patch.
   */
  spotElevations?: Vec3[];
}

export interface RegionPatchDisplay {
  /** Triangulated patch vertices, x,y,z interleaved, survey coordinates. */
  positions: Float64Array;
  /** Triangle indices into positions; empty for open or degenerate borders. */
  indices: Uint32Array;
  /** Border loop for line rendering (closed rings repeat the first vertex). */
  outline: Vec3[];
  /** Breakline polylines carried through for line rendering. */
  breaklines: Vec3[][];
  /** Plan-view (XY) area; the report-quantity placeholder. 0 when open. */
  areaXY: number;
}

/** Shoelace signed area in the XY plane (positive = counter-clockwise). */
export function signedAreaXY(ring: Vec3[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[(i + 1) % ring.length]!;
    sum += ax * by - bx * ay;
  }
  return sum / 2;
}

function triangleAreaXY(a: Vec3, b: Vec3, c: Vec3): number {
  return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

function pointInTriangleXY(p: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  const d1 = triangleAreaXY(a, b, p);
  const d2 = triangleAreaXY(b, c, p);
  const d3 = triangleAreaXY(c, a, p);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation over the XY projection of a simple polygon.
 * Handles concave rings; on pathological input (self-intersection) it falls
 * back to a fan so the display still shows something rather than throwing at
 * the user mid-authoring. Returns indices into the input ring.
 */
function earClipXY(ring: Vec3[]): Uint32Array {
  const n = ring.length;
  if (n < 3) return new Uint32Array(0);

  // Work on a counter-clockwise copy; map indices back at the end.
  const ccw = signedAreaXY(ring) >= 0;
  const order = ccw ? ring.map((_, i) => i) : ring.map((_, i) => n - 1 - i);
  const remaining = [...order.keys()];
  const triangles: number[] = [];

  let guard = 0;
  while (remaining.length > 3 && guard < n * n) {
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      guard++;
      const prev = remaining[(i - 1 + remaining.length) % remaining.length]!;
      const curr = remaining[i]!;
      const next = remaining[(i + 1) % remaining.length]!;
      const a = ring[order[prev]!]!;
      const b = ring[order[curr]!]!;
      const c = ring[order[next]!]!;
      if (triangleAreaXY(a, b, c) <= 0) continue; // reflex or degenerate corner
      let contains = false;
      for (const other of remaining) {
        if (other === prev || other === curr || other === next) continue;
        if (pointInTriangleXY(ring[order[other]!]!, a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      triangles.push(order[prev]!, order[curr]!, order[next]!);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Pathological ring: fan fallback over the original ordering.
      const fan: number[] = [];
      for (let i = 1; i < n - 1; i++) fan.push(0, i, i + 1);
      return Uint32Array.from(fan);
    }
  }
  if (remaining.length === 3) {
    triangles.push(order[remaining[0]!]!, order[remaining[1]!]!, order[remaining[2]!]!);
  }
  return Uint32Array.from(triangles);
}

export function buildRegionPatch(input: RegionPatchInput): RegionPatchDisplay {
  const border = input.border;
  const breaklines = (input.breaklines ?? []).map((line) => line.map((v): Vec3 => [v[0], v[1], v[2]]));
  const outline: Vec3[] = border.map((v): Vec3 => [v[0], v[1], v[2]]);
  if (input.closed && border.length >= 3) outline.push([border[0]![0], border[0]![1], border[0]![2]]);

  if (!input.closed || border.length < 3) {
    return {
      positions: new Float64Array(0),
      indices: new Uint32Array(0),
      outline,
      breaklines,
      areaXY: 0,
    };
  }

  const positions = new Float64Array(border.length * 3);
  for (let i = 0; i < border.length; i++) {
    positions[i * 3] = border[i]![0];
    positions[i * 3 + 1] = border[i]![1];
    positions[i * 3 + 2] = border[i]![2];
  }

  return {
    positions,
    indices: earClipXY(border),
    outline,
    breaklines,
    areaXY: Math.abs(signedAreaXY(border)),
  };
}

/** The persisted region geometry primitives (FeatureRecord.geometry payload). */
export interface RegionGeometry {
  border: Vec3[];
  closed: boolean;
  breaklines: Vec3[][];
}

function isVec3Array(value: unknown): value is Vec3[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => Array.isArray(entry) && entry.length === 3 && entry.every((axis) => typeof axis === 'number'),
    )
  );
}

/**
 * Reads the stored primitives off a region feature record; null when the
 * record does not carry a valid region geometry payload. Shared by the UI
 * display path and the round-trip tests so regeneration has ONE reader.
 */
export function regionGeometryFromFeature(feature: FeatureRecord): RegionGeometry | null {
  if (feature.family !== 'region') return null;
  const geometry = feature.geometry as { border?: unknown; closed?: unknown; breaklines?: unknown };
  if (!isVec3Array(geometry.border)) return null;
  const breaklinesRaw = geometry.breaklines;
  const breaklines: Vec3[][] = [];
  if (Array.isArray(breaklinesRaw)) {
    for (const line of breaklinesRaw) {
      if (isVec3Array(line)) breaklines.push(line);
    }
  }
  return {
    border: geometry.border,
    closed: geometry.closed === true,
    breaklines,
  };
}

export type BuildingRoofType = 'flat' | 'gable' | 'hip';

export interface BuildingInput {
  /** Ordered footprint ring in survey coordinates; last vertex NOT repeated. */
  footprint: Vec3[];
  height: number;
  roofType: BuildingRoofType;
  roofPitchDeg?: number;
  overhang?: number;
  /** Optional v1 ridge override; otherwise inferred from the footprint bbox. */
  ridge?: Vec3[];
}

export interface BuildingCadLineSet {
  footprint: Vec3[];
  face: Vec3[];
  overhang: Vec3[];
  roof: Vec3[];
  ridge: Vec3[];
  hip: Vec3[];
}

export interface BuildingDisplay {
  /** Mass + roof display mesh, x,y,z interleaved, survey coordinates. */
  positions: Float64Array;
  indices: Uint32Array;
  /** Display/CAD line sets. Values are references only; no DWG export in v1. */
  lines: BuildingCadLineSet;
}

export interface BuildingGeometry {
  footprint: Vec3[];
  roofType: BuildingRoofType;
  ridge?: Vec3[];
}

function cloneVec3(v: Vec3): Vec3 {
  return [v[0], v[1], v[2]];
}

function closedLine(points: Vec3[]): Vec3[] {
  if (points.length === 0) return [];
  return [...points.map(cloneVec3), cloneVec3(points[0]!)];
}

function centroidXY(points: Vec3[]): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point[0];
    y += point[1];
  }
  return { x: x / points.length, y: y / points.length };
}

function bboxXY(points: Vec3[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function offsetFromCentroid(points: Vec3[], distance: number): Vec3[] {
  if (distance <= 0) return points.map(cloneVec3);
  const center = centroidXY(points);
  return points.map((point) => {
    const dx = point[0] - center.x;
    const dy = point[1] - center.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) return cloneVec3(point);
    return [point[0] + (dx / length) * distance, point[1] + (dy / length) * distance, point[2]];
  });
}

function pushPositions(target: number[], points: Vec3[]): number[] {
  const base: number[] = [];
  for (const point of points) {
    base.push(target.length / 3);
    target.push(point[0], point[1], point[2]);
  }
  return base;
}

function addPolygonFan(indices: number[], vertexIds: number[]): void {
  for (let i = 1; i < vertexIds.length - 1; i++) {
    indices.push(vertexIds[0]!, vertexIds[i]!, vertexIds[i + 1]!);
  }
}

function inferredRidge(footprint: Vec3[], eaveZ: number, roofPitchDeg: number, roofType: BuildingRoofType): Vec3[] {
  const box = bboxXY(footprint);
  const width = box.maxX - box.minX;
  const depth = box.maxY - box.minY;
  const alongX = width >= depth;
  const shortSpan = Math.max(alongX ? depth : width, 0);
  const rise = roofType === 'flat' ? 0 : (shortSpan / 2) * Math.tan((roofPitchDeg * Math.PI) / 180);
  const ridgeZ = eaveZ + Math.max(rise, 0);
  const midX = (box.minX + box.maxX) / 2;
  const midY = (box.minY + box.maxY) / 2;
  if (roofType === 'hip') {
    const inset = Math.min(width, depth) / 4;
    return alongX
      ? [
          [box.minX + inset, midY, ridgeZ],
          [box.maxX - inset, midY, ridgeZ],
        ]
      : [
          [midX, box.minY + inset, ridgeZ],
          [midX, box.maxY - inset, ridgeZ],
        ];
  }
  return alongX
    ? [
        [box.minX, midY, ridgeZ],
        [box.maxX, midY, ridgeZ],
      ]
    : [
        [midX, box.minY, ridgeZ],
        [midX, box.maxY, ridgeZ],
      ];
}

function nearestVertexIndex(points: Vec3[], target: Vec3): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const dist = Math.hypot(point[0] - target[0], point[1] - target[1]);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

export function buildBuildingDisplay(input: BuildingInput): BuildingDisplay {
  const footprint = input.footprint.map(cloneVec3);
  if (footprint.length < 3) {
    return {
      positions: new Float64Array(0),
      indices: new Uint32Array(0),
      lines: { footprint: closedLine(footprint), face: [], overhang: [], roof: [], ridge: [], hip: [] },
    };
  }

  const height = Math.max(input.height, 0);
  const eaves = footprint.map((point): Vec3 => [point[0], point[1], point[2] + height]);
  const positions: number[] = [];
  const indices: number[] = [];
  const baseIds = pushPositions(positions, footprint);
  const eaveIds = pushPositions(positions, eaves);

  for (let i = 0; i < footprint.length; i++) {
    const next = (i + 1) % footprint.length;
    indices.push(baseIds[i]!, baseIds[next]!, eaveIds[next]!);
    indices.push(baseIds[i]!, eaveIds[next]!, eaveIds[i]!);
  }

  const avgEaveZ = eaves.reduce((sum, point) => sum + point[2], 0) / eaves.length;
  const roofPitchDeg = input.roofPitchDeg ?? 30;
  const ridge =
    input.ridge && input.ridge.length >= 2
      ? input.ridge.slice(0, 2).map(cloneVec3)
      : inferredRidge(footprint, avgEaveZ, roofPitchDeg, input.roofType);

  const roofIds = pushPositions(positions, eaves);
  if (input.roofType === 'flat') {
    addPolygonFan(indices, roofIds);
  } else {
    const ridgeIds = pushPositions(positions, ridge);
    for (let i = 0; i < eaves.length; i++) {
      const next = (i + 1) % eaves.length;
      const edgeMid: Vec3 = [
        (eaves[i]![0] + eaves[next]![0]) / 2,
        (eaves[i]![1] + eaves[next]![1]) / 2,
        (eaves[i]![2] + eaves[next]![2]) / 2,
      ];
      const ridgeEnd = nearestVertexIndex(ridge, edgeMid);
      const otherRidgeEnd = ridgeEnd === 0 ? 1 : 0;
      if (input.roofType === 'hip' && (i === nearestVertexIndex(eaves, ridge[0]!) || i === nearestVertexIndex(eaves, ridge[1]!))) {
        indices.push(roofIds[i]!, roofIds[next]!, ridgeIds[ridgeEnd]!);
      } else {
        indices.push(roofIds[i]!, roofIds[next]!, ridgeIds[otherRidgeEnd]!);
        indices.push(roofIds[i]!, ridgeIds[otherRidgeEnd]!, ridgeIds[ridgeEnd]!);
      }
    }
  }

  const overhang = offsetFromCentroid(eaves, input.overhang ?? 0);
  const hip: Vec3[] =
    input.roofType === 'hip'
      ? eaves.flatMap((point) => [point, ridge[nearestVertexIndex(ridge, point)]!])
      : [];

  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    lines: {
      footprint: closedLine(footprint),
      face: eaves.flatMap((point, index) => [footprint[index]!, point]),
      overhang: closedLine(overhang),
      roof: closedLine(eaves),
      ridge: input.roofType === 'flat' ? [] : ridge.map(cloneVec3),
      hip,
    },
  };
}

export function buildingGeometryFromFeature(feature: FeatureRecord): BuildingGeometry | null {
  if (feature.family !== 'building') return null;
  const geometry = feature.geometry as { footprint?: unknown; roofType?: unknown; ridge?: unknown };
  if (!isVec3Array(geometry.footprint)) return null;
  const roofType = geometry.roofType;
  if (roofType !== 'flat' && roofType !== 'gable' && roofType !== 'hip') return null;
  return {
    footprint: geometry.footprint,
    roofType,
    ...(isVec3Array(geometry.ridge) && geometry.ridge.length >= 2 ? { ridge: geometry.ridge.slice(0, 2) } : {}),
  };
}

export interface PointPrimitiveInput {
  point: Vec3;
  size?: number;
  height?: number;
}

export interface PointPrimitiveDisplay {
  lines: Vec3[][];
}

export interface PointPrimitiveGeometry {
  point: Vec3;
}

export interface LineGeometry {
  vertices: Vec3[];
}

export interface LineDisplay {
  lines: Vec3[][];
  lengthXY: number;
}

export function buildPointPrimitiveDisplay(input: PointPrimitiveInput): PointPrimitiveDisplay {
  const [x, y, z] = input.point;
  const size = Math.max(input.size ?? 2, 0.1);
  const height = Math.max(input.height ?? size, 0);
  const half = size / 2;
  return {
    lines: [
      [
        [x - half, y, z],
        [x + half, y, z],
      ],
      [
        [x, y - half, z],
        [x, y + half, z],
      ],
      [
        [x, y, z],
        [x, y, z + height],
      ],
    ],
  };
}

export function buildLineDisplay(input: LineGeometry): LineDisplay {
  let lengthXY = 0;
  for (let i = 1; i < input.vertices.length; i++) {
    const a = input.vertices[i - 1]!;
    const b = input.vertices[i]!;
    lengthXY += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return { lines: [input.vertices.map(cloneVec3)], lengthXY };
}

export function pointPrimitiveGeometryFromFeature(feature: FeatureRecord): PointPrimitiveGeometry | null {
  if (feature.family !== 'object' && feature.family !== 'marker') return null;
  const geometry = feature.geometry as { point?: unknown };
  if (!isVec3Array([geometry.point])) return null;
  return { point: cloneVec3(geometry.point as Vec3) };
}

export function lineGeometryFromFeature(feature: FeatureRecord): LineGeometry | null {
  if (feature.family !== 'line') return null;
  const geometry = feature.geometry as { vertices?: unknown };
  if (!isVec3Array(geometry.vertices)) return null;
  return { vertices: geometry.vertices.map(cloneVec3) };
}
