// src/viewer/buildingGenerators.ts - pure geometry for beta BUILDINGS
// (envelope first, then evidence-fitted faces). Same contract as the other
// generator modules: no Three.js, Node-testable, display geometry regenerated
// from stored primitives on every load and never persisted.
//
// Three jobs live here:
//   1. Readers - envelope polygon and the metadata.building component records
//      (tolerant: malformed entries are skipped, absence reads as empty).
//   2. Plane fitting - deterministic best-fit plane (Jacobi eigen of the
//      evidence covariance) that turns explicitly selected evidence points
//      into an inspectable face record: plane frame + extents + dims + fit
//      quality. Fitting NEVER mutates the feature - the controller persists a
//      component only when the user accepts the preview.
//   3. Display - envelope outline, face quads, and face-hosted feature
//      primitives (door/window rects, vertical chimney boxes, vent markers).

import {
  faceKindLabel,
  type BuildingComponentsRecord,
  type BuildingFaceFeatureRecord,
  type BuildingFaceKind,
  type BuildingFaceRecord,
  type BuildingPlaneRecord,
} from '../shared/building-catalog';
import type { FeatureRecord } from '../shared/workbench-types';
import type { Vec3 } from './geometry';
import { isolateBoundaryFromFeature, type SolidPrimitiveDisplay } from './generators';

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every((axis) => typeof axis === 'number' && Number.isFinite(axis));
}

function isVec3Array(value: unknown): value is Vec3[] {
  return Array.isArray(value) && value.every(isVec3);
}

