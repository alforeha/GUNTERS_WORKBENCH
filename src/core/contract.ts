// src/core/contract.ts — THE normalized contract. All parsers emit this; all consumers read this.
// Revision 1.2 (docs/08 Phase 0/2, lead-approved):
//   - Breakline.sourceSpelling loses 'carlson-sourcedata' — investigation proved Carlson's
//     <SourceData><DataPoints> lists are the paginated point inventory, NOT breaklines.
//   - SurfaceModel.sourceDataPointLists? records that inventory (count + totalPoints) for
//     honest import reporting; the lists themselves are not stored or rendered.
//   - DxfDataset family added (docs/04 §4) — DXF linework normalized for draping.
// Revision 1.1 (docs/06 D1, PM-approved): SurfaceModel.contours + ImportReport.fileLevel;
// helpers moved to their only consumer (parse.ts) so this file stays pure types. FROZEN again.

export interface SourceMeta {            // 1. source metadata
  fileName: string; format: 'landxml' | 'carlson-dtm' | 'dxf' | 'geotiff' | 'pdf' | 'las' | 'synthetic';
  producer?: string;                     // e.g. "Carlson Survey 2021"
  formatVersion?: string;                // e.g. "LandXML-1.2", "DTM rev 24603"
  units: { linear: 'usSurveyFoot' | 'foot' | 'meter' | 'unknown'; raw: string };
}

export interface SurfaceModel {
  id: string; name: string;
  meta: SourceMeta;
  positions: Float64Array;               // 2. ORIGINAL coords, x=Easting y=Northing z=Elev, full precision, never mutated by rendering
  precisionHint: number;                 //    max decimal places seen in source (for faithful export)
  sourcePointIds: Uint32Array;           // 4. original ids (may be sparse) — preserved for export
  indices: Uint32Array | null;           // 5. faces (0-based); null = no faces in file → requiresRebuild
  faceVisibility: Uint8Array | null;     //    from <F i="1"> flags
  edges: Uint32Array | null;             // 6. source-defined edge records (pairs), if format provides them (Carlson DTM does); derived render edges are computed downstream, not stored here
  breaklines: Breakline[];               // 7.
  boundaries: Boundary[];                // 8.
  contours?: Polyline3D[];               //    from <Contours> source data — stored, not rendered yet (rev 1.1)
  /** Carlson SourceData/DataPoints inventory (paginated copy of <Pnts> — informational only,
   *  never rendered; rev 1.2). */
  sourceDataPointLists?: { count: number; totalPoints: number };
  report: ImportReport;                  // 9. diagnostics, persisted with dataset
  provenance: 'source-explicit' | 'rebuilt-delaunay' | 'modified'; // 10.
  dirty: boolean;
}
// 3. Local rebased Float32 coords are NOT stored on SurfaceModel — they are derived render
//    state owned by the viewer (RenderSurface), regenerated from positions + SceneOrigin.

export interface Polyline3D { pts: Float64Array }

// ── DXF dataset (rev 1.2, docs/04 §4 + docs/08 Phase 2) ─────────────────────
// DXF linework is normalized to flat polylines for draping. Source XY is kept forever
// (drape is a recompute against a chosen target surface — never a mutation).

export interface DxfLayer {
  name: string;
  /** resolved RGB (0xRRGGBB) from the layer's ACI color */
  colorRGB: number;
  linetype: string;   // e.g. 'CONTINUOUS', 'DASHED'
  /** lineweight in 1/100 mm (DXF group 370); −3 = default */
  lineweight: number;
  /** layer off (negative color) or frozen in the source file */
  hidden: boolean;
}

export interface DxfEntity {
  layer: string;
  /** resolved RGB (0xRRGGBB) — ByLayer/ByBlock already resolved at parse */
  colorRGB: number;
  kind: 'polyline';
  /** x,y,z triplets — source coordinates, full precision */
  pts: Float64Array;
  closed: boolean;
  /** true when the source entity carried real elevations (nonzero Z) */
  hasZ: boolean;
}

/** POINT entities: stored + counted, not rendered this sprint — they feed the future
 *  POINT tab / CSV track (docs/08 Phase 2). */
export interface DxfPoint {
  id: number;
  x: number; y: number; z: number;
  layer: string;
}

export interface DxfDataset {
  id: string;
  name: string;
  meta: SourceMeta; // format: 'dxf'
  layers: DxfLayer[];
  entities: DxfEntity[];
  points: DxfPoint[];
  report: ImportReport;
}

export interface RasterBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface GeoTransform {
  pixelScale: [number, number];
  origin: [number, number];
  tiepoint: [number, number, number, number, number, number] | null;
  source: 'embedded' | 'world-file';
}

export interface GeotiffDataset {
  id: string;
  name: string;
  meta: SourceMeta; // format: 'geotiff'
  width: number;
  height: number;
  samplesPerPixel: number;
  bitsPerSample: number[];
  tileWidth: number;
  tileHeight: number;
  isTiled: boolean;
  crsText: string | null;
  geoTransform: GeoTransform | null;
  worldBounds: RasterBounds | null;
  report: ImportReport;
}

export interface PdfPageInfo {
  pageIndex: number;
  widthPt: number;
  heightPt: number;
  widthPx150: number;
  heightPx150: number;
  rotation: number;
}

