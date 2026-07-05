import * as THREE from 'three';
import type { BorderCrop, PdfCalibration, PdfNorthArrow, PdfPlacement, PdfScaleBar, PdfKnownDistance } from '../core/contract';
import type {
  PdfDecodeTileRequest,
  PdfOpenRequest,
  PdfWorkerMessage,
} from '../workers/pdf.worker';
import type { Vec3 } from './geometry';
import type { RenderSurface } from './RenderSurface';
import { DRAPE_OFFSET_FT } from './RenderDxf';

const TILE_SIZE_PX = 1024;
export const DEFAULT_PIXELS_PER_FOOT = 100;
const MAX_CONCURRENT_TILE_DECODES = 4;
const MIN_DRAPE_SEGMENTS = 8;
const MAX_DRAPE_SEGMENTS = 24;
const DRAPE_SEGMENT_SPACING_FT = 1.5;

interface PdfTileState {
  id: string;
  window: [number, number, number, number];
  needsCropMask: boolean;
  localBounds: THREE.Box3;
  loaded: boolean;
  loading: boolean;
  requestToken: number;
  mesh: THREE.Mesh | null;
  texture: THREE.DataTexture | null;
  bounds: THREE.Box3;
}

export interface PdfRenderableSheet {
  handle: string;
  pageIndex: number;
  label: string;
  visible: boolean;
  calibration: PdfCalibration | null;
  orientation: number | null;
  opacityPct: number;
  whiteThreshold: number;
  widthPx150: number;
  heightPx150: number;
  relativeLayoutPx: { x: number; y: number };
  borderCrop: BorderCrop | null;
  northArrow: PdfNorthArrow | null;
  scaleBar: PdfScaleBar | null;
  knownDistance: PdfKnownDistance | null;
  markupOpacity: number;
  edgeVisible: boolean;
  edgeColor: string;
  placement: PdfPlacement | null;
}

export class RenderPdf {
  readonly handle: string;
  readonly group = new THREE.Group();

  private sheet: PdfRenderableSheet;
  private file: File;
  private origin: Vec3;
  private worker: Worker;
  private workerReady = false;
  private nextMessageId = 0;
  private pending = new Map<number, (msg: PdfWorkerMessage) => void>();
  private tiles: PdfTileState[] = [];
  private visibleAll = true;
  private opacity = 1;
  private requestRender: () => void;
  private notifyBoundsChanged: () => void;
  private disposedFlag = false;
  private outlineMesh: THREE.LineLoop | null = null;
  private loadingBarMesh: THREE.Mesh | null = null;
  private loadingBarTexture: THREE.DataTexture | null = null;
  private northArrowGroup: THREE.Group | null = null;
  private scaleBarGroup: THREE.Group | null = null;
  private knownDistanceGroup: THREE.Group | null = null;
  private edgeGroup: THREE.Group | null = null;
  private sheetRenderOrder = 30;
  private target: RenderSurface | null = null;
  private overlap = false;
  private warnedMissingPickMesh = false;
  private drapeExaggeration = 1;

