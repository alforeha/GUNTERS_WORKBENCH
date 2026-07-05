import { describe, expect, it } from 'vitest';
import type { SurfaceModel } from '../core/contract';
import { RenderSurface } from './RenderSurface';

function makeSurface(): SurfaceModel {
  return {
    id: 's1',
    name: 'test',
    meta: {
      fileName: 'test.xml',
      format: 'synthetic',
      units: { linear: 'foot', raw: 'foot' },
    },
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ]),
    precisionHint: 2,
    sourcePointIds: new Uint32Array([1, 2, 3, 4]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    faceVisibility: null,
    edges: null,
    breaklines: [],
    boundaries: [],
    report: { counts: { points: 4, faces: 2 }, triangulationPreserved: true, warnings: [], infos: [], unknownElements: {} },
    provenance: 'source-explicit',
    dirty: false,
  };
}

describe('RenderSurface swap edge', () => {
  it('swaps the shared diagonal and can be undone by swapping back', () => {
    const render = new RenderSurface('s1', makeSurface(), [0, 0, 0]);
    const swapped = render.swapInteriorEdge(0, 2);
    expect(swapped.ok).toBe(true);
    expect(swapped.beforeIndices).toEqual([0, 1, 2, 0, 2, 3]);
    expect(swapped.afterIndices).toEqual([1, 3, 0, 3, 1, 2]);
    expect(Array.from(render.model.indices ?? [])).toEqual([1, 3, 0, 3, 1, 2]);

    const undo = render.swapInteriorEdge(1, 3);
    expect(undo.ok).toBe(true);
    expect(faceSets(render.model.indices ?? new Uint32Array())).toEqual(new Set(['0,1,2', '0,2,3']));
    render.dispose();
  });
});

function faceSets(indices: Uint32Array): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i]!, indices[i + 1]!, indices[i + 2]!].sort((a, b) => a - b);
    out.add(tri.join(','));
  }
  return out;
}
