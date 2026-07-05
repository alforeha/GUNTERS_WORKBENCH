// src/core — normalized data model, parsers, exporters.
// DEPENDENCY RULE: ui → viewer → core, never backwards.
// core has NO Three.js imports and NO React imports; it is unit-testable in Node.
// Owned by Agent B (except contract.ts is shared, PM-reviewed, change-controlled).
export * from './contract';
export * from './detect';
export * from './derivedBoundary';
export { parseDxf, type ParseDxfOptions } from './dxf/parse';
export { DEFAULT_CHORD_TOL } from './dxf/tessellate';
export {
  buildGeotiffDataset,
  boundsFromTransform,
  parseWorldFile,
  reportForGeotiff,
  sourceMetaForGeotiff,
  type GeotiffMetadataInput,
  type ParsedWorldFile,
} from './geotiff/metadata';
export { buildPdfDataset, reportForPdf, sourceMetaForPdf, type PdfMetadataInput } from './pdf/metadata';
export {
  writeLandXML,
  type LandXMLWriteOptions,
  type LandXMLWriteStats,
  type SurfaceExportSummary,
} from './landxml/write';
export { parseLasMetadata, sampleAttributes, type LasMetadataInput } from './las/metadata';
