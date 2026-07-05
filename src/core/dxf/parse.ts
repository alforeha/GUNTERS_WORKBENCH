// src/core/dxf/parse.ts — DXF → normalized DxfDataset (contract rev 1.2, docs/04 §4 + docs/08
// Phase 2). dxf-parser does the group-code heavy lifting (PM direction); custom entity
// handlers add HATCH (boundary linework), ATTRIB and MULTILEADER (skip + count) which the
// library does not ship. Pure core code: no DOM, no Three.js — runs in Node and in a Worker.
//
// Normalization rules (docs/04 §4):
//  - LWPOLYLINE (incl. bulge/group-42 arcs), POLYLINE, LINE, ARC, CIRCLE, ELLIPSE, SPLINE
//    → polylines tessellated at ~0.1 ft chord tolerance
//  - INSERT → recursive explode through the full transform (cycle-guarded; ATTRIBs skipped)
//  - HATCH → boundary linework only (fill is parked); counted in the report
//  - POINT → DxfDataset.points (stored + counted, NOT rendered this sprint)
//  - 3DFACE → closed polyline outline, hasZ (they carry real elevations)
//  - TEXT/MTEXT/ATTRIB/ATTDEF/MULTILEADER/DIMENSION → skip + count
//  - paper space → skip, noted in the report
//  - never throw on malformed content — everything lands in the ImportReport

import DxfParser from 'dxf-parser';
import type { DxfDataset, DxfEntity, DxfLayer, DxfPoint, ImportReport, SourceMeta } from '../contract';
import {
  DEFAULT_CHORD_TOL,
  sampleSpline,
  tessellateArc,
  tessellateBulge,
  tessellateEllipse,
} from './tessellate';

// ---------------------------------------------------------------------------
// loose raw-entity typing (dxf-parser output is dynamic; we read defensively)
// ---------------------------------------------------------------------------

interface RawPoint { x?: number; y?: number; z?: number }
interface RawEntity {
  type: string;
  layer?: string;
  colorIndex?: number;
  color?: number;
  inPaperSpace?: boolean;
  // geometry fields (per type)
  vertices?: (RawPoint & { bulge?: number })[];
  elevation?: number;
  shape?: boolean;
  closed?: boolean;
  center?: RawPoint;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  majorAxisEndPoint?: RawPoint;
  axisRatio?: number;
  controlPoints?: RawPoint[];
  fitPoints?: RawPoint[];
  knotValues?: number[];
  degreeOfSplineCurve?: number;
  position?: RawPoint;
  name?: string;
  xScale?: number;
  yScale?: number;
  zScale?: number;
  rotation?: number;
  columnCount?: number;
  rowCount?: number;
  columnSpacing?: number;
  rowSpacing?: number;
  isPolyfaceMesh?: boolean;
  is3dPolygonMesh?: boolean;
  // custom HATCH handler output
  hatchLoops?: number[][];
}

interface RawLayer { name?: string; color?: number; colorIndex?: number; visible?: boolean; frozen?: boolean }
interface RawBlock { entities?: RawEntity[]; position?: RawPoint }
interface RawDxf {
  entities?: RawEntity[];
  blocks?: Record<string, RawBlock>;
  tables?: { layer?: { layers?: Record<string, RawLayer> } };
  header?: Record<string, unknown>;
}

interface ScannerGroup { code: number; value: unknown }
interface Scanner { next(): ScannerGroup; isEOF(): boolean; rewind(): void; lastReadGroup: ScannerGroup }

// ---------------------------------------------------------------------------
// custom entity handlers (HATCH boundary linework; ATTRIB/MULTILEADER skip+count)
// ---------------------------------------------------------------------------

/** Buffer every group of the current entity (until the next code-0), leaving the scanner
 *  positioned so dxf-parser's loop resumes correctly. */
