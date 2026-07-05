// src/core/landxml/parse.ts — streaming LandXML parser → normalized SurfaceModel (contract.ts).
//
// Pure core code: no DOM, no DOMParser (R11), no Three.js. Runs in Node (Vitest) and in a Worker.
// Input is consumed as a stream of chunks; per-point/per-face text is the only buffered state,
// so peak memory stays proportional to output arrays, not to DOM node count.
//
// Sample-verified vs schema-derived markers per docs/04 §0.1: Carlson-specific interpretation
// carries a `// CARLSON-ASSUMPTION:` comment.

import type { Boundary, Breakline, ImportReport, Polyline3D, SourceMeta, SurfaceModel } from '../contract';
import { SaxTokenizer, type SaxHandlers } from './sax';

// Report helpers. Kept here (not in contract.ts) per the Sprint 1 lead ruling:
// contract.ts stays pure types; helpers live next to their consumer.
export function emptyReport(): ImportReport {
  return { counts: {}, triangulationPreserved: false, warnings: [], infos: [], unknownElements: {} };
}

/** Merge `from` into `into` (counts/unknowns summed, messages appended). Returns `into`. */
export function mergeReports(into: ImportReport, from: ImportReport): ImportReport {
  for (const k of Object.keys(from.counts)) into.counts[k] = (into.counts[k] ?? 0) + (from.counts[k] ?? 0);
  for (const k of Object.keys(from.unknownElements)) {
    into.unknownElements[k] = (into.unknownElements[k] ?? 0) + (from.unknownElements[k] ?? 0);
  }
  into.warnings.push(...from.warnings);
  into.infos.push(...from.infos);
  return into;
}

export type ParsePhase = 'reading' | 'parsing' | 'building';
export interface ParseProgress {
  phase: ParsePhase;
  bytesProcessed: number;
  bytesTotal: number; // 0 = unknown (stream without a provided total)
}

export interface ParseLandXMLOptions {
  fileName?: string;
  /** Called per input chunk (≥4 Hz at streaming rates — docs/06 D3). Node-testable. */
  onProgress?: (p: ParseProgress) => void;
  /** Total input size in bytes when known (e.g. File.size); strings default to their length. */
  bytesTotal?: number;
}

export interface LandXMLParseResult {
  surfaces: SurfaceModel[];
}

/**
 * Parse LandXML text (whole string or streamed chunks) into normalized SurfaceModels.
 * Never throws on malformed/unknown content — problems land in each surface's ImportReport.
 * Async because ReadableStream input is inherently async; string input resolves immediately.
 */
export async function parseLandXML(
  input: string | ReadableStream<Uint8Array | string>,
  opts: ParseLandXMLOptions = {},
): Promise<LandXMLParseResult> {
  const builder = new LandXMLBuilder(opts.fileName ?? 'untitled.xml');
  const tokenizer = new SaxTokenizer(builder);
  const onProgress = opts.onProgress;
  let processed = 0;

  if (typeof input === 'string') {
    const total = opts.bytesTotal ?? input.length;
    onProgress?.({ phase: 'reading', bytesProcessed: 0, bytesTotal: total });
    const CHUNK = 1 << 20; // identical code path as streaming — exercises chunk handling
    for (let i = 0; i < input.length; i += CHUNK) {
      const slice = input.slice(i, i + CHUNK);
      tokenizer.feed(slice);
      processed += slice.length;
      onProgress?.({ phase: 'parsing', bytesProcessed: processed, bytesTotal: total });
    }
    tokenizer.end();
    onProgress?.({ phase: 'building', bytesProcessed: processed, bytesTotal: total });
    return { surfaces: builder.finish() };
  }

  const total = opts.bytesTotal ?? 0; // 0 = unknown
  onProgress?.({ phase: 'reading', bytesProcessed: 0, bytesTotal: total });
  const reader = input.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
    processed += typeof value === 'string' ? value.length : value.byteLength;
    if (text.length) tokenizer.feed(text);
    onProgress?.({ phase: 'parsing', bytesProcessed: processed, bytesTotal: total });
  }
  const tail = decoder.decode();
  if (tail.length) tokenizer.feed(tail);
  tokenizer.end();
  onProgress?.({ phase: 'building', bytesProcessed: processed, bytesTotal: total });
  return { surfaces: builder.finish() };
}

// ---------------------------------------------------------------------------
// growable typed-array builders
// ---------------------------------------------------------------------------

