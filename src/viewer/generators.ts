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

import { getTemplate } from '../shared/template-catalog';
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

export interface SolidPrimitiveDisplay {
  fill?: { positions: Float64Array; indices: Uint32Array };
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

export function buildObjectDisplay(feature: FeatureRecord): SolidPrimitiveDisplay | null {
  if (feature.family !== 'object') return null;
  const geometry = pointPrimitiveGeometryFromFeature(feature);
  const template = feature.templateId ? getTemplate(feature.templateId) : null;
  if (!geometry || !template) return null;

  const yawDeg = objectNumberParam(feature, 'rotationYaw', 0);
  switch (template.subtype) {
    case 'box':
      return buildBoxPrimitive({
        point: geometry.point,
        width: objectNumberParam(feature, 'width', 6),
        depth: objectNumberParam(feature, 'depth', 6),
        height: objectNumberParam(feature, 'height', 6),
        yawDeg,
        origin: 'center',
      });
    case 'cylinder':
      return buildCylinderPrimitive({
        point: geometry.point,
        radius: objectNumberParam(feature, 'diameter', 4) / 2,
        height: objectNumberParam(feature, 'height', 8),
        yawDeg,
        origin: 'center',
      });
    case 'pine':
      return buildPinePrimitive({
        point: geometry.point,
        height: objectNumberParam(feature, 'height', 18),
        baseRadius: objectNumberParam(feature, 'baseRadius', 5),
        trunkHeight: objectNumberParam(feature, 'trunkHeight', 4),
        yawDeg,
      });
    case 'simple-tree':
      return buildSimpleTreePrimitive({
        point: geometry.point,
        height: objectNumberParam(feature, 'height', 20),
        canopyRadius: objectNumberParam(feature, 'canopyRadius', 7),
        trunkHeight: objectNumberParam(feature, 'trunkHeight', 6),
        yawDeg,
      });
    case 'shrub':
      return buildShrubPrimitive({
        point: geometry.point,
        width: objectNumberParam(feature, 'width', 6),
        depth: objectNumberParam(feature, 'depth', 5),
        height: objectNumberParam(feature, 'height', 3),
        yawDeg,
      });
    case 'sign':
      return buildSignPrimitive({
        point: geometry.point,
        postHeight: objectNumberParam(feature, 'postHeight', 8),
        signWidth: objectNumberParam(feature, 'signWidth', 4),
        signHeight: objectNumberParam(feature, 'signHeight', 2),
        numberOfFaces: objectNumberParam(feature, 'numberOfFaces', 2),
        yawDeg,
      });
    case 'post':
      return buildCylinderPrimitive({
        point: geometry.point,
        radius: objectNumberParam(feature, 'diameter', 0.75) / 2,
        height: objectNumberParam(feature, 'height', 6),
        yawDeg,
        origin: 'base',
      });
    default:
      return null;
  }
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

/**
 * User-drawn isolate/focus boundary stored on an object feature. Context only:
 * it scopes viewer emphasis and future work areas, and is NEVER an evidence
 * source. Lives in feature.metadata so the manifest schema needs no change.
 */
export function isolateBoundaryFromFeature(feature: FeatureRecord): Vec3[] | null {
  const isolate = feature.metadata?.isolateBoundary as { polygon?: unknown } | undefined;
  if (!isolate || !isVec3Array(isolate.polygon) || isolate.polygon.length < 3) return null;
  return isolate.polygon.map(cloneVec3);
}

function objectNumberParam(feature: FeatureRecord, name: string, fallback: number): number {
  const value = feature.parameters?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export interface PrimitiveBuffers {
  positions: number[];
  indices: number[];
  lines: Vec3[][];
}

export type VerticalOrigin = 'center' | 'base' | 'top';

export function createBuffers(): PrimitiveBuffers {
  return { positions: [], indices: [], lines: [] };
}

export function toDisplay(buffers: PrimitiveBuffers): SolidPrimitiveDisplay {
  return {
    ...(buffers.indices.length > 0
      ? {
          fill: {
            positions: Float64Array.from(buffers.positions),
            indices: Uint32Array.from(buffers.indices),
          },
        }
      : {}),
    lines: buffers.lines,
  };
}

export function mergePrimitive(into: PrimitiveBuffers, next: SolidPrimitiveDisplay): void {
  if (next.fill) {
    const base = into.positions.length / 3;
    into.positions.push(...next.fill.positions);
    for (const index of next.fill.indices) into.indices.push(base + index);
  }
  into.lines.push(...next.lines.map((line) => line.map(cloneVec3)));
}

function rotateXY(x: number, y: number, yawRad: number): [number, number] {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  return [x * c - y * s, x * s + y * c];
}

export function worldPoint(anchor: Vec3, localX: number, localY: number, localZ: number, yawRad: number): Vec3 {
  const [rx, ry] = rotateXY(localX, localY, yawRad);
  return [anchor[0] + rx, anchor[1] + ry, anchor[2] + localZ];
}

function pushPoint(positions: number[], point: Vec3): number {
  positions.push(point[0], point[1], point[2]);
  return positions.length / 3 - 1;
}

export function ringLine(points: Vec3[]): Vec3[] {
  return points.length === 0 ? [] : [...points.map(cloneVec3), cloneVec3(points[0]!)];
}

function zRange(anchorZ: number, height: number, origin: VerticalOrigin): { bottom: number; top: number } {
  if (origin === 'center') return { bottom: anchorZ - height / 2, top: anchorZ + height / 2 };
  if (origin === 'top') return { bottom: anchorZ - height, top: anchorZ };
  return { bottom: anchorZ, top: anchorZ + height };
}

export function buildBoxPrimitive(input: {
  point: Vec3;
  width: number;
  depth: number;
  height: number;
  yawDeg: number;
  origin: VerticalOrigin;
}): SolidPrimitiveDisplay {
  const width = Math.max(input.width, 0.1);
  const depth = Math.max(input.depth, 0.1);
  const height = Math.max(input.height, 0.1);
  const yawRad = (input.yawDeg * Math.PI) / 180;
  const z = zRange(input.point[2], height, input.origin);
  const locals: Array<[number, number, number]> = [
    [-width / 2, -depth / 2, z.bottom - input.point[2]],
    [width / 2, -depth / 2, z.bottom - input.point[2]],
    [width / 2, depth / 2, z.bottom - input.point[2]],
    [-width / 2, depth / 2, z.bottom - input.point[2]],
    [-width / 2, -depth / 2, z.top - input.point[2]],
    [width / 2, -depth / 2, z.top - input.point[2]],
    [width / 2, depth / 2, z.top - input.point[2]],
    [-width / 2, depth / 2, z.top - input.point[2]],
  ];
  const points = locals.map(([x, y, localZ]) => worldPoint(input.point, x, y, localZ, yawRad));
  const positions: number[] = [];
  for (const point of points) pushPoint(positions, point);
  const indices = [
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ];
  return {
    fill: { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) },
    lines: [ringLine(points.slice(0, 4)), ringLine(points.slice(4, 8)), [points[0]!, points[4]!], [points[1]!, points[5]!], [points[2]!, points[6]!], [points[3]!, points[7]!]],
  };
}

export function buildCylinderPrimitive(input: {
  point: Vec3;
  radius: number;
  height: number;
  yawDeg: number;
  origin: VerticalOrigin;
  segments?: number;
}): SolidPrimitiveDisplay {
  const radius = Math.max(input.radius, 0.05);
  const height = Math.max(input.height, 0.1);
  const yawRad = (input.yawDeg * Math.PI) / 180;
  const segments = Math.max(input.segments ?? 12, 6);
  const z = zRange(input.point[2], height, input.origin);
  const bottomLocalZ = z.bottom - input.point[2];
  const topLocalZ = z.top - input.point[2];
  const positions: number[] = [];
  const indices: number[] = [];
  const bottom: Vec3[] = [];
  const top: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (Math.PI * 2 * i) / segments;
    bottom.push(worldPoint(input.point, Math.cos(angle) * radius, Math.sin(angle) * radius, bottomLocalZ, yawRad));
    top.push(worldPoint(input.point, Math.cos(angle) * radius, Math.sin(angle) * radius, topLocalZ, yawRad));
  }
  const bottomIds = bottom.map((point) => pushPoint(positions, point));
  const topIds = top.map((point) => pushPoint(positions, point));
  const bottomCenterId = pushPoint(positions, [input.point[0], input.point[1], z.bottom]);
  const topCenterId = pushPoint(positions, [input.point[0], input.point[1], z.top]);
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    indices.push(bottomIds[i]!, bottomIds[next]!, topIds[next]!);
    indices.push(bottomIds[i]!, topIds[next]!, topIds[i]!);
    indices.push(bottomCenterId, bottomIds[next]!, bottomIds[i]!);
    indices.push(topCenterId, topIds[i]!, topIds[next]!);
  }
  return {
    fill: { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) },
    lines: [ringLine(bottom), ringLine(top), [bottom[0]!, top[0]!], [bottom[Math.floor(segments / 4)]!, top[Math.floor(segments / 4)]!]],
  };
}

