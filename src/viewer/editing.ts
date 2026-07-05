// Pure edit helpers: vertex adjacency, incremental normal updates, and screen-space picking math.
// No Three.js imports here â€” these stay Node-testable.
import type { Vec3 } from './geometry';

export interface CameraPickFrame {
  projection: 'perspective' | 'orthographic';
  viewportHeightPx: number;
  distanceToPoint: number;
  fovDeg?: number;
  orthoSpan?: number;
  exaggeration: number;
}

export interface ScreenPoint {
  id: number;
  x: number;
  y: number;
}

export interface EdgeFaces {
  vertices: [number, number];
  faces: [number, number];
}

export function buildVertexFaceAdjacency(indices: Uint32Array, vertexCount: number): Uint32Array[] {
  const buckets: number[][] = Array.from({ length: vertexCount }, () => []);
  for (let face = 0; face < indices.length; face += 3) {
    const faceIndex = face / 3;
    buckets[indices[face]!]!.push(faceIndex);
    buckets[indices[face + 1]!]!.push(faceIndex);
    buckets[indices[face + 2]!]!.push(faceIndex);
  }
  return buckets.map((bucket) => Uint32Array.from(bucket));
}

export function computeVertexNormals(
  positions: Float64Array,
  indices: Uint32Array,
  adjacency = buildVertexFaceAdjacency(indices, positions.length / 3),
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let vertex = 0; vertex < adjacency.length; vertex++) {
    writeVertexNormal(positions, indices, adjacency, normals, vertex);
  }
  return normals;
}

export function affectedVerticesForEdit(
  indices: Uint32Array,
  adjacency: Uint32Array[],
  vertexId: number,
): number[] {
  const out = new Set<number>([vertexId]);
  const faces = adjacency[vertexId] ?? new Uint32Array(0);
  for (const faceIndex of faces) {
    const base = faceIndex * 3;
    out.add(indices[base]!);
    out.add(indices[base + 1]!);
    out.add(indices[base + 2]!);
  }
  return [...out];
}

export function recomputeAffectedVertexNormals(
  positions: Float64Array,
  indices: Uint32Array,
  adjacency: Uint32Array[],
  normals: Float32Array,
  changedVertexId: number,
): number[] {
  const affected = affectedVerticesForEdit(indices, adjacency, changedVertexId);
  for (const vertexId of affected) {
    writeVertexNormal(positions, indices, adjacency, normals, vertexId);
  }
  return affected;
}

export function triangleOrientationSign(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

export function wouldFlipIncidentTriangles(
  positions: Float64Array,
  indices: Uint32Array,
  adjacency: Uint32Array[],
  vertexId: number,
  nextX: number,
  nextY: number,
): boolean {
  const faces = adjacency[vertexId] ?? new Uint32Array(0);
  for (const faceIndex of faces) {
    const base = faceIndex * 3;
    const tri = [indices[base]!, indices[base + 1]!, indices[base + 2]!];
    const coords = tri.map((id) =>
      id === vertexId
        ? [nextX, nextY]
        : [positions[id * 3]!, positions[id * 3 + 1]!] as const,
    );
    const sign = triangleOrientationSign(
      coords[0]![0],
      coords[0]![1],
      coords[1]![0],
      coords[1]![1],
      coords[2]![0],
      coords[2]![1],
    );
    if (Math.abs(sign) < 1e-9) return true;
    const original = triangleOrientationSign(
      positions[tri[0]! * 3]!,
      positions[tri[0]! * 3 + 1]!,
      positions[tri[1]! * 3]!,
      positions[tri[1]! * 3 + 1]!,
      positions[tri[2]! * 3]!,
      positions[tri[2]! * 3 + 1]!,
    );
    if (sign * original <= 0) return true;
  }
  return false;
}

export function buildEdgeFaceMap(indices: Uint32Array): Map<string, EdgeFaces> {
  const map = new Map<string, EdgeFaces>();
  for (let base = 0; base < indices.length; base += 3) {
    const face = base / 3;
    addEdgeFace(map, indices[base]!, indices[base + 1]!, face);
    addEdgeFace(map, indices[base + 1]!, indices[base + 2]!, face);
    addEdgeFace(map, indices[base + 2]!, indices[base]!, face);
  }
  return map;
}

function addEdgeFace(map: Map<string, EdgeFaces>, a: number, b: number, face: number): void {
  const key = edgeKey(a, b);
  const current = map.get(key);
  if (!current) {
    map.set(key, { vertices: orderedEdge(a, b), faces: [face, -1] });
    return;
  }
  current.faces[1] = face;
}

export function edgeKey(a: number, b: number): string {
  const [lo, hi] = orderedEdge(a, b);
  return `${lo}:${hi}`;
}

export function orderedEdge(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

function writeVertexNormal(
  positions: Float64Array,
  indices: Uint32Array,
  adjacency: Uint32Array[],
  normals: Float32Array,
  vertexId: number,
): void {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const faces = adjacency[vertexId] ?? new Uint32Array(0);
  for (const faceIndex of faces) {
    const base = faceIndex * 3;
    const a = indices[base]!;
    const b = indices[base + 1]!;
    const c = indices[base + 2]!;
    const faceNormal = faceNormalFromPositions(positions, a, b, c);
    nx += faceNormal[0];
    ny += faceNormal[1];
    nz += faceNormal[2];
  }
  const len = Math.hypot(nx, ny, nz);
  const offset = vertexId * 3;
  if (len === 0) {
    normals[offset] = 0;
    normals[offset + 1] = 0;
    normals[offset + 2] = 1;
    return;
  }
  normals[offset] = nx / len;
  normals[offset + 1] = ny / len;
  normals[offset + 2] = nz / len;
}

function faceNormalFromPositions(
  positions: Float64Array,
  a: number,
  b: number,
  c: number,
): Vec3 {
  const ax = positions[a * 3]!;
  const ay = positions[a * 3 + 1]!;
  const az = positions[a * 3 + 2]!;
  const bx = positions[b * 3]!;
  const by = positions[b * 3 + 1]!;
  const bz = positions[b * 3 + 2]!;
  const cx = positions[c * 3]!;
  const cy = positions[c * 3 + 1]!;
  const cz = positions[c * 3 + 2]!;
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  return [
    aby * acz - abz * acy,
    abz * acx - abx * acz,
    abx * acy - aby * acx,
  ];
}

export function worldUnitsPerPixel(frame: CameraPickFrame): number {
  const height = Math.max(frame.viewportHeightPx, 1);
  if (frame.projection === 'orthographic') {
    return (frame.orthoSpan ?? 1) / height / Math.max(frame.exaggeration, 1e-6);
  }
  const fov = frame.fovDeg ?? 50;
  const worldHeight = 2 * frame.distanceToPoint * Math.tan((fov * Math.PI) / 360);
  return worldHeight / height / Math.max(frame.exaggeration, 1e-6);
}

export function pickClosestScreenPoint(
  pointer: { x: number; y: number },
  candidates: ScreenPoint[],
  snapRadiusPx: number,
): number | null {
  let winner: number | null = null;
  let best = snapRadiusPx;
  for (const candidate of candidates) {
    const dist = Math.hypot(candidate.x - pointer.x, candidate.y - pointer.y);
    if (dist <= best) {
      best = dist;
      winner = candidate.id;
    }
  }
  return winner;
}
