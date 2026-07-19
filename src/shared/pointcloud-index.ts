// src/shared/pointcloud-index.ts — pure, THREE-/Node-free helpers describing the WPI v2
// point-cloud index record and its staleness detection. Kept free of fs/electron so the
// comparison logic is unit-testable in isolation (same pattern as pointCloudLod.ts).
//
// The index is a first-class *asset* (kind = 'point-cloud-index', truthStatus =
// 'indexed-full') linked to the source point cloud by sourceAssetId. Truth lives on the
// asset, never on the reality simulation. Real COPC is deferred; this is a workbench-
// internal index shaped like a COPC octree (L-X-Y-Z addressing) — never claim COPC.

/** Asset kind used for index records so they are never mislabeled as `source`. */
export const POINT_CLOUD_INDEX_ASSET_KIND = 'point-cloud-index';
/** The only index type this build understands. */
export const POINT_CLOUD_INDEX_TYPE = 'wpi-octree';
/** On-disk/manifest index format version. Bump when the tile/hierarchy layout changes. */
export const POINT_CLOUD_INDEX_VERSION = 2;
/** Generator identity recorded on every index so provenance is honest. */
export const POINT_CLOUD_INDEX_GENERATOR_NAME = 'workbench';
/** Semantic version of the WPI builder; stamped into generator.version on each index. */
export const POINT_CLOUD_INDEX_BUILDER_VERSION = '2.0.0';

/** All friendly index warnings share this prefix so open-time checks can dedupe them. */
export const POINT_CLOUD_INDEX_WARNING_PREFIX = 'Point-cloud index';

/**
 * Fingerprint of the source file an index was built from, stored on the index record.
 * mtimeMs is nullable because reference imports may not expose a reliable mtime; when it
 * is null we fall back to size + header-sha for staleness.
 */
export interface PointCloudIndexSourceFingerprint {
  headerSha256: string;
  fileSize: number;
  mtimeMs: number | null;
}

/** Live fingerprint of the current source, computed at open / before-stream time. */
export interface CurrentSourceFingerprint {
  exists: boolean;
  headerSha256?: string;
  fileSize?: number;
  mtimeMs?: number | null;
}

export type IndexStalenessReason =
  | 'source-missing'
  | 'header-sha-changed'
  | 'file-size-changed'
  | 'mtime-changed';

export interface IndexStalenessResult {
  /** True when the source diverged from the fingerprint the index was built against. */
  stale: boolean;
  /** True when freshness could not be confirmed because the source file is gone. */
  sourceMissing: boolean;
  reasons: IndexStalenessReason[];
}

/**
 * Compare the fingerprint stored on an index record against the current source.
 *
 * The index tiles live under `derived/` and are self-contained, so a *missing* source does
 * not invalidate the index — it only means we can neither re-verify freshness nor
 * regenerate. That case is surfaced as `sourceMissing` (not `stale`). A present source
 * whose header-sha / size / mtime diverges is genuinely `stale`.
 */
export function detectIndexStaleness(
  stored: PointCloudIndexSourceFingerprint,
  current: CurrentSourceFingerprint,
): IndexStalenessResult {
  if (!current.exists) {
    return { stale: false, sourceMissing: true, reasons: ['source-missing'] };
  }

  const reasons: IndexStalenessReason[] = [];
  if (current.headerSha256 !== undefined && current.headerSha256 !== stored.headerSha256) {
    reasons.push('header-sha-changed');
  }
  if (current.fileSize !== undefined && current.fileSize !== stored.fileSize) {
    reasons.push('file-size-changed');
  }
  if (
    stored.mtimeMs !== null &&
    current.mtimeMs !== null &&
    current.mtimeMs !== undefined &&
    current.mtimeMs !== stored.mtimeMs
  ) {
    reasons.push('mtime-changed');
  }

  return { stale: reasons.length > 0, sourceMissing: false, reasons };
}

const STALE_REASON_LABELS: Record<IndexStalenessReason, string> = {
  'source-missing': 'source file is missing',
  'header-sha-changed': 'source header content changed',
  'file-size-changed': 'source file size changed',
  'mtime-changed': 'source modified time changed',
};

/**
 * Build a friendly, user-facing warning for an index staleness result, or null when the
 * index is fresh. The regenerate action is offered by the caller alongside this text.
 */
export function formatStaleIndexWarning(result: IndexStalenessResult): string | null {
  if (result.sourceMissing) {
    return `${POINT_CLOUD_INDEX_WARNING_PREFIX} source is missing; the existing index is still usable but cannot be re-verified or regenerated until the source is available.`;
  }
  if (!result.stale) return null;
  const detail = result.reasons.map((reason) => STALE_REASON_LABELS[reason]).join(', ');
  return `${POINT_CLOUD_INDEX_WARNING_PREFIX} may be out of date (${detail}). Regenerate the index to match the current source.`;
}

/** Friendly warning for indexes built with an older, no-longer-preferred format. */
export function formatOutdatedIndexWarning(indexVersion: number): string | null {
  if (indexVersion >= POINT_CLOUD_INDEX_VERSION) return null;
  return `${POINT_CLOUD_INDEX_WARNING_PREFIX} format is outdated (v${indexVersion}); rebuild the index for indexed display and Walk Mode.`;
}

/** Whether a warning string is one this module produced (for idempotent open-time dedupe). */
export function isManagedIndexWarning(warning: string): boolean {
  return warning.startsWith(POINT_CLOUD_INDEX_WARNING_PREFIX);
}

/** Whether a warning says the index format is older than the current streaming/display target. */
export function isOutdatedIndexWarning(warning: string): boolean {
  return isManagedIndexWarning(warning) && warning.includes('format is outdated');
}

/**
 * Whether an index warning means the index is genuinely stale (source diverged).
 *
 * Deliberately excludes the missing-source warning — a missing source leaves the index
 * self-contained and fully usable (Phase 1 semantics), and densification cannot run
 * without the source anyway.  Only "out of date" warnings gate streaming.
 */
export function isStaleIndexWarning(warning: string): boolean {
  return isManagedIndexWarning(warning) && warning.includes('out of date');
}

/**
 * Gate for the densification→streaming demotion (Phase 4).
 *
 * An index asset is considered *valid for streaming* when it exists, has the correct kind,
 * and carries NO stale-index or outdated-format warnings. A missing-source warning does NOT
 * disqualify the index — the index tiles are self-contained under derived/ and streaming
 * remains the only viable refinement path (densification also needs the missing source).
 * Older v1/file-order indexes are also treated as absent for streaming/display so the UI
 * can fall back to preview, prompt a rebuild, and avoid the known patchy coarse coverage.
 */
export function hasValidIndexForStreaming(
  indexAsset: { kind: string; warnings: string[] } | undefined,
): boolean {
  return (
    indexAsset !== undefined &&
    indexAsset.kind === POINT_CLOUD_INDEX_ASSET_KIND &&
    !indexAsset.warnings.some((w) => isStaleIndexWarning(w) || isOutdatedIndexWarning(w))
  );
}