function cloneVec3(v: Vec3): Vec3 {
  return [v[0], v[1], v[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v: Vec3): Vec3 {
  const len = norm(v);
  return len > 0 ? scale(v, 1 / len) : [1, 0, 0];
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** True for the beta envelope-first building (legacy massing subtypes stay on their own path). */
export function isEnvelopeBuilding(feature: FeatureRecord): boolean {
  return feature.family === 'building' && feature.subtype === 'envelope';
}

/** The drawn envelope polygon (stored as geometry.footprint like every building). */
export function buildingEnvelopeFromFeature(feature: FeatureRecord): Vec3[] | null {
  if (feature.family !== 'building') return null;
  const geometry = feature.geometry as { footprint?: unknown };
  if (!isVec3Array(geometry.footprint) || geometry.footprint.length < 3) return null;
  return geometry.footprint.map(cloneVec3);
}

/**
 * The effective isolate/focus boundary of a feature. For envelope buildings
 * isolation is NOT optional: a user-drawn boundary (metadata.isolateBoundary)
 * is only an override, and in its absence the envelope itself is the
 * boundary. Every other family keeps the plain optional isolate area.
 */
export function focusBoundaryFromFeature(feature: FeatureRecord): Vec3[] | null {
  const override = isolateBoundaryFromFeature(feature);
  if (override) return override;
  return isEnvelopeBuilding(feature) ? buildingEnvelopeFromFeature(feature) : null;
}

const FACE_KINDS: BuildingFaceKind[] = ['wall', 'roof', 'floor', 'soffit', 'generic'];
const FEATURE_TYPES = ['door', 'window', 'chimney', 'vent', 'opening', 'generic'];

function isPlaneRecord(value: unknown): value is BuildingPlaneRecord {
  const plane = value as BuildingPlaneRecord | undefined;
  return (
    plane !== undefined &&
    isVec3(plane.origin) &&
    isVec3(plane.normal) &&
    isVec3(plane.xAxis) &&
    isVec3(plane.yAxis)
  );
}

function isFaceRecord(value: unknown): value is BuildingFaceRecord {
  const face = value as BuildingFaceRecord | undefined;
  return (
    face !== undefined &&
    typeof face.id === 'string' &&
    typeof face.name === 'string' &&
    FACE_KINDS.includes(face.kind) &&
    isPlaneRecord(face.plane) &&
    face.extents !== undefined &&
    typeof face.extents.minU === 'number' &&
    typeof face.extents.maxU === 'number' &&
    typeof face.extents.minV === 'number' &&
    typeof face.extents.maxV === 'number'
  );
}

function isFaceFeatureRecord(value: unknown): value is BuildingFaceFeatureRecord {
  const item = value as BuildingFaceFeatureRecord | undefined;
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    typeof item.faceId === 'string' &&
    FEATURE_TYPES.includes(item.type) &&
    typeof item.offsetU === 'number' &&
    typeof item.offsetV === 'number' &&
    typeof item.width === 'number' &&
    typeof item.height === 'number' &&
    typeof item.depth === 'number'
  );
}

/**
 * Validated read of the building's component records. Hosted features whose
 * face no longer exists are dropped here so the display and the panel never
 * show an orphan.
 */
export function buildingComponentsFromFeature(feature: FeatureRecord): BuildingComponentsRecord {
  const raw = feature.metadata?.building as { faces?: unknown; faceFeatures?: unknown } | undefined;
  const faces = Array.isArray(raw?.faces) ? raw.faces.filter(isFaceRecord) : [];
  const faceIds = new Set(faces.map((face) => face.id));
  const faceFeatures = Array.isArray(raw?.faceFeatures)
    ? raw.faceFeatures.filter(isFaceFeatureRecord).filter((item) => faceIds.has(item.faceId))
    : [];
  return { faces, faceFeatures };
}

// ---------------------------------------------------------------------------
// Plane fitting (deterministic beta)
// ---------------------------------------------------------------------------

type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];

/**
 * Cyclic Jacobi eigen-decomposition for a symmetric 3x3 matrix. Deterministic
 * and plenty for a covariance this small; returns eigen pairs sorted by
 * ascending eigenvalue.
 */
function jacobiEigen3(input: Mat3): { values: [number, number, number]; vectors: [Vec3, Vec3, Vec3] } {
  const a: Mat3 = [[...input[0]], [...input[1]], [...input[2]]] as Mat3;
  let v: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      const rotate = (m: Mat3): Mat3 => {
        const out: Mat3 = [[...m[0]], [...m[1]], [...m[2]]] as Mat3;
        for (let k = 0; k < 3; k++) {
          const mkp = m[k][p];
          const mkq = m[k][q];
          out[k][p] = c * mkp - s * mkq;
          out[k][q] = s * mkp + c * mkq;
        }
        return out;
      };
      // a' = R^T a R (apply column rotation, then the symmetric row rotation).
      const ar = rotate(a);
      for (let k = 0; k < 3; k++) {
        const apk = ar[p][k];
        const aqk = ar[q][k];
        ar[p][k] = c * apk - s * aqk;
        ar[q][k] = s * apk + c * aqk;
      }
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i][j] = ar[i][j];
      v = rotate(v);
    }
  }
  const pairs = [0, 1, 2]
    .map((i) => ({ value: a[i][i], vector: [v[0][i], v[1][i], v[2][i]] as Vec3 }))
    .sort((left, right) => left.value - right.value);
  return {
    values: [pairs[0]!.value, pairs[1]!.value, pairs[2]!.value],
    vectors: [pairs[0]!.vector, pairs[1]!.vector, pairs[2]!.vector],
  };
}

export interface FittedPlane {
  /** Evidence centroid. */
  origin: Vec3;
  /** Unit normal, deterministically oriented (z up; horizontal normals x/y positive). */
  normal: Vec3;
  /** RMS point-to-plane distance of the input points. */
  rms: number;
  pointCount: number;
}

/**
 * Best-fit plane through 3+ points (least squares via the covariance's
 * smallest eigenvector). Null for degenerate input: fewer than 3 points,
 * coincident points, or a collinear set (no unique plane).
 */
