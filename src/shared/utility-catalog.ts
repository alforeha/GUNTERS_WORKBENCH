// src/shared/utility-catalog.ts - the seed catalog of utility templates for
// beta Utilities (Generic + Storm). A utility is a normal authored feature
// (family 'utility') whose template carries TWO orthogonal identities:
//   - utilitySystem: which network/group it belongs to (generic | storm)
//   - utilityClass:  which physical object it is (manhole, pipe, stub, ...)
// The stored FeatureRecord is creation-rail agnostic: whether a utility is
// placed by hand today or arrives from point codes / PNEZDA / recognition
// later, the record shape is identical. Definitions only - display geometry
// lives in viewer/utilityGenerators.ts. No network graph: connection params
// are plain optional text metadata, never traced or validated.

import type { FeatureTemplate, TemplateParamSpec } from './template-catalog';

export type UtilitySystemId = 'generic' | 'storm';

export const UTILITY_SYSTEM_LABELS: Record<UtilitySystemId, string> = {
  generic: 'Generic',
  storm: 'Storm',
};

export type UtilityClassId =
  | 'structure'
  | 'box'
  | 'vault'
  | 'lid'
  | 'manhole'
  | 'pole'
  | 'inlet'
  | 'culvert'
  | 'pipe'
  | 'stub';

export const UTILITY_CLASS_LABELS: Record<UtilityClassId, string> = {
  structure: 'Structure',
  box: 'Box',
  vault: 'Vault',
  lid: 'Lid',
  manhole: 'Manhole',
  pole: 'Pole',
  inlet: 'Inlet',
  culvert: 'Culvert',
  pipe: 'Pipe/Line',
  stub: 'Stub',
};

/** Point classes place one pin; line classes place a 2+ vertex alignment. */
export type UtilityGeometryKind = 'point' | 'line';

const CLASS_GEOMETRY: Record<UtilityClassId, UtilityGeometryKind> = {
  structure: 'point',
  box: 'point',
  vault: 'point',
  lid: 'point',
  manhole: 'point',
  pole: 'point',
  inlet: 'point',
  culvert: 'line',
  pipe: 'line',
  stub: 'line',
};

export function utilityClassGeometry(classId: UtilityClassId): UtilityGeometryKind {
  return CLASS_GEOMETRY[classId];
}

export function utilityTemplateGeometry(template: FeatureTemplate): UtilityGeometryKind | null {
  return template.utilityClass ? CLASS_GEOMETRY[template.utilityClass] : null;
}

// ---------------------------------------------------------------------------
// Param spec builders (local copies of the tiny template-catalog helpers)
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

const yawParam = num('rotationYaw', 'Rotation / yaw', 0, { min: -180, max: 180 });
const notesParam = str('notes', 'Notes');
const sourceParam = pick('sourceType', 'Source', 'surveyed', [
  'surveyed',
  'pothole',
  'painted-mark',
  'inferred',
  'manual',
  'unknown',
]);

const pipeShapeParam = pick('pipeShape', 'Pipe shape', 'round', ['round', 'box', 'elliptical', 'arch', 'unknown']);
const stormMaterialParam = pick('material', 'Material', 'RCP', ['RCP', 'CMP', 'HDPE', 'PVC', 'concrete-box', 'unknown']);
const genericMaterialParam = pick('material', 'Material', 'unknown', [
  'PVC',
  'HDPE',
  'steel',
  'concrete',
  'RCP',
  'CMP',
  'unknown',
]);
const flowDirectionParam = pick('flowDirection', 'Flow direction', 'with-line', ['with-line', 'against-line', 'unknown']);

/**
 * Endpoint elevation handling for line runs. 'as-placed' means the placed
 * vertex Z governs; invert/depth store a known value in the paired text param;
 * assumed/unknown are honest field states. Beta records these - it does not
 * re-drape the drawn alignment from them.
 */
function elevationModeParams(end: 'start' | 'end'): TemplateParamSpec[] {
  const label = end === 'start' ? 'Start' : 'End';
  return [
    pick(`${end}ElevationMode`, `${label} elevation mode`, 'as-placed', ['as-placed', 'invert', 'depth', 'assumed', 'unknown']),
    str(`${end}ElevationValue`, `${label} invert/depth value`),
  ];
}

