import { describe, expect, it } from 'vitest';
import type { PointCloudDataset, PointCloudOctreeNode } from '../src/core/contract';
import {
  DEFAULT_POINT_APPEARANCE,
  FIXED_RADIUS_PRESETS_FT,
  RADIUS_SCALE_MAX,
  RADIUS_SCALE_MIN,
  applyRadiusScaleStep,
  detailPresetParams,
  effectivePointDiameter,
  feetToUnits,
  fixedWorldDiameter,
  formatAppearanceDisclosure,
  formatGlobalShowWithinDisclosure,
  formatRadiusScale,
  rangeClipWorld,
  type PointAppearance,
} from '../src/viewer/pointCloudAppearance';
import { POINT_BUDGET_MAX, POINT_BUDGET_MIN } from '../src/viewer/pointCloudLod';
import { RenderPointCloud } from '../src/viewer/RenderPointCloud';

function appearance(overrides: Partial<PointAppearance> = {}): PointAppearance {
  return { ...DEFAULT_POINT_APPEARANCE, ...overrides };
}

describe('radius model', () => {
  it('includes the Blender-reference 0.12 ft preset', () => {
    expect(FIXED_RADIUS_PRESETS_FT).toContain(0.12);
  });

  it('maps a fixed radius (ft) to a world diameter (PointsMaterial.size)', () => {
    // radius 0.12 ft → diameter 0.24 in foot-unit worlds
    expect(fixedWorldDiameter(appearance({ radiusMode: 'fixed', fixedRadiusFt: 0.12 }), 'usSurveyFoot')).toBeCloseTo(0.24, 9);
    expect(fixedWorldDiameter(appearance({ radiusMode: 'fixed', fixedRadiusFt: 0.12 }), 'foot')).toBeCloseTo(0.24, 9);
    // meter worlds convert: 0.12 ft = 0.036576 m radius
    expect(fixedWorldDiameter(appearance({ radiusMode: 'fixed', fixedRadiusFt: 0.12 }), 'meter')).toBeCloseTo(0.073152, 9);
  });

  it('returns null in auto mode so renderers keep their own sizing', () => {
    expect(fixedWorldDiameter(appearance(), 'usSurveyFoot')).toBeNull();
  });

  it('applies the radius scale to fixed and auto sizing alike', () => {
    expect(fixedWorldDiameter(appearance({ radiusMode: 'fixed', fixedRadiusFt: 0.12, radiusScale: 2 }), 'foot')).toBeCloseTo(0.48, 9);
    expect(effectivePointDiameter(appearance({ radiusScale: 10 }), 'foot', 0.075)).toBeCloseTo(0.75, 9);
    expect(effectivePointDiameter(appearance({ radiusMode: 'fixed', fixedRadiusFt: 0.06 }), 'foot', 0.075)).toBeCloseTo(0.12, 9);
  });

  it('converts feet to dataset units', () => {
    expect(feetToUnits('usSurveyFoot')).toBe(1);
    expect(feetToUnits('foot')).toBe(1);
    expect(feetToUnits('meter')).toBeCloseTo(0.3048, 9);
    expect(feetToUnits('unknown')).toBe(1);
  });
});

describe('applyRadiusScaleStep', () => {
  it('steps multiplicatively (÷10 ÷2 ×2 ×10)', () => {
    expect(applyRadiusScaleStep(1, 2)).toBe(2);
    expect(applyRadiusScaleStep(2, 10)).toBe(20);
    expect(applyRadiusScaleStep(1, 0.5)).toBe(0.5);
    expect(applyRadiusScaleStep(1, 0.1)).toBe(0.1);
  });

  it('round-trips without float drift', () => {
    let scale = 1;
    scale = applyRadiusScaleStep(scale, 0.1);
    scale = applyRadiusScaleStep(scale, 10);
    expect(scale).toBe(1);
  });

  it('clamps to the safe range', () => {
    expect(applyRadiusScaleStep(RADIUS_SCALE_MIN, 0.1)).toBe(RADIUS_SCALE_MIN);
    expect(applyRadiusScaleStep(RADIUS_SCALE_MAX, 10)).toBe(RADIUS_SCALE_MAX);
  });
});