export function fitPlaneToPoints(points: Vec3[]): FittedPlane | null {
  if (points.length < 3) return null;
  const centroid: Vec3 = [0, 0, 0];
  for (const point of points) {
    centroid[0] += point[0];
    centroid[1] += point[1];
    centroid[2] += point[2];
  }
  centroid[0] /= points.length;
  centroid[1] /= points.length;
  centroid[2] /= points.length;

  const c: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const point of points) {
    const d = sub(point, centroid);
    c[0][0] += d[0] * d[0];
    c[0][1] += d[0] * d[1];
    c[0][2] += d[0] * d[2];
    c[1][1] += d[1] * d[1];
    c[1][2] += d[1] * d[2];
    c[2][2] += d[2] * d[2];
  }
  c[1][0] = c[0][1];
  c[2][0] = c[0][2];
  c[2][1] = c[1][2];

  const eigen = jacobiEigen3(c);
  const [smallest, middle, largest] = eigen.values;
  // Coincident points: no spread at all. Collinear: only one spread direction.
  if (largest <= 1e-12) return null;
  if (middle / largest < 1e-6) return null;

  let normal = normalize(eigen.vectors[0]);
  // Deterministic orientation: up-facing; vertical planes face +x, then +y.
  if (normal[2] < -1e-9) normal = scale(normal, -1);
  else if (Math.abs(normal[2]) <= 1e-9) {
    if (normal[0] < -1e-9) normal = scale(normal, -1);
    else if (Math.abs(normal[0]) <= 1e-9 && normal[1] < 0) normal = scale(normal, -1);
  }

  let sumSq = 0;
  for (const point of points) {
    const d = dot(sub(point, centroid), normal);
    sumSq += d * d;
  }
  void smallest;
  return { origin: centroid, normal, rms: Math.sqrt(sumSq / points.length), pointCount: points.length };
}