/** Optional plain-text references only - NOT a network graph, never traced. */
const connectionParams: TemplateParamSpec[] = [
  str('startConnection', 'Start connects to'),
  str('endConnection', 'End connects to'),
];

const lidTypeParam = pick('lidType', 'Lid type', 'solid', ['solid', 'grate', 'unknown']);

// ---------------------------------------------------------------------------
// Template builder
// ---------------------------------------------------------------------------

interface UtilityTemplateOpts {
  /** Point classes: pin at center 'bottom' (above-ground) or center 'top' (below-ground). */
  origin?: 'bottom' | 'top';
  params: TemplateParamSpec[];
  pointCode: string;
  layer: string;
}

function utilityTemplate(
  system: UtilitySystemId,
  classId: UtilityClassId,
  opts: UtilityTemplateOpts,
): FeatureTemplate {
  const subtype = `${system}-${classId}`;
  const geometry = CLASS_GEOMETRY[classId];
  return {
    id: `utility.${subtype}`,
    family: 'utility',
    subtype,
    displayName: UTILITY_CLASS_LABELS[classId],
    utilitySystem: system,
    utilityClass: classId,
    ...(opts.origin ? { utilityOrigin: opts.origin } : {}),
    paramSchema: [...opts.params, sourceParam, notesParam],
    reality: { primitive: `utility-${classId}` },
    cad: { layer: opts.layer, pointCode: opts.pointCode },
    report: { quantityKind: geometry === 'line' ? 'length' : 'count' },
  };
}

const GENERIC_LAYER = 'UTIL-GENERIC';
const STORM_LAYER = 'UTIL-STORM';

