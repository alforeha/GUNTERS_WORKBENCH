// src/viewer/pointCloudAppearance.ts - pure, THREE-free point-cloud appearance
// model shared by the preview (RenderPointCloud) and indexed (StreamingPointCloud)
// renderers, so the two paths speak the same owner-facing language: point RADIUS
// in feet (never the abstract 1-5 slider), quick x/÷ scale steps, indexed detail
// presets over the existing SSE/budget knobs, and a camera range clip. Node-
// testable like pointCloudLod.ts / pointCloudStreaming.ts.
//
// Internal mapping: THREE.PointsMaterial `size` with sizeAttenuation is a
// world-space DIAMETER. The owner-facing unit is radius in feet, so
// worldDiameter = radiusFt * feetToUnits * radiusScale * 2.

import { POINT_BUDGET_MAX, POINT_BUDGET_MIN } from './pointCloudLod';

export type RadiusMode = 'auto' | 'fixed';

/** Indexed-cloud refinement presets over the existing SSE threshold / point budget. */
export type DetailPreset = 'faster' | 'balanced' | 'detailed' | 'inspect';

export interface PointAppearance {
  /** 'auto': renderer-derived sizing (level fill / slider lerp); 'fixed': explicit radius. */
  radiusMode: RadiusMode;
  /** Fixed point radius in feet (owner-facing; converted per dataset units). */
  fixedRadiusFt: number;
  /** Multiplier over the auto-derived or fixed radius (the ÷10 ÷2 ×2 ×10 steps). */
  radiusScale: number;
  /** Hide points farther than this from the camera, in feet; null = off. */
  rangeClipFt: number | null;
}

export const DEFAULT_POINT_APPEARANCE: PointAppearance = {
  radiusMode: 'auto',
  fixedRadiusFt: 0.12,
  radiusScale: 1,
  rangeClipFt: null,
};

/** Fixed radius presets (feet). 0.12 ft is the owner's Blender reference size. */
export const FIXED_RADIUS_PRESETS_FT = [0.03, 0.06, 0.12, 0.18, 0.25] as const;

/** Range clip presets (feet). */
export const RANGE_CLIP_PRESETS_FT = [10, 25, 50, 100, 250] as const;

export const RADIUS_SCALE_MIN = 0.01;
export const RADIUS_SCALE_MAX = 100;

/** One ÷10/÷2/×2/×10 step over the current scale, clamped and de-drifted. */
export function applyRadiusScaleStep(current: number, factor: number): number {
  const next = Math.min(Math.max(current * factor, RADIUS_SCALE_MIN), RADIUS_SCALE_MAX);
  return Math.round(next * 1000) / 1000;
}

/** Feet → dataset linear units. Survey vs intl foot differ by 2ppm — irrelevant at display radii. */
export function feetToUnits(units: string): number {
  return units === 'meter' ? 0.3048 : 1;
}

/**
 * Fixed-mode world diameter (what PointsMaterial.size takes), or null in auto
 * mode - the caller then keeps its own auto sizing scaled by radiusScale.
 */
export function fixedWorldDiameter(appearance: PointAppearance, units: string): number | null {
  if (appearance.radiusMode !== 'fixed') return null;
  return appearance.fixedRadiusFt * feetToUnits(units) * appearance.radiusScale * 2;
}

/**
 * The one sizing rule both renderers share: fixed radius wins; otherwise the
 * renderer's auto diameter scaled by radiusScale.
 */
export function effectivePointDiameter(appearance: PointAppearance, units: string, autoDiameter: number): number {
  return fixedWorldDiameter(appearance, units) ?? autoDiameter * appearance.radiusScale;
}

/** Range clip in world units; null = off. */
export function rangeClipWorld(appearance: PointAppearance, units: string): number | null {
  return appearance.rangeClipFt === null ? null : appearance.rangeClipFt * feetToUnits(units);
}

export interface DetailParams {
  /** Refine while screen-space error exceeds this (px) - lower = more refinement. */
  sseThreshold: number;
  /** Loaded-point budget ceiling (the 2-5M work-order window). */
  budgetMax: number;
}

/**
 * Detail presets over the existing streaming knobs. 'balanced' matches the
 * engine defaults (DEFAULT_SSE_THRESHOLD 400 px / POINT_BUDGET_MAX).
 */
export function detailPresetParams(preset: DetailPreset): DetailParams {
  switch (preset) {
    case 'faster':
      return { sseThreshold: 800, budgetMax: POINT_BUDGET_MIN };
    case 'detailed':
      return { sseThreshold: 200, budgetMax: POINT_BUDGET_MAX };
    case 'inspect':
      return { sseThreshold: 100, budgetMax: POINT_BUDGET_MAX };
    case 'balanced':
    default:
      return { sseThreshold: 400, budgetMax: POINT_BUDGET_MAX };
  }
}

export const DETAIL_PRESETS: { id: DetailPreset; label: string }[] = [
  { id: 'faster', label: 'Faster' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'detailed', label: 'Detailed' },
  { id: 'inspect', label: 'Inspect' },
];

/** ×2 / ÷2 style label for a radius scale (1 → ×1). */
export function formatRadiusScale(scale: number): string {
  if (scale >= 1) return `×${Math.round(scale * 1000) / 1000}`;
  return `÷${Math.round((1 / scale) * 1000) / 1000}`;
}

/**
 * Disclosure fragment for non-default appearance; null when everything is at
 * defaults (no banner noise). Radius is labeled explicitly as a radius.
 */
export function formatAppearanceDisclosure(
  appearance: PointAppearance,
  detail: DetailPreset | null = null,
  includeRangeClip = true,
): string | null {
  const parts: string[] = [];
  if (appearance.radiusMode === 'fixed') {
    const scaleLabel = appearance.radiusScale !== 1 ? ` ${formatRadiusScale(appearance.radiusScale)}` : '';
    parts.push(`point radius ${appearance.fixedRadiusFt} ft fixed${scaleLabel}`);
  } else if (appearance.radiusScale !== 1) {
    parts.push(`point radius auto ${formatRadiusScale(appearance.radiusScale)}`);
  }
  if (detail && detail !== 'balanced') {
    parts.push(`detail ${detail}`);
  }
  if (includeRangeClip && appearance.rangeClipFt !== null) {
    parts.push(`showing within ${appearance.rangeClipFt} ft`);
  }
  return parts.length > 0 ? `Display: ${parts.join(' · ')}` : null;
}

export function formatGlobalShowWithinDisclosure(distanceFt: number | null): string | null {
  return distanceFt !== null ? `Display: showing within ${distanceFt} ft` : null;
}
