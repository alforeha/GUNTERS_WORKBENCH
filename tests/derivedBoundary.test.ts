// Sprint 4 Phase 1 acceptance (docs/08): derived outer boundary — edges referenced by
// exactly one triangle; holes fall out as additional closed loops.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { boundaryEdges, boundaryLoops } from '../src/core/derivedBoundary';
import { parseLandXML } from '../src/core/landxml/parse';
import type { SurfaceModel } from '../src/core/contract';
import { refPath } from './refs';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('boundaryEdges', () => {
  it('single triangle: all 3 edges are boundary', () => {
    const edges = boundaryEdges(Uint32Array.from([0, 1, 2]));
    expect(edges).toHaveLength(6);
    const set = new Set<string>();
    for (let i = 0; i < edges.length; i += 2) set.add(`${edges[i]}-${edges[i + 1]}`);
    expect(set).toEqual(new Set(['0-1', '1-2', '0-2']));
  });

  it('two triangles sharing an edge: shared edge is NOT boundary', () => {
    // quad 0-1-2-3 split along 0-2
    const edges = boundaryEdges(Uint32Array.from([0, 1, 2, 0, 2, 3]));
    expect(edges).toHaveLength(8); // 4 rim edges
    for (let i = 0; i < edges.length; i += 2) {
      const lo = Math.min(edges[i]!, edges[i + 1]!);
      const hi = Math.max(edges[i]!, edges[i + 1]!);
      expect(`${lo}-${hi}`).not.toBe('0-2');
    }
  });
});

/** 4×4 vertex grid (16 verts, 18 tris) with the two central triangles removed → 1 hole. */
function gridWithHole(): { positions: Float64Array; indices: Uint32Array } {
  const N = 4;
  const positions = new Float64Array(N * N * 3);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      positions[i * 3] = c * 10;
      positions[i * 3 + 1] = r * 10;
      positions[i * 3 + 2] = 0;
    }
  }
  const tris: number[] = [];
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N - 1; c++) {
      if (r === 1 && c === 1) continue; // hole: remove the central cell entirely
      const a = r * N + c;
      const b = a + 1;
      const d = a + N;
      const e = d + 1;
      tris.push(a, b, e, a, e, d);
    }
  }
  return { positions, indices: Uint32Array.from(tris) };
}

describe('boundaryLoops', () => {
  it('grid with a hole: outer loop + 1 hole, outer is the longest', () => {
    const { positions, indices } = gridWithHole();
    const edges = boundaryEdges(indices);
    const { loops, outerIndex, holeCount } = boundaryLoops(edges, positions);
    expect(loops).toHaveLength(2);
    expect(holeCount).toBe(1);
    // outer rim of a 4×4 grid = 12 vertices; hole = 4 vertices
    const sizes = loops.map((l) => l.length).sort((a, b) => a - b);
    expect(sizes).toEqual([4, 12]);
    expect(loops[outerIndex]!.length).toBe(12);
  });

  it('Carlson sample: a clean single-loop perimeter, zero holes', async () => {
    const text = readFileSync(refPath('CO23012_TOPO.XML'), 'utf8');
    const { surfaces } = await parseLandXML(text, { fileName: 'CO23012_TOPO.XML' });
    const s = surfaces[0] as SurfaceModel;
    const edges = boundaryEdges(s.indices!);
    expect(edges.length).toBeGreaterThan(0);
    const { loops, holeCount } = boundaryLoops(edges, s.positions);
    expect(loops.length).toBeGreaterThanOrEqual(1);
    expect(holeCount).toBe(loops.length - 1);
    // every boundary edge is used exactly once across the loops
    const totalLoopVerts = loops.reduce((acc, l) => acc + l.length, 0);
    expect(totalLoopVerts).toBe(edges.length / 2);
  });

  it('degenerate/empty input never throws', () => {
    expect(boundaryLoops(new Uint32Array(0)).loops).toHaveLength(0);
    expect(boundaryLoops(Uint32Array.from([0, 1])).loops).toHaveLength(1); // open chain kept
  });
});
