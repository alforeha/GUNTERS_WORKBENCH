// src/viewer/utilityGenerators.ts - pure parametric display generators for
// utility features (beta Generic + Storm). Same contract as generators.ts:
// display geometry ONLY, regenerated from stored primitives + params on every
// load, never persisted, no Three.js imports (Node-testable).
//
// Rendering conventions (beta):
//   - Above-ground point classes (structure/box/pole) pin at center bottom
//     and extend up; below-ground classes (vault/lid/manhole/inlet) pin at
//     center top and extend down, so the two read differently in the viewer.
//   - Line classes (pipe/culvert) render as a centerline plus a simple tube
//     (round/box/elliptical cross-section) along the placed alignment.
//   - Stubs render as dashed, fill-less runs with an end cross so an assumed
//     or unsurveyed endpoint never reads as confirmed pipe.
// Elevation-mode params (invert/depth/assumed/unknown) are recorded metadata:
// beta does not re-drape the drawn alignment from them.

import { getTemplate, type FeatureTemplate } from '../shared/template-catalog';
import { utilityTemplateGeometry } from '../shared/utility-catalog';
import type { FeatureRecord } from '../shared/workbench-types';
import type { Vec3 } from './geometry';
import {
  buildBoxPrimitive,
  buildCylinderPrimitive,
  createBuffers,
  mergePrimitive,
  ringLine,
  toDisplay,
  worldPoint,
  type SolidPrimitiveDisplay,
} from './generators';

export interface UtilityPointGeometry {
  point: Vec3;
}

export interface UtilityLineGeometry {
  vertices: Vec3[];
}

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every((axis) => typeof axis === 'number');
}

function isVec3Array(value: unknown): value is Vec3[] {
  return Array.isArray(value) && value.every(isVec3);
}

function cloneVec3(v: Vec3): Vec3 {
  return [v[0], v[1], v[2]];
}

export function utilityPointGeometryFromFeature(feature: FeatureRecord): UtilityPointGeometry | null {
  if (feature.family !== 'utility') return null;
  const geometry = feature.geometry as { point?: unknown };
  if (!isVec3(geometry.point)) return null;
  return { point: cloneVec3(geometry.point) };
}

export function utilityLineGeometryFromFeature(feature: FeatureRecord): UtilityLineGeometry | null {
  if (feature.family !== 'utility') return null;
  const geometry = feature.geometry as { vertices?: unknown };
  if (!isVec3Array(geometry.vertices) || geometry.vertices.length < 2) return null;
  return { vertices: geometry.vertices.map(cloneVec3) };
}

/** Pin for overlays/preview: the point, or the start of a line run. */
export function utilityOriginFromFeature(feature: FeatureRecord): Vec3 | null {
  const point = utilityPointGeometryFromFeature(feature);
  if (point) return point.point;
  const line = utilityLineGeometryFromFeature(feature);
  return line ? cloneVec3(line.vertices[0]!) : null;
}

function numberParam(feature: FeatureRecord, name: string, fallback: number): number {
  const value = feature.parameters?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringParam(feature: FeatureRecord, name: string, fallback: string): string {
  const value = feature.parameters?.[name];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// Line-run helpers (tube, dashes)
// ---------------------------------------------------------------------------

interface CrossSection {
  kind: 'round' | 'box' | 'ellipse';
  /** Half-width (ft). */
  rx: number;
  /** Half-height (ft). */
  rz: number;
}

/** Cross-section from pipe params: size is inches for round, span/rise feet for box. */
function crossSectionFromParams(feature: FeatureRecord): CrossSection {
  const shape = stringParam(feature, 'pipeShape', 'round');
  if (shape === 'box') {
    return {
      kind: 'box',
      rx: Math.max(numberParam(feature, 'boxSpan', 4) / 2, 0.1),
      rz: Math.max(numberParam(feature, 'boxRise', 3) / 2, 0.1),
    };
  }
  const radius = Math.max(numberParam(feature, 'pipeSize', 12) / 12 / 2, 0.15);
  if (shape === 'elliptical' || shape === 'arch') {
    return { kind: 'ellipse', rx: radius, rz: radius * 0.7 };
  }
  return { kind: 'round', rx: radius, rz: radius };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v: Vec3): Vec3 {
  const len = length(v);
  return len > 0 ? scale(v, 1 / len) : [1, 0, 0];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Horizontal unit vector perpendicular to the segment (fallback for vertical runs). */
function horizontalPerp(dir: Vec3): Vec3 {
  const perp: Vec3 = [-dir[1], dir[0], 0];
  const len = length(perp);
  return len > 1e-6 ? scale(perp, 1 / len) : [1, 0, 0];
}

const TUBE_SEGMENTS = 10;

/** Ring of cross-section points around a center on a segment with direction dir. */
function sectionRing(center: Vec3, dir: Vec3, section: CrossSection): Vec3[] {
  const u = horizontalPerp(dir);
  if (section.kind === 'box') {
    // Box culverts stay upright regardless of grade: horizontal span, vertical rise.
    const w: Vec3 = [0, 0, 1];
    return [
      add(center, add(scale(u, -section.rx), scale(w, -section.rz))),
      add(center, add(scale(u, section.rx), scale(w, -section.rz))),
      add(center, add(scale(u, section.rx), scale(w, section.rz))),
      add(center, add(scale(u, -section.rx), scale(w, section.rz))),
    ];
  }
  // Round/elliptical sections sit perpendicular to the run axis.
  const w = normalize(cross(dir, u));
  const ring: Vec3[] = [];
  for (let i = 0; i < TUBE_SEGMENTS; i++) {
    const angle = (Math.PI * 2 * i) / TUBE_SEGMENTS;
    ring.push(add(center, add(scale(u, Math.cos(angle) * section.rx), scale(w, Math.sin(angle) * section.rz))));
  }
  return ring;
}

/**
 * Simple per-segment tube along the placed alignment: a cross-section ring at
 * each segment end with quad walls between them. No mitering at joints - the
 * beta look is a readable run, not CAD-quality pipe.
 */
export function buildTubeDisplay(vertices: Vec3[], section: CrossSection): SolidPrimitiveDisplay {
  const positions: number[] = [];
  const indices: number[] = [];
  const lines: Vec3[][] = [];
  const pushRing = (ring: Vec3[]): number[] =>
    ring.map((point) => {
      positions.push(point[0], point[1], point[2]);
      return positions.length / 3 - 1;
    });
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1]!;
    const b = vertices[i]!;
    const dir = normalize(sub(b, a));
    const ringA = sectionRing(a, dir, section);
    const ringB = sectionRing(b, dir, section);
    const idsA = pushRing(ringA);
    const idsB = pushRing(ringB);
    const n = ringA.length;
    for (let k = 0; k < n; k++) {
      const next = (k + 1) % n;
      indices.push(idsA[k]!, idsA[next]!, idsB[next]!);
      indices.push(idsA[k]!, idsB[next]!, idsB[k]!);
    }
    if (i === 1) lines.push(ringLine(ringA));
    lines.push(ringLine(ringB));
  }
  lines.push(vertices.map(cloneVec3));
  return {
    fill: { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) },
    lines,
  };
}

