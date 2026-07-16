// src/shared/building-catalog.ts - definitions for beta BUILDINGS (envelope
// first, then evidence-fitted faces). A building is a normal authored feature
// (family 'building', subtype 'envelope') whose drawn envelope boundary
// doubles as its isolate/focus area. Faces, roof planes and face-hosted
// features are COMPONENTS stored under feature.metadata.building - real
// inspectable records (plane + extents + dims + evidence summary), never big
// raw point arrays and never baked display geometry. Definitions only:
// fitting math and display generators live in viewer/buildingGenerators.ts.
// The legacy parametric massing templates (flat/gable/hip) are untouched.

import type { FeatureTemplate, TemplateParamSpec } from './template-catalog';

export type XYZ = [number, number, number];

export const BUILDING_ENVELOPE_TEMPLATE_ID = 'building.envelope';

export type BuildingRoofTypeId = 'flat' | 'gable' | 'hip' | 'shed' | 'complex' | 'unknown';

export const BUILDING_ROOF_TYPES: BuildingRoofTypeId[] = ['flat', 'gable', 'hip', 'shed', 'complex', 'unknown'];

// ---------------------------------------------------------------------------
// Face components
// ---------------------------------------------------------------------------

export type BuildingFaceKind = 'wall' | 'roof' | 'floor' | 'soffit' | 'generic';

export const BUILDING_FACE_KIND_LABELS: Record<BuildingFaceKind, string> = {
  wall: 'Wall',
  roof: 'Roof plane',
  floor: 'Floor',
  soffit: 'Soffit',
  generic: 'Generic face',
};

export function faceKindLabel(kind: string | undefined): string {
  return kind && kind in BUILDING_FACE_KIND_LABELS ? BUILDING_FACE_KIND_LABELS[kind as BuildingFaceKind] : 'Face';
}

/**
 * Orthonormal in-plane frame for a fitted face. xAxis is the horizontal
 * "length" direction, yAxis the in-plane perpendicular (vertical on walls,
 * up-slope on roof planes). Normals are unit vectors with a deterministic
 * orientation so refits are reproducible.
 */
export interface BuildingPlaneRecord {
  origin: XYZ;
  normal: XYZ;
  xAxis: XYZ;
  yAxis: XYZ;
}

/**
 * One authored face/roof plane. Extents are plane coordinates about the
 * origin (u along xAxis, v along yAxis) - enough to rebuild the display quad
 * without persisting geometry. Evidence stays a summary: count + a bounded
 * representative sample of the points the user fitted from.
 */
