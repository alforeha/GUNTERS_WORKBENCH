// src/core/derivedBoundary.ts — derived outer boundary of a TIN (docs/08 Phase 1).
//
// PURE derived display data: computed on demand from the triangle index buffer, never stored
// on SurfaceModel, never exported. A boundary edge is an edge referenced by exactly ONE
// triangle; holes in the TIN fall out for free as additional closed loops.
//
// Pure core code: no DOM, no Three.js, Node-testable. Trivially fast at 5k faces; the
// count pass is a single Map over 3F edges with packed numeric keys, fine at 1M faces.

/**
 * Edges referenced by exactly one triangle, as a flat Uint32 pair buffer
 * [a0,b0, a1,b1, …] of 0-based vertex indices — directly usable as a LineSegments index.
 */
export function boundaryEdges(indices: Uint32Array): Uint32Array {
  let maxV = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]!;
    if (v > maxV) maxV = v;
  }
  const span = maxV + 1; // key = lo*span + hi — safe below 2^53 for span up to ~94M vertices
  const count = new Map<number, number>();
  const add = (a: number, b: number): void => {
    const key = a < b ? a * span + b : b * span + a;
    count.set(key, (count.get(key) ?? 0) + 1);
  };
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]!;
    const b = indices[i + 1]!;
    const c = indices[i + 2]!;
    add(a, b);
    add(b, c);
    add(c, a);
  }
  const out: number[] = [];
  for (const [key, n] of count) {
    if (n === 1) {
      const lo = Math.floor(key / span);
      out.push(lo, key - lo * span);
    }
  }
  return Uint32Array.from(out);
}

export interface BoundaryLoopsResult {
  /** Closed loops as 0-based vertex index sequences (closure implied — last connects to first). */
  loops: Uint32Array[];
  /** Index into `loops` of the longest loop (XY perimeter) — labeled "outer". */
  outerIndex: number;
  /** loops.length − 1 (clamped ≥ 0): every non-outer closed loop is a hole in the TIN. */
  holeCount: number;
}

/**
 * Group boundary edges into closed loops and label the longest "outer"; the rest are holes.
 * `positions` is the x,y,z-interleaved Float64 source buffer (XY perimeter decides "longest";
 * falls back to vertex count when omitted). Non-manifold junctions are walked greedily —
 * never throws.
 */
export function boundaryLoops(edges: Uint32Array, positions?: Float64Array): BoundaryLoopsResult {
  // adjacency: vertex → boundary-edge neighbors (typically exactly 2 on a clean manifold rim)
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    const l = adj.get(a);
    if (l) l.push(b);
    else adj.set(a, [b]);
  };
  for (let i = 0; i + 1 < edges.length; i += 2) {
    link(edges[i]!, edges[i + 1]!);
    link(edges[i + 1]!, edges[i]!);
  }

  const usedEdge = new Set<number>(); // packed undirected pair keys (same scheme as boundaryEdges)
  let span = 0;
  for (const v of adj.keys()) if (v + 1 > span) span = v + 1;
  const edgeKey = (a: number, b: number): number => (a < b ? a * span + b : b * span + a);

  const loops: Uint32Array[] = [];
  for (let i = 0; i + 1 < edges.length; i += 2) {
    const start = edges[i]!;
    const first = edges[i + 1]!;
    if (usedEdge.has(edgeKey(start, first))) continue;

    const loop: number[] = [start];
    let prev = start;
    let cur = first;
    usedEdge.add(edgeKey(prev, cur));
    // walk until we close back to start (or dead-end on degenerate input)
    for (let guard = 0; guard <= edges.length && cur !== start; guard++) {
      loop.push(cur);
      const neighbors = adj.get(cur) ?? [];
      let next = -1;
      for (const n of neighbors) {
        if (n !== prev && !usedEdge.has(edgeKey(cur, n))) {
          next = n;
          break;
        }
      }
      if (next < 0) break; // open chain (degenerate/non-manifold input) — keep what we have
      usedEdge.add(edgeKey(cur, next));
      prev = cur;
      cur = next;
    }
    loops.push(Uint32Array.from(loop));
  }

  let outerIndex = 0;
  let best = -1;
  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li]!;
    let measure: number;
    if (positions) {
      measure = 0;
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]! * 3;
        const b = loop[(i + 1) % loop.length]! * 3;
        measure += Math.hypot(positions[b]! - positions[a]!, positions[b + 1]! - positions[a + 1]!);
      }
    } else {
      measure = loop.length;
    }
    if (measure > best) {
      best = measure;
      outerIndex = li;
    }
  }

  return { loops, outerIndex, holeCount: Math.max(loops.length - 1, 0) };
}