export interface RoofSlopeInfo {
  /** Degrees off horizontal (0 = flat). */
  slopeDeg: number;
  /** Downhill compass azimuth in degrees from north; null when effectively flat. */
  aspectDeg: number | null;
  aspectLabel: string | null;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function roofSlopeInfo(normal: Vec3): RoofSlopeInfo {
  const nz = Math.min(Math.abs(normal[2]), 1);
  const slopeDeg = (Math.acos(nz) * 180) / Math.PI;
  if (slopeDeg < 0.5) return { slopeDeg, aspectDeg: null, aspectLabel: null };
  // Downhill direction of the plane z(x,y) is the horizontal (nx, ny).
  const aspectDeg = ((Math.atan2(normal[0], normal[1]) * 180) / Math.PI + 360) % 360;
  const label = COMPASS[Math.round(aspectDeg / 45) % 8]!;
  return { slopeDeg, aspectDeg, aspectLabel: label };
}

/** Deterministic bounded sample: evenly spaced picks in stored order. */
export function representativeEvidence(points: Vec3[], max = 8): Vec3[] {
  if (points.length <= max) return points.map(cloneVec3);
  const out: Vec3[] = [];
  for (let i = 0; i < max; i++) {
    out.push(cloneVec3(points[Math.floor((i * (points.length - 1)) / (max - 1))]!));
  }
  return out;
}

export interface FittedFace {
  plane: BuildingPlaneRecord;
  extents: { minU: number; maxU: number; minV: number; maxV: number };
  /** Extent along xAxis (horizontal / along-strike). */
  length: number;
  /** Extent along yAxis (vertical on walls, up-slope on roof planes). */
  height: number;
  /** Fitted-rectangle area (the honest beta area). */
  area: number;
  fitRms: number;
  pointCount: number;
  slope: RoofSlopeInfo;
  /** What the plane orientation suggests the face is (hint only, user picks). */
  suggestedKind: 'wall' | 'roof';
}

/**
 * Fits a face frame to selected evidence points: best-fit plane, an
 * orthonormal in-plane frame (xAxis horizontal, yAxis up/up-slope), and the
 * evidence extents in that frame. Pure - the caller decides whether the
 * result ever becomes a component.
 */
export function fitFaceFromEvidence(points: Vec3[]): FittedFace | null {
  const fit = fitPlaneToPoints(points);
  if (!fit) return null;
  const { normal, origin } = fit;
  // Horizontal in-plane axis; degenerate only for a flat (horizontal) plane.
  const strike = cross([0, 0, 1], normal);
  const xAxis = norm(strike) > 1e-6 ? normalize(strike) : ([1, 0, 0] as Vec3);
  const yAxis = normalize(cross(normal, xAxis));

  let minU = Number.POSITIVE_INFINITY;
  let maxU = Number.NEGATIVE_INFINITY;
  let minV = Number.POSITIVE_INFINITY;
  let maxV = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const d = sub(point, origin);
    const u = dot(d, xAxis);
    const v = dot(d, yAxis);
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const length = maxU - minU;
  const height = maxV - minV;
  const slope = roofSlopeInfo(normal);
  return {
    plane: { origin: cloneVec3(origin), normal: cloneVec3(normal), xAxis, yAxis },
    extents: { minU, maxU, minV, maxV },
    length,
    height,
    area: length * height,
    fitRms: fit.rms,
    pointCount: fit.pointCount,
    slope,
    suggestedKind: Math.abs(normal[2]) < 0.5 ? 'wall' : 'roof',
  };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** World-space quad corners of a face: (minU,minV) (maxU,minV) (maxU,maxV) (minU,maxV). */
export function faceCorners(plane: BuildingPlaneRecord, extents: BuildingFaceRecord['extents']): [Vec3, Vec3, Vec3, Vec3] {
  const at = (u: number, v: number): Vec3 => add(plane.origin, add(scale(plane.xAxis, u), scale(plane.yAxis, v)));
  return [
    at(extents.minU, extents.minV),
    at(extents.maxU, extents.minV),
    at(extents.maxU, extents.maxV),
    at(extents.minU, extents.maxV),
  ];
}

function quadDisplay(corners: [Vec3, Vec3, Vec3, Vec3]): SolidPrimitiveDisplay {
  const positions: number[] = [];
  for (const corner of corners) positions.push(corner[0], corner[1], corner[2]);
  return {
    fill: { positions: Float64Array.from(positions), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) },
    lines: [[...corners.map(cloneVec3), cloneVec3(corners[0])]],
  };
}

/** Face quad + outline from the stored plane/extents. */
export function buildFaceDisplay(face: BuildingFaceRecord): SolidPrimitiveDisplay {
  return quadDisplay(faceCorners(face.plane, face.extents));
}

/** Outline + corner diagonals for the pending fit preview (draft lines). */
export function faceFitPreviewLines(fitted: FittedFace): Vec3[][] {
  const corners = faceCorners(fitted.plane, fitted.extents);
  return [
    [...corners.map(cloneVec3), cloneVec3(corners[0])],
    [cloneVec3(corners[0]), cloneVec3(corners[2])],
    [cloneVec3(corners[1]), cloneVec3(corners[3])],
  ];
}

/** Small out-of-plane lift so hosted features never z-fight their face. */
const FACE_FEATURE_LIFT = 0.08;

/**
 * Display for one hosted feature in its face's local frame. Doors, windows
 * and openings are rectangles on the face; chimneys are vertical boxes rising
 * `depth` above the face plane; vents and generic features are thin boxes
 * extruded along the face normal.
 */
export function buildFaceFeatureDisplay(face: BuildingFaceRecord, item: BuildingFaceFeatureRecord): SolidPrimitiveDisplay {
  const plane = face.plane;
  const baseU = face.extents.minU + item.offsetU;
  const baseV = face.extents.minV + item.offsetV;
  const lift = scale(plane.normal, FACE_FEATURE_LIFT);
  const at = (u: number, v: number): Vec3 => add(add(plane.origin, add(scale(plane.xAxis, u), scale(plane.yAxis, v))), lift);
  const corners: [Vec3, Vec3, Vec3, Vec3] = [
    at(baseU, baseV),
    at(baseU + item.width, baseV),
    at(baseU + item.width, baseV + item.height),
    at(baseU, baseV + item.height),
  ];
  if (item.type === 'door' || item.type === 'window' || item.type === 'opening') {
    const display = quadDisplay(corners);
    if (item.type === 'window') {
      // Mullion cross so windows read differently from doors at a glance.
      const mid = (a: Vec3, b: Vec3): Vec3 => scale(add(a, b), 0.5);
      display.lines.push([mid(corners[0], corners[3]), mid(corners[1], corners[2])]);
      display.lines.push([mid(corners[0], corners[1]), mid(corners[3], corners[2])]);
    }
    return display;
  }
  const rise: Vec3 = item.type === 'chimney' ? [0, 0, Math.max(item.depth, 0.1)] : scale(plane.normal, Math.max(item.depth, 0.1));
  const top = corners.map((corner) => add(corner, rise)) as [Vec3, Vec3, Vec3, Vec3];
  const positions: number[] = [];
  for (const corner of [...corners, ...top]) positions.push(corner[0], corner[1], corner[2]);
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
    lines: [
      [...corners.map(cloneVec3), cloneVec3(corners[0])],
      [...top.map(cloneVec3), cloneVec3(top[0])],
      [corners[0], top[0]],
      [corners[1], top[1]],
      [corners[2], top[2]],
      [corners[3], top[3]],
    ],
  };
}

