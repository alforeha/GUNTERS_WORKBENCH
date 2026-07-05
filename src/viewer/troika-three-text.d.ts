// Minimal type surface for troika-three-text (no upstream types as of 0.52.x).
// Only the members LabelPool uses are declared.
declare module 'troika-three-text' {
  import * as THREE from 'three';

  export class Text extends THREE.Mesh {
    text: string;
    fontSize: number;
    color: string | number;
    fillOpacity: number;
    outlineOpacity: number;
    outlineWidth: number | string;
    outlineColor: string | number;
    anchorX: 'left' | 'center' | 'right' | number | string;
    anchorY: 'top' | 'top-baseline' | 'middle' | 'bottom-baseline' | 'bottom' | number | string;
    material: THREE.Material;
    sync(callback?: () => void): void;
    dispose(): void;
  }
}
