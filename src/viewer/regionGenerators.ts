import type { FeatureRecord } from '../shared/workbench-types'
import type { GeneratedRegionSurfaceRecord, RegionSurfacePointRecord } from '../shared/regionMetadata'
import type { Vec3 } from './geometry'

export interface RegionPatchInput {
  border: Vec3[]
  closed: boolean
  breaklines?: Vec3[][]
  surfacePoints?: Vec3[]
}

export interface RegionPatchDisplay {
  positions: Float64Array
  indices: Uint32Array
  outline: Vec3[]
  breaklines: Vec3[][]
  areaXY: number
  minElevation: number | null
  maxElevation: number | null
  averageElevation: number | null
}

export interface RegionGeometry {
  border: Vec3[]
  closed: boolean
  breaklines: Vec3[][]
}

function cloneVec3(v: Vec3): Vec3 {
  return [v[0], v[1], v[2]]
}

function isVec3Array(value: unknown): value is Vec3[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => Array.isArray(entry) && entry.length === 3 && entry.every((axis) => typeof axis === 'number' && Number.isFinite(axis)),
    )
  )
}

export function signedAreaXY(ring: Vec3[]): number {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]!
    const [bx, by] = ring[(i + 1) % ring.length]!
    sum += ax * by - bx * ay
  }
  return sum / 2
}

function triangleAreaXY(a: Vec3, b: Vec3, c: Vec3): number {
  return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2
}

function pointOnSegmentXY(point: Vec3, a: Vec3, b: Vec3, epsilon = 1e-6): boolean {
  const cross = triangleAreaXY(a, b, point)
  if (Math.abs(cross) > epsilon) return false
  const minX = Math.min(a[0], b[0]) - epsilon
  const maxX = Math.max(a[0], b[0]) + epsilon
  const minY = Math.min(a[1], b[1]) - epsilon
  const maxY = Math.max(a[1], b[1]) + epsilon
  return point[0] >= minX && point[0] <= maxX && point[1] >= minY && point[1] <= maxY
}

function equalXY(a: Vec3, b: Vec3, epsilon = 1e-6): boolean {
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon
}

function pointInPolygonOrBoundaryXY(point: Vec3, polygon: Vec3[]): boolean {
  if (polygon.length < 3) return false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (pointOnSegmentXY(point, polygon[j]!, polygon[i]!)) return true
  }
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!
    const b = polygon[j]!
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside
    }
  }
  return inside
}

function circumcircleContains(a: Vec3, b: Vec3, c: Vec3, point: Vec3): boolean {
  const ax = a[0] - point[0]
  const ay = a[1] - point[1]
  const bx = b[0] - point[0]
  const by = b[1] - point[1]
  const cx = c[0] - point[0]
  const cy = c[1] - point[1]
  const det =
    (ax * ax + ay * ay) * (bx * cy - by * cx) -
    (bx * bx + by * by) * (ax * cy - ay * cx) +
    (cx * cx + cy * cy) * (ax * by - ay * bx)
  return det > 1e-9
}

function superTriangle(points: Vec3[]): [Vec3, Vec3, Vec3] {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of points) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const dx = maxX - minX
  const dy = maxY - minY
  const delta = Math.max(dx, dy, 1)
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2
  return [
    [midX - 20 * delta, midY - delta, 0],
    [midX + 20 * delta, midY - delta, 0],
    [midX, midY + 20 * delta, 0],
  ]
}

interface TriangleIndex {
  a: number
  b: number
  c: number
}

function triangleCentroid(points: Vec3[], triangle: TriangleIndex): Vec3 {
  const a = points[triangle.a]!
  const b = points[triangle.b]!
  const c = points[triangle.c]!
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]
}

function orientation2d(a: Vec3, b: Vec3, c: Vec3): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function onSegment2d(a: Vec3, b: Vec3, p: Vec3, epsilon = 1e-6): boolean {
  if (Math.abs(orientation2d(a, b, p)) > epsilon) return false
  return (
    p[0] >= Math.min(a[0], b[0]) - epsilon &&
    p[0] <= Math.max(a[0], b[0]) + epsilon &&
    p[1] >= Math.min(a[1], b[1]) - epsilon &&
    p[1] <= Math.max(a[1], b[1]) + epsilon
  )
}

function segmentsIntersect2d(a: Vec3, b: Vec3, c: Vec3, d: Vec3): boolean {
  const o1 = orientation2d(a, b, c)
  const o2 = orientation2d(a, b, d)
  const o3 = orientation2d(c, d, a)
  const o4 = orientation2d(c, d, b)
  if (o1 * o2 < 0 && o3 * o4 < 0) return true
  if (Math.abs(o1) <= 1e-6 && onSegment2d(a, b, c)) return true
  if (Math.abs(o2) <= 1e-6 && onSegment2d(a, b, d)) return true
  if (Math.abs(o3) <= 1e-6 && onSegment2d(c, d, a)) return true
  if (Math.abs(o4) <= 1e-6 && onSegment2d(c, d, b)) return true
  return false
}