class GrowableF64 {
  private chunks: Float64Array[] = [];
  private cur = new Float64Array(4096);
  private fill = 0;
  length = 0;

  push(v: number): void {
    if (this.fill === this.cur.length) {
      this.chunks.push(this.cur);
      this.cur = new Float64Array(Math.min(this.cur.length * 2, 1 << 21));
      this.fill = 0;
    }
    this.cur[this.fill++] = v;
    this.length++;
  }

  toArray(): Float64Array {
    const out = new Float64Array(this.length);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    out.set(this.cur.subarray(0, this.fill), o);
    return out;
  }
}

class GrowableU32 {
  private chunks: Uint32Array[] = [];
  private cur = new Uint32Array(4096);
  private fill = 0;
  length = 0;

  push(v: number): void {
    if (this.fill === this.cur.length) {
      this.chunks.push(this.cur);
      this.cur = new Uint32Array(Math.min(this.cur.length * 2, 1 << 21));
      this.fill = 0;
    }
    this.cur[this.fill++] = v;
    this.length++;
  }

  /** Read back value at index (slow path — used only for id-map building). */
  at(i: number): number {
    let off = 0;
    for (const c of this.chunks) {
      if (i < off + c.length) return c[i - off] as number;
      off += c.length;
    }
    return this.cur[i - off] as number;
  }

  toArray(): Uint32Array {
    const out = new Uint32Array(this.length);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    out.set(this.cur.subarray(0, this.fill), o);
    return out;
  }
}

// ---------------------------------------------------------------------------
// streaming whitespace-separated number reader (tolerates splits mid-number)
// ---------------------------------------------------------------------------

class NumberStream {
  private partial = '';
  readonly values = new GrowableF64();
  maxDecimals = 0;
  badTokens = 0;

  push(chunk: string): void {
    const s = this.partial.length ? this.partial + chunk : chunk;
    this.partial = '';
    let start = -1;
    const n = s.length;
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      const ws = c === 32 || c === 10 || c === 13 || c === 9;
      if (ws) {
        if (start >= 0) { this.take(s.slice(start, i)); start = -1; }
      } else if (start < 0) {
        start = i;
      }
    }
    if (start >= 0) this.partial = s.slice(start); // possible split mid-number — finish next chunk
  }

  flush(): void {
    if (this.partial.length) { this.take(this.partial); this.partial = ''; }
  }

  private take(tok: string): void {
    const v = Number(tok);
    if (Number.isFinite(v)) {
      this.values.push(v);
      const d = decimalsOf(tok);
      if (d > this.maxDecimals) this.maxDecimals = d;
    } else {
      this.badTokens++;
    }
  }
}

/** Decimal places in a numeric token's literal spelling, e.g. "4185.801000" → 6. */
function decimalsOf(tok: string): number {
  const dot = tok.indexOf('.');
  if (dot < 0) return 0;
  let end = tok.length;
  for (let i = dot + 1; i < tok.length; i++) {
    const c = tok.charCodeAt(i);
    if (c < 48 || c > 57) { end = i; break; } // stop at exponent marker etc.
  }
  return end - dot - 1;
}

// ---------------------------------------------------------------------------
// builder (sax handler → SurfaceModel[])
// ---------------------------------------------------------------------------

const WS_RE = /\s+/;
const MAX_WARNINGS = 50;

/** Elements we recognize (and either consume or deliberately ignore). Everything else → unknownElements. */
const KNOWN_ELEMENTS = new Set([
  'LandXML', 'Project', 'Application', 'Author', 'Units', 'Imperial', 'Metric',
  'CoordinateSystem', 'FeatureDictionary', 'Feature', 'Property',
  'Surfaces', 'Surface', 'Definition', 'Pnts', 'P', 'Faces', 'F',
  'SourceData', 'DataPoints', 'Breaklines', 'Breakline', 'Boundaries', 'Boundary',
  'Contours', 'Contour', 'PntList2D', 'PntList3D',
]);

type ListTarget = 'breakline-spec' | 'source-data-points' | 'boundary' | 'contour' | 'ignore';

interface ActiveList {
  sink: NumberStream;
  dims: 2 | 3;
  target: ListTarget;
}

