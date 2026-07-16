import { describe, expect, it } from 'vitest'
import type { FeatureRecord } from '../shared/workbench-types'
import type { Vec3 } from './geometry'
import {
  buildRegionPatch,
  buildStoredRegionSurface,
  generateGridPointsInRegion,
  regionBoundaryFromFeature,
  regionGeometryFromFeature,
} from './regionGenerators'

const BORDER: Vec3[] = [
  [0, 0, 10],
  [10, 0, 10],
  [10, 10, 10],
  [0, 10, 10],
]

describe('regionGenerators', () => {
  it('keeps the authored boundary as the region focus boundary', () => {
    const feature: FeatureRecord = {
      id: 'feat-region',
      simulationId: 'sim-1',
      type: 'polyline',
      name: 'Region 1',
      geometry: { border: BORDER, closed: true, breaklines: [] },
      createdAt: '2026-07-16T00:00:00.000Z',
      modifiedAt: '2026-07-16T00:00:00.000Z',
      family: 'region',
    }
    expect(regionBoundaryFromFeature(feature)).toEqual(BORDER)
    expect(regionGeometryFromFeature(feature)?.border).toEqual(BORDER)
  })

  it('triangulates boundary plus interior surface points with visible z variation', () => {
    const patch = buildRegionPatch({
      border: BORDER,
      closed: true,
      breaklines: [],
      surfacePoints: [
        [5, 5, 15],
        [3, 6, 12],
      ],
    })
    expect(patch.indices.length).toBeGreaterThan(6)
    expect(patch.positions.length / 3).toBe(6)
    expect(patch.maxElevation).toBe(15)
    expect(patch.averageElevation).toBeGreaterThan(10)
  })

  it('avoids an obvious long cross-region edge when nearby points exist', () => {
    const patch = buildRegionPatch({
      border: BORDER,
      closed: true,
      surfacePoints: [
        [3, 3, 10],
        [7, 3, 10],
        [3, 7, 10],
        [7, 7, 10],
      ],
    })
    const edges = new Set<string>()
    for (let i = 0; i < patch.indices.length; i += 3) {
      const tri = [patch.indices[i]!, patch.indices[i + 1]!, patch.indices[i + 2]!]
      for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
        edges.add(a < b ? `${a}:${b}` : `${b}:${a}`)
      }
    }
    expect(edges.has('0:2')).toBe(false)
    expect(edges.has('1:3')).toBe(false)
  })

  it('includes breakline vertices in the generated surface point set', () => {
    const patch = buildRegionPatch({
      border: BORDER,
      closed: true,
      breaklines: [[[2, 2, 11], [8, 8, 12]]],
    })
    const positions = [] as number[]
    for (let i = 0; i < patch.positions.length; i += 3) positions.push(patch.positions[i]!, patch.positions[i + 1]!, patch.positions[i + 2]!)
    expect(positions).toContain(2)
    expect(positions).toContain(8)
    expect(patch.positions.length / 3).toBe(6)
  })

  it('generates grid points inside the polygon and stores a mesh record', () => {
    const grid = generateGridPointsInRegion(BORDER, 5, 10)
    expect(grid).toEqual([
      [2.5, 2.5, 10],
      [7.5, 2.5, 10],
      [2.5, 7.5, 10],
      [7.5, 7.5, 10],
    ])

    const patch = buildRegionPatch({ border: BORDER, closed: true, surfacePoints: grid })
    const stored = buildStoredRegionSurface(patch, '2026-07-16T12:00:00.000Z')
    expect(stored).not.toBeNull()
    expect(stored?.triangleCount).toBeGreaterThan(0)
    expect(stored?.generatedAt).toBe('2026-07-16T12:00:00.000Z')
  })
})