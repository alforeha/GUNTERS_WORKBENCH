export interface GroundEstimate {
  z: number;
  pointCount: number;
}

export function estimateLowPercentileGroundZ(
  zSamples: number[],
  percentile: number,
  minPoints: number,
): GroundEstimate | null {
  if (zSamples.length < minPoints) return null;
  const sorted = [...zSamples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * percentile)));
  return { z: sorted[rank] ?? sorted[sorted.length - 1] ?? 0, pointCount: sorted.length };
}

export function smoothGroundZ(previousZ: number | null, nextZ: number | null, dtMs: number, smoothingMs = 180): number | null {
  if (nextZ === null) return previousZ;
  if (previousZ === null) return nextZ;
  const alpha = 1 - Math.exp(-Math.max(dtMs, 0) / Math.max(smoothingMs, 1));
  return previousZ + (nextZ - previousZ) * alpha;
}