interface SurfBuild {
  name: string;
  report: ImportReport;
  pos: GrowableF64;          // x=E, y=N, z=Z (already swapped at read)
  ids: GrowableU32;
  idsContiguous: boolean;    // ids === 1..N in order → faces resolve via id-1 fast path
  idToIndex: Map<number, number> | null;
  maxDecimals: number;
  faces: GrowableU32;
  faceFlags: number[] | null; // 1 = visible, 0 = invisible (<F i="1">); allocated on first flag
  breaklines: Breakline[];
  boundaries: Boundary[];
  contours: number;          // <Contour> element count (may exceed stored polylines if empty)
  contourPolys: Polyline3D[]; // stored per contract rev 1.1 — not rendered yet
  sourceDataListCount: number;  // SourceData/DataPoints PntList blocks (rev 1.2 — informational)
  sourceDataPointTotal: number; // total points across those lists
  skippedPoints: number;
  skippedFaces: number;
  missingIdWarned: boolean;
  depth: { sourceData: number; dataPoints: number; breaklines: number; breakline: number; boundary: number; contour: number };
}

let surfaceCounter = 0;
function newSurfaceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `surface-${Date.now()}-${++surfaceCounter}`;
}

function capWarn(report: ImportReport, msg: string): void {
  if (report.warnings.length < MAX_WARNINGS) report.warnings.push(msg);
  else if (report.warnings.length === MAX_WARNINGS) report.warnings.push('… further warnings suppressed');
}

function normalizeUnits(rawLinear: string | undefined, report: ImportReport): SourceMeta['units'] {
  const raw = rawLinear ?? '';
  const r = raw.toLowerCase();
  let linear: SourceMeta['units']['linear'];
  if (r.includes('ussurvey')) linear = 'usSurveyFoot';
  else if (r.includes('foot') || r.includes('feet')) linear = 'foot';
  else if (r.includes('met')) linear = 'meter';
  else {
    capWarn(report, `unrecognized linearUnit "${raw}" — assuming meter`);
    linear = 'meter';
  }
  return { linear, raw };
}

// LandXML 1.2 Boundary bndType (schema-derived — no boundary coverage in available samples).
function normalizeBndType(raw: string | undefined, report: ImportReport): Boundary['kind'] {
  switch ((raw ?? '').toLowerCase()) {
    case 'outer': return 'outer';
    case 'island': case 'include': case 'inclusion': return 'inclusion';
    case 'void': case 'exclude': case 'exclusion': return 'exclusion';
    default:
      capWarn(report, `unrecognized Boundary bndType "${raw ?? ''}" — treating as outer`);
      return 'outer';
  }
}

class LandXMLBuilder implements SaxHandlers {
  private readonly fileReport = emptyReport();
  private readonly surfaces: SurfaceModel[] = [];
  private producer: string | undefined;
  private formatVersion: string | undefined;
  private units: SourceMeta['units'] | null = null;
  private inUnits = false;

  private s: SurfBuild | null = null;
  private pText: string | null = null;
  private pId: number | null = null;
  private fText: string | null = null;
  private fInvisible = false;
  private list: ActiveList | null = null;
  private boundaryKind: Boundary['kind'] = 'outer';

  constructor(private readonly fileName: string) {}

  private report(): ImportReport {
    return this.s ? this.s.report : this.fileReport;
  }

  // ---- sax handlers -------------------------------------------------------

  open(name: string, attrs: Record<string, string>): void {
    switch (name) {
      case 'LandXML':
        if (attrs['version']) this.formatVersion = `LandXML-${attrs['version']}`;
        break;
      case 'Application':
        if (attrs['name']) this.producer = attrs['name'];
        break;
      case 'Units':
        this.inUnits = true;
        break;
      case 'Imperial':
      case 'Metric':
        if (this.inUnits && !this.units) this.units = normalizeUnits(attrs['linearUnit'], this.fileReport);
        break;
      case 'Surface':
        this.beginSurface(attrs['name']);
        break;
      case 'P':
        if (this.s) {
          this.pText = '';
          const idAttr = attrs['id'];
          this.pId = idAttr !== undefined ? Number(idAttr) : null;
        }
        break;
      case 'F':
        if (this.s) {
          this.fText = '';
          // <F i="1"> marks an invisible face. n1..n3 neighbor attrs are intentionally
          // ignored (schema-derived; absent in sample).
          this.fInvisible = attrs['i'] === '1';
        }
        break;
      case 'Breaklines': if (this.s) this.s.depth.breaklines++; break;
      case 'Breakline':  if (this.s) this.s.depth.breakline++; break;
      case 'SourceData': if (this.s) this.s.depth.sourceData++; break;
      case 'DataPoints': if (this.s) this.s.depth.dataPoints++; break;
      case 'Boundary':
        if (this.s) {
          this.s.depth.boundary++;
          this.boundaryKind = normalizeBndType(attrs['bndType'], this.s.report);
        }
        break;
      case 'Contour':
        if (this.s) {
          this.s.contours++;
          this.s.depth.contour++;
        }
        break;
      case 'PntList2D':
      case 'PntList3D':
        this.beginList(name === 'PntList3D' ? 3 : 2);
        break;
      default:
        if (!KNOWN_ELEMENTS.has(name)) {
          const r = this.report();
          r.unknownElements[name] = (r.unknownElements[name] ?? 0) + 1;
        }
    }
  }