  constructor(
    handle: string,
    sheet: PdfRenderableSheet,
    file: File,
    origin: Vec3,
    requestRender: () => void,
    notifyBoundsChanged: () => void,
  ) {
    this.handle = handle;
    this.sheet = sheet;
    this.file = file;
    this.origin = origin;
    this.requestRender = requestRender;
    this.notifyBoundsChanged = notifyBoundsChanged;
    this.group.name = `pdf:${handle}`;
    this.group.renderOrder = this.sheetRenderOrder;
    this.applyTransform();
    this.tiles = this.buildTileIndex();
    this.buildLoadingOverlay();
    this.buildNorthArrowOverlay();
    this.buildScaleBarOverlay();
    this.buildKnownDistanceOverlay();
    this.buildEdgeOverlay();
    this.worker = new Worker(new URL('../workers/pdf.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<PdfWorkerMessage>) => {
      const resolver = this.pending.get(e.data.id);
      if (!resolver) return;
      resolver(e.data);
    };
    this.worker.onerror = (e) => {
      console.warn(`[PDF] worker error for "${this.sheet.label}":`, e.message);
    };
    this.openWorker();
  }

  get bounds(): THREE.Box3 {
    if (!this.group.visible) return new THREE.Box3().makeEmpty();
    const box = new THREE.Box3();
    for (const tile of this.tiles) box.union(tile.bounds);
    if (box.isEmpty()) {
      const size = this.sheetWorldSize();
      box.set(
        new THREE.Vector3(-size.width / 2, -size.height / 2, 0),
        new THREE.Vector3(size.width / 2, size.height / 2, 0),
      );
    }
    return box.applyMatrix4(this.group.matrixWorld);
  }

  setTarget(target: RenderSurface | null): void {
    if (!this.sheet.placement) return;
    if (this.target === target) return;
    this.target = target;
    this.overlap = this.computePdfOverlap();
    this.clearLoadedTiles();
    this.notifyBoundsChanged();
    this.requestRender();
  }

  private computePdfOverlap(): boolean {
    if (!this.target) return false;
    const surfaceBounds = this.target.bounds;
    const sMinX = surfaceBounds.min.x;
    const sMinY = surfaceBounds.min.y;
    const sMaxX = surfaceBounds.max.x;
    const sMaxY = surfaceBounds.max.y;
    const wSize = this.sheetWorldSize();
    const hw = wSize.width / 2;
    const hh = wSize.height / 2;
    const localCorners = [
      new THREE.Vector3(-hw, -hh, 0),
      new THREE.Vector3( hw, -hh, 0),
      new THREE.Vector3( hw,  hh, 0),
      new THREE.Vector3(-hw,  hh, 0),
    ];
    const worldCorners = localCorners.map((c) => c.applyMatrix4(this.group.matrix));
    const pMinX = Math.min(...worldCorners.map((c) => c.x));
    const pMaxX = Math.max(...worldCorners.map((c) => c.x));
    const pMinY = Math.min(...worldCorners.map((c) => c.y));
    const pMaxY = Math.max(...worldCorners.map((c) => c.y));
    return !(pMaxX < sMinX || pMinX > sMaxX || pMaxY < sMinY || pMinY > sMaxY);
  }

  dispose(): void {
    this.disposedFlag = true;
    this.clearLoadedTiles();
    this.pending.clear();
    this.worker.terminate();
    this.disposeLoadingOverlay();
    this.disposeNorthArrowOverlay();
    this.disposeScaleBarOverlay();
    this.disposeKnownDistanceOverlay();
    this.disposeEdgeOverlay();
    this.group.removeFromParent();
  }

  setDisplay(visible: boolean, opacityPct: number): void {
    this.visibleAll = visible;
    this.opacity = THREE.MathUtils.clamp(opacityPct / 100, 0, 1);
    this.group.visible = visible;
    for (const tile of this.tiles) {
      const material = tile.mesh?.material as THREE.MeshBasicMaterial | undefined;
      if (!material) continue;
      material.opacity = this.opacity;
      material.transparent = true;
      material.needsUpdate = true;
    }
    this.requestRender();
  }

  updateSheet(sheet: PdfRenderableSheet): void {
    const scaleChanged = this.pixelsPerFoot() !== pixelsPerFootForSheet(sheet);
    const thresholdChanged = this.sheet.whiteThreshold !== sheet.whiteThreshold;
    const cropChanged = JSON.stringify(this.sheet.borderCrop) !== JSON.stringify(sheet.borderCrop);
    // Capture old markup refs before reassignment so vis-only check can compare old vs new
    const oldNorthArrow = this.sheet.northArrow;
    const oldScaleBar = this.sheet.scaleBar;
    const oldKnownDistance = this.sheet.knownDistance;
    const northArrowChanged = JSON.stringify(oldNorthArrow) !== JSON.stringify(sheet.northArrow);
    const scaleBarChanged = JSON.stringify(oldScaleBar) !== JSON.stringify(sheet.scaleBar);
    const knownDistanceChanged = JSON.stringify(oldKnownDistance) !== JSON.stringify(sheet.knownDistance);
    const oldMarkupOpacity = this.sheet.markupOpacity;
    const oldEdgeVisible = this.sheet.edgeVisible;
    const oldEdgeColor = this.sheet.edgeColor;
    this.sheet = sheet;
    const markupOpacityChanged = oldMarkupOpacity !== sheet.markupOpacity;
    const edgeChanged = oldEdgeVisible !== sheet.edgeVisible || oldEdgeColor !== sheet.edgeColor;
    this.applyTransform();
    if (scaleChanged || cropChanged) {
      this.clearLoadedTiles();
      this.tiles = this.buildTileIndex();
      this.notifyBoundsChanged();
    } else if (thresholdChanged) {
      this.clearLoadedTiles();
      this.requestRender();
    }
    // If ONLY markupOpacity changed, update overlay material opacities without rebuild
    if (markupOpacityChanged && !scaleChanged && !northArrowChanged && !scaleBarChanged && !knownDistanceChanged && !cropChanged && !edgeChanged) {
      this.applyOverlayOpacity(sheet.markupOpacity);
    } else if (scaleChanged || northArrowChanged || cropChanged) {
      // Visibility-only: just toggle group.visible, no geometry rebuild
      const naVisOnly = !scaleChanged
        && this.northArrowGroup !== null
        && oldNorthArrow !== null && sheet.northArrow !== null
        && oldNorthArrow.visible !== sheet.northArrow.visible
        && JSON.stringify({ ...oldNorthArrow, visible: sheet.northArrow.visible }) === JSON.stringify(sheet.northArrow);
      if (naVisOnly && this.northArrowGroup) {
        this.northArrowGroup.visible = sheet.northArrow!.visible;
        this.requestRender();
      } else {
        this.buildNorthArrowOverlay();
      }
    }
    if (scaleChanged || scaleBarChanged || cropChanged) {
      const sbVisOnly = !scaleChanged
        && this.scaleBarGroup !== null
        && oldScaleBar !== null && sheet.scaleBar !== null
        && oldScaleBar.visible !== sheet.scaleBar.visible
        && JSON.stringify({ ...oldScaleBar, visible: sheet.scaleBar.visible }) === JSON.stringify(sheet.scaleBar);
      if (sbVisOnly && this.scaleBarGroup) {
        this.scaleBarGroup.visible = sheet.scaleBar!.visible;
        this.requestRender();
      } else {
        this.buildScaleBarOverlay();
      }
    }
    if (scaleChanged || knownDistanceChanged || cropChanged) {
      const kdVisOnly = !scaleChanged
        && this.knownDistanceGroup !== null
        && oldKnownDistance !== null && sheet.knownDistance !== null
        && oldKnownDistance.visible !== sheet.knownDistance.visible
        && JSON.stringify({ ...oldKnownDistance, visible: sheet.knownDistance.visible }) === JSON.stringify(sheet.knownDistance);
      if (kdVisOnly && this.knownDistanceGroup) {
        this.knownDistanceGroup.visible = sheet.knownDistance!.visible;
        this.requestRender();
      } else {
        this.buildKnownDistanceOverlay();
      }
    }
    if (scaleChanged || edgeChanged || cropChanged) {
      const edgeVisOnly = !scaleChanged && !cropChanged
        && this.edgeGroup !== null
        && oldEdgeVisible !== sheet.edgeVisible
        && oldEdgeColor === sheet.edgeColor;
      if (edgeVisOnly && this.edgeGroup) {
        this.edgeGroup.visible = sheet.edgeVisible;
        this.requestRender();
      } else {
        this.buildEdgeOverlay();
      }
    }
    this.setDisplay(sheet.visible, sheet.opacityPct);
  }

  setRenderOrder(order: number): void {
    this.sheetRenderOrder = 30 + order;
    this.group.renderOrder = this.sheetRenderOrder;
    if (this.outlineMesh) this.outlineMesh.renderOrder = this.sheetRenderOrder + 1;
    if (this.loadingBarMesh) this.loadingBarMesh.renderOrder = this.sheetRenderOrder + 2;
    for (const tile of this.tiles) {
      if (tile.mesh) tile.mesh.renderOrder = this.sheetRenderOrder;
    }
    this.requestRender();
  }

  updateVisible(camera: THREE.Camera, exaggeration = 1): boolean {
    this.group.visible = this.visibleAll;
    if (!this.group.visible || !this.workerReady) {
      let changed = false;
      for (const tile of this.tiles) {
        if (tile.mesh) {
          this.disposeTile(tile);
          changed = true;
        }
      }
      if (changed) this.notifyBoundsChanged();
      return changed;
    }

    this.drapeExaggeration = exaggeration;

    const projScreen = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(projScreen);
    this.group.updateMatrixWorld(true);
    let activeDecodes = this.tiles.reduce((count, tile) => count + (tile.loading ? 1 : 0), 0);
    for (const tile of this.tiles) {
      const worldBox = tile.localBounds.clone().applyMatrix4(this.group.matrixWorld);
      const shouldShow = frustum.intersectsBox(worldBox);
      // Only decode tiles newly entering the frustum; loaded tiles are never evicted on pan.
      if (shouldShow && !tile.loaded && !tile.loading && activeDecodes < MAX_CONCURRENT_TILE_DECODES) {
        void this.decodeTile(tile);
        activeDecodes++;
      }
    }

    if (this.outlineMesh !== null || this.loadingBarMesh !== null) {
      // Clear once every tile that intersects the frustum is loaded.
      // Out-of-frustum tiles are never decoded, so we exclude them from the check.
      const frustumTiles = this.tiles.filter((t) => {
        const worldBox = t.localBounds.clone().applyMatrix4(this.group.matrixWorld);
        return frustum.intersectsBox(worldBox);
      });
      const allVisibleLoaded = frustumTiles.length > 0 && frustumTiles.every((t) => t.loaded);
      if (allVisibleLoaded) {
        this.disposeLoadingOverlay();
      } else {
        this.updateLoadingBar(performance.now());
        this.requestRender();
      }
    }

    return false;
  }

  previewOrientation(
    orientationDeg: number,
    pivotScenePx?: { x: number; y: number },
    baselineOrientDeg?: number,
    baseCenterScenePx?: { x: number; y: number },
  ): void {
    const rad = THREE.MathUtils.degToRad(orientationDeg);
    if (pivotScenePx !== undefined && baselineOrientDeg !== undefined) {
      const ppf = this.pixelsPerFoot();
      const pivotWx = pivotScenePx.x / ppf;
      const pivotWy = pivotScenePx.y / ppf;
      const baseWx = baseCenterScenePx !== undefined ? baseCenterScenePx.x / ppf : this.sheet.relativeLayoutPx.x / ppf;
      const baseWy = baseCenterScenePx !== undefined ? baseCenterScenePx.y / ppf : this.sheet.relativeLayoutPx.y / ppf;
      const deltaRad = THREE.MathUtils.degToRad(baselineOrientDeg) - rad;
      const dx = pivotWx - baseWx;
      const dy = pivotWy - baseWy;
      const cosD = Math.cos(deltaRad);
      const sinD = Math.sin(deltaRad);
      this.group.position.x = pivotWx - (cosD * dx - sinD * dy);
      this.group.position.y = pivotWy - (sinD * dx + cosD * dy);
    }
    this.group.rotation.z = -rad;
  }

  pixelsPerFoot(): number {
    return pixelsPerFootForSheet(this.sheet);
  }

  private sheetWorldSize(): { width: number; height: number } {
    const ppf = this.pixelsPerFoot();
    return {
      width: this.sheet.widthPx150 / ppf,
      height: this.sheet.heightPx150 / ppf,
    };
  }

  private applyTransform(): void {
    const placement = this.sheet.placement;
    if (placement) {
      const ppf = this.pixelsPerFoot();
      const rad = THREE.MathUtils.degToRad(placement.anchorRotationDeg);
      const cz = Math.cos(rad);
      const sz = Math.sin(rad);
      const rx = this.sheet.relativeLayoutPx.x / ppf;
      const ry = this.sheet.relativeLayoutPx.y / ppf;
      const at = placement.anchorTranslation;
      this.group.position.set(
        at.x + rx * cz - ry * sz - this.origin[0],
        at.y + rx * sz + ry * cz - this.origin[1],
        at.z - this.origin[2],
      );
      const sheetRotRad = THREE.MathUtils.degToRad(this.sheet.orientation ?? 0);
      this.group.rotation.set(0, 0, rad + sheetRotRad);
      this.group.scale.setScalar(1);
      this.group.visible = this.visibleAll;
      return;
    }
    const rotation = THREE.MathUtils.degToRad(this.sheet.orientation ?? 0);
    const ppf = this.pixelsPerFoot();
    this.group.position.set(
      this.sheet.relativeLayoutPx.x / ppf,
      this.sheet.relativeLayoutPx.y / ppf,
      0,
    );
    this.group.rotation.set(0, 0, rotation);
    this.group.scale.setScalar(1);
    this.group.visible = this.visibleAll;
  }

  /** Update the scene origin and re-apply the transform.
   *  Used when a positioned dataset first anchors sceneOrigin after PDFs
   *  were already loaded — re-centers the PDF on the data. */
  setOrigin(origin: Vec3): void {
    this.origin = origin;
    this.applyTransform();
  }

  private buildLoadingOverlay(): void {
    const size = this.sheetWorldSize();
    const hw = size.width / 2;
    const hh = size.height / 2;

    // Dashed outline
    const outlinePositions = new Float32Array([
      -hw, -hh, 0,
       hw, -hh, 0,
       hw,  hh, 0,
      -hw,  hh, 0,
    ]);
    const outlineGeo = new THREE.BufferGeometry();
    outlineGeo.setAttribute('position', new THREE.BufferAttribute(outlinePositions, 3));
    const outlineMat = new THREE.LineDashedMaterial({
      color: 0x2a2f35,
      dashSize: 1,
      gapSize: 0.5,
      depthWrite: false,
    });
    const outline = new THREE.LineLoop(outlineGeo, outlineMat);
    outline.computeLineDistances();
    outline.name = `pdf-outline:${this.handle}`;
    outline.renderOrder = this.sheetRenderOrder + 1;
    this.group.add(outline);
    this.outlineMesh = outline;

    // Loading bar
    const barWidth = size.width * 0.6;
    const barHeight = size.height * 0.04;
    const texWidth = 256;
    const texHeight = 16;
    const texData = new Uint8Array(texWidth * texHeight * 4);
    // Fill with dark track color (0x1a1d21, alpha 200)
    for (let i = 0; i < texWidth * texHeight; i++) {
      texData[i * 4 + 0] = 0x1a;
      texData[i * 4 + 1] = 0x1d;
      texData[i * 4 + 2] = 0x21;
      texData[i * 4 + 3] = 200;
    }
    const texture = new THREE.DataTexture(texData, texWidth, texHeight, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.needsUpdate = true;
    const barGeo = new THREE.PlaneGeometry(barWidth, barHeight);
    barGeo.translate(0, 0, 0.02);
    const barMat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const barMesh = new THREE.Mesh(barGeo, barMat);
    barMesh.name = `pdf-loadingbar:${this.handle}`;
    barMesh.renderOrder = this.sheetRenderOrder + 2;
    this.group.add(barMesh);
    this.loadingBarMesh = barMesh;
    this.loadingBarTexture = texture;
  }

  private updateLoadingBar(timestamp: number): void {
    const texture = this.loadingBarTexture;
    if (!texture) return;
    const data = texture.image.data as Uint8Array;
    const texWidth = 256;
    const texHeight = 16;
    // Reset to track color
    for (let i = 0; i < texWidth * texHeight; i++) {
      data[i * 4 + 0] = 0x1a;
      data[i * 4 + 1] = 0x1d;
      data[i * 4 + 2] = 0x21;
      data[i * 4 + 3] = 200;
    }
    // Indeterminate sliding highlight: period 1400ms, highlight width = 40% of texture
    const period = 1400;
    const t = (timestamp % period) / period; // 0..1
    const highlightW = Math.floor(texWidth * 0.4);
    // Center of highlight travels from -highlightW to texWidth+highlightW
    const travelRange = texWidth + highlightW;
    const centerX = Math.floor(t * travelRange) - Math.floor(highlightW / 2);
    const x0 = Math.max(0, centerX - Math.floor(highlightW / 2));
    const x1 = Math.min(texWidth, centerX + Math.floor(highlightW / 2));
    for (let row = 0; row < texHeight; row++) {
      for (let col = x0; col < x1; col++) {
        const idx = (row * texWidth + col) * 4;
        data[idx + 0] = 0x4a;
        data[idx + 1] = 0x9e;
        data[idx + 2] = 0xd8;
        data[idx + 3] = 220;
      }
    }
    texture.needsUpdate = true;
  }

  private buildNorthArrowOverlay(): void {
    this.disposeNorthArrowOverlay();
    const na = this.sheet.northArrow;
    if (!na) return;

    const ppf = this.pixelsPerFoot();
    const sheetW = this.sheet.widthPx150;
    const sheetH = this.sheet.heightPx150;

    // Crop clip polygon in sheet-px space (top-left origin, Y-down)
    const cropPoly = this.sheet.borderCrop
      ? cropClipPolygon(this.sheet.borderCrop, sheetW, sheetH)
      : null;

    // Sheet-px helper: convert world-unit 3D local coords back to sheet-px.
    // Local space: cx = (spx - sheetW/2)/ppf, cy = -((spy - sheetH/2)/ppf)
    // => spx = cx*ppf + sheetW/2, spy = -cy*ppf + sheetH/2
    // World local from sheet-px
    const toWorld2 = (spx: number, spy: number): [number, number] => [
      (spx - sheetW / 2) / ppf,
      -((spy - sheetH / 2) / ppf),
    ];

    // All geometry is first computed in world-unit local coords (same as before),
    // then clipped in sheet-px space, then converted back.

    const cx = (na.x - sheetW / 2) / ppf;
    const cy = -((na.y - sheetH / 2) / ppf);
    const r = 75 / ppf; // NORTH_ARROW_RADIUS = 75px

    const color = new THREE.Color(na.color);

    const group = new THREE.Group();
    group.name = `pdf-north-arrow:${this.handle}`;
    group.renderOrder = 100;
    group.visible = na.visible;

    const lineMat = new THREE.LineBasicMaterial({
      color,
      depthWrite: false,
      depthTest: false,
      transparent: true,
      opacity: this.sheet.markupOpacity,
      toneMapped: false,
    });

    // Circle (32 segments) — clip each chord against cropPoly
    const SEG = 32;
    if (cropPoly) {
      // Build sheet-px arc points, clip each segment, emit surviving Line objects
      const arcPx: [number, number][] = [];
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        // Sheet-px: center + offset. Y-axis: sin positive is downward in sheet-px.
        arcPx.push([na.x + Math.cos(a) * 75, na.y - Math.sin(a) * 75]);
      }
      const segs = clipPolyline(arcPx, cropPoly);
      for (const [s0, s1] of segs) {
        const [wx0, wy0] = toWorld2(s0[0], s0[1]);
        const [wx1, wy1] = toWorld2(s1[0], s1[1]);
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(wx0, wy0, 0),
          new THREE.Vector3(wx1, wy1, 0),
        ]);
        const line = new THREE.Line(geo, lineMat);
        line.renderOrder = 100;
        group.add(line);
      }
    } else {
      const circlePoints: THREE.Vector3[] = [];
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        circlePoints.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0));
      }
      const circleGeo = new THREE.BufferGeometry().setFromPoints(circlePoints);
      const circle = new THREE.Line(circleGeo, lineMat);
      circle.renderOrder = 100;
      group.add(circle);
    }

    // Arrow shaft: center to tip — in 3D local space
    const rad = (-na.angleDeg + 90) * Math.PI / 180;
    const tipX = cx + Math.cos(rad) * r;
    const tipY = cy + Math.sin(rad) * r;

    if (cropPoly) {
      // Convert shaft endpoints to sheet-px for clipping
      const shaftP0: [number, number] = [na.x, na.y];
      // tip in sheet-px: na.x + cos, na.y - sin (Y-down)
      const shaftP1: [number, number] = [na.x + Math.cos(rad) * 75, na.y - Math.sin(rad) * 75];
      const seg = clipSegment(shaftP0, shaftP1, cropPoly);
      if (seg) {
        const [wx0, wy0] = toWorld2(seg[0][0], seg[0][1]);
        const [wx1, wy1] = toWorld2(seg[1][0], seg[1][1]);
        const shaftGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(wx0, wy0, 0),
          new THREE.Vector3(wx1, wy1, 0),
        ]);
        const shaft = new THREE.Line(shaftGeo, lineMat);
        shaft.renderOrder = 100;
        group.add(shaft);
      }
    } else {
      const shaftGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(cx, cy, 0),
        new THREE.Vector3(tipX, tipY, 0),
      ]);
      const shaft = new THREE.Line(shaftGeo, lineMat);
      shaft.renderOrder = 100;
      group.add(shaft);
    }

    // Arrowhead triangle — clip against crop
    const headLen = 8 / ppf;
    const headW = 4 / ppf;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    const perpX = -uy;
    const perpY = ux;
    const headMat = new THREE.MeshBasicMaterial({ color, depthWrite: false, depthTest: false, transparent: true, opacity: this.sheet.markupOpacity, toneMapped: false, side: THREE.DoubleSide });

    if (cropPoly) {
      // Sheet-px tip and base points (headLen/headW are in world units; convert back)
      const tipPx: [number, number] = [na.x + Math.cos(rad) * 75, na.y - Math.sin(rad) * 75];
      const headLenPx = headLen * ppf;
      const headWPx = headW * ppf;
      // In sheet-px: ux/uy are world-unit vectors; Y is inverted -> py is -ux in world = ux in sheet-px
      const triPx: [number, number][] = [
        tipPx,
        [tipPx[0] - ux * headLenPx - perpX * headWPx, tipPx[1] + uy * headLenPx + perpY * headWPx],
        [tipPx[0] - ux * headLenPx + perpX * headWPx, tipPx[1] + uy * headLenPx - perpY * headWPx],
      ];
      const clipped = sutherlandHodgman(triPx, cropPoly);
      if (clipped.length >= 3) {
        const worldPts = clipped.map(([spx, spy]) => {
          const [wx, wy] = toWorld2(spx, spy);
          return new THREE.Vector3(wx, wy, 0);
        });
        // Triangulate as fan from first vertex
        const verts: number[] = [];
        for (let i = 1; i + 1 < worldPts.length; i++) {
          verts.push(worldPts[0]!.x, worldPts[0]!.y, 0);
          verts.push(worldPts[i]!.x, worldPts[i]!.y, 0);
          verts.push(worldPts[i + 1]!.x, worldPts[i + 1]!.y, 0);
        }
        const headGeo = new THREE.BufferGeometry();
        headGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
        const head = new THREE.Mesh(headGeo, headMat);
        head.renderOrder = 100;
        group.add(head);
      }
    } else {
      const headGeo = new THREE.BufferGeometry();
      const headVerts = new Float32Array([
        tipX, tipY, 0,
        tipX - ux * headLen - perpX * headW, tipY - uy * headLen - perpY * headW, 0,
        tipX - ux * headLen + perpX * headW, tipY - uy * headLen + perpY * headW, 0,
      ]);
      headGeo.setAttribute('position', new THREE.BufferAttribute(headVerts, 3));
      const head = new THREE.Mesh(headGeo, headMat);
      head.renderOrder = 100;
      group.add(head);
    }

    // N label — show only if center is inside crop
    const centerInCrop = !cropPoly || pointInPolygon2D([na.x, na.y], cropPoly);
    if (centerInCrop) {
      const labelSize = 20 / ppf;
      const texSize = 64;
      const labelCanvas = document.createElement('canvas');
      labelCanvas.width = texSize;
      labelCanvas.height = texSize;
      const lctx = labelCanvas.getContext('2d');
      if (lctx) {
        lctx.fillStyle = 'rgba(17,20,23,0.75)';
        lctx.fillRect(0, 0, texSize, texSize);
        lctx.fillStyle = na.color;
        lctx.font = `bold ${Math.floor(texSize * 0.65)}px sans-serif`;
        lctx.textAlign = 'center';
        lctx.textBaseline = 'middle';
        lctx.fillText('N', texSize / 2, texSize / 2);
      }
      const labelTex = new THREE.CanvasTexture(labelCanvas);
      const labelGeo = new THREE.PlaneGeometry(labelSize, labelSize);
      labelGeo.translate(cx, cy, 0);
      const labelMat = new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, opacity: this.sheet.markupOpacity, alphaTest: 0.1, depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide });
      const label = new THREE.Mesh(labelGeo, labelMat);
      label.renderOrder = 101;
      group.add(label);
    }

    this.group.add(group);
    this.northArrowGroup = group;
    this.requestRender();
  }

  private disposeNorthArrowOverlay(): void {
    if (!this.northArrowGroup) return;
    this.northArrowGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => {
            if ((m as THREE.MeshBasicMaterial).map) (m as THREE.MeshBasicMaterial).map!.dispose();
            m.dispose();
          });
        } else {
          const mat = obj.material as THREE.MeshBasicMaterial | THREE.LineBasicMaterial;
          if ('map' in mat && mat.map) mat.map.dispose();
          mat.dispose();
        }
      }
    });
    this.northArrowGroup.removeFromParent();
    this.northArrowGroup = null;
  }

  private buildScaleBarOverlay(): void {
    this.disposeScaleBarOverlay();
    const sb = this.sheet.scaleBar;
    if (!sb || !sb.visible || sb.realWorldFt === null) return;
    const ppf = this.pixelsPerFoot();
    const sheetW = this.sheet.widthPx150;
    const sheetH = this.sheet.heightPx150;

    const cropPoly = this.sheet.borderCrop
      ? cropClipPolygon(this.sheet.borderCrop, sheetW, sheetH)
      : null;

    const toWorld2 = (spx: number, spy: number): [number, number] => [
      (spx - sheetW / 2) / ppf,
      -((spy - sheetH / 2) / ppf),
    ];

    const cx = (sb.x - sheetW / 2) / ppf;
    const cy = -((sb.y - sheetH / 2) / ppf);
    const halfW = (150 / 2) / ppf; // SCALE_BAR_LEN_PX / 2
    const headLen = 8 / ppf;
    const headW = 4 / ppf;
    const color = new THREE.Color(sb.color);
    const lineMat = new THREE.LineBasicMaterial({ color, depthWrite: false, depthTest: false, transparent: true, opacity: this.sheet.markupOpacity, toneMapped: false });
    const meshMat = new THREE.MeshBasicMaterial({ color, depthWrite: false, depthTest: false, transparent: true, opacity: this.sheet.markupOpacity, toneMapped: false, side: THREE.DoubleSide });
    const group = new THREE.Group();
    group.name = `pdf-scale-bar:${this.handle}`;
    group.renderOrder = 100;

    // Sheet-px coords for the bar endpoints (Y same — horizontal line)
    const halfWPx = 75; // 150/2
    const sbP0Px: [number, number] = [sb.x - halfWPx, sb.y];
    const sbP1Px: [number, number] = [sb.x + halfWPx, sb.y];
    const headLenPx = headLen * ppf;
    const headWPx = headW * ppf;

    // main line
    if (cropPoly) {
      const seg = clipSegment(sbP0Px, sbP1Px, cropPoly);
      if (seg) {
        const [wx0, wy0] = toWorld2(seg[0][0], seg[0][1]);
        const [wx1, wy1] = toWorld2(seg[1][0], seg[1][1]);
        const lineGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(wx0, wy0, 0),
          new THREE.Vector3(wx1, wy1, 0),
        ]);
        const line = new THREE.Line(lineGeo, lineMat);
        line.renderOrder = 100;
        group.add(line);
      }
    } else {
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(cx - halfW, cy, 0),
        new THREE.Vector3(cx + halfW, cy, 0),
      ]);
      const line = new THREE.Line(lineGeo, lineMat);
      line.renderOrder = 100;
      group.add(line);
    }

    // left arrowhead — triangle pointing left at sbP0Px
    const lhTriPx: [number, number][] = [
      sbP0Px,
      [sbP0Px[0] + headLenPx, sbP0Px[1] - headWPx],
      [sbP0Px[0] + headLenPx, sbP0Px[1] + headWPx],
    ];
    const lhClipped = cropPoly ? sutherlandHodgman(lhTriPx, cropPoly) : lhTriPx;
    if (lhClipped.length >= 3) {
      const worldPts = lhClipped.map(([spx, spy]) => { const [wx, wy] = toWorld2(spx, spy); return new THREE.Vector3(wx, wy, 0); });
      const verts: number[] = [];
      for (let i = 1; i + 1 < worldPts.length; i++) {
        verts.push(worldPts[0]!.x, worldPts[0]!.y, 0, worldPts[i]!.x, worldPts[i]!.y, 0, worldPts[i + 1]!.x, worldPts[i + 1]!.y, 0);
      }
      const lhGeo = new THREE.BufferGeometry();
      lhGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      const lh = new THREE.Mesh(lhGeo, meshMat);
      lh.renderOrder = 100;
      group.add(lh);
    }

    // right arrowhead — triangle pointing right at sbP1Px
    const rhTriPx: [number, number][] = [
      sbP1Px,
      [sbP1Px[0] - headLenPx, sbP1Px[1] - headWPx],
      [sbP1Px[0] - headLenPx, sbP1Px[1] + headWPx],
    ];
    const rhClipped = cropPoly ? sutherlandHodgman(rhTriPx, cropPoly) : rhTriPx;
    if (rhClipped.length >= 3) {
      const worldPts = rhClipped.map(([spx, spy]) => { const [wx, wy] = toWorld2(spx, spy); return new THREE.Vector3(wx, wy, 0); });
      const verts: number[] = [];
      for (let i = 1; i + 1 < worldPts.length; i++) {
        verts.push(worldPts[0]!.x, worldPts[0]!.y, 0, worldPts[i]!.x, worldPts[i]!.y, 0, worldPts[i + 1]!.x, worldPts[i + 1]!.y, 0);
      }
      const rhGeo = new THREE.BufferGeometry();
      rhGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      const rh = new THREE.Mesh(rhGeo, meshMat.clone());
      rh.renderOrder = 100;
      group.add(rh);
    }

    // label — show only if bar center is inside crop
    const centerInCrop = !cropPoly || pointInPolygon2D([sb.x, sb.y], cropPoly);
    if (centerInCrop) {
      const texSize = 128;
      const labelCanvas = document.createElement('canvas');
      labelCanvas.width = texSize * 2; labelCanvas.height = texSize;
      const lctx = labelCanvas.getContext('2d');
      if (lctx) {
        lctx.fillStyle = 'rgba(17,20,23,0.75)';
        lctx.fillRect(0, 0, labelCanvas.width, labelCanvas.height);
        lctx.fillStyle = sb.color;
        lctx.font = `bold ${Math.floor(texSize * 0.5)}px sans-serif`;
        lctx.textAlign = 'center';
        lctx.textBaseline = 'middle';
        lctx.fillText(`1"=${sb.realWorldFt}ft`, labelCanvas.width / 2, labelCanvas.height / 2);
      }
      const labelTex = new THREE.CanvasTexture(labelCanvas);
      const labelW = (halfW * 2) * 1.1;
      const labelH = labelW * 0.25;
      const labelGeo = new THREE.PlaneGeometry(labelW, labelH);
      labelGeo.translate(cx, cy - halfW * 0.4, 0);
      const labelMat = new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, opacity: this.sheet.markupOpacity, alphaTest: 0.1, depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide });
      const labelMesh = new THREE.Mesh(labelGeo, labelMat);
      labelMesh.renderOrder = 101;
      group.add(labelMesh);
    }

    this.group.add(group);
    this.scaleBarGroup = group;
    this.requestRender();
  }

  private disposeScaleBarOverlay(): void {
    if (!this.scaleBarGroup) return;
    this.scaleBarGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry.dispose();
        const mat = obj.material as THREE.MeshBasicMaterial | THREE.LineBasicMaterial;
        if ('map' in mat && mat.map) mat.map.dispose();
        mat.dispose();
      }
    });
    this.scaleBarGroup.removeFromParent();
    this.scaleBarGroup = null;
  }

  private buildKnownDistanceOverlay(): void {
    this.disposeKnownDistanceOverlay();
    const kd = this.sheet.knownDistance;
    if (!kd || !kd.visible || kd.realWorldFt === null) return;
    const ppf = this.pixelsPerFoot();
    const sheetW = this.sheet.widthPx150;
    const sheetH = this.sheet.heightPx150;

    const cropPoly = this.sheet.borderCrop
      ? cropClipPolygon(this.sheet.borderCrop, sheetW, sheetH)
      : null;

    const toWorld2 = (spx: number, spy: number): [number, number] => [
      (spx - sheetW / 2) / ppf,
      -((spy - sheetH / 2) / ppf),
    ];
    const toWorldVec = (spx: number, spy: number): THREE.Vector3 => {
      const [wx, wy] = toWorld2(spx, spy);
      return new THREE.Vector3(wx, wy, 0);
    };

    // World-unit endpoints (for non-clipped path and label geometry)
    const bv = toWorldVec(kd.begin.x, kd.begin.y);
    const ev = toWorldVec(kd.end.x, kd.end.y);
    const dir = new THREE.Vector3().subVectors(ev, bv);
    const len = dir.length();
    if (len < 0.001) return;
    const headLen = 8 / ppf;
    const headW = 4 / ppf;
    const headLenPx = headLen * ppf;
    const headWPx = headW * ppf;

    // Sheet-px direction unit vector (Y-down: uy_px = -uy_world)
    const dxPx = kd.end.x - kd.begin.x;
    const dyPx = kd.end.y - kd.begin.y;
    const lenPx = Math.hypot(dxPx, dyPx);
    const uxPx = dxPx / (lenPx || 1);
    const uyPx = dyPx / (lenPx || 1);

    const color = new THREE.Color(kd.color);
    const lineMat = new THREE.LineBasicMaterial({ color, depthWrite: false, depthTest: false, transparent: true, toneMapped: false });
    const meshMat = new THREE.MeshBasicMaterial({ color, depthWrite: false, depthTest: false, transparent: true, toneMapped: false, side: THREE.DoubleSide });
    const group = new THREE.Group();
    group.name = `pdf-known-distance:${this.handle}`;
    group.renderOrder = 100;

    // main line
    const lineP0Px: [number, number] = [kd.begin.x, kd.begin.y];
    const lineP1Px: [number, number] = [kd.end.x, kd.end.y];
    if (cropPoly) {
      const seg = clipSegment(lineP0Px, lineP1Px, cropPoly);
      if (seg) {
        const lineGeo = new THREE.BufferGeometry().setFromPoints([
          toWorldVec(seg[0][0], seg[0][1]),
          toWorldVec(seg[1][0], seg[1][1]),
        ]);
        const line = new THREE.Line(lineGeo, lineMat);
        line.renderOrder = 100;
        group.add(line);
      }
    } else {
      const lineGeo = new THREE.BufferGeometry().setFromPoints([bv, ev]);
      const line = new THREE.Line(lineGeo, lineMat);
      line.renderOrder = 100;
      group.add(line);
    }

    // begin arrowhead — in sheet-px space
    const bhTriPx: [number, number][] = [
      [kd.begin.x, kd.begin.y],
      [kd.begin.x + uxPx * headLenPx - uyPx * headWPx, kd.begin.y + uyPx * headLenPx + uxPx * headWPx],
      [kd.begin.x + uxPx * headLenPx + uyPx * headWPx, kd.begin.y + uyPx * headLenPx - uxPx * headWPx],
    ];
    const bhClipped = cropPoly ? sutherlandHodgman(bhTriPx, cropPoly) : bhTriPx;
    if (bhClipped.length >= 3) {
      const worldPts = bhClipped.map(([spx, spy]) => toWorldVec(spx, spy));
      const verts: number[] = [];
      for (let i = 1; i + 1 < worldPts.length; i++) {
        verts.push(worldPts[0]!.x, worldPts[0]!.y, 0, worldPts[i]!.x, worldPts[i]!.y, 0, worldPts[i + 1]!.x, worldPts[i + 1]!.y, 0);
      }
      const bhGeo = new THREE.BufferGeometry();
      bhGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      const bh = new THREE.Mesh(bhGeo, meshMat);
      bh.renderOrder = 100;
      group.add(bh);
    }

    // end arrowhead — in sheet-px space
    const ehTriPx: [number, number][] = [
      [kd.end.x, kd.end.y],
      [kd.end.x - uxPx * headLenPx - uyPx * headWPx, kd.end.y - uyPx * headLenPx + uxPx * headWPx],
      [kd.end.x - uxPx * headLenPx + uyPx * headWPx, kd.end.y - uyPx * headLenPx - uxPx * headWPx],
    ];
    const ehClipped = cropPoly ? sutherlandHodgman(ehTriPx, cropPoly) : ehTriPx;
    if (ehClipped.length >= 3) {
      const worldPts = ehClipped.map(([spx, spy]) => toWorldVec(spx, spy));
      const verts: number[] = [];
      for (let i = 1; i + 1 < worldPts.length; i++) {
        verts.push(worldPts[0]!.x, worldPts[0]!.y, 0, worldPts[i]!.x, worldPts[i]!.y, 0, worldPts[i + 1]!.x, worldPts[i + 1]!.y, 0);
      }
      const ehGeo = new THREE.BufferGeometry();
      ehGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      const eh = new THREE.Mesh(ehGeo, meshMat.clone());
      eh.renderOrder = 100;
      group.add(eh);
    }

    // label at midpoint — show only if midpoint is inside crop
    const midPx: [number, number] = [(kd.begin.x + kd.end.x) / 2, (kd.begin.y + kd.end.y) / 2];
    const midInCrop = !cropPoly || pointInPolygon2D(midPx, cropPoly);
    if (midInCrop) {
      const mx = (bv.x + ev.x) / 2;
      const my = (bv.y + ev.y) / 2;
      const measuredIn = (len * ppf) / 150;
      const texSize = 128;
      const labelCanvas = document.createElement('canvas');
      labelCanvas.width = texSize * 2; labelCanvas.height = texSize;
      const lctx = labelCanvas.getContext('2d');
      if (lctx) {
        lctx.fillStyle = 'rgba(17,20,23,0.75)';
        lctx.fillRect(0, 0, labelCanvas.width, labelCanvas.height);
        lctx.fillStyle = kd.color;
        lctx.font = `bold ${Math.floor(texSize * 0.45)}px sans-serif`;
        lctx.textAlign = 'center';
        lctx.textBaseline = 'middle';
        lctx.fillText(`${measuredIn.toFixed(2)}"=${kd.realWorldFt}ft`, labelCanvas.width / 2, labelCanvas.height / 2);
      }
      const labelTex = new THREE.CanvasTexture(labelCanvas);
      const labelW = len * 1.1;
      const labelH = labelW * 0.2;
      const labelGeo = new THREE.PlaneGeometry(labelW, labelH);
      labelGeo.translate(mx, my + labelH, 0);
      const labelMat = new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, alphaTest: 0.1, depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide });
      const labelMesh = new THREE.Mesh(labelGeo, labelMat);
      labelMesh.renderOrder = 101;
      group.add(labelMesh);
    }

    this.group.add(group);
    this.knownDistanceGroup = group;
    this.requestRender();
  }

  private disposeKnownDistanceOverlay(): void {
    if (!this.knownDistanceGroup) return;
    this.knownDistanceGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry.dispose();
        const mat = obj.material as THREE.MeshBasicMaterial | THREE.LineBasicMaterial;
        if ('map' in mat && mat.map) mat.map.dispose();
        mat.dispose();
      }
    });
    this.knownDistanceGroup.removeFromParent();
    this.knownDistanceGroup = null;
  }

  private buildEdgeOverlay(): void {
    this.disposeEdgeOverlay();
    const ppf = this.pixelsPerFoot();
    const sheetW = this.sheet.widthPx150;
    const sheetH = this.sheet.heightPx150;

    const toWorld2 = (spx: number, spy: number): [number, number] => [
      (spx - sheetW / 2) / ppf,
      -((spy - sheetH / 2) / ppf),
    ];

    const points: [number, number][] = this.sheet.borderCrop
      ? cropClipPolygon(this.sheet.borderCrop, sheetW, sheetH)
      : [[0, 0], [sheetW, 0], [sheetW, sheetH], [0, sheetH]];

    if (points.length < 3) return;

    const worldPts = points.map(([spx, spy]) => {
      const [wx, wy] = toWorld2(spx, spy);
      return new THREE.Vector3(wx, wy, 0);
    });

    const color = new THREE.Color(this.sheet.edgeColor);
    const mat = new THREE.LineBasicMaterial({
      color,
      depthWrite: false,
      depthTest: false,
      transparent: true,
      opacity: this.sheet.markupOpacity,
      toneMapped: false,
    });

    const geo = new THREE.BufferGeometry().setFromPoints(worldPts.concat(worldPts[0]!));
    const line = new THREE.LineLoop(geo, mat);
    line.renderOrder = 100;

    const group = new THREE.Group();
    group.name = `pdf-edge:${this.handle}`;
    group.renderOrder = 100;
    group.visible = this.sheet.edgeVisible;
    group.add(line);

    this.group.add(group);
    this.edgeGroup = group;
    this.requestRender();
  }

  private disposeEdgeOverlay(): void {
    if (!this.edgeGroup) return;
    this.edgeGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry.dispose();
        const mat = obj.material as THREE.MeshBasicMaterial | THREE.LineBasicMaterial;
        if ('map' in mat && mat.map) mat.map.dispose();
        mat.dispose();
      }
    });
    this.edgeGroup.removeFromParent();
    this.edgeGroup = null;
  }

  private applyOverlayOpacity(opacity: number): void {
    const groups = [this.northArrowGroup, this.scaleBarGroup, this.knownDistanceGroup, this.edgeGroup];
    for (const group of groups) {
      if (!group) continue;
      group.traverse((obj) => {
        const mat = (obj as THREE.Mesh | THREE.Line).material;
        if (mat && 'opacity' in mat) {
          mat.opacity = opacity;
          mat.needsUpdate = true;
        }
      });
    }
    this.requestRender();
  }

  private disposeLoadingOverlay(): void {
    if (this.outlineMesh) {
      this.outlineMesh.removeFromParent();
      this.outlineMesh.geometry.dispose();
      (this.outlineMesh.material as THREE.Material).dispose();
      this.outlineMesh = null;
    }
    if (this.loadingBarMesh) {
      this.loadingBarMesh.removeFromParent();
      this.loadingBarMesh.geometry.dispose();
      (this.loadingBarMesh.material as THREE.Material).dispose();
      this.loadingBarMesh = null;
    }
    if (this.loadingBarTexture) {
      this.loadingBarTexture.dispose();
      this.loadingBarTexture = null;
    }
  }

  private openWorker(): void {
    const messageId = ++this.nextMessageId;
    const req: PdfOpenRequest = {
      kind: 'open',
      id: messageId,
      fileName: this.file.name,
      payload: this.file,
    };
    this.pending.set(messageId, (msg) => {
      if (msg.type === 'progress') return;
      this.pending.delete(messageId);
      if (msg.type === 'opened' && msg.ok) {
        this.workerReady = true;
      } else if (msg.type === 'result' && !msg.ok) {
        console.warn(`[PDF] worker open failed for "${this.sheet.label}":`, msg.error);
      }
      this.requestRender();
    });
    this.worker.postMessage(req);
  }

  private buildTileIndex(): PdfTileState[] {
    const tiles: PdfTileState[] = [];
    const ppf = this.pixelsPerFoot();
    const fullWidthFt = this.sheet.widthPx150 / ppf;
    const fullHeightFt = this.sheet.heightPx150 / ppf;
    const crop = borderCropBounds(this.sheet.borderCrop, this.sheet.widthPx150, this.sheet.heightPx150);
    const cropX0 = Math.max(0, Math.min(this.sheet.widthPx150, Math.floor(crop.x)));
    const cropY0 = Math.max(0, Math.min(this.sheet.heightPx150, Math.floor(crop.y)));
    const cropX1 = Math.max(cropX0, Math.min(this.sheet.widthPx150, Math.ceil(crop.x + crop.width)));
    const cropY1 = Math.max(cropY0, Math.min(this.sheet.heightPx150, Math.ceil(crop.y + crop.height)));
    for (let y = cropY0; y < cropY1; y += TILE_SIZE_PX) {
      for (let x = cropX0; x < cropX1; x += TILE_SIZE_PX) {
        const x1 = Math.min(cropX1, x + TILE_SIZE_PX);
        const y1 = Math.min(cropY1, y + TILE_SIZE_PX);
        const minX = x / ppf - fullWidthFt / 2;
        const maxX = x1 / ppf - fullWidthFt / 2;
        const maxY = fullHeightFt / 2 - y / ppf;
        const minY = fullHeightFt / 2 - y1 / ppf;
        const localBounds = new THREE.Box3(
          new THREE.Vector3(minX, minY, -0.01),
          new THREE.Vector3(maxX, maxY, 0.01),
        );
        tiles.push({
          id: `${x}:${y}`,
          window: [x, y, x1, y1],
          needsCropMask: this.sheet.borderCrop?.kind === 'polygon'
            ? tileNeedsCropMask(this.sheet.borderCrop, x, y, x1, y1)
            : false,
          localBounds,
          loaded: false,
          loading: false,
          requestToken: 0,
          mesh: null,
          texture: null,
          bounds: localBounds.clone(),
        });
      }
    }
    return tiles;
  }

  private async decodeTile(tile: PdfTileState): Promise<void> {
    const requestToken = ++tile.requestToken;
    tile.loading = true;
    const messageId = ++this.nextMessageId;
    const req: PdfDecodeTileRequest = {
      kind: 'decodeTile',
      id: messageId,
      pageIndex: this.sheet.pageIndex,
      window: tile.window,
      whiteThreshold: this.sheet.whiteThreshold !== 0 ? this.sheet.whiteThreshold : 240,
    };
    const response = await new Promise<PdfWorkerMessage>((resolve) => {
      this.pending.set(messageId, (msg) => {
        this.pending.delete(messageId);
        resolve(msg);
      });
      this.worker.postMessage(req);
    });
    if (requestToken !== tile.requestToken || this.disposedFlag) return;
    tile.loading = false;
    if (response.type !== 'tile' || !response.ok || !this.group.visible) {
      if (response.type === 'result' && !response.ok) {
        console.warn(`[PDF] tile decode failed for "${this.sheet.label}":`, response.error);
      }
      return;
    }
    this.buildTileMesh(tile, response.tile.width, response.tile.height, response.tile.rgba);
    tile.loaded = true;
    this.notifyBoundsChanged();
    this.requestRender();
  }

  private buildTileMesh(tile: PdfTileState, width: number, height: number, rgba: Uint8ClampedArray): void {
    const pixels = new Uint8Array(rgba.length);
    pixels.set(rgba);
    const polygonCrop = this.sheet.borderCrop?.kind === 'polygon'
      ? this.sheet.borderCrop
      : null;
    const isMasked = tile.needsCropMask && polygonCrop !== null;
    if (polygonCrop && tile.needsCropMask) {
      maskTileRgba(
        pixels,
        width,
        height,
        tile.window,
        polygonCrop.points,
      );
    }
    const size = tile.localBounds.getSize(new THREE.Vector3());
    const center = tile.localBounds.getCenter(new THREE.Vector3());

    const draped = this.target && this.overlap;
    const segments = draped
      ? THREE.MathUtils.clamp(
          Math.ceil(Math.max(size.x, size.y) / DRAPE_SEGMENT_SPACING_FT),
          MIN_DRAPE_SEGMENTS,
          MAX_DRAPE_SEGMENTS,
        )
      : 1;
    const geometry = new THREE.PlaneGeometry(size.x, size.y, segments, segments);
    geometry.translate(center.x, center.y, 0);

    if (draped && this.target?.pickMesh) {
      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      const raycaster = new THREE.Raycaster();
      raycaster.firstHitOnly = true;
      const down = new THREE.Vector3(0, 0, -1);
      const rayOrigin = new THREE.Vector3();
      const surfaceBounds = this.target.bounds;
      const exaggeration = Math.max(this.drapeExaggeration, 1e-6);
      const zTop = (surfaceBounds.max.z + 100) * exaggeration;
      const groupMatrix = this.group.matrix;
      let minZ = Number.POSITIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;

      for (let i = 0; i < position.count; i++) {
        const docLocal = new THREE.Vector3(position.getX(i), position.getY(i), 0);
        const cgPt = docLocal.applyMatrix4(groupMatrix);
        rayOrigin.set(cgPt.x, cgPt.y, zTop);
        raycaster.set(rayOrigin, down);
        raycaster.far = Infinity;
        const hit = raycaster.intersectObject(this.target!.pickMesh!, false)[0];
        const cgZ = hit ? hit.point.z / exaggeration + DRAPE_OFFSET_FT : surfaceBounds.min.z;
        const localZ = cgZ - this.group.position.z;
        position.setZ(i, localZ);
        if (localZ < minZ) minZ = localZ;
        if (localZ > maxZ) maxZ = localZ;
      }
      position.needsUpdate = true;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      tile.bounds = new THREE.Box3(
        new THREE.Vector3(tile.localBounds.min.x, tile.localBounds.min.y, minZ),
        new THREE.Vector3(tile.localBounds.max.x, tile.localBounds.max.y, maxZ),
      );
    } else {
      if (draped && !this.warnedMissingPickMesh) {
        this.warnedMissingPickMesh = true;
        console.warn(`[PDF] "${this.sheet.label}" cannot drape because the target surface has no mesh.`);
      }
      tile.bounds = tile.localBounds.clone();
    }

    const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = true;
    texture.generateMipmaps = !isMasked;
    texture.minFilter = isMasked
      ? THREE.LinearFilter
      : THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: this.opacity,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `pdf-tile:${this.handle}:${tile.id}`;
    mesh.renderOrder = this.sheetRenderOrder;
    this.disposeTileMesh(tile);
    this.group.add(mesh);
    tile.mesh = mesh;
    tile.texture = texture;
  }

  private disposeTile(tile: PdfTileState): void {
    tile.requestToken++;
    tile.loaded = false;
    tile.loading = false;
    this.disposeTileMesh(tile);
  }

  private disposeTileMesh(tile: PdfTileState): void {
    tile.mesh?.removeFromParent();
    tile.mesh?.geometry.dispose();
    (tile.mesh?.material as THREE.Material | undefined)?.dispose();
    tile.texture?.dispose();
    tile.mesh = null;
    tile.texture = null;
  }

  private clearLoadedTiles(): void {
    for (const tile of this.tiles) this.disposeTile(tile);
  }
}