function isBoundaryEdge(a: Vec3, b: Vec3, polygon: Vec3[]): boolean {
  for (let i = 0; i < polygon.length; i++) {
    const start = polygon[i]!
    const end = polygon[(i + 1) % polygon.length]!
    if ((equalXY(a, start) && equalXY(b, end)) || (equalXY(a, end) && equalXY(b, start))) return true
  }
  return false
}

function edgeAllowedInPolygon(a: Vec3, b: Vec3, polygon: Vec3[]): boolean {
  if (isBoundaryEdge(a, b, polygon)) return true
  const midpoint: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
  if (!pointInPolygonOrBoundaryXY(midpoint, polygon)) return false
  for (let i = 0; i < polygon.length; i++) {
    const start = polygon[i]!
    const end = polygon[(i + 1) % polygon.length]!
    const sharesEndpoint = equalXY(a, start) || equalXY(a, end) || equalXY(b, start) || equalXY(b, end)
    if (sharesEndpoint) continue
    if (segmentsIntersect2d(a, b, start, end)) return false
  }
  return true
}

function delaunayTriangulateXY(points: Vec3[], polygon: Vec3[]): Uint32Array {
  if (points.length < 3) return new Uint32Array(0)
  const basePoints = points.map(cloneVec3)
  const [sa, sb, sc] = superTriangle(basePoints)
  const work = [...basePoints, sa, sb, sc]
  const superA = basePoints.length
  const superB = basePoints.length + 1
  const superC = basePoints.length + 2
  let triangles: TriangleIndex[] = [{ a: superA, b: superB, c: superC }]

  for (let pointIndex = 0; pointIndex < basePoints.length; pointIndex++) {
    const point = work[pointIndex]!
    const bad = triangles.filter((triangle) => {
      const a = work[triangle.a]!
      const b = work[triangle.b]!
      const c = work[triangle.c]!
      return circumcircleContains(a, b, c, point)
    })
    const edges = new Map<string, [number, number]>()
    const counts = new Map<string, number>()
    for (const triangle of bad) {
      for (const [u, v] of [
        [triangle.a, triangle.b],
        [triangle.b, triangle.c],
        [triangle.c, triangle.a],
      ] as const) {
        const key = u < v ? `${u}:${v}` : `${v}:${u}`
        edges.set(key, u < v ? [u, v] : [v, u])
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    triangles = triangles.filter((triangle) => !bad.includes(triangle))
    for (const [key, edge] of edges) {
      if (counts.get(key) !== 1) continue
      const [u, v] = edge
      const a = work[u]!
      const b = work[v]!
      const c = work[pointIndex]!
      if (Math.abs(orientation2d(a, b, c)) <= 1e-9) continue
      triangles.push(orientation2d(a, b, c) > 0 ? { a: u, b: v, c: pointIndex } : { a: v, b: u, c: pointIndex })
    }
  }

  const filtered = triangles.filter((triangle) => triangle.a < basePoints.length && triangle.b < basePoints.length && triangle.c < basePoints.length)
  const kept: number[] = []
  for (const triangle of filtered) {
    const a = basePoints[triangle.a]!
    const b = basePoints[triangle.b]!
    const c = basePoints[triangle.c]!
    const centroid = triangleCentroid(basePoints, triangle)
    if (!pointInPolygonOrBoundaryXY(centroid, polygon)) continue
    if (!edgeAllowedInPolygon(a, b, polygon)) continue
    if (!edgeAllowedInPolygon(b, c, polygon)) continue
    if (!edgeAllowedInPolygon(c, a, polygon)) continue
    kept.push(triangle.a, triangle.b, triangle.c)
  }
  return Uint32Array.from(kept)
}

function duplicateXY(points: Vec3[], point: Vec3, epsilon = 1e-6): boolean {
  return points.some((candidate) => Math.abs(candidate[0] - point[0]) <= epsilon && Math.abs(candidate[1] - point[1]) <= epsilon)
}

function elevationStats(points: Vec3[]): { min: number | null; max: number | null; average: number | null } {
  if (points.length === 0) return { min: null, max: null, average: null }
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let sum = 0
  for (const [, , z] of points) {
    min = Math.min(min, z)
    max = Math.max(max, z)
    sum += z
  }
  return { min, max, average: sum / points.length }
}

export function buildRegionPatch(input: RegionPatchInput): RegionPatchDisplay {
  const border = input.border.map(cloneVec3)
  const breaklines = (input.breaklines ?? []).map((line) => line.map(cloneVec3))
  const outline = border.map(cloneVec3)
  if (input.closed && border.length >= 3) outline.push(cloneVec3(border[0]!))

  if (!input.closed || border.length < 3) {
    return {
      positions: new Float64Array(0),
      indices: new Uint32Array(0),
      outline,
      breaklines,
      areaXY: 0,
      minElevation: null,
      maxElevation: null,
      averageElevation: null,
    }
  }

  const points = border.map(cloneVec3)
  for (const point of input.surfacePoints ?? []) {
    if (!pointInPolygonOrBoundaryXY(point, border) || duplicateXY(points, point)) continue
    points.push(cloneVec3(point))
  }
  for (const breakline of breaklines) {
    for (const point of breakline) {
      if (!pointInPolygonOrBoundaryXY(point, border) || duplicateXY(points, point)) continue
      points.push(cloneVec3(point))
    }
  }
  const indices = delaunayTriangulateXY(points, border)

  const positions = new Float64Array(points.length * 3)
  for (let i = 0; i < points.length; i++) {
    positions[i * 3] = points[i]![0]
    positions[i * 3 + 1] = points[i]![1]
    positions[i * 3 + 2] = points[i]![2]
  }
  const stats = elevationStats(points)
  return {
    positions,
    indices,
    outline,
    breaklines,
    areaXY: Math.abs(signedAreaXY(border)),
    minElevation: stats.min,
    maxElevation: stats.max,
    averageElevation: stats.average,
  }
}

export function regionGeometryFromFeature(feature: FeatureRecord): RegionGeometry | null {
  if (feature.family !== 'region') return null
  const geometry = feature.geometry as { border?: unknown; closed?: unknown; breaklines?: unknown }
  if (!isVec3Array(geometry.border)) return null
  const breaklines: Vec3[][] = []
  if (Array.isArray(geometry.breaklines)) {
    for (const line of geometry.breaklines) {
      if (isVec3Array(line)) breaklines.push(line.map(cloneVec3))
    }
  }
  return {
    border: geometry.border.map(cloneVec3),
    closed: geometry.closed === true,
    breaklines,
  }
}

export function regionBoundaryFromFeature(feature: FeatureRecord): Vec3[] | null {
  const geometry = regionGeometryFromFeature(feature)
  return geometry?.closed ? geometry.border : null
}

export function averageRegionElevation(border: Vec3[], surfacePoints: RegionSurfacePointRecord[]): number {
  const candidates = surfacePoints.length > 0 ? surfacePoints.map((point) => point.coordinate as Vec3) : border
  if (candidates.length === 0) return 0
  return candidates.reduce((sum, point) => sum + point[2], 0) / candidates.length
}

export function generateGridPointsInRegion(border: Vec3[], spacing: number, elevation: number): Vec3[] {
  if (border.length < 3 || !Number.isFinite(spacing) || spacing <= 0) return []
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of border) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const points: Vec3[] = []
  const startX = minX + spacing / 2
  const startY = minY + spacing / 2
  for (let y = startY; y < maxY; y += spacing) {
    for (let x = startX; x < maxX; x += spacing) {
      const point: Vec3 = [x, y, elevation]
      if (pointInPolygonOrBoundaryXY(point, border)) points.push(point)
    }
  }
  return points
}

export function buildStoredRegionSurface(patch: RegionPatchDisplay, generatedAt: string): GeneratedRegionSurfaceRecord | null {
  if (patch.indices.length === 0 || patch.positions.length === 0) return null
  return {
    positions: Array.from(patch.positions),
    indices: Array.from(patch.indices),
    generatedAt,
    triangleCount: patch.indices.length / 3,
    minElevation: patch.minElevation,
    maxElevation: patch.maxElevation,
    averageElevation: patch.averageElevation,
  }
}

export function buildSurfaceWireframeLines(surface: GeneratedRegionSurfaceRecord): Vec3[][] {
  const lines: Vec3[][] = []
  const seen = new Set<string>()
  const pointAt = (index: number): Vec3 => [
    surface.positions[index * 3]!,
    surface.positions[index * 3 + 1]!,
    surface.positions[index * 3 + 2]!,
  ]
  const addEdge = (a: number, b: number): void => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    if (seen.has(key)) return
    seen.add(key)
    lines.push([pointAt(a), pointAt(b)])
  }
  for (let i = 0; i < surface.indices.length; i += 3) {
    const a = surface.indices[i]!
    const b = surface.indices[i + 1]!
    const c = surface.indices[i + 2]!
    addEdge(a, b)
    addEdge(b, c)
    addEdge(c, a)
  }
  return lines
}