  close(name: string): void {
    switch (name) {
      case 'Units': this.inUnits = false; break;
      case 'P': this.endPoint(); break;
      case 'F': this.endFace(); break;
      case 'PntList2D':
      case 'PntList3D': this.endList(); break;
      case 'Breaklines': if (this.s && this.s.depth.breaklines > 0) this.s.depth.breaklines--; break;
      case 'Breakline':  if (this.s && this.s.depth.breakline > 0) this.s.depth.breakline--; break;
      case 'SourceData': if (this.s && this.s.depth.sourceData > 0) this.s.depth.sourceData--; break;
      case 'DataPoints': if (this.s && this.s.depth.dataPoints > 0) this.s.depth.dataPoints--; break;
      case 'Boundary':   if (this.s && this.s.depth.boundary > 0) this.s.depth.boundary--; break;
      case 'Contour':    if (this.s && this.s.depth.contour > 0) this.s.depth.contour--; break;
      case 'Surface': this.endSurface(); break;
    }
  }

  text(chunk: string): void {
    if (this.pText !== null) this.pText += chunk;
    else if (this.fText !== null) this.fText += chunk;
    else if (this.list) this.list.sink.push(chunk);
  }

  // ---- element semantics --------------------------------------------------

  private beginSurface(name: string | undefined): void {
    if (this.s) this.endSurface(); // tolerate missing </Surface>
    this.s = {
      name: name ?? `Surface ${this.surfaces.length + 1}`,
      report: emptyReport(),
      pos: new GrowableF64(),
      ids: new GrowableU32(),
      idsContiguous: true,
      idToIndex: null,
      maxDecimals: 0,
      faces: new GrowableU32(),
      faceFlags: null,
      breaklines: [],
      boundaries: [],
      contours: 0,
      contourPolys: [],
      sourceDataListCount: 0,
      sourceDataPointTotal: 0,
      skippedPoints: 0,
      skippedFaces: 0,
      missingIdWarned: false,
      depth: { sourceData: 0, dataPoints: 0, breaklines: 0, breakline: 0, boundary: 0, contour: 0 },
    };
  }

  private beginList(dims: 2 | 3): void {
    const s = this.s;
    let target: ListTarget = 'ignore';
    if (s) {
      if (s.depth.breakline > 0) {
        target = 'breakline-spec'; // spec <Breaklines><Breakline><PntList…> (schema-derived)
      } else if (s.depth.sourceData > 0 && s.depth.dataPoints > 0) {
        // CARLSON-ASSUMPTION (corrected, Sprint 4 Phase 0 — investigation-verified): Carlson's
        // <SourceData><DataPoints><PntList3D> lists are the surface's COMPLETE point inventory
        // paginated at 256 points/chunk, NOT breaklines (the earlier "11 breaklines" reading
        // produced polyline spaghetti). Evidence in docs/01 §1: all list points match <Pnts>
        // in exact id order; consecutive "vertices" jump up to 2,650 ft. These lists are
        // NEVER classified as breaklines — counted for the ImportReport only.
        // Spec <Breaklines> remains the only breakline source.
        target = 'source-data-points';
      } else if (s.depth.boundary > 0) {
        target = 'boundary';
      } else if (s.depth.contour > 0) {
        target = 'contour'; // stored per contract rev 1.1 — rendering arrives in a later sprint
      }
      // PntList anywhere else: ignored for now (Sprint 3+).
    }
    this.list = { sink: new NumberStream(), dims, target };
  }