export function pixelsPerFootForSheet(sheet: Pick<PdfRenderableSheet, 'calibration'>): number {
  const calibration: PdfCalibration | null = sheet.calibration;
  return calibration?.unit === 'foot' && calibration.pixelsPerUnit > 0
    ? calibration.pixelsPerUnit
    : DEFAULT_PIXELS_PER_FOOT;
}

function borderCropBounds(crop: BorderCrop | null, widthPx: number, heightPx: number): { x: number; y: number; width: number; height: number } {
  if (!crop) return { x: 0, y: 0, width: widthPx, height: heightPx };
  if (crop.kind === 'rect') return crop;
  if (crop.points.length === 0) return { x: 0, y: 0, width: widthPx, height: heightPx };
  const first = crop.points[0]!;
  let minX = first[0];
  let minY = first[1];
  let maxX = first[0];
  let maxY = first[1];
  for (const [x, y] of crop.points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

function pointInPolygon2D(point: [number, number], polygon: [number, number][]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (pointOnSegment(point, a, b)) return true;
    const intersects = ((a[1] > point[1]) !== (b[1] > point[1]))
      && (point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / ((b[1] - a[1]) || Number.EPSILON) + a[0]);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointOnSegment(point: [number, number], a: [number, number], b: [number, number]): boolean {
  const cross = (point[1] - a[1]) * (b[0] - a[0]) - (point[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(cross) > 1e-9) return false;
  const dot = (point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1]);
  if (dot < 0) return false;
  const lenSq = (b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]);
  return dot <= lenSq;
}

function orientation2D(a: [number, number], b: [number, number], c: [number, number]): number {
  const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(value) <= 1e-9) return 0;
  return value > 0 ? 1 : 2;
}

function segmentsIntersect(
  a0: [number, number],
  a1: [number, number],
  b0: [number, number],
  b1: [number, number],
): boolean {
  const o1 = orientation2D(a0, a1, b0);
  const o2 = orientation2D(a0, a1, b1);
  const o3 = orientation2D(b0, b1, a0);
  const o4 = orientation2D(b0, b1, a1);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && pointOnSegment(b0, a0, a1)) return true;
  if (o2 === 0 && pointOnSegment(b1, a0, a1)) return true;
  if (o3 === 0 && pointOnSegment(a0, b0, b1)) return true;
  if (o4 === 0 && pointOnSegment(a1, b0, b1)) return true;
  return false;
}