function bufferEntityGroups(scanner: Scanner, first: ScannerGroup): ScannerGroup[] {
  const groups: ScannerGroup[] = [];
  let curr = first.code === 0 ? scanner.next() : first;
  while (!scanner.isEOF()) {
    if (curr.code === 0) break;
    groups.push(curr);
    curr = scanner.next();
  }
  return groups;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

/** Consume-and-tag handler for entities we only count (ATTRIB, MULTILEADER/MLEADER). */
class SkipHandler {
  constructor(readonly ForEntityName: string) {}
  parseEntity(scanner: Scanner, curr: ScannerGroup): RawEntity {
    const entity: RawEntity = { type: this.ForEntityName };
    for (const g of bufferEntityGroups(scanner, curr)) {
      if (g.code === 8) entity.layer = String(g.value);
      else if (g.code === 67) entity.inPaperSpace = num(g.value) !== 0;
    }
    return entity;
  }
}

/** HATCH: boundary path linework only (docs/08 Phase 2 — hatch fill on faces is parked).
 *  Buffered parse: tolerant, count-driven, never throws. */
class HatchHandler {
  readonly ForEntityName = 'HATCH';
  parseEntity(scanner: Scanner, curr: ScannerGroup): RawEntity {
    const entity: RawEntity = { type: 'HATCH', hatchLoops: [] };
    const groups = bufferEntityGroups(scanner, curr);
    let i = 0;
    const n = groups.length;
    // common props live before the loop data (group 91)
    for (; i < n; i++) {
      const g = groups[i]!;
      if (g.code === 8) entity.layer = String(g.value);
      else if (g.code === 62) entity.colorIndex = num(g.value);
      else if (g.code === 420) entity.color = num(g.value);
      else if (g.code === 67) entity.inPaperSpace = num(g.value) !== 0;
      else if (g.code === 91) break; // number of boundary loops
    }
    if (i >= n) return entity;
    let loopsLeft = num(groups[i]!.value);
    i++;
    const tol = DEFAULT_CHORD_TOL;

    while (loopsLeft > 0 && i < n) {
      // seek loop start (92 = boundary path type flag)
      while (i < n && groups[i]!.code !== 92) i++;
      if (i >= n) break;
      const flags = num(groups[i]!.value);
      i++;
      loopsLeft--;
      const pts: number[] = [];

      if ((flags & 2) !== 0) {
        // polyline path: 72 hasBulge, 73 closed, 93 count, then 10/20[/42] per vertex
        let nVerts = 0;
        while (i < n && groups[i]!.code !== 10) {
          if (groups[i]!.code === 93) nVerts = num(groups[i]!.value);
          if (groups[i]!.code === 92) break;
          i++;
        }
        let lastX = 0;
        let lastY = 0;
        let lastBulge = 0;
        let got = 0;
        while (got < nVerts && i < n && groups[i]!.code === 10) {
          const x = num(groups[i]!.value);
          i++;
          let y = 0;
          if (i < n && groups[i]!.code === 20) {
            y = num(groups[i]!.value);
            i++;
          }
          let bulge = 0;
          if (i < n && groups[i]!.code === 42) {
            bulge = num(groups[i]!.value);
            i++;
          }
          if (got === 0) pts.push(x, y, 0);
          else tessellateBulge(pts, lastX, lastY, x, y, lastBulge, 0, tol);
          lastX = x;
          lastY = y;
          lastBulge = bulge;
          got++;
        }
        if (got > 1 && lastBulge !== 0) {
          // closing arc back to the first vertex
          tessellateBulge(pts, lastX, lastY, pts[0]!, pts[1]!, lastBulge, 0, tol);
          pts.length -= 3; // drop duplicate of the first point — closure is implied
        }
      } else {
        // edge list: 93 edge count, then per edge 72 = type + geometry codes
        let nEdges = 0;
        while (i < n && groups[i]!.code !== 72) {
          if (groups[i]!.code === 93) nEdges = num(groups[i]!.value);
          if (groups[i]!.code === 92) break;
          i++;
        }
        const read = (code: number): number | null => {
          // expect `code` at or just ahead of the cursor (skip stray groups, stop at 92/72)
          let j = i;
          let hops = 0;
          while (j < n && hops < 6) {
            const g = groups[j]!;
            if (g.code === code) {
              i = j + 1;
              return num(g.value);
            }
            if (g.code === 92) return null;
            j++;
            hops++;
          }
          return null;
        };
        for (let e = 0; e < nEdges && i < n; e++) {
          while (i < n && groups[i]!.code !== 72) {
            if (groups[i]!.code === 92) break;
            i++;
          }
          if (i >= n || groups[i]!.code !== 72) break;
          const edgeType = num(groups[i]!.value);
          i++;
          if (edgeType === 1) {
            const x1 = read(10), y1 = read(20), x2 = read(11), y2 = read(21);
            if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
              if (pts.length === 0) pts.push(x1, y1, 0);
              pts.push(x2, y2, 0);
            }
          } else if (edgeType === 2) {
            const cx = read(10), cy = read(20), r = read(40), sa = read(50), ea = read(51), ccw = read(73);
            if (cx !== null && cy !== null && r !== null && sa !== null && ea !== null) {
              const s = (sa * Math.PI) / 180;
              let sweepDeg = ccw === 0 ? -(((sa - ea) % 360) + 360) % 360 : (((ea - sa) % 360) + 360) % 360;
              if (sweepDeg === 0) sweepDeg = ccw === 0 ? -360 : 360;
              tessellateArc(pts, cx, cy, r, s, s + (sweepDeg * Math.PI) / 180, 0, tol, pts.length === 0);
            }
          } else if (edgeType === 3) {
            const cx = read(10), cy = read(20), mx = read(11), my = read(21), ratio = read(40);
            const sa = read(50), ea = read(51);
            if (cx !== null && cy !== null && mx !== null && my !== null && ratio !== null && sa !== null && ea !== null) {
              tessellateEllipse(pts, cx, cy, mx, my, ratio, (sa * Math.PI) / 180, (ea * Math.PI) / 180, 0, tol);
            }
          } else {
            // spline edge (4) or unknown: approximate with its control/fit points (codes 10/20)
            let j = i;
            while (j < n && groups[j]!.code !== 72 && groups[j]!.code !== 92 && groups[j]!.code !== 97) {
              if (groups[j]!.code === 10) {
                const x = num(groups[j]!.value);
                const yg = groups[j + 1];
                if (yg && yg.code === 20) pts.push(x, num(yg.value), 0);
              }
              j++;
            }
            i = j;
          }
        }
      }
      if (pts.length >= 9) entity.hatchLoops!.push(pts); // ≥3 points = drawable loop
    }
    return entity;
  }
}