  private endPoint(): void {
    const s = this.s;
    const text = this.pText;
    const idAttr = this.pId;
    this.pText = null;
    this.pId = null;
    if (!s || text === null) return;

    const toks = text.trim().split(WS_RE);
    // CARLSON-ASSUMPTION: <P> coordinate order is "Northing Easting Elevation" (N E Z) —
    // sample-verified against Carlson output only; LandXML spec agrees but other vendors
    // have not been checked. Stored swapped: x=Easting, y=Northing, z=Elevation.
    const nVal = Number(toks[0]);
    const eVal = Number(toks[1]);
    const zVal = Number(toks[2]);
    if (toks.length < 3 || !Number.isFinite(nVal) || !Number.isFinite(eVal) || !Number.isFinite(zVal)) {
      s.skippedPoints++;
      capWarn(s.report, `skipped malformed <P> (id ${idAttr ?? '?'}): "${text.trim().slice(0, 40)}"`);
      return;
    }
    if (toks.length > 3) capWarn(s.report, `<P> with ${toks.length} values — extra values ignored`);

    const index = s.ids.length;
    let id: number;
    if (idAttr !== null && Number.isFinite(idAttr) && idAttr >= 0) {
      id = idAttr;
    } else {
      id = index + 1;
      if (!s.missingIdWarned) {
        s.missingIdWarned = true;
        capWarn(s.report, '<P> without id attribute — sequential ids assigned');
      }
    }
    if (id !== index + 1) s.idsContiguous = false;
    s.ids.push(id);
    s.pos.push(eVal);
    s.pos.push(nVal);
    s.pos.push(zVal);
    for (let i = 0; i < 3; i++) {
      const d = decimalsOf(toks[i] as string);
      if (d > s.maxDecimals) s.maxDecimals = d;
    }
  }

  private endFace(): void {
    const s = this.s;
    const text = this.fText;
    const invisible = this.fInvisible;
    this.fText = null;
    this.fInvisible = false;
    if (!s || text === null) return;

    const toks = text.trim().split(WS_RE);
    if (toks.length < 3) {
      s.skippedFaces++;
      capWarn(s.report, `skipped malformed <F>: "${text.trim().slice(0, 40)}"`);
      return;
    }
    const a = this.resolvePointId(s, Number(toks[0]));
    const b = this.resolvePointId(s, Number(toks[1]));
    const c = this.resolvePointId(s, Number(toks[2]));
    if (a === undefined || b === undefined || c === undefined) {
      s.skippedFaces++;
      capWarn(s.report, `skipped <F> referencing unknown point id: "${text.trim().slice(0, 40)}"`);
      return;
    }
    // <F> uses 1-based source point ids → emitted as 0-based indices into positions.
    s.faces.push(a);
    s.faces.push(b);
    s.faces.push(c);
    const faceCount = s.faces.length / 3;
    if (invisible && !s.faceFlags) {
      s.faceFlags = new Array<number>(faceCount - 1).fill(1); // backfill earlier faces as visible
    }
    if (s.faceFlags) s.faceFlags.push(invisible ? 0 : 1);
  }

  private resolvePointId(s: SurfBuild, id: number): number | undefined {
    if (!Number.isFinite(id)) return undefined;
    if (s.idsContiguous) {
      return id >= 1 && id <= s.ids.length ? id - 1 : undefined;
    }
    if (!s.idToIndex) {
      s.idToIndex = new Map();
      for (let i = 0; i < s.ids.length; i++) s.idToIndex.set(s.ids.at(i), i);
    }
    return s.idToIndex.get(id);
  }

  private endList(): void {
    const list = this.list;
    this.list = null;
    if (!list) return;
    list.sink.flush();
    const s = this.s;
    if (!s || list.target === 'ignore') return;

    if (list.target === 'source-data-points') {
      // Informational only (rev 1.2): count lists + points, store nothing, render nothing.
      s.sourceDataListCount++;
      s.sourceDataPointTotal += Math.floor(list.sink.values.length / list.dims);
      return;
    }

    const raw = list.sink.values.toArray();
    const dims = list.dims;
    if (list.sink.badTokens > 0) {
      capWarn(s.report, `${list.sink.badTokens} non-numeric token(s) in point list — skipped`);
    }
    if (raw.length % dims !== 0) {
      capWarn(s.report, `point list length ${raw.length} not divisible by ${dims} — trailing value(s) dropped`);
    }
    const m = Math.floor(raw.length / dims);
    const pts = new Float64Array(m * 3);
    for (let i = 0; i < m; i++) {
      // CARLSON-ASSUMPTION: PntList tuples are N E (Z) order matching <P> — sample-verified
      // for Carlson <SourceData> lists; assumed identical for spec lists (schema-derived).
      const nVal = raw[i * dims] as number;
      const eVal = raw[i * dims + 1] as number;
      const zVal = dims === 3 ? (raw[i * dims + 2] as number) : 0;
      pts[i * 3] = eVal;
      pts[i * 3 + 1] = nVal;
      pts[i * 3 + 2] = zVal;
    }
    if (dims === 2) s.report.infos.push('PntList2D — elevations set to 0');
    if (list.sink.maxDecimals > s.maxDecimals) s.maxDecimals = list.sink.maxDecimals;

    switch (list.target) {
      case 'breakline-spec':
        s.breaklines.push({ pts, sourceSpelling: 'spec-breaklines' });
        break;
      case 'boundary':
        s.boundaries.push({ pts, kind: this.boundaryKind });
        break;
      case 'contour':
        s.contourPolys.push({ pts });
        break;
    }
  }

