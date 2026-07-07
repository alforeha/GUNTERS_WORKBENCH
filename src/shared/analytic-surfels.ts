import type { CurrentSourceFingerprint, IndexStalenessResult, PointCloudIndexSourceFingerprint } from './pointcloud-index';
import { detectIndexStaleness, formatStaleIndexWarning, isManagedIndexWarning } from './pointcloud-index';

export const ANALYTIC_SURFEL_ASSET_KIND = 'analytic-surfel-render';
export const ANALYTIC_SURFEL_TYPE = 'analytic-surfel-octree';
export const ANALYTIC_SURFEL_VERSION = 2;
export const ANALYTIC_SURFEL_GENERATOR_NAME = 'workbench';
export const ANALYTIC_SURFEL_BUILDER_VERSION = '1.0.0';
export const ANALYTIC_SURFEL_WARNING_PREFIX = 'Analytic surfel render';
export const DEFAULT_SURFEL_CELL_SCALE = 2;

export type AnalyticSurfelSourceFingerprint = PointCloudIndexSourceFingerprint;
export type AnalyticSurfelStalenessResult = IndexStalenessResult;

export function detectAnalyticSurfelStaleness(
  stored: AnalyticSurfelSourceFingerprint,
  current: CurrentSourceFingerprint,
): AnalyticSurfelStalenessResult {
  return detectIndexStaleness(stored, current);
}

export function formatAnalyticSurfelWarning(result: AnalyticSurfelStalenessResult): string | null {
  const message = formatStaleIndexWarning(result);
  return message?.replace('Point-cloud index', ANALYTIC_SURFEL_WARNING_PREFIX) ?? null;
}

export function isManagedAnalyticSurfelWarning(warning: string): boolean {
  return warning.startsWith(ANALYTIC_SURFEL_WARNING_PREFIX) || isManagedIndexWarning(warning);
}