function buildConePrimitive(input: { point: Vec3; radius: number; height: number; yawDeg: number }): SolidPrimitiveDisplay {
  const radius = Math.max(input.radius, 0.05);
  const height = Math.max(input.height, 0.1);
  const yawRad = (input.yawDeg * Math.PI) / 180;
  const segments = 12;
  const positions: number[] = [];
  const indices: number[] = [];
  const base: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (Math.PI * 2 * i) / segments;
    base.push(worldPoint(input.point, Math.cos(angle) * radius, Math.sin(angle) * radius, 0, yawRad));
  }
  const tip: Vec3 = [input.point[0], input.point[1], input.point[2] + height];
  const baseIds = base.map((point) => pushPoint(positions, point));
  const tipId = pushPoint(positions, tip);
  const centerId = pushPoint(positions, input.point);
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    indices.push(baseIds[i]!, baseIds[next]!, tipId);
    indices.push(centerId, baseIds[next]!, baseIds[i]!);
  }
  return {
    fill: { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) },
    lines: [ringLine(base), [base[0]!, tip], [base[4]!, tip], [base[8]!, tip]],
  };
}

function buildEllipsoidPrimitive(input: { center: Vec3; radiusX: number; radiusY: number; radiusZ: number; yawDeg: number }): SolidPrimitiveDisplay {
  const radiusX = Math.max(input.radiusX, 0.05);
  const radiusY = Math.max(input.radiusY, 0.05);
  const radiusZ = Math.max(input.radiusZ, 0.05);
  const yawRad = (input.yawDeg * Math.PI) / 180;
  const positions: number[] = [];
  const indices: number[] = [];
  const latSegments = 5;
  const lonSegments = 8;
  const vertexIds: number[][] = [];
  for (let lat = 0; lat <= latSegments; lat++) {
    const phi = (Math.PI * lat) / latSegments;
    const row: number[] = [];
    for (let lon = 0; lon <= lonSegments; lon++) {
      const theta = (Math.PI * 2 * lon) / lonSegments;
      const localX = Math.cos(theta) * Math.sin(phi) * radiusX;
      const localY = Math.sin(theta) * Math.sin(phi) * radiusY;
      const localZ = Math.cos(phi) * radiusZ;
      row.push(pushPoint(positions, worldPoint(input.center, localX, localY, localZ, yawRad)));
    }
    vertexIds.push(row);
  }
  for (let lat = 0; lat < latSegments; lat++) {
    for (let lon = 0; lon < lonSegments; lon++) {
      const a = vertexIds[lat]![lon]!;
      const b = vertexIds[lat]![lon + 1]!;
      const c = vertexIds[lat + 1]![lon + 1]!;
      const d = vertexIds[lat + 1]![lon]!;
      indices.push(a, b, c, a, c, d);
    }
  }
  const equator: Vec3[] = [];
  for (let lon = 0; lon < lonSegments; lon++) {
    const theta = (Math.PI * 2 * lon) / lonSegments;
    equator.push(worldPoint(input.center, Math.cos(theta) * radiusX, Math.sin(theta) * radiusY, 0, yawRad));
  }
  return {
    fill: { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) },
    lines: [ringLine(equator)],
  };
}

