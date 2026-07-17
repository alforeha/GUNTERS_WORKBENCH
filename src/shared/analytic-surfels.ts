import type { CurrentSourceFingerprint, IndexStalenessResult, PointCloudIndexSourceFingerprint } from './pointcloud-index';
import { detectIndexStaleness, formatStaleIndexWarning, isManagedIndexWarning } from './pointcloud-index';

export const ANALYTIC_SURFEL_ASSET_KIND = 'analytic-surfel-render';
export const ANALYTIC_SURFEL_TYPE = 'analytic-surfel-octree';
export const ANALYTIC_SURFEL_VERSION = 1;
export const ANALYTIC_SURFEL_GENERATOR_NAME = 'workbench';
export const ANALYTIC_SURFEL_BUILDER_VERSION = '1.0.0';
export const ANALYTIC_SURFEL_WARNING_PREFIX = 'Analytic surfel render';
export const DEFAULT_SURFEL_CELL_SCALE = 1;

/** Surfel record/artifact versions this build can represent and read. */
export const SUPPORTED_ANALYTIC_SURFEL_VERSIONS = [1, 2] as const;
export type SupportedAnalyticSurfelVersion = (typeof SUPPORTED_ANALYTIC_SURFEL_VERSIONS)[number];

export function isSupportedAnalyticSurfelVersion(version: unknown): version is SupportedAnalyticSurfelVersion {
  return SUPPORTED_ANALYTIC_SURFEL_VERSIONS.includes(version as SupportedAnalyticSurfelVersion);
}

/**
 * Open-time warning placed on the SOURCE point-cloud asset when a derived surfel
 * record is quarantined (removed) because this build cannot represent it. Exact
 * string match is used for idempotent strip-then-re-add on every open.
 */
export const QUARANTINED_SURFEL_RECORD_WARNING = `${ANALYTIC_SURFEL_WARNING_PREFIX} layer was built by an incompatible version and was removed from the project. Regenerate surfels to restore it.`;

/** Open-time warning on the surfel asset when its on-disk artifact is unreadable or version-incompatible. */
export const INCOMPATIBLE_SURFEL_ARTIFACT_WARNING = `${ANALYTIC_SURFEL_WARNING_PREFIX} artifact on disk is unreadable or incompatible with this build. Regenerate surfels to restore it.`;

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