export interface PdfDocumentDataset {
  id: string;
  name: string;
  meta: SourceMeta; // format: 'pdf'
  pageCount: number;
  pages: PdfPageInfo[];
  title: string | null;
  creator: string | null;
  producer: string | null;
  creationDate: string | null;
  modificationDate: string | null;
  report: ImportReport;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CropPolygon = { kind: 'polygon'; points: [number, number][] };
export type CropRect = { kind: 'rect'; x: number; y: number; width: number; height: number };
export type BorderCrop = CropRect | CropPolygon;

export interface PdfCalibration {
  method: 'scale-value' | 'scale-bar' | 'known-distance';
  pixelsPerUnit: number;
  unit: 'foot' | 'meter';
  label: string;
}

export interface PdfPlacementPointPair {
  pdf: { x: number; y: number };
  world: { x: number; y: number; z: number };
}

export interface PdfPlacement {
  pairs: PdfPlacementPointPair[];
  anchorTranslation: { x: number; y: number; z: number };
  anchorRotationDeg: number;
  scale: number;
  residualFt: number | null;
}

export interface BlockOutPolygon {
  id: string;
  label: string;
  visible: boolean;
  points: { x: number; y: number }[];
}

export interface PdfMarkup {
  id: string;
  type: 'highlight' | 'polyline' | 'callout';
  label: string;
  visible: boolean;
  color: string;
  opacity: number;
  lineWeight?: number;
  fontSize?: number;
  points: { x: number; y: number }[];
  text?: string;
}
export interface PdfNorthArrow {
  /** center position in sheet pixel space (150 dpi) */
  x: number;
  y: number;
  /** clockwise degrees from true north (0 = arrow pointing up) */
  angleDeg: number;
  color: string;   // '#rrggbb'
  visible: boolean;
}

export interface PdfScaleBar {
  /** center in sheet pixel space (150 dpi) */
  x: number;
  y: number;
  /** real-world feet the 150px bar represents; null until Set */
  realWorldFt: number | null;
  color: string;
  visible: boolean;
}

export interface PdfKnownDistance {
  begin: { x: number; y: number };
  end: { x: number; y: number };
  /** real-world feet the measured segment represents; null until Set */
  realWorldFt: number | null;
  color: string;
  visible: boolean;
}

export interface PointCloudBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface PointCloudOctreeNode {
  id: number;
  depth: number;
  bounds: PointCloudBounds;
  localBounds: PointCloudBounds;
  pointCount: number;
  sampleCount: number;
  positions: Float32Array;
  colors: Uint8Array;
  intensities: Float32Array;
  classifications: Uint8Array;
  /** LAS return number per sampled point (1-based). Always present; single-return files = all 1. */
  returnNumbers: Uint8Array;
  /** LAS number-of-returns per sampled point. Single-return files = all 1. */
  numberOfReturns: Uint8Array;
  children: PointCloudOctreeNode[];
}

export interface PointCloudOctree {
  origin: [number, number, number];
  maxDepth: number;
  targetLeafPointCount: number;
  totalSampledPoints: number;
  /** Distinct classification codes present across all sampled points (ascending). */
  presentClasses: number[];
  /** Distinct return numbers present across all sampled points (ascending). */
  presentReturns: number[];
  /** Max number-of-returns seen — >1 means the file is multi-return. */
  maxReturnCount: number;
  /** Z range across the whole cloud (world coords) for elevation colormap. */
  zRange: [number, number];
  root: PointCloudOctreeNode;
}

export interface LasAttributeSummary {
  hasIntensity: boolean;
  hasReturns: boolean;
  hasClassification: boolean;
  hasClassificationFlags: boolean;
  hasUserData: boolean;
  hasScanAngle: boolean;
  hasPointSourceId: boolean;
  hasGpsTime: boolean;
  hasRgb: boolean;
  intensityRange: [number, number] | null;
  rgbRange: [[number, number, number], [number, number, number]] | null;
  sampledPoints: number;
  classificationCounts: Record<string, number>;
  returnNumberCounts: Record<string, number>;
  numberOfReturnsCounts: Record<string, number>;
  userDataCounts: Record<string, number>;
}

export interface PointCloudDataset {
  id: string;
  name: string;
  meta: SourceMeta; // format: 'las'
  lasVersion: string;
  pointFormat: number;
  pointRecordLength: number;
  pointCount: number;
  offsetToPointData: number;
  vlrCount: number;
  scale: [number, number, number];
  offset: [number, number, number];
  bounds: PointCloudBounds;
  attributes: LasAttributeSummary;
  pointDensityPerSqFt: number | null;
  octree?: PointCloudOctree;
  report: ImportReport;
}
export interface Breakline { pts: Float64Array; sourceSpelling: 'spec-breaklines' | 'dxf' }
export interface Boundary  { pts: Float64Array; kind: 'outer' | 'inclusion' | 'exclusion' }
export interface ImportReport {
  counts: Record<string, number>;        // points, faces, breaklines, boundaries, skipped entities…
  triangulationPreserved: boolean;
  warnings: string[]; infos: string[]; unknownElements: Record<string, number>;
  fileLevel?: { warnings: string[]; infos: string[]; unknownElements: Record<string, number> };
  // file-scope diagnostics live here ONCE (emitted on the first surface's report);
  // per-surface reports no longer duplicate them (rev 1.1).
}
