import { describe, expect, it } from 'vitest';
import {
  buildVertexFaceAdjacency,
  wouldFlipIncidentTriangles,
  computeVertexNormals,
  pickClosestScreenPoint,
  recomputeAffectedVertexNormals,
  worldUnitsPerPixel,
} from './editing';

describe('vertex picking math', () => {
  it('converts perspective pixels to local world-space tolerance', () => {
    const units = worldUnitsPerPixel({
      projection: 'perspective',
      viewportHeightPx: 1000,
      distanceToPoint: 500,
      fovDeg: 60,
      exaggeration: 2,
    });
    expect(units).toBeCloseTo(0.288675, 6);
  });

  it('chooses the closest candidate inside the snap radius', () => {
    const picked = pickClosestScreenPoint(
      { x: 100, y: 120 },
      [
        { id: 1, x: 112, y: 123 },
        { id: 7, x: 104, y: 117 },
        { id: 9, x: 150, y: 180 },
      ],
      14,
    );
    expect(picked).toBe(7);
    expect(pickClosestScreenPoint({ x: 0, y: 0 }, [{ id: 1, x: 40, y: 40 }], 10)).toBeNull();
  });
});

describe('incremental Z edit path', () => {
  it('recomputes only the edited vertex neighborhood normals', () => {
    const positions = new Float64Array([
      0, 0, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const adjacency = buildVertexFaceAdjacency(indices, 4);
    const normals = computeVertexNormals(positions, indices, adjacency);
    const before = [...normals];

    positions[2] = 2;
    const affected = recomputeAffectedVertexNormals(positions, indices, adjacency, normals, 0);

    expect(affected.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(before).not.toEqual([...normals]);
    expect(normals[2]).toBeGreaterThan(0);
    expect(normals[5]).toBeGreaterThan(0);
  });

  it('blocks XY moves that would invert an incident triangle', () => {
    const positions = new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]);
    const indices = new Uint32Array([0, 1, 2]);
    const adjacency = buildVertexFaceAdjacency(indices, 3);
    expect(wouldFlipIncidentTriangles(positions, indices, adjacency, 0, 0.8, 0.8)).toBe(true);
    expect(wouldFlipIncidentTriangles(positions, indices, adjacency, 0, -0.1, -0.1)).toBe(false);
  });
});
