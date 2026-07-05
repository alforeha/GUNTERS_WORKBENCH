// A4 fixture contract-compliance tests: the synthetic generator is the first consumer
// proving the normalized SurfaceModel contract end-to-end.
import { describe, expect, it } from 'vitest';
import { computeBBox } from './geometry';
import { generateTestMesh, TEST_MESH_CENTER, TEST_MESH_EXTENT_FT } from './synthetic';

describe('generateTestMesh', () => {
  const model = generateTestMesh(10_000, 42); // 100×100 — fast but representative

  it('emits a contract-compliant SurfaceModel', () => {
    expect(model.meta.format).toBe('synthetic');
    expect(model.meta.units.linear).toBe('usSurveyFoot');
    expect(model.positions).toBeInstanceOf(Float64Array);
    expect(model.indices).toBeInstanceOf(Uint32Array);
    expect(model.sourcePointIds).toBeInstanceOf(Uint32Array);
    expect(model.provenance).toBe('source-explicit');
    expect(model.dirty).toBe(false);
    expect(model.report.triangulationPreserved).toBe(true);
    expect(model.report.counts['points']).toBe(model.positions.length / 3);
    expect(model.report.counts['faces']).toBe(model.indices!.length / 3);
  });

  it('sits at survey magnitudes with ~5,000 ft extents (perf gate requirement)', () => {
    const box = computeBBox(model.positions);
    expect(box.center[0]).toBeCloseTo(TEST_MESH_CENTER.e, 0);
    expect(box.center[1]).toBeCloseTo(TEST_MESH_CENTER.n, 0);
    expect(box.max[0] - box.min[0]).toBeCloseTo(TEST_MESH_EXTENT_FT, 6);
    expect(box.max[1] - box.min[1]).toBeCloseTo(TEST_MESH_EXTENT_FT, 6);
    // elevation relief is non-trivial but bounded by the noise amplitude
    const relief = box.max[2] - box.min[2];
    expect(relief).toBeGreaterThan(20);
    expect(relief).toBeLessThan(300);
  });

  it('produces valid 0-based indices and 1-based source ids', () => {
    const vertexCount = model.positions.length / 3;
    for (const idx of model.indices!) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vertexCount);
    }
    expect(model.sourcePointIds[0]).toBe(1);
    expect(model.sourcePointIds[vertexCount - 1]).toBe(vertexCount);
  });

  it('is deterministic for a given seed', () => {
    const again = generateTestMesh(10_000, 42);
    expect(again.positions[12_345]).toBe(model.positions[12_345]);
    const other = generateTestMesh(10_000, 7);
    expect(other.positions[2]).not.toBe(model.positions[2]);
  });

  it('hits the exact vertex target for square counts', () => {
    expect(generateTestMesh(1_000_000, 1).positions.length / 3).toBe(1_000_000);
  });
});
