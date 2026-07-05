// src/viewer/gizmo.ts — corner north-arrow / axis gizmo (07 Phase 2 ruling: include now).
// Rendered as a separate overlay scene/pass by ViewerEngine; ~zero render cost.
import * as THREE from 'three';

export const GIZMO_SIZE = 84; // CSS px square, bottom-right corner
export const GIZMO_MARGIN = 10;

const NORTH_COLOR = '#53c7c0'; // accent — N is the star of the show
const EAST_COLOR = '#a3543f';
const UP_COLOR = '#6f7782';

/** Local position of the N marker inside the gizmo group (world +Y = north). */
export const NORTH_LOCAL = new THREE.Vector3(0, 1.0, 0);

function makeTextSprite(text: string, color: string, scale: number): THREE.Sprite {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 44px -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, size / 2, size / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(scale);
  return sprite;
}

function makeAxisLine(dir: THREE.Vector3, length: number, color: string): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    dir.clone().multiplyScalar(length),
  ]);
  const material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
  return new THREE.Line(geometry, material);
}

/**
 * Axes (E/N/Up) + an emphasized N marker. The group quaternion is set per-frame to the
 * INVERSE of the camera quaternion so world directions read correctly in view space.
 */
export function buildNorthGizmo(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'north-gizmo';

  group.add(makeAxisLine(new THREE.Vector3(0, 1, 0), 0.78, NORTH_COLOR)); // north
  group.add(makeAxisLine(new THREE.Vector3(1, 0, 0), 0.6, EAST_COLOR)); // east
  group.add(makeAxisLine(new THREE.Vector3(0, 0, 1), 0.6, UP_COLOR)); // up

  const n = makeTextSprite('N', NORTH_COLOR, 0.62);
  n.position.copy(NORTH_LOCAL);
  n.name = 'north-marker';
  group.add(n);

  const e = makeTextSprite('E', EAST_COLOR, 0.4);
  e.position.set(0.88, 0, 0);
  group.add(e);

  return group;
}

/** NDC position of the N marker through the gizmo camera (for click hit-testing). */
export function projectGizmoNorth(group: THREE.Group, camera: THREE.Camera): THREE.Vector3 {
  return NORTH_LOCAL.clone().applyQuaternion(group.quaternion).project(camera);
}