  private endSurface(): void {
    const s = this.s;
    this.s = null;
    if (!s) return;
    const report = s.report;

    const positions = s.pos.toArray();
    const sourcePointIds = s.ids.toArray();
    const indices = s.faces.length > 0 ? s.faces.toArray() : null;
    const triangulationPreserved = indices !== null;
    if (!triangulationPreserved) {
      capWarn(report, 'no faces — triangulation rebuild required');
    }
    report.triangulationPreserved = triangulationPreserved;
    report.counts['points'] = sourcePointIds.length;
    report.counts['faces'] = indices ? indices.length / 3 : 0;
    report.counts['breaklines'] = s.breaklines.length;
    report.counts['boundaries'] = s.boundaries.length;
    if (s.skippedPoints) report.counts['skippedPoints'] = s.skippedPoints;
    if (s.skippedFaces) report.counts['skippedFaces'] = s.skippedFaces;
    if (s.contours) {
      report.counts['contours'] = s.contours;
      report.infos.push(`${s.contours} contour(s) stored from source data — not rendered yet (later sprint)`);
    }
    if (s.sourceDataListCount > 0) {
      report.counts['sourceDataPointLists'] = s.sourceDataListCount;
      report.infos.push(
        `${s.sourceDataListCount} source-data point lists (${s.sourceDataPointTotal.toLocaleString()} points) — informational, not rendered`,
      );
    }

    let units = this.units;
    if (!units) {
      capWarn(report, 'no <Units> element — assuming meter');
      units = { linear: 'meter', raw: '' };
    }
    const meta: SourceMeta = {
      fileName: this.fileName,
      format: 'landxml',
      producer: this.producer,
      formatVersion: this.formatVersion,
      units,
    };

    this.surfaces.push({
      id: newSurfaceId(),
      name: s.name,
      meta,
      positions,
      precisionHint: s.maxDecimals,
      sourcePointIds,
      indices,
      faceVisibility: s.faceFlags ? Uint8Array.from(s.faceFlags) : null,
      edges: null, // LandXML carries no source edge records (Carlson DTM binary does — Sprint 5 spike)
      breaklines: s.breaklines,
      boundaries: s.boundaries,
      ...(s.contourPolys.length ? { contours: s.contourPolys } : {}),
      ...(s.sourceDataListCount > 0
        ? { sourceDataPointLists: { count: s.sourceDataListCount, totalPoints: s.sourceDataPointTotal } }
        : {}),
      report,
      provenance: 'source-explicit',
      dirty: false,
    });
  }

  finish(): SurfaceModel[] {
    if (this.s) this.endSurface(); // tolerate truncated input
    // File-level diagnostics (unknown elements outside any <Surface>, units fallbacks) live
    // ONCE in report.fileLevel — emitted on the FIRST surface's report (contract rev 1.1,
    // docs/06 C3 design rule). Per-surface reports no longer duplicate them.
    // If the file yields zero surfaces, file-level diagnostics are dropped (the import UI
    // shows a generic "no surfaces" message in that case) — documented in NOTES.md.
    const f = this.fileReport;
    const first = this.surfaces[0];
    if (first && (f.warnings.length || f.infos.length || Object.keys(f.unknownElements).length)) {
      first.report.fileLevel = {
        warnings: [...f.warnings],
        infos: [...f.infos],
        unknownElements: { ...f.unknownElements },
      };
    }
    return this.surfaces;
  }
}