function buildPinePrimitive(input: { point: Vec3; height: number; baseRadius: number; trunkHeight: number; yawDeg: number }): SolidPrimitiveDisplay {
  const totalHeight = Math.max(input.height, 0.5);
  const trunkHeight = Math.max(Math.min(input.trunkHeight, totalHeight * 0.5), 0.25);
  const buffers = createBuffers();
  mergePrimitive(
    buffers,
    buildCylinderPrimitive({ point: input.point, radius: Math.max(input.baseRadius * 0.12, 0.15), height: trunkHeight, yawDeg: input.yawDeg, origin: 'base', segments: 10 }),
  );
  mergePrimitive(
    buffers,
    buildConePrimitive({ point: [input.point[0], input.point[1], input.point[2] + trunkHeight], radius: Math.max(input.baseRadius, 0.2), height: Math.max(totalHeight - trunkHeight, 0.2), yawDeg: input.yawDeg }),
  );
  return toDisplay(buffers);
}

function buildSimpleTreePrimitive(input: { point: Vec3; height: number; canopyRadius: number; trunkHeight: number; yawDeg: number }): SolidPrimitiveDisplay {
  const totalHeight = Math.max(input.height, 0.5);
  const trunkHeight = Math.max(Math.min(input.trunkHeight, totalHeight * 0.7), 0.3);
  const canopyHeight = Math.max(totalHeight - trunkHeight, 0.2);
  const buffers = createBuffers();
  mergePrimitive(
    buffers,
    buildCylinderPrimitive({ point: input.point, radius: Math.max(input.canopyRadius * 0.12, 0.15), height: trunkHeight, yawDeg: input.yawDeg, origin: 'base', segments: 10 }),
  );
  mergePrimitive(
    buffers,
    buildEllipsoidPrimitive({ center: [input.point[0], input.point[1], input.point[2] + trunkHeight + canopyHeight / 2], radiusX: Math.max(input.canopyRadius, 0.2), radiusY: Math.max(input.canopyRadius, 0.2), radiusZ: canopyHeight / 2, yawDeg: input.yawDeg }),
  );
  return toDisplay(buffers);
}