function tileNeedsCropMask(
  crop: BorderCrop,
  tileX0: number,
  tileY0: number,
  tileX1: number,
  tileY1: number,
): boolean {
  if (crop.kind === 'rect' || crop.points.length < 3) return false;
  const corners: [number, number][] = [
    [tileX0, tileY0],
    [tileX1, tileY0],
    [tileX1, tileY1],
    [tileX0, tileY1],
  ];
  if (!corners.every((corner) => pointInPolygon2D(corner, crop.points))) return true;

  const tileEdges: [[number, number], [number, number]][] = [
    [corners[0]!, corners[1]!],
    [corners[1]!, corners[2]!],
    [corners[2]!, corners[3]!],
    [corners[3]!, corners[0]!],
  ];
  for (let i = 0; i < crop.points.length; i++) {
    const a = crop.points[i]!;
    const b = crop.points[(i + 1) % crop.points.length]!;
    for (const [edgeA, edgeB] of tileEdges) {
      if (segmentsIntersect(a, b, edgeA, edgeB)) return true;
    }
  }
  return false;
}

function maskTileRgba(
  rgba: Uint8Array,
  tileWidth: number,
  tileHeight: number,
  tileWindow: [number, number, number, number],
  polygon: [number, number][],
): void {
  for (let py = 0; py < tileHeight; py++) {
    for (let px = 0; px < tileWidth; px++) {
      const sheetX = tileWindow[0] + px;
      const sheetY = tileWindow[1] + py;
      if (pointInPolygon2D([sheetX, sheetY], polygon)) continue;
      const i = (py * tileWidth + px) * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = 0;
    }
  }
}