// ---------------------------------------------------------------------------
// layer extras (linetype / lineweight) — dxf-parser's layer table skips codes 6 & 370,
// so one cheap pass over the TABLES section text recovers them (docs/08 Phase 5 needs both).
// ---------------------------------------------------------------------------

export function scanLayerExtras(text: string): Map<string, { linetype: string; lineweight: number }> {
  const out = new Map<string, { linetype: string; lineweight: number }>();
  const tablesAt = text.indexOf('\nTABLES');
  if (tablesAt < 0) return out;
  const endsecAt = text.indexOf('\nENDSEC', tablesAt);
  const section = text.slice(tablesAt, endsecAt < 0 ? undefined : endsecAt + 7);
  // group-code pair walk within TABLES only
  const lines = section.split(/\r?\n/);
  let inLayerRecord = false;
  let name = '';
  let linetype = 'CONTINUOUS';
  let lineweight = -3;
  const flush = (): void => {
    if (inLayerRecord && name) out.set(name, { linetype, lineweight });
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    const value = (lines[i + 1] ?? '').trim();
    if (code === 0) {
      flush();
      inLayerRecord = value === 'LAYER';
      name = '';
      linetype = 'CONTINUOUS';
      lineweight = -3;
    } else if (inLayerRecord) {
      if (code === 2) name = value;
      else if (code === 6) linetype = value || 'CONTINUOUS';
      else if (code === 370) lineweight = Number(value);
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

/** 2.5D affine: x' = m00·x + m01·y + tx; y' = m10·x + m11·y + ty; z' = sz·z + tz. */
type Transform = [number, number, number, number, number, number, number, number];
const IDENTITY: Transform = [1, 0, 0, 1, 0, 0, 1, 0];

function compose(p: Transform, c: Transform): Transform {
  return [
    p[0] * c[0] + p[1] * c[2],
    p[0] * c[1] + p[1] * c[3],
    p[2] * c[0] + p[3] * c[2],
    p[2] * c[1] + p[3] * c[3],
    p[0] * c[4] + p[1] * c[5] + p[4],
    p[2] * c[4] + p[3] * c[5] + p[5],
    p[6] * c[6],
    p[6] * c[7] + p[7],
  ];
}

function applyTransform(t: Transform, pts: number[]): void {
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i]!;
    const y = pts[i + 1]!;
    const z = pts[i + 2]!;
    pts[i] = t[0] * x + t[1] * y + t[4];
    pts[i + 1] = t[2] * x + t[3] * y + t[5];
    pts[i + 2] = t[6] * z + t[7];
  }
}

const Z_EPS = 1e-9;

let dxfCounter = 0;
function newDatasetId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `dxf-${Date.now()}-${++dxfCounter}`;
}

