// src/viewer — imperative Three.js engine + derived render state.
// DEPENDENCY RULE: ui → viewer → core, never backwards. NO React imports anywhere in here.
export { ViewerEngine, DEFAULT_SUN } from './ViewerEngine';
export type {
  CameraMode,
  EditCommitCallback,
  EditMessageCallback,
  CursorCallback,
  EditTool,
  EditDragCallback,
  EditSelectionCallback,
  FrameStatsCallback,
  LabelStatusCallback,
} from './ViewerEngine';
export { DEFAULT_SURFACE_COLOR, DEFAULT_BOUNDARY_COLOR } from './RenderSurface';
export type { OverlayKind, ResolvedDisplay, ResolvedElement } from './RenderSurface';
export { DEFAULT_DENSIFY_FT, DRAPE_OFFSET_FT, densifyPolyline } from './RenderDxf';
export type { DxfDrapeResult, DxfLayerDisplay } from './RenderDxf';
export { LABEL_CAP } from './labels';
export { generateTestMesh } from './synthetic';
export {
  buildVertexFaceAdjacency,
  computeVertexNormals,
  pickClosestScreenPoint,
  recomputeAffectedVertexNormals,
  worldUnitsPerPixel,
} from './editing';
