// src/shared/template-catalog.ts - the read-only seed catalog of parametric
// feature templates for Create Sim v1. Definitions only: param schemas plus
// representation reference NAMES (layer/hatch/block/point-code) that resolve
// through the future codelist. No geometry lives here (generators are viewer
// code) and no template editor exists: the catalog is code, not project data.

import type { FeatureFamily } from './workbench-types';

export const TEMPLATE_CATALOG_VERSION = 1;

export type TemplateParamType = 'number' | 'string' | 'boolean' | 'enum';

export interface TemplateParamSpec {
  name: string;
  label: string;
  type: TemplateParamType;
  default: number | string | boolean;
  min?: number;
  max?: number;
  /** enum params only. */
  options?: string[];
}

/** CAD representation references: codelist names, never baked geometry. */
export interface TemplateCadRefs {
  layer?: string;
  hatch?: string;
  block?: string;
  linetype?: string;
  pointCode?: string;
  /** Multi-line-set families (building) name each generated line set. */
  layers?: Record<string, string>;
}

export interface TemplateRealityRefs {
  material?: string;
  primitive?: string;
  /** Maps reality appearance inputs to param names, e.g. { bladeHeight: 'verticalScale' }. */
  bind?: Record<string, string>;
}

export interface TemplateReportRefs {
  quantityKind?: 'area' | 'length' | 'count';
}

export interface FeatureTemplate {
  /** Always `${family}.${subtype}`. */
  id: string;
  family: FeatureFamily;
  subtype: string;
  displayName: string;
  paramSchema: TemplateParamSpec[];
  reality?: TemplateRealityRefs;
  cad?: TemplateCadRefs;
  report?: TemplateReportRefs;
}

function num(name: string, label: string, def: number, range?: { min?: number; max?: number }): TemplateParamSpec {
  return { name, label, type: 'number', default: def, ...range };
}

function region(
  subtype: string,
  displayName: string,
  opts: { hatch: string; params?: TemplateParamSpec[]; bind?: Record<string, string> },
): FeatureTemplate {
  return {
    id: `region.${subtype}`,
    family: 'region',
    subtype,
    displayName,
    paramSchema: [
      // 'vertical' is reserved: v1 renders draped patches only, no vertical faces.
      { name: 'heightBehavior', label: 'Height behavior', type: 'enum', default: 'drape', options: ['drape', 'vertical'] },
      num('verticalScale', 'Vertical scale', 0, { min: 0, max: 3 }),
      { name: 'appearancePreset', label: 'Appearance preset', type: 'string', default: 'default' },
      ...(opts.params ?? []),
    ],
    reality: { material: subtype, ...(opts.bind ? { bind: opts.bind } : {}) },
    cad: { layer: `SURF-${subtype.toUpperCase()}`, hatch: opts.hatch },
    report: { quantityKind: 'area' },
  };
}

function objectTemplate(
  subtype: string,
  displayName: string,
  opts: { params: TemplateParamSpec[]; block: string; pointCode: string; primitive: string },
): FeatureTemplate {
  return {
    id: `object.${subtype}`,
    family: 'object',
    subtype,
    displayName,
    paramSchema: opts.params,
    reality: { primitive: opts.primitive },
    cad: { block: opts.block, pointCode: opts.pointCode },
    report: { quantityKind: 'count' },
  };
}

function building(subtype: string, displayName: string, params: TemplateParamSpec[]): FeatureTemplate {
  return {
    id: `building.${subtype}`,
    family: 'building',
    subtype,
    displayName,
    paramSchema: params,
    cad: {
      layers: {
        footprint: 'BLDG-FOOTPRINT',
        face: 'BLDG-FACE',
        overhang: 'BLDG-OVERHANG',
        roof: 'BLDG-ROOF',
        ridge: 'BLDG-RIDGE',
      },
    },
    report: { quantityKind: 'area' },
  };
}

function line(subtype: string, displayName: string, opts: { breakline: boolean; layer: string }): FeatureTemplate {
  return {
    id: `line.${subtype}`,
    family: 'line',
    subtype,
    displayName,
    paramSchema: [{ name: 'isBreakline', label: 'Breakline', type: 'boolean', default: opts.breakline }],
    cad: { layer: opts.layer },
    report: { quantityKind: 'length' },
  };
}

function marker(subtype: string, displayName: string, opts: { params?: TemplateParamSpec[]; pointCode: string }): FeatureTemplate {
  return {
    id: `marker.${subtype}`,
    family: 'marker',
    subtype,
    displayName,
    paramSchema: opts.params ?? [],
    cad: { pointCode: opts.pointCode },
    report: { quantityKind: 'count' },
  };
}

const heightParam = (def: number): TemplateParamSpec => num('height', 'Height', def, { min: 0 });
const decayParam = num('decay', 'Decay', 0, { min: 0, max: 1 });