// ── Overlay geometry clipping helpers ────────────────────────────────────────
// All coordinates below are in sheet-pixel space (150 dpi, top-left origin,
// matching the BorderCrop coordinate system).

/** Return the clip polygon for a BorderCrop as a flat [x,y][] list. */
function cropClipPolygon(
  crop: BorderCrop,
  sheetW: number,
  sheetH: number,
): [number, number][] {
  if (crop.kind === 'rect') {
    const { x, y, width, height } = crop;
    return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  }
  // polygon — ensure we have at least 3 points
  return crop.points.length >= 3 ? crop.points : [
    [0, 0], [sheetW, 0], [sheetW, sheetH], [0, sheetH],
  ];
}

/**
 * Sutherland-Hodgman polygon clipping.
 * Clips `subject` (array of [x,y]) against the convex `clip` polygon.
 * Returns the surviving polygon vertices (may be empty).
 */
function sutherlandHodgman(
  subject: [number, number][],
  clip: [number, number][],
): [number, number][] {
  if (subject.length === 0 || clip.length < 3) return subject;

  const intersectEdge = (
    a: [number, number],
    b: [number, number],
    c: [number, number],
    d: [number, number],
  ): [number, number] => {
    const a1 = b[1] - a[1];
    const b1 = a[0] - b[0];
    const c1 = a1 * a[0] + b1 * a[1];
    const a2 = d[1] - c[1];
    const b2 = c[0] - d[0];
    const c2 = a2 * c[0] + b2 * c[1];
    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-12) return a; // parallel — return a as fallback
    return [(b2 * c1 - b1 * c2) / det, (a1 * c2 - a2 * c1) / det];
  };

  const inside = (
    p: [number, number],
    a: [number, number],
    b: [number, number],
  ): boolean => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;

  let output = subject.slice();
  for (let i = 0; i < clip.length; i++) {
    if (output.length === 0) break;
    const edgeA = clip[i]!;
    const edgeB = clip[(i + 1) % clip.length]!;
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const curr = input[j]!;
      const prev = input[(j + input.length - 1) % input.length]!;
      if (inside(curr, edgeA, edgeB)) {
        if (!inside(prev, edgeA, edgeB)) {
          output.push(intersectEdge(prev, curr, edgeA, edgeB));
        }
        output.push(curr);
      } else if (inside(prev, edgeA, edgeB)) {
        output.push(intersectEdge(prev, curr, edgeA, edgeB));
      }
    }
  }
  return output;
}