export interface ParseDxfOptions {
  fileName?: string;
  /** chord tolerance for curve tessellation (drawing units; default 0.1 — docs/04 §4) */
  chordTol?: number;
  /** coarse progress: 'parsing' → 'normalizing' → 'done' */
  onProgress?: (phase: 'parsing' | 'normalizing' | 'done') => void;
}

const BYBLOCK_FALLBACK = 0xffffff;

export function parseDxf(text: string, opts: ParseDxfOptions = {}): DxfDataset {
  const fileName = opts.fileName ?? 'untitled.dxf';
  const tol = opts.chordTol ?? DEFAULT_CHORD_TOL;
  const report: ImportReport = {
    counts: {},
    triangulationPreserved: false, // not applicable to DXF linework — kept false by definition
    warnings: [],
    infos: [],
    unknownElements: {},
  };
  const counts = report.counts;
  const bump = (key: string, by = 1): void => {
    counts[key] = (counts[key] ?? 0) + by;
  };

  opts.onProgress?.('parsing');
  const parser = new DxfParser() as unknown as {
    parseSync(s: string): RawDxf | null;
    registerEntityHandler(h: unknown): void;
  };
  parser.registerEntityHandler(HatchHandler);
  parser.registerEntityHandler(class extends SkipHandler { constructor() { super('ATTRIB'); } });
  parser.registerEntityHandler(class extends SkipHandler { constructor() { super('MULTILEADER'); } });
  parser.registerEntityHandler(class extends SkipHandler { constructor() { super('MLEADER'); } });

  let dxf: RawDxf | null = null;
  try {
    dxf = parser.parseSync(text);
  } catch (err) {
    report.warnings.push(`DXF parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  opts.onProgress?.('normalizing');

  // ── layers ────────────────────────────────────────────────────────────────
  const extras = scanLayerExtras(text);
  const rawLayers = dxf?.tables?.layer?.layers ?? {};
  const allLayers: DxfLayer[] = [];
  const layerColor = new Map<string, number>();
  for (const [name, l] of Object.entries(rawLayers)) {
    const colorRGB = typeof l.color === 'number' ? l.color : 0xffffff;
    const ex = extras.get(name);
    allLayers.push({
      name,
      colorRGB,
      linetype: ex?.linetype ?? 'CONTINUOUS',
      lineweight: ex?.lineweight ?? -3,
      hidden: l.visible === false || l.frozen === true,
    });
    layerColor.set(name, colorRGB);
  }

  // ── entities ──────────────────────────────────────────────────────────────
  const blocks = dxf?.blocks ?? {};
  const entities: DxfEntity[] = [];
  const points: DxfPoint[] = [];
  const skipped = new Map<string, number>();
  let paperSpace = 0;
  let insertsExploded = 0;
  let hatchBoundaries = 0;
  let pointId = 0;

  const resolveColor = (e: RawEntity, layer: string, inherited: number | null): number => {
    if (e.colorIndex === 0) return inherited ?? layerColor.get(layer) ?? BYBLOCK_FALLBACK; // ByBlock
    if (e.colorIndex !== undefined && e.colorIndex !== 256 && typeof e.color === 'number') return e.color;
    if (e.colorIndex === undefined && typeof e.color === 'number') return e.color; // TrueColor (420)
    return layerColor.get(layer) ?? BYBLOCK_FALLBACK; // ByLayer / unspecified
  };

  const emit = (e: RawEntity, pts: number[], closed: boolean, layer: string, color: number, tf: Transform): void => {
    if (pts.length < 6) return; // need at least 2 points to draw
    applyTransform(tf, pts);
    let hasZ = false;
    for (let i = 2; i < pts.length; i += 3) {
      if (Math.abs(pts[i]!) > Z_EPS) {
        hasZ = true;
        break;
      }
    }
    entities.push({ layer, colorRGB: color, kind: 'polyline', pts: Float64Array.from(pts), closed, hasZ });
    void e;
  };

  // Exploded block content is ATTRIBUTED to the INSERT's layer for display control (one layer
  // row toggles the whole symbol — matches the audit's layer census and how surveyors think
  // of symbol blocks), while ByLayer COLORS still resolve through the child's own layer.
  const normalizeEntity = (
    e: RawEntity,
    tf: Transform,
    blockCtx: { layer: string; color: number } | null,
    blockStack: Set<string>,
  ): void => {
    const type = (e.type || 'UNKNOWN').toUpperCase();
    if (e.inPaperSpace && !blockCtx) return; // counted by the caller — skip, never normalize
    const layer = blockCtx ? blockCtx.layer : (e.layer ?? '0');
    // CARLSON-ASSUMPTION: block sub-entities on layer '0' take the INSERT's layer for color
    // resolution too — standard AutoCAD semantics, verified against the pair's SPT*/STRM-*/
    // COMM-* blocks.
    const colorLayer = blockCtx && e.layer && e.layer !== '0' ? e.layer : layer;
    const color = resolveColor(e, colorLayer, blockCtx ? blockCtx.color : null);

    switch (type) {
      case 'LINE': {
        const v = e.vertices ?? [];
        if (v.length >= 2) {
          emit(e, [v[0]!.x ?? 0, v[0]!.y ?? 0, v[0]!.z ?? 0, v[1]!.x ?? 0, v[1]!.y ?? 0, v[1]!.z ?? 0], false, layer, color, tf);
        }
        break;
      }
      case 'LWPOLYLINE': {
        const v = e.vertices ?? [];
        if (v.length < 2) break;
        const z = e.elevation ?? 0;
        const pts: number[] = [v[0]!.x ?? 0, v[0]!.y ?? 0, z];
        for (let i = 1; i < v.length; i++) {
          tessellateBulge(pts, v[i - 1]!.x ?? 0, v[i - 1]!.y ?? 0, v[i]!.x ?? 0, v[i]!.y ?? 0, v[i - 1]!.bulge ?? 0, z, tol);
        }
        const closed = e.shape === true;
        if (closed && (v[v.length - 1]!.bulge ?? 0) !== 0) {
          tessellateBulge(pts, v[v.length - 1]!.x ?? 0, v[v.length - 1]!.y ?? 0, v[0]!.x ?? 0, v[0]!.y ?? 0, v[v.length - 1]!.bulge ?? 0, z, tol);
          pts.length -= 3; // closure is implied by `closed`
        }
        emit(e, pts, closed, layer, color, tf);
        break;
      }
      case 'POLYLINE': {
        if (e.isPolyfaceMesh || e.is3dPolygonMesh) {
          if (!blockCtx) skipped.set('POLYLINE (mesh)', (skipped.get('POLYLINE (mesh)') ?? 0) + 1);
          else bump('skippedInBlocks');
          break;
        }
        const v = e.vertices ?? [];
        if (v.length < 2) break;
        const pts: number[] = [v[0]!.x ?? 0, v[0]!.y ?? 0, v[0]!.z ?? 0];
        for (let i = 1; i < v.length; i++) {
          tessellateBulge(pts, v[i - 1]!.x ?? 0, v[i - 1]!.y ?? 0, v[i]!.x ?? 0, v[i]!.y ?? 0, v[i - 1]!.bulge ?? 0, v[i]!.z ?? 0, tol);
        }
        emit(e, pts, e.shape === true, layer, color, tf);
        break;
      }
      case 'ARC': {
        const c = e.center ?? {};
        const pts: number[] = [];
        // dxf-parser already converted ARC angles to radians
        let end = e.endAngle ?? 0;
        const start = e.startAngle ?? 0;
        if (end <= start) end += Math.PI * 2;
        tessellateArc(pts, c.x ?? 0, c.y ?? 0, e.radius ?? 0, start, end, c.z ?? 0, tol, true);
        emit(e, pts, false, layer, color, tf);
        break;
      }
      case 'CIRCLE': {
        const c = e.center ?? {};
        const pts: number[] = [];
        tessellateArc(pts, c.x ?? 0, c.y ?? 0, e.radius ?? 0, 0, Math.PI * 2, c.z ?? 0, tol, true);
        pts.length -= 3; // closure implied
        emit(e, pts, true, layer, color, tf);
        break;
      }
      case 'ELLIPSE': {
        const c = e.center ?? {};
        const m = e.majorAxisEndPoint ?? {};
        const start = e.startAngle ?? 0;
        const end = e.endAngle ?? Math.PI * 2;
        const full = Math.abs(end - start - Math.PI * 2) < 1e-6;
        const pts: number[] = [];
        tessellateEllipse(pts, c.x ?? 0, c.y ?? 0, m.x ?? 0, m.y ?? 0, e.axisRatio ?? 1, start, end, c.z ?? 0, tol);
        if (full) pts.length -= 3;
        emit(e, pts, full, layer, color, tf);
        break;
      }
      case 'SPLINE': {
        const ctrl = (e.controlPoints ?? []).map((p) => [p.x ?? 0, p.y ?? 0, p.z ?? 0] as const);
        const pts: number[] = [];
        if (ctrl.length >= 2) {
          const samples = Math.min(512, Math.max(16, ctrl.length * 8));
          sampleSpline(pts, ctrl, e.degreeOfSplineCurve ?? 3, e.knotValues ?? [], null, samples);
        } else if ((e.fitPoints ?? []).length >= 2) {
          for (const p of e.fitPoints!) pts.push(p.x ?? 0, p.y ?? 0, p.z ?? 0);
        }
        emit(e, pts, e.closed === true, layer, color, tf);
        break;
      }
      case '3DFACE': {
        const v = (e.vertices ?? []).slice(0, 4);
        // drop a duplicated 4th corner (triangle convention)
        if (v.length === 4) {
          const a = v[2]!;
          const b = v[3]!;
          if (a.x === b.x && a.y === b.y && a.z === b.z) v.pop();
        }
        const pts: number[] = [];
        for (const p of v) pts.push(p.x ?? 0, p.y ?? 0, p.z ?? 0);
        emit(e, pts, true, layer, color, tf); // hasZ falls out of the real elevations
        break;
      }
      case 'SOLID': {
        const v = e.vertices ?? [];
        const pts: number[] = [];
        for (const p of v) pts.push(p.x ?? 0, p.y ?? 0, p.z ?? 0);
        emit(e, pts, true, layer, color, tf);
        break;
      }
      case 'POINT': {
        const p = e.position ?? {};
        const pt = [p.x ?? 0, p.y ?? 0, p.z ?? 0];
        applyTransform(tf, pt);
        points.push({ id: ++pointId, x: pt[0]!, y: pt[1]!, z: pt[2]!, layer });
        break;
      }
      case 'HATCH': {
        for (const loop of e.hatchLoops ?? []) {
          emit(e, [...loop], true, layer, color, tf);
          hatchBoundaries++;
        }
        break;
      }
      case 'INSERT': {
        const name = e.name ?? '';
        const block = blocks[name];
        if (!block || !block.entities) {
          skipped.set('INSERT (unresolved block)', (skipped.get('INSERT (unresolved block)') ?? 0) + 1);
          break;
        }
        if (blockStack.has(name)) {
          report.warnings.push(`cyclic block reference "${name}" — explosion stopped`);
          break;
        }
        insertsExploded++;
        const rot = ((e.rotation ?? 0) * Math.PI) / 180;
        const cosR = Math.cos(rot);
        const sinR = Math.sin(rot);
        const sx = e.xScale ?? 1;
        const sy = e.yScale ?? 1;
        const sz = e.zScale ?? 1;
        const px = e.position?.x ?? 0;
        const py = e.position?.y ?? 0;
        const pz = e.position?.z ?? 0;
        const bx = block.position?.x ?? 0;
        const by = block.position?.y ?? 0;
        const bz = block.position?.z ?? 0;
        const cols = Math.max(1, e.columnCount ?? 1);
        const rows = Math.max(1, e.rowCount ?? 1);
        blockStack.add(name);
        for (let cI = 0; cI < cols; cI++) {
          for (let rI = 0; rI < rows; rI++) {
            const ox = cI * (e.columnSpacing ?? 0);
            const oy = rI * (e.rowSpacing ?? 0);
            // local = S then R then T(insert + rotated array offset); block base subtracted first
            const local: Transform = [
              cosR * sx, -sinR * sy,
              sinR * sx, cosR * sy,
              px + cosR * ox - sinR * oy,
              py + sinR * ox + cosR * oy,
              sz, pz - bz * sz,
            ];
            // fold the block base-point translation into the local transform (x − bx, y − by)
            local[4] -= local[0] * bx + local[1] * by;
            local[5] -= local[2] * bx + local[3] * by;
            const worldTf = compose(tf, local);
            const ctx = { layer, color };
            for (const child of block.entities) {
              const childType = (child.type || '').toUpperCase();
              if (childType === 'ATTDEF' || childType === 'ATTRIB') {
                // attribute entities are skipped during explode (docs/08 Phase 2)
                bump('skippedInBlocks');
                continue;
              }
              normalizeEntity(child, worldTf, ctx, blockStack);
            }
          }
        }
        blockStack.delete(name);
        break;
      }
      default:
        // TEXT/MTEXT/ATTRIB/ATTDEF/MULTILEADER/DIMENSION and anything else non-drawable:
        // skip + count (docs/08 Phase 2 — never throw on junk). The dialog reports model-space
        // skip counts; annotation buried inside blocks rolls into one aggregate.
        if (!blockCtx) skipped.set(type, (skipped.get(type) ?? 0) + 1);
        else bump('skippedInBlocks');
    }
  };

  const top = dxf?.entities ?? [];
  const topLayerRefs = new Set<string>();
  for (const e of top) {
    if (e.inPaperSpace) {
      paperSpace++;
      continue;
    }
    bump(`entity:${(e.type || 'UNKNOWN').toUpperCase()}`); // raw MODEL-space census per type (01 §6)
    topLayerRefs.add(e.layer ?? '0'); // annotation-only layers still appear in the layer list
    normalizeEntity(e, IDENTITY, null, new Set());
  }

  // ── layer list = layers actually carrying content (the audit's layer counts are
  //    used-layer counts; a CAD LAYER table also holds unused/xref layers — noise in the UI) ──
  const usedLayers = new Set<string>(topLayerRefs);
  for (const e of entities) usedLayers.add(e.layer);
  for (const p of points) usedLayers.add(p.layer);
  const layers = allLayers.filter((l) => usedLayers.has(l.name));
  // content on a layer missing from the table (malformed files): synthesize an entry
  for (const name of usedLayers) {
    if (!layers.some((l) => l.name === name)) {
      layers.push({ name, colorRGB: 0xffffff, linetype: 'CONTINUOUS', lineweight: -3, hidden: false });
    }
  }
  counts['layers'] = layers.length;

  // ── report ────────────────────────────────────────────────────────────────
  counts['normalizedPolylines'] = entities.length;
  counts['points'] = points.length;
  if (insertsExploded) {
    counts['insertsExploded'] = insertsExploded;
    report.infos.push(`${insertsExploded.toLocaleString()} block insert(s) exploded through their transforms`);
  }
  if (hatchBoundaries) {
    counts['hatchBoundaries'] = hatchBoundaries;
    report.infos.push(`${hatchBoundaries} hatch boundary loop(s) — boundary linework only, fill not rendered`);
  }
  for (const [type, nSkipped] of skipped) {
    counts[`skipped:${type}`] = nSkipped;
  }
  if (skipped.size > 0) {
    const summary = [...skipped.entries()].map(([t, k]) => `${t} ×${k}`).join(', ');
    report.infos.push(`skipped (not drawable linework): ${summary}`);
  }
  if (paperSpace > 0) {
    counts['paperSpaceEntities'] = paperSpace;
    report.infos.push('paper-space entities present: ignored');
  }
  if (points.length > 0) {
    const zero = points.reduce((acc, p) => acc + (Math.abs(p.z) <= Z_EPS ? 1 : 0), 0);
    report.infos.push(
      `${points.length} point(s) stored for the future POINT tab — not rendered this sprint` +
        (zero > 0 ? ` (${zero} at zero elevation)` : ''),
    );
  }
  report.infos.push(`${layers.length} layer(s)`);
  if (!dxf) report.warnings.push('file produced no DXF content — nothing to display');

  const acadVer = dxf?.header?.['$ACADVER'];
  const meta: SourceMeta = {
    fileName,
    format: 'dxf',
    formatVersion: typeof acadVer === 'string' ? acadVer : undefined,
    // DXF carries no unit declaration we can trust ($INSUNITS is widely wrong) — the dataset
    // adopts the scene's units on import; raw spelling records the assumption.
    units: { linear: 'usSurveyFoot', raw: 'dxf-unitless (assumed drawing units)' },
  };

  opts.onProgress?.('done');
  return {
    id: newDatasetId(),
    name: fileName.replace(/\.[^.]+$/, ''),
    meta,
    layers,
    entities,
    points,
    report,
  };
}
