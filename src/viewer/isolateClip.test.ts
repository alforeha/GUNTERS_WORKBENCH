import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  MAX_ISOLATE_VERTICES,
  applyIsolateClip,
  createIsolateClipUniforms,
  pointInPolygonXY,
  setIsolateClipPolygon,
} from './isolateClip';

describe('isolate clip uniforms', () => {
  it('starts inactive with a fixed-capacity polygon array', () => {
    const uniforms = createIsolateClipUniforms();
    expect(uniforms.count.value).toBe(0);
    expect(uniforms.poly.value).toHaveLength(MAX_ISOLATE_VERTICES);
  });

  it('loads a polygon and clears back to inactive', () => {
    const uniforms = createIsolateClipUniforms();
    setIsolateClipPolygon(uniforms, [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ]);
    expect(uniforms.count.value).toBe(3);
    expect(uniforms.poly.value[0]!.x).toBe(1);
    expect(uniforms.poly.value[2]!.y).toBe(6);

    setIsolateClipPolygon(uniforms, null);
    expect(uniforms.count.value).toBe(0);
  });

  it('ignores degenerate polygons and truncates oversized ones', () => {
    const uniforms = createIsolateClipUniforms();
    setIsolateClipPolygon(uniforms, [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
    expect(uniforms.count.value).toBe(0);

    const oversized = Array.from({ length: MAX_ISOLATE_VERTICES + 8 }, (_, i) => ({ x: i, y: i }));
    setIsolateClipPolygon(uniforms, oversized);
    expect(uniforms.count.value).toBe(MAX_ISOLATE_VERTICES);
  });
});

describe('pointInPolygonXY', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('classifies inside and outside points', () => {
    expect(pointInPolygonXY(5, 5, square)).toBe(true);
    expect(pointInPolygonXY(15, 5, square)).toBe(false);
    expect(pointInPolygonXY(-1, -1, square)).toBe(false);
  });

  it('handles concave polygons', () => {
    // U-shape: the notch between the arms is outside.
    const uShape = [
      { x: 0, y: 0 },
      { x: 12, y: 0 },
      { x: 12, y: 10 },
      { x: 8, y: 10 },
      { x: 8, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygonXY(2, 8, uShape)).toBe(true); // left arm
    expect(pointInPolygonXY(10, 8, uShape)).toBe(true); // right arm
    expect(pointInPolygonXY(6, 8, uShape)).toBe(false); // notch
    expect(pointInPolygonXY(6, 2, uShape)).toBe(true); // base
  });
});

describe('applyIsolateClip', () => {
  it('wires shared uniforms and injects the polygon discard into both stages', () => {
    const uniforms = createIsolateClipUniforms();
    const material = new THREE.PointsMaterial();
    applyIsolateClip(material, uniforms);

    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: 'void main() {\n\t#include <project_vertex>\n}',
      fragmentShader: 'void main() {\n\t#include <clipping_planes_fragment>\n}',
    };
    material.onBeforeCompile(shader as never, undefined as never);

    // Shared object identity: updating the polygon updates every compiled program.
    expect(shader.uniforms.uIsolateCount).toBe(uniforms.count);
    expect(shader.uniforms.uIsolatePoly).toBe(uniforms.poly);
    expect(shader.vertexShader).toContain('vIsolateXY = (modelMatrix * vec4( position, 1.0 )).xy;');
    expect(shader.vertexShader).toContain('#include <project_vertex>');
    expect(shader.fragmentShader).toContain('uniform vec2 uIsolatePoly');
    expect(shader.fragmentShader).toContain('discard');
    expect(material.customProgramCacheKey()).toBe('isolate-clip');
  });
});