describe('detailPresetParams', () => {
  it('balanced matches the engine defaults', () => {
    expect(detailPresetParams('balanced')).toEqual({ sseThreshold: 400, budgetMax: POINT_BUDGET_MAX });
  });

  it('faster reduces load pressure; detailed/inspect refine further', () => {
    const faster = detailPresetParams('faster');
    const balanced = detailPresetParams('balanced');
    const detailed = detailPresetParams('detailed');
    const inspect = detailPresetParams('inspect');
    expect(faster.budgetMax).toBe(POINT_BUDGET_MIN);
    expect(faster.sseThreshold).toBeGreaterThan(balanced.sseThreshold);
    expect(detailed.sseThreshold).toBeLessThan(balanced.sseThreshold);
    expect(inspect.sseThreshold).toBeLessThan(detailed.sseThreshold);
    // Inspect stays within the safe budget ceiling - never above POINT_BUDGET_MAX.
    expect(inspect.budgetMax).toBeLessThanOrEqual(POINT_BUDGET_MAX);
  });
});

describe('range clip', () => {
  it('converts feet to world units and models off as null', () => {
    expect(rangeClipWorld(appearance(), 'foot')).toBeNull();
    expect(rangeClipWorld(appearance({ rangeClipFt: 50 }), 'foot')).toBe(50);
    expect(rangeClipWorld(appearance({ rangeClipFt: 50 }), 'meter')).toBeCloseTo(15.24, 9);
  });
});

describe('formatAppearanceDisclosure', () => {
  it('is silent at defaults (no banner noise)', () => {
    expect(formatAppearanceDisclosure(appearance())).toBeNull();
    expect(formatAppearanceDisclosure(appearance(), 'balanced')).toBeNull();
  });

  it('labels a fixed radius explicitly as a radius in feet', () => {
    const text = formatAppearanceDisclosure(appearance({ radiusMode: 'fixed', fixedRadiusFt: 0.12 }));
    expect(text).toContain('point radius 0.12 ft fixed');
  });

  it('shows scaled auto radius with ÷/× labels', () => {
    expect(formatRadiusScale(1)).toBe('×1');
    expect(formatRadiusScale(2)).toBe('×2');
    expect(formatRadiusScale(0.5)).toBe('÷2');
    expect(formatAppearanceDisclosure(appearance({ radiusScale: 0.5 }))).toContain('point radius auto ÷2');
  });

  it('discloses detail preset and range clip', () => {
    const text = formatAppearanceDisclosure(appearance({ rangeClipFt: 50 }), 'inspect');
    expect(text).toContain('detail inspect');
    expect(text).toContain('showing within 50 ft');
  });

  it('can omit per-layer range disclosure when global Show Within owns it', () => {
    const text = formatAppearanceDisclosure(appearance({ rangeClipFt: 50 }), 'inspect', false);
    expect(text).toContain('detail inspect');
    expect(text).not.toContain('showing within 50 ft');
  });
});

describe('formatGlobalShowWithinDisclosure', () => {
  it('reports the single global Show Within state and stays silent when off', () => {
    expect(formatGlobalShowWithinDisclosure(null)).toBeNull();
    expect(formatGlobalShowWithinDisclosure(50)).toBe('Display: showing within 50 ft');
  });
});

// ── Preview path (RenderPointCloud) ───────────────────────────────────────────

const EMPTY_BOUNDS = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };

function emptyNode(): PointCloudOctreeNode {
  return {
    id: 0,
    depth: 0,
    bounds: EMPTY_BOUNDS,
    localBounds: EMPTY_BOUNDS,
    pointCount: 0,
    sampleCount: 0,
    positions: new Float32Array(0),
    colors: new Uint8Array(0),
    intensities: new Float32Array(0),
    classifications: new Uint8Array(0),
    returnNumbers: new Uint8Array(0),
    numberOfReturns: new Uint8Array(0),
    sourceRanges: [],
    children: [],
  };
}

