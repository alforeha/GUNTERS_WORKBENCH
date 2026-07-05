// src/viewer/synthetic.ts — A4 synthetic perf gate fixture.
// Generates simplex-noise terrain AT SURVEY MAGNITUDES (center ≈ E 3,510,000 / N 1,511,000 /
// Z 4,190, extents ~5,000 ft) as a real SurfaceModel — this is both the 1M-vertex perf fixture
// and the first consumer proving the normalized contract works end-to-end.
import type { SurfaceModel } from '../core/contract';
import { SimplexNoise2D } from './noise';

export const TEST_MESH_CENTER = { e: 3_510_000, n: 1_511_000, z: 4_190 };
export const TEST_MESH_EXTENT_FT = 5_000;

export function generateTestMesh(vertexTarget = 1_000_000, seed = 1337): SurfaceModel {
  const side = Math.max(2, Math.round(Math.sqrt(vertexTarget)));
  const count = side * side;
  const spacing = TEST_MESH_EXTENT_FT / (side - 1);
  const e0 = TEST_MESH_CENTER.e - TEST_MESH_EXTENT_FT / 2;
  const n0 = TEST_MESH_CENTER.n - TEST_MESH_EXTENT_FT / 2;

  const noise = new SimplexNoise2D(seed);
  const baseWavelengthFt = 1_500; // dominant terrain feature size
  const amplitudeFt = 120;
  const octaves = 5;

  // Original coordinates: Float64, x=Easting y=Northing z=Elev (contract item 2).
  const positions = new Float64Array(count * 3);
  const sourcePointIds = new Uint32Array(count);
  let k = 0;
  for (let row = 0; row < side; row++) {
    const n = n0 + row * spacing;
    for (let col = 0; col < side; col++) {
      const e = e0 + col * spacing;
      const z =
        TEST_MESH_CENTER.z +
        amplitudeFt * noise.fbm(e / baseWavelengthFt, n / baseWavelengthFt, octaves);
      const i = k * 3;
      positions[i] = e;
      positions[i + 1] = n;
      positions[i + 2] = z;
      sourcePointIds[k] = k + 1; // 1-based like typical LandXML point ids
      k++;
    }
  }

  // Grid triangulation, CCW when viewed from +Z (up).
  const cells = side - 1;
  const faceCount = cells * cells * 2;
  const indices = new Uint32Array(faceCount * 3);
  let f = 0;
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      const a = row * side + col;
      const b = a + 1;
      const c = a + side + 1;
      const d = a + side;
      indices[f++] = a;
      indices[f++] = b;
      indices[f++] = c;
      indices[f++] = a;
      indices[f++] = c;
      indices[f++] = d;
    }
  }

  return {
    id: `synthetic-${count}-${seed}`,
    name: `Synthetic terrain (${count.toLocaleString()} pts)`,
    meta: {
      fileName: `synthetic://testmesh?n=${count}&seed=${seed}`,
      format: 'synthetic',
      producer: 'gunters.app test generator',
      formatVersion: '1',
      units: { linear: 'usSurveyFoot', raw: 'USSurveyFoot' },
    },
    positions,
    precisionHint: 3,
    sourcePointIds,
    indices,
    faceVisibility: null,
    edges: null,
    breaklines: [],
    boundaries: [],
    report: {
      counts: { points: count, faces: faceCount, breaklines: 0, boundaries: 0 },
      triangulationPreserved: true,
      warnings: [],
      infos: [`Synthetic perf fixture: ${side}×${side} grid, seed ${seed}`],
      unknownElements: {},
    },
    provenance: 'source-explicit',
    dirty: false,
  };
}