export interface BuildingDisplayEntryParts {
  fill?: { positions: Float64Array; indices: Uint32Array };
  lines: Vec3[][];
  fillColor: number;
  lineColor: number;
}

const ENVELOPE_LINE_COLOR = 0x546e7a;

function faceColors(kind: BuildingFaceKind): { fill: number; line: number } {
  if (kind === 'roof') return { fill: 0xa1887f, line: 0x4e342e };
  if (kind === 'wall') return { fill: 0x90a4ae, line: 0x37474f };
  return { fill: 0xb0bec5, line: 0x546e7a };
}

const FEATURE_COLORS: Record<string, { fill: number; line: number }> = {
  door: { fill: 0x7fb3d5, line: 0x1f5673 },
  window: { fill: 0xaed6f1, line: 0x1f5673 },
  opening: { fill: 0x7fb3d5, line: 0x1f5673 },
  chimney: { fill: 0xc9847a, line: 0x6e3b34 },
  vent: { fill: 0xd7bde2, line: 0x5b2c6f },
  generic: { fill: 0xd5dbdb, line: 0x566573 },
};

/**
 * Full display for one envelope building: the envelope outline entry, one
 * entry per visible face (kind-tinted), and one entry per visible hosted
 * feature (skipped when the host face is hidden). Multiple entries share the
 * featureId - the renderer treats each independently.
 */
export function buildBuildingComponentDisplayEntries(feature: FeatureRecord): BuildingDisplayEntryParts[] {
  const envelope = buildingEnvelopeFromFeature(feature);
  if (!envelope) return [];
  const entries: BuildingDisplayEntryParts[] = [
    {
      lines: [[...envelope.map(cloneVec3), cloneVec3(envelope[0]!)]],
      fillColor: ENVELOPE_LINE_COLOR,
      lineColor: ENVELOPE_LINE_COLOR,
    },
  ];
  const components = buildingComponentsFromFeature(feature);
  const visibleFaces = new Map<string, BuildingFaceRecord>();
  for (const face of components.faces) {
    if (face.visible === false) continue;
    visibleFaces.set(face.id, face);
    const color = faceColors(face.kind);
    entries.push({ ...buildFaceDisplay(face), fillColor: color.fill, lineColor: color.line });
  }
  for (const item of components.faceFeatures) {
    if (item.visible === false) continue;
    const host = visibleFaces.get(item.faceId);
    if (!host) continue;
    const color = FEATURE_COLORS[item.type] ?? FEATURE_COLORS.generic!;
    entries.push({ ...buildFaceFeatureDisplay(host, item), fillColor: color.fill, lineColor: color.line });
  }
  return entries;
}

/** `Wall 3` / `Roof plane 2` style default component names. */
export function nextFaceName(components: BuildingComponentsRecord, kind: BuildingFaceKind): string {
  const count = components.faces.filter((face) => face.kind === kind).length;
  return `${faceKindLabel(kind)} ${count + 1}`;
}
