// src/viewer/isolateClip.ts - GPU isolate-focus clipping for point clouds.
// While an object with an isolate boundary is open, fragments whose world XY
// falls outside the polygon are discarded, so only the work area renders.
// Display-only: geometry, streaming, picking, and evidence records are
// untouched, and setting the polygon to null instantly restores full display
// (uniform-driven - no shader recompile on toggle).

import * as THREE from 'three';

/** Uniform array capacity; boundaries beyond this are truncated. */
export const MAX_ISOLATE_VERTICES = 32;

/** Shared uniform objects: every material of one cloud renderer points at these. */
export interface IsolateClipUniforms {
  count: { value: number };
  poly: { value: THREE.Vector2[] };
}

export function createIsolateClipUniforms(): IsolateClipUniforms {
  return {
    count: { value: 0 },
    poly: { value: Array.from({ length: MAX_ISOLATE_VERTICES }, () => new THREE.Vector2()) },
  };
}

/**
 * Loads a render-local XY polygon into the shared uniforms; null (or fewer
 * than 3 vertices) disables clipping.
 */
export function setIsolateClipPolygon(
  uniforms: IsolateClipUniforms,
  polygonXY: { x: number; y: number }[] | null,
): void {
  const points = (polygonXY ?? []).slice(0, MAX_ISOLATE_VERTICES);
  if (points.length < 3) {
    uniforms.count.value = 0;
    return;
  }
  for (let i = 0; i < points.length; i++) uniforms.poly.value[i]!.set(points[i]!.x, points[i]!.y);
  uniforms.count.value = points.length;
}

/**
 * CPU twin of the shader's even-odd test, for picking: while isolate focus is
 * active, snapping and window selection must only consider the points the
 * user can actually see.
 */
export function pointInPolygonXY(x: number, y: number, polygon: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Patches a built-in points material to discard fragments outside the isolate
 * polygon (even-odd rule on world XY). The test is skipped entirely while
 * count < 3, so an idle clip costs one uniform branch per fragment.
 */
export function applyIsolateClip(material: THREE.PointsMaterial, uniforms: IsolateClipUniforms): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uIsolateCount = uniforms.count;
    shader.uniforms.uIsolatePoly = uniforms.poly;
    shader.vertexShader =
      'varying vec2 vIsolateXY;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        'vIsolateXY = (modelMatrix * vec4( position, 1.0 )).xy;\n\t#include <project_vertex>',
      );
    shader.fragmentShader =
      'varying vec2 vIsolateXY;\n' +
      'uniform int uIsolateCount;\n' +
      `uniform vec2 uIsolatePoly[${MAX_ISOLATE_VERTICES}];\n` +
      shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
	if ( uIsolateCount >= 3 ) {
		bool isolateInside = false;
		vec2 isolatePrev = uIsolatePoly[ uIsolateCount - 1 ];
		for ( int i = 0; i < ${MAX_ISOLATE_VERTICES}; i++ ) {
			if ( i >= uIsolateCount ) break;
			vec2 isolateCurr = uIsolatePoly[ i ];
			if ( ( ( isolateCurr.y > vIsolateXY.y ) != ( isolatePrev.y > vIsolateXY.y ) ) &&
				( vIsolateXY.x < ( isolatePrev.x - isolateCurr.x ) * ( vIsolateXY.y - isolateCurr.y ) / ( isolatePrev.y - isolateCurr.y ) + isolateCurr.x ) ) {
				isolateInside = !isolateInside;
			}
			isolatePrev = isolateCurr;
		}
		if ( !isolateInside ) discard;
	}`,
      );
  };
  // Distinguish patched programs from stock PointsMaterial in the program cache.
  material.customProgramCacheKey = () => 'isolate-clip';
}