/** Splits a polyline into dash segments so assumed runs read as incomplete. */
export function dashPolyline(vertices: Vec3[], dashLength = 2, gapLength = 1.2): Vec3[][] {
  const dashes: Vec3[][] = [];
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1]!;
    const b = vertices[i]!;
    const segment = sub(b, a);
    const total = length(segment);
    if (total < 1e-6) continue;
    const dir = scale(segment, 1 / total);
    let cursor = 0;
    while (cursor < total) {
      const end = Math.min(cursor + dashLength, total);
      dashes.push([add(a, scale(dir, cursor)), add(a, scale(dir, end))]);
      cursor = end + gapLength;
    }
  }
  return dashes;
}

/** Small 3-axis cross marking an assumed/unsurveyed endpoint. */
function endCross(point: Vec3, size: number): Vec3[][] {
  const half = Math.max(size, 0.5);
  return [
    [
      [point[0] - half, point[1], point[2]],
      [point[0] + half, point[1], point[2]],
    ],
    [
      [point[0], point[1] - half, point[2]],
      [point[0], point[1] + half, point[2]],
    ],
    [
      [point[0], point[1], point[2] - half],
      [point[0], point[1], point[2] + half],
    ],
  ];
}

// ---------------------------------------------------------------------------
// Per-class display builders
// ---------------------------------------------------------------------------

function buildPointClassDisplay(feature: FeatureRecord, template: FeatureTemplate): SolidPrimitiveDisplay | null {
  const geometry = utilityPointGeometryFromFeature(feature);
  if (!geometry) return null;
  const point = geometry.point;
  const yawDeg = numberParam(feature, 'rotationYaw', 0);
  switch (template.utilityClass) {
    case 'structure':
    case 'box': {
      const origin = template.utilityOrigin === 'top' ? 'top' : 'base';
      const vertical = origin === 'top' ? numberParam(feature, 'depth', 6) : numberParam(feature, 'height', 3);
      return buildBoxPrimitive({
        point,
        width: numberParam(feature, 'width', 3),
        depth: numberParam(feature, 'length', 3),
        height: vertical,
        yawDeg,
        origin,
      });
    }
    case 'vault':
      return buildBoxPrimitive({
        point,
        width: numberParam(feature, 'width', 5),
        depth: numberParam(feature, 'length', 8),
        height: numberParam(feature, 'depth', 7),
        yawDeg,
        origin: 'top',
      });
    case 'lid':
      return buildCylinderPrimitive({
        point,
        radius: numberParam(feature, 'diameter', 2) / 2,
        height: Math.max(numberParam(feature, 'thickness', 0.3), 0.1),
        yawDeg,
        origin: 'top',
      });
    case 'manhole': {
      const radius = numberParam(feature, 'diameter', 4) / 2;
      const buffers = createBuffers();
      mergePrimitive(
        buffers,
        buildCylinderPrimitive({ point, radius, height: numberParam(feature, 'depth', 6), yawDeg, origin: 'top' }),
      );
      // Lid bump at the rim so the pin elevation reads at a glance.
      mergePrimitive(
        buffers,
        buildCylinderPrimitive({ point, radius: Math.max(radius * 0.65, 0.3), height: 0.2, yawDeg, origin: 'base' }),
      );
      return toDisplay(buffers);
    }
    case 'pole':
      return buildCylinderPrimitive({
        point,
        radius: Math.max(numberParam(feature, 'diameter', 1) / 2, 0.1),
        height: numberParam(feature, 'height', 20),
        yawDeg,
        origin: 'base',
      });
    case 'inlet': {
      const width = numberParam(feature, 'width', 3);
      const len = numberParam(feature, 'length', 3);
      const buffers = createBuffers();
      mergePrimitive(
        buffers,
        buildBoxPrimitive({ point, width, depth: len, height: numberParam(feature, 'depth', 4), yawDeg, origin: 'top' }),
      );
      // Grate bars across the top face (display hint for the flow entry).
      const yawRad = (yawDeg * Math.PI) / 180;
      const bars = 3;
      for (let i = 1; i <= bars; i++) {
        const localY = -len / 2 + (len * i) / (bars + 1);
        buffers.lines.push([worldPoint(point, -width / 2, localY, 0, yawRad), worldPoint(point, width / 2, localY, 0, yawRad)]);
      }
      return toDisplay(buffers);
    }
    default:
      return null;
  }
}