function buildShrubPrimitive(input: { point: Vec3; width: number; depth: number; height: number; yawDeg: number }): SolidPrimitiveDisplay {
  return buildEllipsoidPrimitive({
    center: [input.point[0], input.point[1], input.point[2] + Math.max(input.height, 0.1) / 2],
    radiusX: Math.max(input.width, 0.1) / 2,
    radiusY: Math.max(input.depth, 0.1) / 2,
    radiusZ: Math.max(input.height, 0.1) / 2,
    yawDeg: input.yawDeg,
  });
}

function buildSignPrimitive(input: {
  point: Vec3;
  postHeight: number;
  signWidth: number;
  signHeight: number;
  numberOfFaces: number;
  yawDeg: number;
}): SolidPrimitiveDisplay {
  const buffers = createBuffers();
  const postHeight = Math.max(input.postHeight, 0.2);
  const signHeight = Math.max(input.signHeight, 0.2);
  mergePrimitive(
    buffers,
    buildCylinderPrimitive({ point: input.point, radius: Math.max(input.signWidth * 0.04, 0.08), height: postHeight, yawDeg: input.yawDeg, origin: 'base', segments: 10 }),
  );
  mergePrimitive(
    buffers,
    buildSignFacesPrimitive({
      point: input.point,
      postHeight,
      signWidth: input.signWidth,
      signHeight,
      numberOfFaces: input.numberOfFaces,
      yawDeg: input.yawDeg,
    }),
  );
  return toDisplay(buffers);
}

function buildSignFacesPrimitive(input: {
  point: Vec3;
  postHeight: number;
  signWidth: number;
  signHeight: number;
  numberOfFaces: number;
  yawDeg: number;
}): SolidPrimitiveDisplay {
  const buffers = createBuffers();
  const faceCount = Math.max(1, Math.min(4, Math.round(input.numberOfFaces)));
  const mountCenterZ = input.point[2] + Math.max(input.postHeight - input.signHeight / 2, input.signHeight / 2);
  const depth = Math.max(input.signWidth * 0.08, 0.08);
  for (let index = 0; index < faceCount; index++) {
    const yawDeg = input.yawDeg + (360 / faceCount) * index;
    mergePrimitive(
      buffers,
      buildBoxPrimitive({
        point: [input.point[0], input.point[1], mountCenterZ],
        width: Math.max(input.signWidth, 0.2),
        depth,
        height: input.signHeight,
        yawDeg,
        origin: 'center',
      }),
    );
  }
  return toDisplay(buffers);
}