function previewDataset(units: 'usSurveyFoot' | 'meter' = 'usSurveyFoot'): PointCloudDataset {
  return {
    id: 'pc',
    name: 'pc.las',
    meta: { fileName: 'pc.las', format: 'las', units: { linear: units, raw: units } } as PointCloudDataset['meta'],
    lasVersion: '1.4',
    pointFormat: 7,
    pointRecordLength: 36,
    pointCount: 0,
    offsetToPointData: 0,
    vlrCount: 0,
    scale: [0.001, 0.001, 0.001],
    offset: [0, 0, 0],
    bounds: EMPTY_BOUNDS,
    crsText: null,
    unitSource: 'assumed',
    attributes: {
      hasIntensity: false,
      hasReturns: false,
      hasClassification: false,
      hasClassificationFlags: false,
      hasUserData: false,
      hasScanAngle: false,
      hasPointSourceId: false,
      hasGpsTime: false,
      hasRgb: true,
      rgbEncoding: 'u16',
      intensityRange: null,
      rgbRange: null,
      sampledPoints: 0,
      classificationCounts: {},
      returnNumberCounts: {},
      numberOfReturnsCounts: {},
      userDataCounts: {},
    },
    pointDensityPerSqFt: null,
    octree: {
      origin: [0, 0, 0],
      maxDepth: 1,
      targetLeafPointCount: 1,
      totalSampledPoints: 0,
      presentClasses: [],
      presentReturns: [],
      maxReturnCount: 1,
      zRange: [0, 1],
      root: emptyNode(),
    },
    report: { counts: {}, triangulationPreserved: true, warnings: [], infos: [], unknownElements: {} },
  };
}

describe('RenderPointCloud appearance', () => {
  it('defaults to the legacy auto diameter (slider 2 → 0.075 world units)', () => {
    const cloud = new RenderPointCloud('pc', previewDataset(), [0, 0, 0]);
    expect(cloud.pointDiameterWorld).toBeCloseTo(0.075, 9);
  });

  it('applies a fixed 0.12 ft radius as a 0.24 world diameter and holds it across setDisplay', () => {
    const cloud = new RenderPointCloud('pc', previewDataset(), [0, 0, 0]);
    cloud.setAppearance(appearance({ radiusMode: 'fixed', fixedRadiusFt: 0.12 }));
    expect(cloud.pointDiameterWorld).toBeCloseTo(0.24, 9);
    cloud.setDisplay(true, 5); // legacy slider must not override the fixed radius
    expect(cloud.pointDiameterWorld).toBeCloseTo(0.24, 9);
  });

  it('converts fixed radii for meter-unit datasets', () => {
    const cloud = new RenderPointCloud('pc', previewDataset('meter'), [0, 0, 0]);
    cloud.setAppearance(appearance({ radiusMode: 'fixed', fixedRadiusFt: 0.12 }));
    expect(cloud.pointDiameterWorld).toBeCloseTo(0.073152, 9);
  });

  it('scales the auto diameter with the quick-scale factor', () => {
    const cloud = new RenderPointCloud('pc', previewDataset(), [0, 0, 0]);
    cloud.setAppearance(appearance({ radiusScale: 10 }));
    expect(cloud.pointDiameterWorld).toBeCloseTo(0.75, 9);
    cloud.setAppearance(appearance({ radiusScale: 1 }));
    expect(cloud.pointDiameterWorld).toBeCloseTo(0.075, 9);
  });

  it('sets and clears the camera range clip in world units', () => {
    const cloud = new RenderPointCloud('pc', previewDataset(), [0, 0, 0]);
    expect(cloud.getRangeClipWorld()).toBeNull();
    cloud.setAppearance(appearance({ rangeClipFt: 50 }));
    expect(cloud.getRangeClipWorld()).toBe(50);
    cloud.setAppearance(appearance({ rangeClipFt: null }));
    expect(cloud.getRangeClipWorld()).toBeNull();
  });
});
