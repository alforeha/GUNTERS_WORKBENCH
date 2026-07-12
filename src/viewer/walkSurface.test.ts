import { describe, expect, it } from 'vitest';
import { estimateLowPercentileGroundZ, smoothGroundZ } from './walkSurface';

describe('estimateLowPercentileGroundZ', () => {
  it('uses a low percentile instead of the absolute minimum', () => {
    const estimate = estimateLowPercentileGroundZ([0, 1, 2, 3, 4, 5, 100], 0.1, 4);
    expect(estimate).toEqual({ z: 0, pointCount: 7 });

    const wider = estimateLowPercentileGroundZ([0, 1, 2, 3, 4, 5, 100], 0.25, 4);
    expect(wider).toEqual({ z: 1, pointCount: 7 });
  });

  it('returns null when there are not enough nearby samples', () => {
    expect(estimateLowPercentileGroundZ([1, 2, 3], 0.1, 4)).toBeNull();
  });
});

describe('smoothGroundZ', () => {
  it('keeps the prior height when no new estimate is available', () => {
    expect(smoothGroundZ(12, null, 16)).toBe(12);
  });

  it('eases toward the new estimate over time', () => {
    const next = smoothGroundZ(10, 14, 90, 180);
    expect(next).toBeGreaterThan(10);
    expect(next).toBeLessThan(14);
  });
});