export const UTILITY_TEMPLATES: FeatureTemplate[] = [
  // Generic system: broad/flexible classes for unidentified or misc utilities.
  utilityTemplate('generic', 'structure', {
    origin: 'bottom',
    params: [num('width', 'Width', 3, { min: 0 }), num('length', 'Length', 3, { min: 0 }), num('height', 'Height', 4, { min: 0 }), yawParam],
    pointCode: 'USTR',
    layer: GENERIC_LAYER,
  }),
  utilityTemplate('generic', 'box', {
    origin: 'bottom',
    params: [num('width', 'Width', 2, { min: 0 }), num('length', 'Length', 2, { min: 0 }), num('height', 'Height', 2, { min: 0 }), yawParam],
    pointCode: 'UBOX',
    layer: GENERIC_LAYER,
  }),
  utilityTemplate('generic', 'vault', {
    origin: 'top',
    params: [num('width', 'Width', 5, { min: 0 }), num('length', 'Length', 8, { min: 0 }), num('depth', 'Depth', 7, { min: 0 }), yawParam],
    pointCode: 'UVLT',
    layer: GENERIC_LAYER,
  }),
  utilityTemplate('generic', 'lid', {
    origin: 'top',
    params: [num('diameter', 'Diameter', 2, { min: 0 }), num('thickness', 'Thickness', 0.3, { min: 0 }), lidTypeParam],
    pointCode: 'ULID',
    layer: GENERIC_LAYER,
  }),
  utilityTemplate('generic', 'manhole', {
    origin: 'top',
    params: [num('diameter', 'Diameter', 4, { min: 0 }), num('depth', 'Depth', 6, { min: 0 }), lidTypeParam],
    pointCode: 'UMH',
    layer: GENERIC_LAYER,
  }),
  utilityTemplate('generic', 'pole', {
    origin: 'bottom',
    params: [num('diameter', 'Diameter', 1, { min: 0 }), num('height', 'Height', 20, { min: 0 })],
    pointCode: 'UPOLE',
    layer: GENERIC_LAYER,
  }),
  utilityTemplate('generic', 'pipe', {
    params: [
      num('pipeSize', 'Pipe size (in)', 6, { min: 0 }),
      pipeShapeParam,
      genericMaterialParam,
      num('boxSpan', 'Box span (ft)', 4, { min: 0 }),
      num('boxRise', 'Box rise (ft)', 3, { min: 0 }),
      flowDirectionParam,
      ...elevationModeParams('start'),
      ...elevationModeParams('end'),
      ...connectionParams,
    ],
    pointCode: 'UPIPE',
    layer: GENERIC_LAYER,
  }),
  utilityTemplate('generic', 'stub', {
    params: [
      num('pipeSize', 'Pipe size (in)', 6, { min: 0 }),
      pipeShapeParam,
      genericMaterialParam,
      flowDirectionParam,
      ...elevationModeParams('start'),
      str('startConnection', 'Start connects to'),
    ],
    pointCode: 'USTUB',
    layer: GENERIC_LAYER,
  }),

  // Storm system: drainage-specific classes with real storm parameters.
  utilityTemplate('storm', 'manhole', {
    origin: 'top',
    params: [
      num('diameter', 'Diameter', 4, { min: 0 }),
      num('depth', 'Depth', 8, { min: 0 }),
      lidTypeParam,
      str('invertIn', 'Invert in'),
      str('invertOut', 'Invert out'),
    ],
    pointCode: 'STMH',
    layer: STORM_LAYER,
  }),
  utilityTemplate('storm', 'inlet', {
    origin: 'top',
    params: [
      pick('inletType', 'Inlet type', 'grate', ['curb', 'grate', 'combo', 'drop', 'unknown']),
      num('width', 'Width', 3, { min: 0 }),
      num('length', 'Length', 3, { min: 0 }),
      num('depth', 'Depth', 4, { min: 0 }),
      yawParam,
      str('invertOut', 'Invert out'),
    ],
    pointCode: 'STIN',
    layer: STORM_LAYER,
  }),
  utilityTemplate('storm', 'structure', {
    origin: 'top',
    params: [
      num('width', 'Width', 4, { min: 0 }),
      num('length', 'Length', 4, { min: 0 }),
      num('depth', 'Depth', 6, { min: 0 }),
      yawParam,
      str('invertIn', 'Invert in'),
      str('invertOut', 'Invert out'),
    ],
    pointCode: 'STSTR',
    layer: STORM_LAYER,
  }),
  utilityTemplate('storm', 'culvert', {
    params: [
      num('pipeSize', 'Pipe size (in)', 18, { min: 0 }),
      pipeShapeParam,
      stormMaterialParam,
      num('boxSpan', 'Box span (ft)', 4, { min: 0 }),
      num('boxRise', 'Box rise (ft)', 3, { min: 0 }),
      flowDirectionParam,
      str('invertIn', 'Invert in'),
      str('invertOut', 'Invert out'),
    ],
    pointCode: 'STCLV',
    layer: STORM_LAYER,
  }),
  utilityTemplate('storm', 'pipe', {
    params: [
      num('pipeSize', 'Pipe size (in)', 15, { min: 0 }),
      pipeShapeParam,
      stormMaterialParam,
      num('boxSpan', 'Box span (ft)', 4, { min: 0 }),
      num('boxRise', 'Box rise (ft)', 3, { min: 0 }),
      flowDirectionParam,
      ...elevationModeParams('start'),
      ...elevationModeParams('end'),
      ...connectionParams,
    ],
    pointCode: 'STPIPE',
    layer: STORM_LAYER,
  }),
  utilityTemplate('storm', 'stub', {
    params: [
      num('pipeSize', 'Pipe size (in)', 15, { min: 0 }),
      pipeShapeParam,
      stormMaterialParam,
      flowDirectionParam,
      ...elevationModeParams('start'),
      str('startConnection', 'Start connects to'),
    ],
    pointCode: 'STSTUB',
    layer: STORM_LAYER,
  }),
];

/** Systems in presentation order with their class templates. */
export function utilitySystems(): { id: UtilitySystemId; label: string }[] {
  return (['generic', 'storm'] as UtilitySystemId[]).map((id) => ({ id, label: UTILITY_SYSTEM_LABELS[id] }));
}

export function utilitySystemLabel(system: string | undefined): string {
  return system === 'storm' || system === 'generic' ? UTILITY_SYSTEM_LABELS[system] : 'Utility';
}

export function utilityClassLabel(classId: string | undefined): string {
  return classId && classId in UTILITY_CLASS_LABELS ? UTILITY_CLASS_LABELS[classId as UtilityClassId] : 'Utility';
}
