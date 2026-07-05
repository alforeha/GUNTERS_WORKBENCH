// src/viewer/geometry.ts — pure geometry helpers (no Three.js imports → Node-testable).
// These implement the origin-rebasing path (risk R1) and the unique-edge overlay build (04 §3).

export type Vec3 = [number, number, number];

export interface BBox {
  min: Vec3;
  max: Vec3;
  center: Vec3;
}

/** Bounding box of an x,y,z-interleaved Float64 position buffer. */
export function computeBBox(positions: Float64Array): BBox {
  if (positions.length < 3) throw new Error('computeBBox: empty position buffer');
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return { min, max, center };
}

/**
 * Rebase Float64 source coordinates to local Float32 render coordinates: render = source − origin.
 * Raw survey-magnitude values must NEVER enter a Float32 buffer (risk R1) — the subtraction
 * happens here in Float64, and only the small local residual is narrowed to Float32.
 */
export function rebasePositions(positions: Float64Array, origin: Vec3): Float32Array {
  const out = new Float32Array(positions.length);
  const [ox, oy, oz] = origin;
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i]! - ox;
    out[i + 1] = positions[i + 1]! - oy;
    out[i + 2] = positions[i + 2]! - oz;
  }
  return out;
}

/**
 * Unique undirected edge set from a triangle index buffer, as a flat Uint32 pair buffer
 * suitable for one LineSegments draw call (04 §3 — NOT EdgesGeometry, which duplicates).
 */
export function buildUniqueEdges(indices: Uint32Array, vertexCount: number): Uint32Array {
  const seen = new Set<number>();
  const edges: number[] = [];
  const addEdge = (a: number, b: number) => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * vertexCount + hi; // safe: < 2^53 for vertexCount up to ~67M
    if (!seen.has(key)) {
      seen.add(key);
      edges.push(lo, hi);
    }
  };
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]!;
    const b = indices[i + 1]!;
    const c = indices[i + 2]!;
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }
  return Uint32Array.from(edges);
}