function buildLineClassDisplay(feature: FeatureRecord, template: FeatureTemplate): SolidPrimitiveDisplay | null {
  const geometry = utilityLineGeometryFromFeature(feature);
  if (!geometry) return null;
  const section = crossSectionFromParams(feature);
  if (template.utilityClass === 'stub') {
    // Dashed centerline + dashed edge guides + end cross; no solid fill so an
    // assumed run can never be mistaken for confirmed pipe.
    const lines: Vec3[][] = dashPolyline(geometry.vertices);
    for (const side of [-1, 1]) {
      const guide: Vec3[] = [];
      for (let i = 0; i < geometry.vertices.length; i++) {
        const dirSource = i === 0 ? sub(geometry.vertices[1]!, geometry.vertices[0]!) : sub(geometry.vertices[i]!, geometry.vertices[i - 1]!);
        const u = horizontalPerp(normalize(dirSource));
        guide.push(add(geometry.vertices[i]!, scale(u, side * section.rx)));
      }
      lines.push(...dashPolyline(guide));
    }
    lines.push(...endCross(geometry.vertices.at(-1)!, Math.max(section.rx * 2, 1)));
    return { lines };
  }
  const display = buildTubeDisplay(geometry.vertices, section);
  if (template.utilityClass === 'culvert') {
    // Flared end rings hint at the flowline-critical culvert ends.
    for (const endIndex of [0, geometry.vertices.length - 1]) {
      const other = endIndex === 0 ? 1 : geometry.vertices.length - 2;
      const dir = normalize(sub(geometry.vertices[other]!, geometry.vertices[endIndex]!));
      const flared = sectionRing(geometry.vertices[endIndex]!, dir, {
        ...section,
        rx: section.rx * 1.4,
        rz: section.rz * 1.4,
      });
      display.lines.push(ringLine(flared));
    }
  }
  return display;
}

/**
 * Display geometry for one utility feature, dispatched on the template's
 * utilityClass. Null when the record has no valid geometry for its class.
 */
export function buildUtilityDisplay(feature: FeatureRecord): SolidPrimitiveDisplay | null {
  if (feature.family !== 'utility') return null;
  const template = feature.templateId ? getTemplate(feature.templateId) : null;
  if (!template?.utilityClass) return null;
  return utilityTemplateGeometry(template) === 'line'
    ? buildLineClassDisplay(feature, template)
    : buildPointClassDisplay(feature, template);
}

// ---------------------------------------------------------------------------
// Viewer entry (display + system colors)
// ---------------------------------------------------------------------------

/** Display tints: storm reads green, generic reads pink (locate-mark adjacent), above-ground lighter than buried. */
export function utilityDisplayColor(feature: FeatureRecord): { fill: number; line: number } {
  const template = feature.templateId ? getTemplate(feature.templateId) : null;
  const above = template?.utilityOrigin === 'bottom';
  if (template?.utilitySystem === 'storm') {
    return { fill: above ? 0x66bb6a : 0x3d8b4f, line: 0x1e5b2f };
  }
  return { fill: above ? 0xc98bbf : 0x9a5f92, line: 0x6d3f68 };
}

export interface UtilityDisplayEntryParts {
  fill?: { positions: Float64Array; indices: Uint32Array };
  lines: Vec3[][];
  fillColor: number;
  lineColor: number;
}

/** One-call bridge for the display refresh path: geometry + colors, ready to spread into a FeatureDisplayEntry. */
export function buildUtilityDisplayEntry(feature: FeatureRecord): UtilityDisplayEntryParts | null {
  const display = buildUtilityDisplay(feature);
  if (!display) return null;
  const color = utilityDisplayColor(feature);
  return { ...display, fillColor: color.fill, lineColor: color.line };
}