export interface BuildingFaceRecord {
  id: string;
  name: string;
  kind: BuildingFaceKind;
  plane: BuildingPlaneRecord;
  extents: { minU: number; maxU: number; minV: number; maxV: number };
  /** RMS point-to-plane distance of the fitting evidence (fit quality). */
  fitRms: number;
  evidence: { count: number; representative: XYZ[] };
  visible: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Face-hosted features
// ---------------------------------------------------------------------------

export type BuildingFaceFeatureType = 'door' | 'window' | 'chimney' | 'vent' | 'opening' | 'generic';

export const BUILDING_FACE_FEATURE_TYPES: BuildingFaceFeatureType[] = [
  'door',
  'window',
  'chimney',
  'vent',
  'opening',
  'generic',
];

export const BUILDING_FACE_FEATURE_LABELS: Record<BuildingFaceFeatureType, string> = {
  door: 'Door',
  window: 'Window',
  chimney: 'Chimney',
  vent: 'Vent',
  opening: 'Opening',
  generic: 'Generic feature',
};

export function faceFeatureTypeLabel(type: string | undefined): string {
  return type && type in BUILDING_FACE_FEATURE_LABELS
    ? BUILDING_FACE_FEATURE_LABELS[type as BuildingFaceFeatureType]
    : 'Feature';
}

/**
 * A feature hosted BY a face (faceId is the host key - features never float
 * on the building). Position is local face coordinates measured from the
 * face's min corner: offsetU along the face length, offsetV above the face
 * bottom (the sill height on walls). depth is the out-of-plane thickness
 * (chimneys read it as their rise above the roof plane).
 */
export interface BuildingFaceFeatureRecord {
  id: string;
  faceId: string;
  name: string;
  type: BuildingFaceFeatureType;
  offsetU: number;
  offsetV: number;
  width: number;
  height: number;
  depth: number;
  visible: boolean;
  createdAt: string;
}

/** The metadata.building payload on an envelope building feature. */
export interface BuildingComponentsRecord {
  faces: BuildingFaceRecord[];
  faceFeatures: BuildingFaceFeatureRecord[];
}

export function emptyBuildingComponents(): BuildingComponentsRecord {
  return { faces: [], faceFeatures: [] };
}

/** Beta default sizes per hosted-feature type (feet); all editable after add. */
export function defaultFaceFeatureSize(type: BuildingFaceFeatureType): { width: number; height: number; depth: number } {
  switch (type) {
    case 'door':
      return { width: 3, height: 7, depth: 0.5 };
    case 'window':
      return { width: 3, height: 4, depth: 0.5 };
    case 'chimney':
      return { width: 2, height: 2, depth: 4 };
    case 'vent':
      return { width: 1, height: 1, depth: 0.5 };
    case 'opening':
      return { width: 4, height: 4, depth: 0.5 };
    default:
      return { width: 2, height: 2, depth: 1 };
  }
}

// ---------------------------------------------------------------------------
// The envelope template
// ---------------------------------------------------------------------------

function num(name: string, label: string, def: number, range?: { min?: number; max?: number }): TemplateParamSpec {
  return { name, label, type: 'number', default: def, ...range };
}

function str(name: string, label: string, def = ''): TemplateParamSpec {
  return { name, label, type: 'string', default: def };
}

function pick(name: string, label: string, def: string, options: string[]): TemplateParamSpec {
  return { name, label, type: 'enum', default: def, options };
}

/**
 * The beta envelope-first building. Roof type is a PARAMETER here (not the
 * subtype like the legacy massing templates) because envelope buildings get
 * their shape from authored faces, not from a parametric roof generator.
 * Elevations are optional field notes, so they are free-text (empty = unset)
 * rather than numbers forced to a fake default.
 */
export const BUILDING_ENVELOPE_TEMPLATE: FeatureTemplate = {
  id: BUILDING_ENVELOPE_TEMPLATE_ID,
  family: 'building',
  subtype: 'envelope',
  displayName: 'Building (envelope)',
  paramSchema: [
    pick('buildingUse', 'Building type/use', 'unknown', [
      'residential',
      'commercial',
      'industrial',
      'agricultural',
      'accessory',
      'unknown',
    ]),
    pick('roofType', 'Roof type', 'unknown', [...BUILDING_ROOF_TYPES]),
    pick('roofMaterial', 'Roof material', 'unknown', ['shingle', 'metal', 'membrane', 'tile', 'wood', 'unknown']),
    pick('wallMaterial', 'Wall material', 'unknown', ['brick', 'siding', 'stucco', 'concrete', 'metal', 'wood', 'unknown']),
    num('numberOfLevels', 'Number of levels', 1, { min: 0 }),
    str('baseElevation', 'Base elevation'),
    str('finishedFloorElevation', 'Finished floor elevation'),
    str('eaveElevation', 'Eave elevation'),
    str('ridgeElevation', 'Ridge elevation'),
    str('topElevation', 'Top elevation'),
    pick('sourceType', 'Source', 'surveyed', ['surveyed', 'measured', 'photo', 'inferred', 'manual', 'unknown']),
    str('notes', 'Notes'),
  ],
  cad: {
    layers: {
      envelope: 'BLDG-ENVELOPE',
      face: 'BLDG-FACE',
      roof: 'BLDG-ROOF',
      feature: 'BLDG-FEATURE',
    },
  },
  report: { quantityKind: 'area' },
};