/**
 * Clip a line segment [p0,p1] against each half-plane of the clip polygon
 * using the parametric Cyrus-Beck / Liang-Barsky approach applied per edge.
 * Returns [clippedP0, clippedP1] or null if entirely outside.
 */
function clipSegment(
  p0: [number, number],
  p1: [number, number],
  clip: [number, number][],
): [[number, number], [number, number]] | null {
  let tMin = 0;
  let tMax = 1;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    // inward normal of edge a->b (for CCW polygon: left-hand side is inside)
    const nx = -(b[1] - a[1]);
    const ny = b[0] - a[0];
    const denom = nx * dx + ny * dy;
    const num = nx * (p0[0] - a[0]) + ny * (p0[1] - a[1]);
    if (Math.abs(denom) < 1e-12) {
      // parallel — outside if num < 0
      if (num < 0) return null;
    } else {
      const t = -num / denom;
      if (denom < 0) {
        if (t > tMin) tMin = t;
      } else {
        if (t < tMax) tMax = t;
      }
    }
  }
  if (tMin > tMax + 1e-9) return null;
  return [
    [p0[0] + tMin * dx, p0[1] + tMin * dy],
    [p0[0] + tMax * dx, p0[1] + tMax * dy],
  ];
}

/**
 * Clip an open polyline (array of [x,y]) against a crop polygon.
 * Returns an array of sub-segments that survive (each a pair of points).
 * Adjacent surviving segments are returned as separate pairs (not rejoined).
 */
function clipPolyline(
  pts: [number, number][],
  clip: [number, number][],
): [[number, number], [number, number]][] {
  const result: [[number, number], [number, number]][] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = clipSegment(pts[i]!, pts[i + 1]!, clip);
    if (seg) result.push(seg);
  }
  return result;
}
