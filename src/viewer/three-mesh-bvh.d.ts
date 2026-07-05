// Type augmentation for the three-mesh-bvh prototype extensions installed in RenderSurface.ts.
import type { MeshBVH, MeshBVHOptions } from 'three-mesh-bvh';

declare module 'three' {
  interface BufferGeometry {
    computeBoundsTree(options?: MeshBVHOptions): MeshBVH;
    disposeBoundsTree(): void;
    boundsTree?: MeshBVH;
  }
  interface Raycaster {
    /** three-mesh-bvh extension: stop at the first BVH hit. */
    firstHitOnly?: boolean;
  }
}

declare module 'three-mesh-bvh' {
  interface MeshBVH {
    refit(nodeIndices?: Set<number> | number[]): void;
  }
}