const catalog: FeatureTemplate[] = [
  // Regions: the region patch is the surface-patch input; hatch is a reference name only.
  region('grass', 'Grass', {
    hatch: 'GRASS',
    params: [],
    bind: { bladeHeight: 'verticalScale' },
  }),
  region('pavement', 'Pavement', { hatch: 'AR-HBONE', params: [decayParam], bind: { patchiness: 'decay' } }),
  region('gravel', 'Gravel', { hatch: 'GRAVEL' }),
  region('dirt', 'Dirt', { hatch: 'EARTH' }),
  region('concrete', 'Concrete', { hatch: 'AR-CONC', params: [decayParam], bind: { patchiness: 'decay' } }),
  region('landscape', 'Landscape', { hatch: 'DOTS' }),
  region('water', 'Water', { hatch: 'WATER' }),
  region('unknown', 'Unknown', { hatch: 'ANSI31' }),

  // Objects: point-anchored primitives, excluded from ground behavior.
  objectTemplate('tree', 'Tree', {
    params: [
      heightParam(20),
      num('dripline', 'Dripline radius', 8, { min: 0 }),
      num('leafCoverage', 'Leaf coverage', 0.7, { min: 0, max: 1 }),
    ],
    block: 'TREE',
    pointCode: 'TREE',
    primitive: 'tree-billboard',
  }),
  objectTemplate('sign', 'Sign', { params: [heightParam(7)], block: 'SIGN', pointCode: 'SIGN', primitive: 'sign-post' }),
  objectTemplate('pole', 'Pole', { params: [heightParam(25)], block: 'POLE', pointCode: 'POLE', primitive: 'pole' }),
  objectTemplate('hydrant', 'Hydrant', { params: [heightParam(3)], block: 'HYD', pointCode: 'HYD', primitive: 'hydrant' }),
  objectTemplate('valve', 'Valve', {
    params: [num('scale', 'Scale', 1, { min: 0 })],
    block: 'VALVE',
    pointCode: 'VLV',
    primitive: 'flush-disc',
  }),
  objectTemplate('manhole', 'Manhole', {
    params: [num('diameter', 'Rim diameter', 2, { min: 0 })],
    block: 'MH',
    pointCode: 'MH',
    primitive: 'flush-disc',
  }),
  objectTemplate('inlet', 'Inlet', {
    params: [num('width', 'Width', 3, { min: 0 })],
    block: 'INLET',
    pointCode: 'INLET',
    primitive: 'flush-box',
  }),
  objectTemplate('generic', 'Generic object', {
    params: [num('scale', 'Scale', 1, { min: 0 })],
    block: 'GENERIC',
    pointCode: 'GEN',
    primitive: 'generic-box',
  }),

  // Buildings: composite family; ridge is infer-with-override (IMP-4).
  building('flat', 'Flat roof', [heightParam(10), num('overhang', 'Overhang', 1, { min: 0 })]),
  building('gable', 'Gable roof', [
    heightParam(10),
    num('roofPitch', 'Roof pitch (deg)', 30, { min: 1, max: 60 }),
    num('overhang', 'Overhang', 1, { min: 0 }),
  ]),
  building('hip', 'Hip roof', [
    heightParam(10),
    num('roofPitch', 'Roof pitch (deg)', 30, { min: 1, max: 60 }),
    num('overhang', 'Overhang', 1, { min: 0 }),
  ]),

  // Lines: breakline flag is a param so IMP-5 stores it without schema changes.
  line('curb', 'Curb', { breakline: true, layer: 'LINE-CURB' }),
  line('flowline', 'Flowline', { breakline: true, layer: 'LINE-FLOW' }),
  line('ridge', 'Ridge', { breakline: true, layer: 'LINE-RIDGE' }),
  line('ditch', 'Ditch', { breakline: true, layer: 'LINE-DITCH' }),
  line('wall-top', 'Wall top', { breakline: true, layer: 'LINE-WALLT' }),
  line('wall-bottom', 'Wall bottom', { breakline: true, layer: 'LINE-WALLB' }),
  line('edge-of-pavement', 'Edge of pavement', { breakline: true, layer: 'LINE-EOP' }),
  line('fence', 'Fence', { breakline: false, layer: 'LINE-FENCE' }),

  // Markers: spot elevations double as surface constraints for the region patch.
  marker('generic', 'Marker', { pointCode: 'MARK' }),
  marker('spot-elevation', 'Spot elevation', {
    params: [{ name: 'surfaceConstraint', label: 'Surface constraint', type: 'boolean', default: true }],
    pointCode: 'SPOT',
  }),
  marker('control-point', 'Control point', {
    params: [{ name: 'pointNumber', label: 'Point number', type: 'string', default: '' }],
    pointCode: 'CP',
  }),
  marker('note', 'Note', {
    params: [{ name: 'text', label: 'Text', type: 'string', default: '' }],
    pointCode: 'NOTE',
  }),
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const TEMPLATE_CATALOG: readonly FeatureTemplate[] = deepFreeze(catalog);

export function getTemplate(id: string): FeatureTemplate | null {
  return TEMPLATE_CATALOG.find((template) => template.id === id) ?? null;
}

export function templatesForFamily(family: FeatureFamily): FeatureTemplate[] {
  return TEMPLATE_CATALOG.filter((template) => template.family === family);
}
