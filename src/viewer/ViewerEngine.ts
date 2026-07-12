// src/viewer/ViewerEngine.ts — imperative Three.js engine. ZERO React imports.
// React mounts it into a div and communicates only via methods / store subscription (ui side).
// DEPENDENCY RULE: viewer → core only.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { DxfDataset, GeotiffDataset, PointCloudDataset, PointCloudNodePayload, SurfaceModel } from '../core/contract';
import { computeBBox, type Vec3 } from './geometry';
import { pickClosestScreenPoint, worldUnitsPerPixel } from './editing';
import { RenderSurface, type OverlayKind, type ResolvedDisplay } from './RenderSurface';
import { RenderDxf, type DxfDrapeResult, type DxfLayerDisplay } from './RenderDxf';
import { RenderGeotiff } from './RenderGeotiff';
import { RenderPdf, type PdfRenderableSheet } from './RenderPdf';
import { RenderPointCloud } from './RenderPointCloud';
import { StreamingPointCloud, type StreamingHierarchy, type TileFetcher } from './StreamingPointCloud';
import { StreamingSurfels, type SurfelHierarchy, type SurfelTileFetcher } from './StreamingSurfels';
import { AuthoringMachine, type AuthoringGeometryMode, type AuthoringSnapshot } from './authoring';
import { DEFAULT_SNAP_TOLERANCE_PX, closestPointOnScreenSegment, resolvePlacement, type SnapCandidate } from './snap';
import { RenderFeatures, type FeatureDisplayEntry } from './RenderFeatures';
import type { FeatureFamily } from '../shared/workbench-types';
import type { FilterState, PointDisplayMode } from './pointCloudLod';
import { buildNorthGizmo, projectGizmoNorth, GIZMO_SIZE, GIZMO_MARGIN } from './gizmo';
import { smoothGroundZ } from './walkSurface';

export type CameraMode = 'orbit' | 'top' | 'hover';
export type CursorCallback = (pos: { e: number; n: number; z: number } | null) => void;
export type FrameStatsCallback = (fps: number) => void;
export type LabelStatusCallback = (note: string | null) => void;
export type ZoomChangeCallback = (normalized: number) => void;
export type EditTool = 'addPoint' | 'editPoint' | 'swapEdge' | 'removeFence' | 'tagBreakline' | 'untagBreakline';
export type EditSelectionCallback = (selection: {
  surfaceHandle: string;
  vertexId: number;
  sourcePointId: number;
  e: number;
  n: number;
  z: number;
  precisionHint: number;
} | null) => void;
export type EditDragCallback = (dragging: boolean) => void;
export type EditCommitCallback = (command: VertexEditCommand) => void;
export type EditMessageCallback = (message: string | null) => void;
export type PointCloudSettleCallback = (info: { handle: string; nodeIds: number[] }) => void;

interface VertexEditCommand {
  type: 'moveVertex' | 'swapEdge';
  surfaceId: string;
  sourcePointId?: number;
  vertexId?: number;
  oldXYZ?: [number, number, number];
  newXYZ?: [number, number, number];
  edgeVertices?: [number, number];
  beforeIndices?: [number, number, number, number, number, number];
  afterIndices?: [number, number, number, number, number, number];
}

const BG_COLOR = 0x14171a;

// Hillshade-style defaults (07 Phase 2): NW sun, mid altitude — terrain pops.
export const DEFAULT_SUN = { azimuth: 315, altitude: 45 };

export class ViewerEngine {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  /** All surface content lives here so vertical exaggeration is ONE Z-scale matrix (04 §3). */
  private contentGroup = new THREE.Group();
  private exaggeration = 1;

  private perspCamera: THREE.PerspectiveCamera;
  private orthoCamera: THREE.OrthographicCamera;
  private activeCamera: THREE.Camera;
  private orbitControls: OrbitControls;
  private topControls: OrbitControls;
  private mode: CameraMode = 'orbit';

  // SceneOrigin (risk R1): Float64 bbox center of the FIRST loaded dataset. All render
  // positions are source − origin in Float32; raw survey magnitudes never reach the GPU.
  private sceneOrigin: Vec3 | null = null;
  /** Radius of current content (rebased units) — drives dynamic near/far + zoom limits. */
  private sceneRadius = 0;

  private surfaces = new Map<string, RenderSurface>();
  private dxfs = new Map<string, RenderDxf>();
  private geotiffs = new Map<string, RenderGeotiff>();
  private pdfs = new Map<string, RenderPdf>();
  /** Footprint fingerprint per PDF handle: serialized fields that affect world size/position.
   *  Used to guard resetView() in updatePdfSheet -- only fires when footprint actually changes. */
  private pdfFootprints = new Map<string, string>();
  private pointClouds = new Map<string, RenderPointCloud>();
  private pointCloudIndexes = new Map<string, StreamingPointCloud>();
  private analyticSurfels = new Map<string, StreamingSurfels>();
  private handleCounter = 0;
  private activeHandle: string | null = null;

  private renderRequested = false;
  private pickRequested = false;
  private frameScheduled = false;
  private disposed = false;
  private resizeObserver: ResizeObserver;

  private sun: THREE.DirectionalLight;

  // north gizmo — separate overlay scene, near-zero render cost (07 Phase 2 ruling)
  private gizmoScene = new THREE.Scene();
  private gizmoGroup: THREE.Group;
  private gizmoCamera = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0.1, 10);
  private northClickCb: (() => void) | null = null;

  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  private pointerPx = new THREE.Vector2();
  private pointerDirty = false;
  private pointerInside = false;
  private pointerButtonsDown = false;
  /** True while OrbitControls is driving the camera — hover picking is skipped (lag triage). */
  private controlsActive = false;
  private downPos: { x: number; y: number } | null = null;
  private cursorCb: CursorCallback | null = null;
  private editSelectionCb: EditSelectionCallback | null = null;
  private editDragCb: EditDragCallback | null = null;
  private editCommitCb: EditCommitCallback | null = null;
  private editMessageCb: EditMessageCallback | null = null;
  private editSurfaceHandle: string | null = null;
  private hoverVertexId: number | null = null;
  private selectedVertexId: number | null = null;
  private dragStartPointerY = 0;
  private dragStartXYZ: [number, number, number] | null = null;
  private draggingVertex = false;
  private selectedEdge: [number, number] | null = null;
  private editTool: EditTool = 'editPoint';

  // Feature authoring (Create Sim): all logic lives in the pure cores
  // (authoring.ts / snap.ts); the engine only feeds pointer/camera state and
  // scene-collected snap candidates into them.
  private authoringMachine = new AuthoringMachine();
  private snapAssetIdByHandle = new Map<string, string>();
  private renderFeatures: RenderFeatures | null = null;

  private statsCb: FrameStatsCallback | null = null;
  private labelStatusCb: LabelStatusCallback | null = null;
  private zoomCb: ZoomChangeCallback | null = null;
  private hoverHeightCb: ((h: number) => void) | null = null;
  private hoverSpeedCb: ((s: number) => void) | null = null;
  private exitHoverCb: (() => void) | null = null;
  private pointCloudSettleCb: PointCloudSettleCallback | null = null;
  private lastFrameTime = 0;
  private lastCameraMotionAt = 0;
  private lastPointCloudSettleKey = '';
  private labelRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lastOrbitDirection = new THREE.Vector3(0.45, -0.65, -0.35).normalize();
  private lastOrbitDistance = 1200;
  private hoverHeight = 5;
  private hoverSpeed = 15;
  private hoverYaw = 0;
  private hoverPitch = THREE.MathUtils.degToRad(-5);
  private hoverKeys = new Set<string>();
  private hoverLookDragging = false;
  private hoverPointCloudIndexHandle: string | null = null;
  private hoverGroundZ: number | null = null;
  private zoomSensitivity3D = 1.0;
  private fogEnabled = false;
  private edlEnabled = true;
  private postScene = new THREE.Scene();
  private postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postQuad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: true,
  });

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    if (!this.renderer.capabilities.isWebGL2) {
      console.warn('[ViewerEngine] WebGL2 unavailable — falling back to WebGL1');
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(BG_COLOR, 1);
    container.appendChild(this.renderer.domElement);
    this.sceneTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.postQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: {
          tColor: { value: this.sceneTarget.texture },
          tDepth: { value: this.sceneTarget.depthTexture },
          resolution: { value: new THREE.Vector2(1, 1) },
          cameraNear: { value: 0.1 },
          cameraFar: { value: 1_000_000 },
          edlStrength: { value: 1.15 },
          edlOrtho: { value: 0 }, //
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D tColor;
          uniform sampler2D tDepth;
          uniform vec2 resolution;
          uniform float cameraNear;
          uniform float cameraFar;
          uniform float edlStrength;
uniform float edlOrtho;
          varying vec2 vUv;

          float linearizeDepth(float depth) {
            if (edlOrtho > 0.5) return mix(cameraNear, cameraFar, depth);
            float z = depth * 2.0 - 1.0;
            return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
          }

          void main() {
            vec4 color = texture2D(tColor, vUv);
            float centerRaw = texture2D(tDepth, vUv).r;
            if (centerRaw >= 1.0) {
              gl_FragColor = color;
              return;
            }
            float center = linearizeDepth(centerRaw);
            vec2 dx = vec2(1.0 / resolution.x, 0.0);
            vec2 dy = vec2(0.0, 1.0 / resolution.y);
            float accum = 0.0;
            float samples = 0.0;
            vec2 offsets[4];
            offsets[0] = dx;
            offsets[1] = -dx;
            offsets[2] = dy;
            offsets[3] = -dy;
            for (int i = 0; i < 4; i++) {
              float raw = texture2D(tDepth, vUv + offsets[i]).r;
              if (raw >= 1.0) continue;
              float neighbor = linearizeDepth(raw);
              accum += max(0.0, neighbor - center);
              samples += 1.0;
            }
            float shade = exp(-((samples > 0.0 ? accum / samples : 0.0) * edlStrength));
            gl_FragColor = vec4(color.rgb * shade, color.a);
          }
        `,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.postScene.add(this.postQuad);

    this.scene.add(this.contentGroup);

    // Z-up world (survey convention): x=Easting, y=Northing, z=Elevation.
    this.perspCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 1_000_000);
    this.perspCamera.up.set(0, 0, 1);
    this.perspCamera.position.set(500, -800, 600);

    this.orthoCamera = new THREE.OrthographicCamera(-500, 500, 500, -500, 0.1, 1_000_000);
    this.orthoCamera.up.set(0, 1, 0); // looking straight down −Z: North is up on screen
    this.orthoCamera.position.set(0, 0, 1000);

    this.activeCamera = this.perspCamera;

    // Hillshade-style directional light (07 Phase 2): azimuth/altitude driven, shading only
    // (no shadow mapping — cheap by design). Low sun = long shading = terrain pops.
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.scene.add(this.sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.setSun(DEFAULT_SUN.azimuth, DEFAULT_SUN.altitude);

    // ITEM33: intercept wheel before OrbitControls so we own the dolly step.
    // Must be added BEFORE OrbitControls ctor so stopImmediatePropagation works.
    this.renderer.domElement.addEventListener('wheel', this.handleWheel, { passive: false });

    // Damping intentionally OFF: render-on-demand only (battery matters for field laptops).
    this.orbitControls = new OrbitControls(this.perspCamera, this.renderer.domElement);
    this.orbitControls.enableDamping = false;
    // ITEM33: fly-through dolly — minDistance removed; target pushed forward when
    // camera approaches within FLY_THRESHOLD. Wheel intercepted before OrbitControls
    // so the step is sensitivity-driven and pre-clamp (no 1-frame flicker).
    this.orbitControls.zoomToCursor = true;
    this.orbitControls.minDistance = 0;
    this.orbitControls.addEventListener('change', this.handleOrbitChange);
    this.orbitControls.addEventListener('start', this.handleControlsStart);
    this.orbitControls.addEventListener('end', this.handleControlsEnd);

    this.topControls = new OrbitControls(this.orthoCamera, this.renderer.domElement);
    this.topControls.enableDamping = false;
    this.topControls.enableRotate = false; // top mode: pan/zoom only
    this.topControls.screenSpacePanning = true;
    this.topControls.zoomToCursor = true;
    this.topControls.enabled = false;
    this.topControls.addEventListener('change', this.requestRender);
    this.topControls.addEventListener('start', this.handleControlsStart);
    this.topControls.addEventListener('end', this.handleControlsEnd);

    this.gizmoGroup = buildNorthGizmo();
    this.gizmoScene.add(this.gizmoGroup);
    this.gizmoCamera.position.set(0, 0, 5);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
    this.handleResize();

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', this.handlePointerMove);
    el.addEventListener('pointerleave', this.handlePointerLeave);
    el.addEventListener('pointerdown', this.handlePointerDown);
    el.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);

    this.requestRender();
  }

  // ── public surface ──────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.labelRefreshTimer !== null) clearTimeout(this.labelRefreshTimer);
    const el = this.renderer.domElement;
    el.removeEventListener('pointermove', this.handlePointerMove);
    el.removeEventListener('pointerleave', this.handlePointerLeave);
    el.removeEventListener('pointerdown', this.handlePointerDown);
    el.removeEventListener('pointerup', this.handlePointerUp);
    el.removeEventListener('wheel', this.handleWheel);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.resizeObserver.disconnect();
    this.orbitControls.dispose();
    this.topControls.dispose();
    for (const s of this.surfaces.values()) s.dispose();
    this.surfaces.clear();
    for (const d of this.dxfs.values()) d.dispose();
    this.dxfs.clear();
    for (const g of this.geotiffs.values()) g.dispose();
    this.geotiffs.clear();
    for (const p of this.pdfs.values()) p.dispose();
    this.pdfs.clear();
    for (const p of this.pointClouds.values()) p.dispose();
    this.pointClouds.clear();
    for (const p of this.pointCloudIndexes.values()) p.dispose();
    this.pointCloudIndexes.clear();
    for (const s of this.analyticSurfels.values()) s.dispose();
    this.analyticSurfels.clear();
    this.renderFeatures?.dispose();
    this.renderFeatures = null;
    this.postQuad.geometry.dispose();
    this.postQuad.material.dispose();
    this.sceneTarget.dispose();
    this.renderer.dispose();
    el.remove();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  clearSceneContents(): void {
    if (this.disposed) return;
    this.clearEditSelection();
    for (const surface of this.surfaces.values()) surface.dispose();
    this.surfaces.clear();
    for (const dxf of this.dxfs.values()) dxf.dispose();
    this.dxfs.clear();
    for (const geotiff of this.geotiffs.values()) geotiff.dispose();
    this.geotiffs.clear();
    for (const pdf of this.pdfs.values()) pdf.dispose();
    this.pdfs.clear();
    this.pdfFootprints.clear();
    for (const pointCloud of this.pointClouds.values()) pointCloud.dispose();
    this.pointClouds.clear();
    for (const streaming of this.pointCloudIndexes.values()) streaming.dispose();
    this.pointCloudIndexes.clear();
    for (const surfels of this.analyticSurfels.values()) surfels.dispose();
    this.analyticSurfels.clear();
    this.renderFeatures?.dispose();
    this.renderFeatures = null;
    this.sceneOrigin = null;
    this.sceneRadius = 0;
    this.activeHandle = null;
    this.requestRender();
  }

  /** top = orthographic, rotation locked, preserves target. */
  setCameraMode(mode: CameraMode): void {
    if (this.disposed || mode === this.mode) return;
    if (mode === 'hover') return;
    const prevMode = this.mode;
    const currentPos = this.activeCamera.position.clone();
    const sourceTarget = prevMode === 'top' ? this.topControls.target.clone() : this.orbitControls.target.clone();
    if (prevMode === 'orbit') this.rememberOrbitView();
    if (prevMode === 'hover') {
      this.hoverKeys.clear();
      this.hoverLookDragging = false;
      this.hoverPointCloudIndexHandle = null;
      this.hoverGroundZ = null;
    }
    this.mode = mode;

    if (mode === 'top') {
      const halfH =
        prevMode !== 'hover'
          ? Math.max(
              currentPos.distanceTo(sourceTarget) *
                Math.tan(THREE.MathUtils.degToRad(this.perspCamera.fov / 2)),
              1,
            )
          : Math.max(this.hoverHeight * 4, 10);
      this.setOrthoFrustum(halfH);
      this.orthoCamera.position.copy(currentPos);
      this.orthoCamera.zoom = 1;
      this.orthoCamera.up.set(0, 1, 0);
      this.orthoCamera.lookAt(currentPos.x, currentPos.y, currentPos.z - 1);
      this.orthoCamera.updateProjectionMatrix();
      this.topControls.target.set(currentPos.x, currentPos.y, this.resolveSurfaceZAt(currentPos.x, currentPos.y) ?? 0);
      this.topControls.update();
      this.activeCamera = this.orthoCamera;
    } else {
      this.perspCamera.position.copy(currentPos);
      this.activeCamera = this.perspCamera;
      this.rebuildOrbitTargetFromCurrentView();
    }
    this.orbitControls.enabled = mode === 'orbit';
    this.topControls.enabled = mode === 'top';
    this.emitZoomChanged();
    this.scheduleLabelRefresh();
    this.requestRender();
  }

  enterHoverAtPointer(height: number): boolean {
    if (this.disposed || !this.sceneOrigin) return false;
    const hit = this.pickActiveSurfaceAtPointer();
    if (!hit) return false;
    if (this.mode === 'orbit') this.rememberOrbitView();
    this.hoverHeight = height;
    const dir = new THREE.Vector3();
    this.activeCamera.getWorldDirection(dir);
    dir.z = 0;
    if (dir.lengthSq() < 1e-6) {
      dir.copy(this.lastOrbitDirection);
      dir.z = 0;
    }
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
    dir.normalize();
    this.hoverYaw = Math.atan2(dir.x, dir.y);
    this.hoverPitch =
      Math.abs(dir.z) > 0.95 ? THREE.MathUtils.degToRad(-5) : THREE.MathUtils.clamp(Math.asin(dir.z), -1.2, 1.2);
    this.mode = 'hover';
    this.activeCamera = this.perspCamera;
    this.orbitControls.enabled = false;
    this.topControls.enabled = false;
    this.hoverPointCloudIndexHandle = null;
    this.hoverGroundZ = hit.point.z / this.exaggeration;
    this.perspCamera.position.set(
      hit.point.x,
      hit.point.y,
      (hit.point.z / this.exaggeration + this.hoverHeight) * this.exaggeration,
    );
    this.applyHoverLook();
    this.emitZoomChanged();
    this.scheduleLabelRefresh();
    this.requestRender();
    return true;
  }

  enterHoverOnPointCloud(handle: string, height: number): boolean {
    if (this.disposed || !this.sceneOrigin) return false;
    const streaming = this.pointCloudIndexes.get(handle);
    if (!streaming) return false;
    if (this.mode === 'orbit') this.rememberOrbitView();
    this.hoverHeight = height;
    const dir = new THREE.Vector3();
    this.activeCamera.getWorldDirection(dir);
    dir.z = 0;
    if (dir.lengthSq() < 1e-6) {
      dir.copy(this.lastOrbitDirection);
      dir.z = 0;
    }
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
    dir.normalize();
    this.hoverYaw = Math.atan2(dir.x, dir.y);
    this.hoverPitch = Math.abs(dir.z) > 0.95 ? THREE.MathUtils.degToRad(-5) : THREE.MathUtils.clamp(Math.asin(dir.z), -1.2, 1.2);

    const start = this.perspCamera.position.clone();
    let x = start.x;
    let y = start.y;
    let groundZ = this.resolvePointCloudGroundZAt(handle, x, y);
    if (groundZ === null) {
      const center = streaming.bounds.getCenter(new THREE.Vector3());
      x = center.x;
      y = center.y;
      groundZ = this.resolvePointCloudGroundZAt(handle, x, y) ?? streaming.fallbackGroundZ();
    }

    this.mode = 'hover';
    this.activeCamera = this.perspCamera;
    this.orbitControls.enabled = false;
    this.topControls.enabled = false;
    this.hoverPointCloudIndexHandle = handle;
    this.hoverGroundZ = groundZ;
    this.perspCamera.position.set(x, y, (groundZ + this.hoverHeight) * this.exaggeration);
    this.applyHoverLook();
    this.emitZoomChanged();
    this.scheduleLabelRefresh();
    this.requestRender();
    return true;
  }

  /** Frames current content bounds in both cameras. */
  resetView(): void {
    if (this.disposed) return;
    const bounds = this.contentBounds();
    if (!bounds) return;

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);

    const dir = new THREE.Vector3(0.55, -0.8, 0.55).normalize();
    this.perspCamera.position.copy(center).addScaledVector(dir, radius * 2.1);
    this.orbitControls.target.copy(center);
    this.orbitControls.update();

    const halfH = Math.max(size.x, size.y) * 0.55;
    this.setOrthoFrustum(halfH);
    this.orthoCamera.zoom = 1;
    this.orthoCamera.position.set(center.x, center.y, center.z + radius * 2.1);
    this.orthoCamera.updateProjectionMatrix();
    this.topControls.target.copy(center);
    this.topControls.update();

    this.scheduleLabelRefresh();
    this.requestRender();
  }

  /** Builds the RenderSurface (rebase + mesh) and returns its handle. */
  addSurface(model: SurfaceModel): string {
    if (this.disposed) throw new Error('ViewerEngine: addSurface after dispose');
    const wasNull = !this.sceneOrigin;
    if (!this.sceneOrigin) {
      // First dataset fixes the SceneOrigin (Float64 bbox center) — risk R1.
      this.sceneOrigin = computeBBox(model.positions).center;
    }
    if (wasNull) {
      for (const pdf of this.pdfs.values()) pdf.setOrigin(this.sceneOrigin);
    }
    const handle = `s${++this.handleCounter}`;
    const surface = new RenderSurface(handle, model, this.sceneOrigin);
    this.surfaces.set(handle, surface);
    this.contentGroup.add(surface.group);
    this.updateSceneMetrics();
    this.resetView(); // reframe on add (C5)
    this.requestRender();
    return handle;
  }

  removeSurface(handle: string): void {
    const surface = this.surfaces.get(handle);
    if (!surface) return;
    surface.dispose();
    this.surfaces.delete(handle);
    if (this.activeHandle === handle) this.activeHandle = null;
    if (this.surfaces.size === 0 && this.dxfs.size === 0 && this.geotiffs.size === 0 && this.pdfs.size === 0 && this.pointClouds.size === 0 && this.pointCloudIndexes.size === 0 && this.analyticSurfels.size === 0) {
      this.sceneOrigin = null; // next dataset re-anchors the SceneOrigin (R1)
      this.sceneRadius = 0;
    } else {
      this.updateSceneMetrics();
      this.resetView(); // reframe on remove (C5)
    }
    this.requestRender();
  }

  // ── DXF datasets (docs/08 Phases 4/5) ──────────────────────────────────────

  /** Builds the RenderDxf (rebase + per-layer batched linework) and returns its handle. */
  addDxf(dataset: DxfDataset, densify?: number): string {
    if (this.disposed) throw new Error('ViewerEngine: addDxf after dispose');
    const wasNull = !this.sceneOrigin;
    if (!this.sceneOrigin) {
      // DXF-without-surface path: the DXF anchors the SceneOrigin (R1 still holds)
      const first = dataset.entities[0]?.pts;
      this.sceneOrigin = first && first.length >= 3 ? [first[0]!, first[1]!, first[2]!] : [0, 0, 0];
    }
    if (wasNull) {
      for (const pdf of this.pdfs.values()) pdf.setOrigin(this.sceneOrigin);
    }
    const handle = `d${++this.handleCounter}`;
    const dxf = new RenderDxf(handle, dataset, this.sceneOrigin, densify);
    this.dxfs.set(handle, dxf);
    this.contentGroup.add(dxf.group);
    this.updateSceneMetrics();
    this.resetView();
    this.requestRender();
    return handle;
  }

  removeDxf(handle: string): void {
    const dxf = this.dxfs.get(handle);
    if (!dxf) return;
    dxf.dispose();
    this.dxfs.delete(handle);
    if (this.surfaces.size === 0 && this.dxfs.size === 0 && this.geotiffs.size === 0 && this.pdfs.size === 0 && this.pointClouds.size === 0) {
      this.sceneOrigin = null;
      this.sceneRadius = 0;
    } else {
      this.updateSceneMetrics();
      this.resetView();
    }
    this.requestRender();
  }

  /**
   * (Re)drape a DXF against a target surface — or restore native elevations when
   * `surfaceHandle` is null. Returns per-layer miss counts (docs/08 Phase 4).
   */
  drapeDxf(handle: string, surfaceHandle: string | null, densify?: number): DxfDrapeResult | null {
    const dxf = this.dxfs.get(handle);
    if (!dxf) return null;
    if (densify !== undefined) dxf.setDensify(densify);
    let result: DxfDrapeResult | null = null;
    const target = surfaceHandle ? this.surfaces.get(surfaceHandle) : undefined;
    if (target) {
      result = dxf.drape(target);
    } else {
      dxf.applyNativeZ();
      result = { offSurfaceVertices: 0, totalVertices: 0, perLayerMisses: {} };
    }
    this.updateSceneMetrics();
    this.requestRender();
    return result;
  }

  addGeotiff(dataset: GeotiffDataset, file: File, surfaceHandle: string | null): string {
    if (this.disposed) throw new Error('ViewerEngine: addGeotiff after dispose');
    const wasNull = !this.sceneOrigin;
    if (!this.sceneOrigin) {
      const bounds = dataset.worldBounds;
      this.sceneOrigin = bounds
        ? [
            (bounds.minX + bounds.maxX) / 2,
            (bounds.minY + bounds.maxY) / 2,
            0,
          ]
        : [0, 0, 0];
    }
    if (wasNull) {
      for (const pdf of this.pdfs.values()) pdf.setOrigin(this.sceneOrigin);
    }
    const handle = `g${++this.handleCounter}`;
    const geotiff = new RenderGeotiff(
      handle,
      dataset,
      file,
      this.sceneOrigin,
      this.renderer,
      this.requestRender,
      () => this.updateSceneMetrics(),
    );
    const target = surfaceHandle ? this.surfaces.get(surfaceHandle) ?? null : null;
    geotiff.setTarget(target);
    this.geotiffs.set(handle, geotiff);
    this.contentGroup.add(geotiff.group);
    this.updateSceneMetrics();
    this.resetView();
    this.requestRender();
    return handle;
  }

  removeGeotiff(handle: string): void {
    const geotiff = this.geotiffs.get(handle);
    if (!geotiff) return;
    geotiff.dispose();
    this.geotiffs.delete(handle);
    if (this.surfaces.size === 0 && this.dxfs.size === 0 && this.geotiffs.size === 0 && this.pdfs.size === 0 && this.pointClouds.size === 0) {
      this.sceneOrigin = null;
      this.sceneRadius = 0;
    } else {
      this.updateSceneMetrics();
      this.resetView();
    }
    this.requestRender();
  }

  setGeotiffDisplay(handle: string, visible: boolean, opacity: number): void {
    this.geotiffs.get(handle)?.setDisplay(visible, opacity);
    this.updateSceneMetrics();
    this.requestRender();
  }

  setGeotiffTarget(handle: string, surfaceHandle: string | null): void {
    const target = surfaceHandle ? this.surfaces.get(surfaceHandle) ?? null : null;
    this.geotiffs.get(handle)?.setTarget(target);
    this.updateSceneMetrics();
    this.requestRender();
  }

  setPdfDrapeTarget(handle: string, surfaceHandle: string | null): void {
    const target = surfaceHandle ? this.surfaces.get(surfaceHandle) ?? null : null;
    this.pdfs.get(handle)?.setTarget(target);
    this.updateSceneMetrics();
    this.requestRender();
  }

  addPdf(sheet: PdfRenderableSheet, file: File): string {
    if (this.disposed) throw new Error('ViewerEngine: addPdf after dispose');
    const origin = this.sceneOrigin ?? [0, 0, 0] as Vec3;
    const pdf = new RenderPdf(
      sheet.handle,
      sheet,
      file,
      origin,
      this.requestRender,
      () => this.updateSceneMetrics(),
    );
    this.pdfs.set(sheet.handle, pdf);
    this.pdfFootprints.set(sheet.handle, JSON.stringify({
      calibration: sheet.calibration,
      orientation: sheet.orientation,
      relativeLayoutPx: sheet.relativeLayoutPx,
      widthPx150: sheet.widthPx150,
      heightPx150: sheet.heightPx150,
      borderCrop: sheet.borderCrop,
    }));
    this.contentGroup.add(pdf.group);
    this.updateSceneMetrics();
    this.resetView();
    this.requestRender();
    return sheet.handle;
  }

  removePdf(handle: string): void {
    const pdf = this.pdfs.get(handle);
    if (!pdf) return;
    pdf.dispose();
    this.pdfs.delete(handle);
    this.pdfFootprints.delete(handle);
    if (this.surfaces.size === 0 && this.dxfs.size === 0 && this.geotiffs.size === 0 && this.pdfs.size === 0 && this.pointClouds.size === 0) {
      this.sceneOrigin = null;
      this.sceneRadius = 0;
    } else {
      this.updateSceneMetrics();
      this.resetView();
    }
    this.requestRender();
  }

  setPdfDisplay(handle: string, visible: boolean, opacityPct: number): void {
    this.pdfs.get(handle)?.setDisplay(visible, opacityPct);
    this.updateSceneMetrics();
    this.requestRender();
  }

  setPdfRenderOrder(handle: string, order: number): void {
    const pdf = this.pdfs.get(handle);
    if (!pdf) return;
    pdf.setRenderOrder(order);
    this.requestRender();
  }

  updatePdfSheet(sheet: PdfRenderableSheet): void {
    // Only resetView when the world footprint changes (calibration, orientation, offset,
    // sheet dimensions, or border crop). Overlay/visibility/threshold changes must not
    // move the camera.
    const footprintKey = JSON.stringify({
      calibration: sheet.calibration,
      orientation: sheet.orientation,
      relativeLayoutPx: sheet.relativeLayoutPx,
      widthPx150: sheet.widthPx150,
      heightPx150: sheet.heightPx150,
      borderCrop: sheet.borderCrop,
      placement: sheet.placement,
    });
    const footprintChanged = this.pdfFootprints.get(sheet.handle) !== footprintKey;
    this.pdfFootprints.set(sheet.handle, footprintKey);
    this.pdfs.get(sheet.handle)?.updateSheet(sheet);
    this.updateSceneMetrics();
    if (footprintChanged) this.resetView();
    this.requestRender();
  }

  previewPdfOrientation(
    handle: string,
    orientationDeg: number,
    pivotScenePx?: { x: number; y: number },
    baselineOrientDeg?: number,
    baseCenterScenePx?: { x: number; y: number },
  ): void {
    const pdf = this.pdfs.get(handle);
    if (!pdf) return;
    pdf.previewOrientation(orientationDeg, pivotScenePx, baselineOrientDeg, baseCenterScenePx);
    this.requestRender();
  }

  getPdfGroupPositionScenePx(handle: string): { x: number; y: number } | null {
    const pdf = this.pdfs.get(handle);
    if (!pdf) return null;
    const ppf = pdf.pixelsPerFoot();
    return { x: pdf.group.position.x * ppf, y: pdf.group.position.y * ppf };
  }

  getSceneOrigin(): Vec3 {
    return this.sceneOrigin ?? [0, 0, 0];
  }

  addPointCloud(dataset: PointCloudDataset): string {
    if (this.disposed) throw new Error('ViewerEngine: addPointCloud after dispose');
    if (!dataset.octree) throw new Error('ViewerEngine: point cloud has no octree');
    const wasNull = !this.sceneOrigin;
    if (!this.sceneOrigin) this.sceneOrigin = dataset.octree.origin;
    if (wasNull) {
      for (const pdf of this.pdfs.values()) pdf.setOrigin(this.sceneOrigin);
    }
    const handle = `p${++this.handleCounter}`;
    const pointCloud = new RenderPointCloud(handle, dataset, this.sceneOrigin);
    this.pointClouds.set(handle, pointCloud);
    this.contentGroup.add(pointCloud.group);
    this.updateSceneMetrics();
    this.resetView();
    this.requestRender();
    return handle;
  }

  removePointCloud(handle: string): void {
    const pointCloud = this.pointClouds.get(handle);
    if (!pointCloud) return;
    pointCloud.dispose();
    this.pointClouds.delete(handle);
    if (this.surfaces.size === 0 && this.dxfs.size === 0 && this.geotiffs.size === 0 && this.pdfs.size === 0 && this.pointClouds.size === 0) {
      this.sceneOrigin = null;
      this.sceneRadius = 0;
    } else {
      this.updateSceneMetrics();
      this.resetView();
    }
    this.requestRender();
  }

  setPointCloudDisplay(handle: string, visible: boolean, pointSize: number): void {
    this.pointClouds.get(handle)?.setDisplay(visible, pointSize);
    this.updateSceneMetrics();
    this.requestRender();
  }

  setPointCloudDensifiedPointBudget(handle: string, pointBudget: number): void {
    this.pointClouds.get(handle)?.setDensifiedPointBudget(pointBudget);
    this.requestRender();
  }

  applyPointCloudDensifiedNode(handle: string, nodeId: number, payload: PointCloudNodePayload): void {
    if (this.pointClouds.get(handle)?.applyDensifiedNode(nodeId, payload)) this.requestRender();
  }

  releasePointCloudDensifiedNode(handle: string, nodeId: number): void {
    if (this.pointClouds.get(handle)?.releaseDensifiedNode(nodeId)) this.requestRender();
  }

  pointCloudHasDensifiedPoints(handle: string): boolean {
    return this.pointClouds.get(handle)?.hasDensifiedPoints() ?? false;
  }

  getPointCloudDensifiedPointCount(handle: string): number {
    return this.pointClouds.get(handle)?.getDensifiedPointCount() ?? 0;
  }

  /** Attach a streaming indexed-full point cloud (WPI index). fetchTiles is IPC-backed. */
  addPointCloudIndex(hierarchy: StreamingHierarchy, fetchTiles: TileFetcher): string {
    if (this.disposed) throw new Error('ViewerEngine: addPointCloudIndex after dispose');
    const wasNull = !this.sceneOrigin;
    if (!this.sceneOrigin) this.sceneOrigin = hierarchy.origin;
    if (wasNull) {
      for (const pdf of this.pdfs.values()) pdf.setOrigin(this.sceneOrigin);
    }
    const handle = `p${++this.handleCounter}`;
    const streaming = new StreamingPointCloud(handle, hierarchy, this.sceneOrigin, fetchTiles, () => this.requestRender());
    this.pointCloudIndexes.set(handle, streaming);
    this.contentGroup.add(streaming.group);
    this.updateSceneMetrics();
    this.resetView();
    this.requestRender();
    return handle;
  }

  removePointCloudIndex(handle: string): void {
    const streaming = this.pointCloudIndexes.get(handle);
    if (!streaming) return;
    streaming.dispose();
    this.pointCloudIndexes.delete(handle);
    this.updateSceneMetrics();
    this.requestRender();
  }

  setPointCloudIndexDisplay(handle: string, visible: boolean, pointSize: number): void {
    this.pointCloudIndexes.get(handle)?.setDisplay(visible, pointSize);
    this.requestRender();
  }

  setPointCloudIndexDisplayMode(handle: string, mode: PointDisplayMode): void {
    this.pointCloudIndexes.get(handle)?.setDisplayMode(mode);
    this.requestRender();
  }

  setPointCloudIndexFilter(handle: string, filter: FilterState): void {
    this.pointCloudIndexes.get(handle)?.setFilter(filter);
    this.requestRender();
  }

  addAnalyticSurfels(hierarchy: SurfelHierarchy, fetchTiles: SurfelTileFetcher): string {
    if (this.disposed) throw new Error('ViewerEngine: addAnalyticSurfels after dispose');
    const wasNull = !this.sceneOrigin;
    if (!this.sceneOrigin) this.sceneOrigin = hierarchy.origin;
    if (wasNull) {
      for (const pdf of this.pdfs.values()) pdf.setOrigin(this.sceneOrigin);
    }
    const handle = `sf${++this.handleCounter}`;
    const surfels = new StreamingSurfels(handle, hierarchy, this.sceneOrigin, fetchTiles, () => this.requestRender());
    this.analyticSurfels.set(handle, surfels);
    this.contentGroup.add(surfels.group);
    this.updateSceneMetrics();
    this.resetView();
    this.requestRender();
    return handle;
  }

  removeAnalyticSurfels(handle: string): void {
    const surfels = this.analyticSurfels.get(handle);
    if (!surfels) return;
    surfels.dispose();
    this.analyticSurfels.delete(handle);
    this.updateSceneMetrics();
    this.requestRender();
  }

  setAnalyticSurfelsDisplay(handle: string, visible: boolean, sizeScale: number): void {
    this.analyticSurfels.get(handle)?.setDisplay(visible, sizeScale);
    this.requestRender();
  }

  getAnalyticSurfelsDisclosure(handle: string): string | null {
    return this.analyticSurfels.get(handle)?.getDisclosure() ?? null;
  }

  getPointCloudIndexDisclosure(handle: string): string | null {
    return this.pointCloudIndexes.get(handle)?.getDisclosure() ?? null;
  }

  getPointCloudIndexLoadedPointCount(handle: string): number {
    return this.pointCloudIndexes.get(handle)?.getLoadedPointCount() ?? 0;
  }

  setPointCloudDensity(handle: string, density: number): void {
    this.pointClouds.get(handle)?.setDensity(density);
    this.requestRender();
  }

  setPointCloudDisplayMode(handle: string, mode: PointDisplayMode): void {
    this.pointClouds.get(handle)?.setDisplayMode(mode);
    this.requestRender();
  }

  setPointCloudFilter(handle: string, filter: FilterState): void {
    this.pointClouds.get(handle)?.setFilter(filter);
    this.requestRender();
  }

  setPointCloudFog(enabled: boolean): void {
    this.fogEnabled = enabled;
    this.scene.fog = enabled && this.sceneRadius > 0 ? new THREE.FogExp2(0x0c1420, 0.00018) : null;
    this.requestRender();
  }

  setPointCloudEdl(enabled: boolean): void {
    this.edlEnabled = enabled;
    this.requestRender();
  }

  /**
   * Wire a GeoTIFF's coarse overview into a point cloud for GeoTIFF-color mode. Decodes the
   * overview once (async) then recolors on the next settle. Pass null to clear.
   */
  setPointCloudGeotiffSource(handle: string, geotiffHandle: string | null): void {
    const cloud = this.pointClouds.get(handle);
    if (!cloud) return;
    if (geotiffHandle === null) {
      cloud.setOverviewSampler(null);
      this.requestRender();
      return;
    }
    const geotiff = this.geotiffs.get(geotiffHandle);
    if (!geotiff) {
      cloud.setOverviewSampler(null);
      this.requestRender();
      return;
    }
    void geotiff.requestOverview().then((sampler) => {
      if (this.disposed) return;
      // Only apply if the cloud still exists and still wants this source.
      if (this.pointClouds.get(handle) === cloud) {
        cloud.setOverviewSampler(sampler);
        this.requestRender();
      }
    });
  }

  /** Per-layer display application for a DXF (gates ANDed by the UI layer). */
  applyDxfDisplay(handle: string, visible: boolean, layers: Map<string, DxfLayerDisplay>): void {
    this.dxfs.get(handle)?.applyDisplay(visible, layers);
    this.updateSceneMetrics();
    this.requestRender();
  }

  /** Vertical exaggeration: ONE Z-scale matrix on the content group — buffers untouched
   *  (04 §3). Cursor readout + labels compensate. */
  setVerticalExaggeration(k: number): void {
    if (this.disposed || k === this.exaggeration) return;
    this.exaggeration = k;
    this.contentGroup.scale.set(1, 1, k);
    this.contentGroup.updateMatrixWorld(true);
    this.scheduleLabelRefresh();
    this.requestRender();
  }

  /** Hillshade-style sun. azimuth: compass degrees from north, clockwise. altitude: 0–90°. */
  setSun(azimuthDeg: number, altitudeDeg: number): void {
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    const alt = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(altitudeDeg, 2, 90));
    this.sun.position
      .set(Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt))
      .multiplyScalar(1000);
    this.requestRender();
  }

  /** Full per-surface display application (07 Phase 3/5): per-element color/opacity/on,
   *  vertex size, mute — computed by the UI layer (master gates ANDed there). */
  applyDisplay(handle: string, resolved: ResolvedDisplay): void {
    this.surfaces.get(handle)?.applyDisplay(resolved);
    this.updateSceneMetrics();
    this.scheduleLabelRefresh();
    this.requestRender();
  }

  /** Derived-boundary stats for a surface (computed on demand in the RenderSurface, cached).
   *  null when the surface has no faces (08 Phase 1). */
  derivedBoundaryInfo(handle: string): { holeCount: number } | null {
    return this.surfaces.get(handle)?.derivedBoundaryInfo() ?? null;
  }

  /** Live model accessor for export and round-trip verification. */
  getSurfaceModel(handle: string): SurfaceModel | null {
    return this.surfaces.get(handle)?.model ?? null;
  }

  /** Legacy single-overlay toggle (kept for the faceless auto-vertices path). */
  setOverlay(handle: string, overlay: OverlayKind, on: boolean): void {
    this.surfaces.get(handle)?.setOverlay(overlay, on);
    this.requestRender();
  }

  setSurfaceVisible(handle: string, on: boolean): void {
    const s = this.surfaces.get(handle);
    if (s) s.group.visible = on;
    this.updateSceneMetrics();
    this.scheduleLabelRefresh();
    this.requestRender();
  }

  setSurfaceColor(handle: string, color: string): void {
    this.surfaces.get(handle)?.setColor(color);
    this.requestRender();
  }

  setZoomNormalized(normalized: number): void {
    const t = THREE.MathUtils.clamp(normalized, 0, 1);
    if (this.mode === 'top') {
      const minZoom = this.topControls.minZoom || 1e-4;
      const maxZoom = this.topControls.maxZoom || 1e4;
      this.orthoCamera.zoom = Math.exp(Math.log(minZoom) + t * (Math.log(maxZoom) - Math.log(minZoom)));
      this.orthoCamera.updateProjectionMatrix();
      this.topControls.update();
    } else {
      const minDistance = Math.max(this.orbitControls.minDistance, 0.01);
      const maxDistance = Math.max(this.orbitControls.maxDistance, minDistance * 1.01);
      const distance = Math.exp(
        Math.log(minDistance) + (1 - t) * (Math.log(maxDistance) - Math.log(minDistance)),
      );
      const dir = this.activeCamera.position.clone().sub(this.orbitControls.target).normalize();
      this.perspCamera.position.copy(this.orbitControls.target).addScaledVector(dir, distance);
      this.orbitControls.update();
      this.applyFlyThroughDolly();
      this.rememberOrbitView();
    }
    this.emitZoomChanged();
    this.scheduleLabelRefresh();
    this.requestRender();
  }

  setHoverHeight(height: number): void {
    this.hoverHeight = Math.max(height, -1000);
    if (this.mode === 'hover') this.snapHoverCameraToSurface();
  }

  setHoverSpeed(speed: number): void {
    this.hoverSpeed = Math.max(speed, 0.1);
  }

  setZoomSensitivity3D(sensitivity: number): void {
    this.zoomSensitivity3D = THREE.MathUtils.clamp(sensitivity, 0.1, 20);
  }

  /** Active surface drives the cursor readout target (C3). null = readout from any surface. */
  setActiveSurface(handle: string | null): void {
    this.activeHandle = handle;
    this.pointerDirty = true;
    this.requestPick();
  }

  /** Cursor position in ORIGINAL survey coordinates (not rebased), null when off-surface. */
  onCursorPosition(cb: CursorCallback): void {
    this.cursorCb = cb;
  }

  /** Dev/perf-gate hook: fps measured over consecutively rendered frames during interaction. */
  onFrameStats(cb: FrameStatsCallback): void {
    this.statsCb = cb;
  }

  /** Clicking the gizmo's N marker (07 Phase 2) — UI bridges this to top-view north-up. */
  onNorthClick(cb: () => void): void {
    this.northClickCb = cb;
  }

  /** Label auto-off status note ("Labels paused — …") for the status bar (07 Phase 6). */
  onLabelStatus(cb: LabelStatusCallback): void {
    this.labelStatusCb = cb;
  }

  onZoomChange(cb: ZoomChangeCallback): void {
    this.zoomCb = cb;
    cb(this.currentZoomNormalized());
  }

  onHoverHeightChange(cb: (h: number) => void): void {
    this.hoverHeightCb = cb;
  }

  onHoverSpeedChange(cb: (s: number) => void): void {
    this.hoverSpeedCb = cb;
  }

  onPointCloudSettled(cb: PointCloudSettleCallback): void {
    this.pointCloudSettleCb = cb;
  }

  onRequestExitHover(cb: () => void): void {
    this.exitHoverCb = cb;
  }

  onEditSelection(cb: EditSelectionCallback): void {
    this.editSelectionCb = cb;
  }

  onEditDragState(cb: EditDragCallback): void {
    this.editDragCb = cb;
  }

  onEditCommit(cb: EditCommitCallback): void {
    this.editCommitCb = cb;
  }

  onEditMessage(cb: EditMessageCallback): void {
    this.editMessageCb = cb;
  }

  setEditTool(tool: EditTool): void {
    this.editTool = tool;
    this.requestPick();
  }

  beginSelectedVertexDrag(clientY: number): boolean {
    if (this.editTool !== 'editPoint' || !this.editSurfaceHandle || this.selectedVertexId === null) return false;
    const surface = this.surfaces.get(this.editSurfaceHandle);
    if (!surface) return false;
    const [e, n, z] = surface.sourceXYZ(this.selectedVertexId);
    this.dragStartPointerY = clientY;
    this.dragStartXYZ = [e, n, z];
    this.draggingVertex = true;
    this.editDragCb?.(true);
    return true;
  }

  dragSelectedVertex(clientX: number, clientY: number): void {
    this.updateDraggedVertex(clientX, clientY);
  }

  endSelectedVertexDrag(): VertexEditCommand | null {
    return this.finishDraggedVertexCommit();
  }

  clearEditSelection(): void {
    this.selectedVertexId = null;
    this.selectedEdge = null;
    if (this.editSurfaceHandle) {
      const surface = this.surfaces.get(this.editSurfaceHandle);
      surface?.setSelectedVertex(null);
    }
    this.emitEditSelection();
    this.requestRender();
  }

  getEditSelectionScreenPosition(): { x: number; y: number; visible: boolean } | null {
    if (!this.editSurfaceHandle || this.selectedVertexId === null) return null;
    const surface = this.surfaces.get(this.editSurfaceHandle);
    if (!surface) return null;
    const [x, y, z] = surface.localXYZ(this.selectedVertexId);
    const point = new THREE.Vector3(x, y, z * this.exaggeration).project(this.activeCamera);
    const visible = point.z >= -1 && point.z <= 1;
    return {
      x: (point.x * 0.5 + 0.5) * this.container.clientWidth,
      y: (1 - (point.y * 0.5 + 0.5)) * this.container.clientHeight,
      visible,
    };
  }

  setEditMode(surfaceHandle: string | null): void {
    this.editSurfaceHandle = surfaceHandle;
    this.draggingVertex = false;
    this.selectedEdge = null;
    this.editDragCb?.(false);
    for (const [handle, surface] of this.surfaces) {
      surface.setHoverVertex(null);
      surface.setSelectedVertex(handle === surfaceHandle ? this.selectedVertexId : null);
    }
    if (surfaceHandle === null) {
      this.hoverVertexId = null;
      this.selectedVertexId = null;
      this.editSelectionCb?.(null);
    } else {
      this.setActiveSurface(surfaceHandle);
      this.emitEditSelection();
    }
    this.requestRender();
  }

  commitVertexZEdit(surfaceHandle: string, vertexId: number, nextZ: number): VertexEditCommand | null {
    return this.commitVertexEdit(surfaceHandle, vertexId, undefined, undefined, nextZ, false);
  }

  commitVertexEdit(
    surfaceHandle: string,
    vertexId: number,
    nextE?: number,
    nextN?: number,
    nextZ?: number,
    guardOrientation = true,
  ): VertexEditCommand | null {
    const surface = this.surfaces.get(surfaceHandle);
    if (!surface) return null;
    const [e, n, oldZ] = surface.sourceXYZ(vertexId);
    const target: [number, number, number] = [nextE ?? e, nextN ?? n, nextZ ?? oldZ];
    if (target[0] === e && target[1] === n && target[2] === oldZ) return null;
    const result = surface.applyVertexMove(vertexId, target, guardOrientation);
    if (result.blocked) {
      this.editMessageCb?.("can't cross triangle boundary here");
      if (this.editSelectionCb) this.emitEditSelection();
      return null;
    }
    if (!result.changed) return null;
    this.editMessageCb?.(null);
    surface.model.dirty = true;
    surface.model.provenance = 'modified';
    if (this.selectedVertexId === vertexId && this.editSurfaceHandle === surfaceHandle) this.emitEditSelection();
    this.scheduleLabelRefresh();
    this.requestRender();
    return {
      type: 'moveVertex',
      surfaceId: surfaceHandle,
      sourcePointId: surface.sourcePointId(vertexId),
      vertexId,
      oldXYZ: [e, n, oldZ],
      newXYZ: target,
    };
  }

  applyVertexCommand(command: VertexEditCommand, inverse = false): boolean {
    if (command.type === 'swapEdge') return this.applySwapEdgeCommand(command);
    if (command.vertexId === undefined) return false;
    const target = inverse ? command.oldXYZ : command.newXYZ;
    if (!target) return false;
    return this.commitVertexEdit(command.surfaceId, command.vertexId, target[0], target[1], target[2], false) !== null;
  }

  swapSelectedEdge(): VertexEditCommand | null {
    if (!this.editSurfaceHandle || !this.selectedEdge) return null;
    const surface = this.surfaces.get(this.editSurfaceHandle);
    if (!surface) return null;
    const result = surface.swapInteriorEdge(this.selectedEdge[0], this.selectedEdge[1]);
    if (!result.ok) {
      this.editMessageCb?.(result.message ?? 'edge cannot be swapped');
      return null;
    }
    this.editMessageCb?.(null);
    surface.model.dirty = true;
    surface.model.provenance = 'modified';
    this.requestRender();
    return {
      type: 'swapEdge',
      surfaceId: this.editSurfaceHandle,
      edgeVertices: this.selectedEdge,
      beforeIndices: result.beforeIndices,
      afterIndices: result.afterIndices,
    };
  }

  private currentZoomNormalized(): number {
    if (this.mode === 'top') {
      const minZoom = this.topControls.minZoom || 1e-4;
      const maxZoom = this.topControls.maxZoom || 1e4;
      const zoom = THREE.MathUtils.clamp(this.orthoCamera.zoom, minZoom, maxZoom);
      return (Math.log(zoom) - Math.log(minZoom)) / (Math.log(maxZoom) - Math.log(minZoom));
    }
    const minDistance = Math.max(this.orbitControls.minDistance, 0.01);
    const maxDistance = Math.max(this.orbitControls.maxDistance, minDistance * 1.01);
    const distance = THREE.MathUtils.clamp(
      this.perspCamera.position.distanceTo(this.orbitControls.target),
      minDistance,
      maxDistance,
    );
    return 1 - (Math.log(distance) - Math.log(minDistance)) / (Math.log(maxDistance) - Math.log(minDistance));
  }

  private emitZoomChanged(): void {
    this.zoomCb?.(this.currentZoomNormalized());
  }

  // ── ITEM33: fly-through dolly (orbit mode only) ─────────────────────────

  private static readonly FLY_THRESHOLD = 0.1;
  private static readonly FLY_PUSH = 0.15;

  /** OrbitControls 'change' handler — post-correct target distance if camera
   *  crept too close (belt-and-suspenders: wheel interception is the primary
   *  pre-clamp; this catches any edge case from pan/rotate). */
  private handleOrbitChange = (): void => {
    this.applyFlyThroughDolly();
    this.markCameraMotion();
    this.requestRender();
  };

  /** If camera is within FLY_THRESHOLD of the orbit target, push the target
   *  forward so the camera never sits at or behind it. This enables fly-through
   *  zoom without the old minDistance wall. */
  private applyFlyThroughDolly(): void {
    if (this.mode !== 'orbit' || this.disposed) return;
    const dist = this.perspCamera.position.distanceTo(this.orbitControls.target);
    if (dist >= ViewerEngine.FLY_THRESHOLD) return;
    const forward = this.orbitControls.target.clone().sub(this.perspCamera.position).normalize();
    this.orbitControls.target.addScaledVector(forward, ViewerEngine.FLY_PUSH);
    this.orbitControls.update();
  }

  /** Wheel event handler — fires BEFORE OrbitControls' own listener so we can
   *  stopImmediatePropagation() and take over dolly in orbit mode.
   *  Top mode passes through; hover mode adjusts speed. */
  private handleWheel = (ev: WheelEvent): void => {
    if (this.mode === 'hover') {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const delta = -ev.deltaY * 0.5;
      this.hoverSpeed = Math.max(this.hoverSpeed + delta, 0.1);
      this.hoverSpeedCb?.(this.hoverSpeed);
      return;
    }
    if (this.mode === 'top') return; // topControls owns its own wheel
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const step = this.computeOrbitDollyStep(ev.deltaY);
    this.applyOrbitDolly(step);
  };

  /** Sensitivity-driven per-tick step: blends a constant floor (driven by
   *  zoomSensitivity3D) with a distance-proportional component so zoom is
   *  even at close range but still snappy at long distances.
   *  deltaY < 0 = scroll up = zoom IN. */
  private computeOrbitDollyStep(deltaY: number): number {
    const currentDist = this.perspCamera.position.distanceTo(this.orbitControls.target);
    const proportional = currentDist * 0.05;
    const constant = this.zoomSensitivity3D * 2.0;
    const magnitude = Math.max(constant, proportional);
    return magnitude * (deltaY > 0 ? -1 : 1);
  }

  /** Move camera AND orbit target forward (positive step) or backward along
   *  the current view direction. Preserves spherical coords via update(). */
  private applyOrbitDolly(step: number): void {
    const forward = this.orbitControls.target.clone().sub(this.perspCamera.position).normalize();
    const move = forward.clone().multiplyScalar(step);
    this.perspCamera.position.add(move);
    this.orbitControls.target.add(move);
    this.orbitControls.update();
    this.markCameraMotion();
    this.rememberOrbitView();
    this.emitZoomChanged();
    this.scheduleLabelRefresh();
    this.requestRender();
  }

  private rememberOrbitView(): void {
    const dir = this.orbitControls.target.clone().sub(this.perspCamera.position);
    const len = dir.length();
    if (len > 1e-6) {
      this.lastOrbitDistance = len;
      this.lastOrbitDirection.copy(dir.normalize());
    }
  }

  private currentLookDirectionForOrbit(): THREE.Vector3 {
    if (this.mode === 'hover') {
      const dir = new THREE.Vector3();
      this.perspCamera.getWorldDirection(dir);
      if (dir.lengthSq() > 1e-6) return dir.normalize();
    }
    const dir = this.lastOrbitDirection.clone();
    if (Math.abs(dir.z) > 0.98) dir.set(0.45, -0.65, -0.35);
    return dir.normalize();
  }

  private rebuildOrbitTargetFromCurrentView(): void {
    const dir = this.currentLookDirectionForOrbit();
    const distance = Math.max(this.lastOrbitDistance, this.hoverHeight * 4, 5);
    this.perspCamera.up.set(0, 0, 1);
    this.orbitControls.target.copy(this.perspCamera.position).addScaledVector(dir, distance);
    this.orbitControls.update();
    this.rememberOrbitView();
    this.emitZoomChanged();
  }

  private pickActiveSurfaceAtPointer(): THREE.Intersection | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.activeCamera);
    this.raycaster.firstHitOnly = true;
    const active = this.activeHandle ? this.surfaces.get(this.activeHandle) : undefined;
    const targets = active ? [active] : [...this.surfaces.values()];
    let hit: THREE.Intersection | null = null;
    for (const s of targets) {
      if (!s.pickMesh || !s.group.visible) continue;
      const next = this.raycaster.intersectObject(s.pickMesh, false)[0];
      if (next && (!hit || next.distance < hit.distance)) hit = next;
    }
    return hit;
  }

  private resolveSurfaceZAt(x: number, y: number): number | null {
    const active = this.activeHandle ? this.surfaces.get(this.activeHandle) : undefined;
    const surface = active ?? [...this.surfaces.values()][0];
    if (!surface?.pickMesh) return null;
    this.raycaster.set(
      new THREE.Vector3(x, y, this.sceneRadius * Math.max(this.exaggeration, 1) + 10_000),
      new THREE.Vector3(0, 0, -1),
    );
    this.raycaster.firstHitOnly = true;
    const hit = this.raycaster.intersectObject(surface.pickMesh, false)[0];
    return hit ? hit.point.z / this.exaggeration : null;
  }

  /** Raycast at pointer against surfaces, PDF tiles, then z=0 ground plane.
   *  Returns the world-space intersection or null. */
  pickWorldPointAtPointer(): THREE.Vector3 | null {
    if (this.disposed || !this.pointerInside) return null;
    this.raycaster.setFromCamera(this.pointerNdc, this.activeCamera);
    let best: THREE.Intersection | null = null;
    // surfaces
    const active = this.activeHandle ? this.surfaces.get(this.activeHandle) : undefined;
    const surfTargets = active ? [active] : [...this.surfaces.values()];
    for (const s of surfTargets) {
      if (!s.pickMesh || !s.group.visible) continue;
      const hits = this.raycaster.intersectObject(s.pickMesh, false);
      if (hits.length > 0 && (!best || hits[0]!.distance < best.distance)) best = hits[0]!;
    }
    // PDF tile meshes
    const pdfTargets: THREE.Object3D[] = [];
    for (const pdf of this.pdfs.values()) {
      if (pdf.group.visible) pdfTargets.push(pdf.group);
    }
    if (pdfTargets.length > 0) {
      const pdfHits = this.raycaster.intersectObjects(pdfTargets, true);
      if (pdfHits.length > 0 && (!best || pdfHits[0]!.distance < best.distance)) best = pdfHits[0]!;
    }
    if (best) return best.point.clone();
    // fallback: z=0 ground plane in world space
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const intersection = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(plane, intersection)) return intersection;
    return null;
  }

  // -- Feature authoring wiring (Create Sim) ----------------------------------
  // Thin bridge only: state machine + snap resolution live in authoring.ts /
  // snap.ts; these methods feed pointer/camera state in and snapshots out.

  /** Associates engine point-cloud handles with manifest asset ids so snap evidence can reference them. */
  setSnapSourceAssetIds(assetIdByHandle: Record<string, string>): void {
    this.snapAssetIdByHandle = new Map(Object.entries(assetIdByHandle));
  }

  startFeatureAuthoring(
    family: FeatureFamily,
    templateId: string | null,
    geometryMode?: AuthoringGeometryMode,
  ): AuthoringSnapshot {
    this.authoringMachine.start(family, templateId, geometryMode);
    return this.authoringMachine.snapshot();
  }

  /**
   * Snap-resolves the current pointer and records one draft vertex. Falls back
   * to flagged free placement at the surface/plane hit under the pointer.
   */
  placeFeatureVertexAtPointer(tolerancePx = DEFAULT_SNAP_TOLERANCE_PX): AuthoringSnapshot {
    const freeHit = this.pickWorldPointAtPointer();
    const placement = resolvePlacement(
      {
        pointer: { x: this.pointerPx.x, y: this.pointerPx.y },
        candidates: this.collectSnapCandidates(tolerancePx),
        tolerancePx,
      },
      freeHit ? this.renderToSurvey(freeHit) : null,
    );
    if (placement) this.authoringMachine.place(placement);
    return this.authoringMachine.snapshot();
  }

  requestCloseFeatureAuthoring(): AuthoringSnapshot {
    this.authoringMachine.requestClose();
    return this.authoringMachine.snapshot();
  }

  confirmFeatureAuthoring(): AuthoringSnapshot {
    this.authoringMachine.confirm();
    return this.authoringMachine.snapshot();
  }

  cancelFeatureAuthoring(): AuthoringSnapshot {
    this.authoringMachine.cancel();
    return this.authoringMachine.snapshot();
  }

  getFeatureAuthoringSnapshot(): AuthoringSnapshot {
    return this.authoringMachine.snapshot();
  }

  /**
   * Displays authored features from generator output (display geometry only;
   * regenerated by the caller from stored primitives, never persisted). Also
   * refreshes the authored-vertex/edge snap sources.
   */
  setAuthoredFeatures(entries: FeatureDisplayEntry[]): void {
    if (this.disposed) return;
    if (!this.renderFeatures && entries.length === 0) return;
    // Feature-only projects adopt an origin from the first authored vertex,
    // mirroring how addPointCloud adopts the first dataset origin.
    if (!this.sceneOrigin) {
      const firstVertex = entries.flatMap((entry) => entry.lines).find((line) => line.length > 0)?.[0];
      if (!firstVertex) return;
      this.sceneOrigin = [firstVertex[0], firstVertex[1], firstVertex[2]];
      for (const pdf of this.pdfs.values()) pdf.setOrigin(this.sceneOrigin);
    }
    if (!this.renderFeatures) {
      this.renderFeatures = new RenderFeatures(this.sceneOrigin);
      this.contentGroup.add(this.renderFeatures.group);
    }
    this.renderFeatures.setFeatures(entries);
    this.requestRender();
  }

  /** Draft authoring preview (collected lines + active vertices); null clears it. */
  setAuthoringDraftPreview(draft: { lines: Vec3[][]; activeVertices: Vec3[] } | null): void {
    if (this.disposed) return;
    if (!this.renderFeatures) {
      const firstVertex = draft?.activeVertices[0] ?? draft?.lines.find((line) => line.length > 0)?.[0];
      if (!firstVertex) return;
      if (!this.sceneOrigin) this.sceneOrigin = [firstVertex[0], firstVertex[1], firstVertex[2]];
      this.renderFeatures = new RenderFeatures(this.sceneOrigin);
      this.contentGroup.add(this.renderFeatures.group);
    }
    this.renderFeatures.setDraft(draft);
    this.requestRender();
  }

  /** Sim master toggle: shows/hides all authored features as one group. */
  setAuthoredFeaturesVisible(visible: boolean): void {
    this.renderFeatures?.setVisible(visible);
    this.requestRender();
  }

  /**
   * Snap candidates near the pointer: cloud points from preview clouds and
   * streamed indexes, plus authored-feature vertices/edges once features
   * render. this.analyticSurfels is deliberately absent: surfel display
   * entries are never snap sources (resolveSnap and the manifest schema both
   * back this up).
   */
  private collectSnapCandidates(tolerancePx: number): SnapCandidate[] {
    const out: SnapCandidate[] = [];
    if (this.disposed || !this.pointerInside || !this.sceneOrigin) return out;
    this.raycaster.setFromCamera(this.pointerNdc, this.activeCamera);
    this.raycaster.params.Points.threshold = this.dragWorldUnitsPerPixel() * tolerancePx;
    const targets: { handle: string; object: THREE.Object3D }[] = [];
    for (const [handle, cloud] of this.pointClouds) {
      if (cloud.group.visible) targets.push({ handle, object: cloud.group });
    }
    for (const [handle, streaming] of this.pointCloudIndexes) {
      if (streaming.group.visible) targets.push({ handle, object: streaming.group });
    }
    for (const { handle, object } of targets) {
      const hits = this.raycaster.intersectObject(object, true);
      // Ray-sorted; a handful per source is plenty for a screen-space pick.
      for (const hit of hits.slice(0, 8)) {
        const candidate = this.cloudSnapCandidateFromHit(handle, hit);
        if (candidate) out.push(candidate);
      }
    }
    this.collectAuthoredSnapCandidates(out, tolerancePx);
    return out;
  }

  /** Authored-feature vertex/edge candidates from the rendered feature set. */
  private collectAuthoredSnapCandidates(out: SnapCandidate[], tolerancePx: number): void {
    const snapGeometry = this.renderFeatures?.getSnapGeometry();
    if (!snapGeometry) return;
    const pointer = { x: this.pointerPx.x, y: this.pointerPx.y };
    for (const vertex of snapGeometry.vertices) {
      const screen = this.surveyToScreen(vertex.world);
      if (!screen) continue;
      if (Math.abs(screen.x - pointer.x) > tolerancePx * 2 || Math.abs(screen.y - pointer.y) > tolerancePx * 2) continue;
      out.push({ sourceKind: 'authored-vertex', world: vertex.world, screen, featureId: vertex.featureId });
    }
    for (const edge of snapGeometry.edges) {
      const screenA = this.surveyToScreen(edge.a);
      const screenB = this.surveyToScreen(edge.b);
      if (!screenA || !screenB) continue;
      const closest = closestPointOnScreenSegment(pointer, screenA, screenB);
      if (Math.abs(closest.x - pointer.x) > tolerancePx * 2 || Math.abs(closest.y - pointer.y) > tolerancePx * 2) continue;
      out.push({
        sourceKind: 'authored-edge',
        world: [
          edge.a[0] + (edge.b[0] - edge.a[0]) * closest.t,
          edge.a[1] + (edge.b[1] - edge.a[1]) * closest.t,
          edge.a[2] + (edge.b[2] - edge.a[2]) * closest.t,
        ],
        screen: { x: closest.x, y: closest.y },
        featureId: edge.featureId,
      });
    }
  }

  /** Projects a survey coordinate to viewport pixels; null when behind the camera. */
  private surveyToScreen(world: Vec3): { x: number; y: number } | null {
    const [ox, oy, oz] = this.sceneOrigin ?? [0, 0, 0];
    const projected = new THREE.Vector3(
      world[0] - ox,
      world[1] - oy,
      (world[2] - oz) * this.exaggeration,
    ).project(this.activeCamera);
    if (projected.z > 1) return null;
    return {
      x: (projected.x * 0.5 + 0.5) * this.container.clientWidth,
      y: (1 - (projected.y * 0.5 + 0.5)) * this.container.clientHeight,
    };
  }

  /** Reads the actual snapped VERTEX (not the ray point) and projects it to pixels. */
  private cloudSnapCandidateFromHit(handle: string, hit: THREE.Intersection): SnapCandidate | null {
    if (hit.index === undefined || !(hit.object instanceof THREE.Points)) return null;
    const positions = hit.object.geometry.getAttribute('position');
    if (!positions || hit.index >= positions.count) return null;
    const vertex = new THREE.Vector3().fromBufferAttribute(positions, hit.index).applyMatrix4(hit.object.matrixWorld);
    const projected = vertex.clone().project(this.activeCamera);
    const assetId = this.snapAssetIdByHandle.get(handle);
    return {
      sourceKind: 'cloud-point',
      world: this.renderToSurvey(vertex),
      screen: {
        x: (projected.x * 0.5 + 0.5) * this.container.clientWidth,
        y: (1 - (projected.y * 0.5 + 0.5)) * this.container.clientHeight,
      },
      ...(assetId ? { assetId } : {}),
    };
  }

  /** Rebased render coords back to survey coords; same convention as the cursor readout. */
  private renderToSurvey(point: THREE.Vector3): Vec3 {
    const [ox, oy, oz] = this.sceneOrigin ?? [0, 0, 0];
    return [point.x + ox, point.y + oy, point.z / this.exaggeration + oz];
  }

  private applyHoverLook(): void {
    const forward = new THREE.Vector3(
      Math.sin(this.hoverYaw) * Math.cos(this.hoverPitch),
      Math.cos(this.hoverYaw) * Math.cos(this.hoverPitch),
      Math.sin(this.hoverPitch),
    ).normalize();
    this.perspCamera.up.set(0, 0, 1);
    this.perspCamera.lookAt(this.perspCamera.position.clone().add(forward));
  }

  private snapHoverCameraToSurface(): void {
    const z = this.resolveHoverGroundZAt(this.perspCamera.position.x, this.perspCamera.position.y) ?? this.hoverGroundZ;
    if (z === null) return;
    this.hoverGroundZ = z;
    this.perspCamera.position.z = (z + this.hoverHeight) * this.exaggeration;
    this.applyHoverLook();
    this.scheduleLabelRefresh();
    this.requestRender();
  }

  private stepHover(dtMs: number): boolean {
    if (this.mode !== 'hover' || this.hoverKeys.size === 0) return false;
    const forward = new THREE.Vector3(Math.sin(this.hoverYaw), Math.cos(this.hoverYaw), 0);
    const right = new THREE.Vector3(forward.y, -forward.x, 0);
    const delta = new THREE.Vector3();
    if (this.hoverKeys.has('KeyW')) delta.add(forward);
    if (this.hoverKeys.has('KeyS')) delta.sub(forward);
    if (this.hoverKeys.has('KeyD')) delta.add(right);
    if (this.hoverKeys.has('KeyA')) delta.sub(right);
    if (delta.lengthSq() === 0) return false;
    delta.normalize().multiplyScalar(this.hoverSpeed * (dtMs / 1000));
    const nextX = this.perspCamera.position.x + delta.x;
    const nextY = this.perspCamera.position.y + delta.y;
    const z = this.resolveHoverGroundZAt(nextX, nextY);
    if (z === null) return false;
    this.perspCamera.position.x = nextX;
    this.perspCamera.position.y = nextY;
    this.hoverGroundZ = z;
    this.perspCamera.position.z = (z + this.hoverHeight) * this.exaggeration;
    this.applyHoverLook();
    this.markCameraMotion();
    return true;
  }

  private resolveHoverGroundZAt(x: number, y: number): number | null {
    if (this.hoverPointCloudIndexHandle) {
      return this.resolvePointCloudGroundZAt(this.hoverPointCloudIndexHandle, x, y);
    }
    return this.resolveSurfaceZAt(x, y);
  }

  private resolvePointCloudGroundZAt(handle: string, x: number, y: number): number | null {
    const streaming = this.pointCloudIndexes.get(handle);
    if (!streaming) return null;
    return streaming.estimateGroundZ(x, y, streaming.walkGroundRadius(), 0.1, 12)?.z ?? null;
  }

  private updateHoverGroundFollow(dtMs: number): boolean {
    if (this.mode !== 'hover') return false;
    const nextGround = this.resolveHoverGroundZAt(this.perspCamera.position.x, this.perspCamera.position.y);
    const smoothed = smoothGroundZ(this.hoverGroundZ, nextGround, dtMs);
    if (smoothed === null) return false;
    const nextCameraZ = (smoothed + this.hoverHeight) * this.exaggeration;
    const changed = this.hoverGroundZ === null || Math.abs(smoothed - this.hoverGroundZ) > 1e-3 || Math.abs(this.perspCamera.position.z - nextCameraZ) > 1e-3;
    this.hoverGroundZ = smoothed;
    if (!changed) return false;
    this.perspCamera.position.z = nextCameraZ;
    this.applyHoverLook();
    this.markCameraMotion();
    this.scheduleLabelRefresh();
    return true;
  }


  // ── internals ───────────────────────────────────────────────────────────

  private contentBounds(): THREE.Box3 | null {
    const bounds = new THREE.Box3();
    for (const s of this.surfaces.values()) {
      if (s.group.visible) bounds.union(s.bounds);
    }
    for (const d of this.dxfs.values()) {
      if (d.group.visible) bounds.union(d.bounds);
    }
    for (const g of this.geotiffs.values()) {
      if (g.group.visible) bounds.union(g.bounds);
    }
    for (const p of this.pdfs.values()) {
      if (p.group.visible) bounds.union(p.bounds);
    }
    for (const p of this.pointClouds.values()) {
      if (p.group.visible) bounds.union(p.bounds);
    }
    for (const p of this.pointCloudIndexes.values()) {
      if (p.group.visible) bounds.union(p.bounds);
    }
    for (const s of this.analyticSurfels.values()) {
      if (s.group.visible) bounds.union(s.bounds);
    }
    if (bounds.isEmpty()) return null;
    // contentGroup carries the exaggeration matrix — scale Z for framing math.
    bounds.min.z *= this.exaggeration;
    bounds.max.z *= this.exaggeration;
    return bounds;
  }

  private updateSceneMetrics(): void {
    const bounds = this.contentBounds();
    this.sceneRadius = bounds ? bounds.getSize(new THREE.Vector3()).length() / 2 : 0;
    if (this.sceneRadius > 0) {
      this.orbitControls.maxDistance = this.sceneRadius * 12;
      this.topControls.minZoom = 1e-4;
      this.topControls.maxZoom = 1e4;
    }
    if (this.fogEnabled) {
      this.scene.fog = this.sceneRadius > 0 ? new THREE.FogExp2(0x0c1420, 0.00018) : null;
    }
  }

  /** Dynamic near/far from scene bounds + camera distance (close-zoom fix, 07 Phase 2):
   *  near shrinks as you approach so a single triangle survives the depth buffer; far grows
   *  so full extents never clip. Updated only on meaningful change (no matrix churn). */
  private updateClipPlanes(): void {
    if (this.sceneRadius <= 0) return;
    const dist =
      this.mode === 'hover'
        ? Math.max(this.hoverHeight * 4, 5)
        : this.perspCamera.position.distanceTo(this.orbitControls.target);
    const near = THREE.MathUtils.clamp(dist / 500, 0.01, this.sceneRadius / 50 || 10);
    const far = Math.max(this.sceneRadius * 8, dist * 6);
    if (
      Math.abs(near - this.perspCamera.near) / this.perspCamera.near > 0.25 ||
      Math.abs(far - this.perspCamera.far) / this.perspCamera.far > 0.25
    ) {
      this.perspCamera.near = near;
      this.perspCamera.far = far;
      this.perspCamera.updateProjectionMatrix();
    }
  }

  private setOrthoFrustum(halfH: number): void {
    const aspect = this.container.clientWidth / Math.max(this.container.clientHeight, 1);
    this.orthoCamera.left = -halfH * aspect;
    this.orthoCamera.right = halfH * aspect;
    this.orthoCamera.top = halfH;
    this.orthoCamera.bottom = -halfH;
    this.orthoCamera.updateProjectionMatrix();
  }

  private handleResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.sceneTarget.setSize(w, h);
    this.postQuad.material.uniforms['resolution'].value.set(w, h);
    this.perspCamera.aspect = w / h;
    this.perspCamera.updateProjectionMatrix();
    this.setOrthoFrustum(this.orthoCamera.top);
    this.requestRender();
  }

  private handleControlsStart = (): void => {
    this.controlsActive = true;
  };

  private handleControlsEnd = (): void => {
    this.controlsActive = false;
    if (this.mode === 'orbit') this.rememberOrbitView();
    // One pick when the camera settles (lag triage: no hover raycasts mid-interaction),
    // and a debounced label refresh (Phase 6: labels update when the camera rests).
    this.pointerDirty = true;
    this.requestPick();
    this.scheduleLabelRefresh();
  };

  private handleKeyDown = (ev: KeyboardEvent): void => {
    if (this.mode !== 'hover') return;
    if (ev.code === 'KeyX') {
      ev.preventDefault();
      this.exitHoverCb?.();
      return;
    }
    if (ev.code === 'KeyQ') {
      ev.preventDefault();
      this.hoverHeight -= 1.0;
      this.hoverHeightCb?.(this.hoverHeight);
      this.snapHoverCameraToSurface();
      return;
    }
    if (ev.code === 'KeyE') {
      ev.preventDefault();
      this.hoverHeight += 1.0;
      this.hoverHeightCb?.(this.hoverHeight);
      this.snapHoverCameraToSurface();
      return;
    }
    if (!['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(ev.code)) return;
    ev.preventDefault();
    this.hoverKeys.add(ev.code);
    this.scheduleFrame();
  };

  private handleKeyUp = (ev: KeyboardEvent): void => {
    if (this.mode !== 'hover') return;
    this.hoverKeys.delete(ev.code);
  };

  private handlePointerMove = (ev: PointerEvent): void => {
    if (this.mode === 'hover' && this.hoverLookDragging && this.pointerButtonsDown) {
      this.hoverYaw -= ev.movementX * 0.0024;
      this.hoverPitch = THREE.MathUtils.clamp(this.hoverPitch - ev.movementY * 0.0018, -1.35, 1.35);
      this.applyHoverLook();
      this.markCameraMotion();
      this.requestRender();
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerPx.set(ev.clientX - rect.left, ev.clientY - rect.top);
    this.pointerNdc.set(
      (this.pointerPx.x / rect.width) * 2 - 1,
      -(this.pointerPx.y / rect.height) * 2 + 1,
    );
    this.pointerInside = true;
    this.pointerDirty = true;
    this.updateDraggedVertex(ev.clientX, ev.clientY);
    // Lag triage (07 Phase 2): hover schedules a PICK-ONLY frame — it does NOT trigger a
    // scene re-render (the old code re-rendered the full scene on every pointermove).
    this.requestPick();
  };

  private handlePointerLeave = (): void => {
    this.pointerInside = false;
    this.hoverLookDragging = false;
    this.cursorCb?.(null);
    if (this.editSurfaceHandle) this.setHoveredVertex(null);
  };

  private handlePointerDown = (ev: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerPx.set(ev.clientX - rect.left, ev.clientY - rect.top);
    this.pointerNdc.set(
      (this.pointerPx.x / rect.width) * 2 - 1,
      -(this.pointerPx.y / rect.height) * 2 + 1,
    );
    this.pointerInside = true;
    this.pointerButtonsDown = true;
    this.downPos = { x: ev.clientX, y: ev.clientY };
    if (this.mode === 'hover' && ev.button === 0) this.hoverLookDragging = true;
    if (
      this.editTool === 'editPoint' &&
      this.editSurfaceHandle &&
      this.selectedVertexId !== null &&
      this.hoverVertexId === this.selectedVertexId
    ) {
      this.beginSelectedVertexDrag(ev.clientY);
    }
  };

  private handlePointerUp = (ev: PointerEvent): void => {
    const wasDragging = this.draggingVertex;
    this.pointerButtonsDown = false;
    this.hoverLookDragging = false;
    const wasClick =
      this.downPos &&
      Math.abs(ev.clientX - this.downPos.x) < 5 &&
      Math.abs(ev.clientY - this.downPos.y) < 5;
    this.downPos = null;
    if (wasClick && this.hitTestGizmoNorth(ev)) {
      this.northClickCb?.();
      return;
    }
    if (wasDragging) {
      const command = this.finishDraggedVertexCommit();
      this.pointerDirty = true;
      this.requestPick();
      if (command) this.editCommitCb?.(command);
      return;
    }
    this.draggingVertex = false;
    this.editDragCb?.(false);
    this.dragStartXYZ = null;
    if (wasClick && this.editSurfaceHandle) {
      if (this.editTool === 'swapEdge') {
        const edge = this.pickNearestEdge();
        if (!edge) {
          this.editMessageCb?.('pick an interior edge to swap');
        } else {
          this.selectedEdge = edge;
          const command = this.swapSelectedEdge();
          if (command) this.editCommitCb?.(command);
        }
      } else if (this.hoverVertexId !== null) {
        this.selectedVertexId = this.hoverVertexId;
        this.surfaces.get(this.editSurfaceHandle)?.setSelectedVertex(this.selectedVertexId);
        this.emitEditSelection();
        this.requestRender();
      }
    }
    this.pointerDirty = true;
    this.requestPick();
  };

  /** True when a click lands on the gizmo's N marker (corner viewport coordinates). */
  private hitTestGizmoNorth(ev: PointerEvent): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const boxLeft = rect.width - GIZMO_MARGIN - GIZMO_SIZE;
    const boxTop = rect.height - GIZMO_MARGIN - GIZMO_SIZE;
    const gx = ev.clientX - rect.left - boxLeft;
    const gy = ev.clientY - rect.top - boxTop;
    if (gx < 0 || gy < 0 || gx > GIZMO_SIZE || gy > GIZMO_SIZE) return false;
    const n = projectGizmoNorth(this.gizmoGroup, this.gizmoCamera);
    const nx = (n.x * 0.5 + 0.5) * GIZMO_SIZE;
    const ny = (1 - (n.y * 0.5 + 0.5)) * GIZMO_SIZE;
    return Math.hypot(gx - nx, gy - ny) < 16;
  }

  private requestRender = (): void => {
    this.renderRequested = true;
    this.scheduleFrame();
  };

  private requestPick = (): void => {
    this.pickRequested = true;
    this.scheduleFrame();
  };

  private scheduleFrame(): void {
    if (this.frameScheduled || this.disposed) return;
    this.frameScheduled = true;
    requestAnimationFrame(this.renderFrame);
  }

  private renderFrame = (time: number): void => {
    this.frameScheduled = false;
    if (this.disposed) return;
    if (this.lastCameraMotionAt === 0) this.lastCameraMotionAt = time;
    const dt = this.lastFrameTime > 0 ? time - this.lastFrameTime : 16;
    this.lastFrameTime = time;
    if (this.stepHover(dt)) this.renderRequested = true;
    if (this.updateHoverGroundFollow(dt)) this.renderRequested = true;
    const doRender = this.renderRequested;
    const doPick = this.pickRequested;
    this.renderRequested = false;
    this.pickRequested = false;

    // Hover raycast: at most once per rAF, skipped entirely while the camera is moving
    // or a button is down (07 Phase 2 lag triage).
    if (doPick && this.pointerDirty && !this.controlsActive && (!this.pointerButtonsDown || this.editSurfaceHandle !== null)) {
      this.pointerDirty = false;
      if (this.pointerInside) this.updateCursorReadout();
    }

    const cameraSettled =
      !this.controlsActive &&
      !(this.mode === 'hover' && (this.hoverKeys.size > 0 || this.hoverLookDragging)) &&
      time - this.lastCameraMotionAt >= 260;
    let geotiffChanged = false;
    for (const geotiff of this.geotiffs.values()) {
      if (geotiff.updateVisible(this.activeCamera, this.exaggeration, cameraSettled, this.mode === 'hover')) {
        geotiffChanged = true;
      }
    }
    if (geotiffChanged) {
      this.updateSceneMetrics();
      this.renderRequested = true;
    }
    let pdfChanged = false;
    for (const pdf of this.pdfs.values()) {
      if (pdf.updateVisible(this.activeCamera, this.exaggeration)) pdfChanged = true;
    }
    if (pdfChanged) {
      this.updateSceneMetrics();
      this.renderRequested = true;
    }
    let pointCloudChanged = false;
    for (const pointCloud of this.pointClouds.values()) {
      if (pointCloud.updateVisible(this.activeCamera, this.exaggeration, cameraSettled)) pointCloudChanged = true;
    }
    if (pointCloudChanged) this.renderRequested = true;

    if (this.pointCloudIndexes.size > 0) {
      const viewportHeightPx = this.renderer.domElement.clientHeight || this.renderer.domElement.height || 1;
      const fovY =
        this.activeCamera instanceof THREE.PerspectiveCamera
          ? THREE.MathUtils.degToRad(this.activeCamera.fov)
          : Math.PI / 3;
          if (this.analyticSurfels.size > 0) {
            const viewportHeightPx = this.renderer.domElement.clientHeight || this.renderer.domElement.height || 1;
            const fovY =
              this.activeCamera instanceof THREE.PerspectiveCamera
                ? THREE.MathUtils.degToRad(this.activeCamera.fov)
                : Math.PI / 3;
            let surfelChanged = false;
            for (const surfels of this.analyticSurfels.values()) {
              if (surfels.update(this.activeCamera, viewportHeightPx, fovY)) surfelChanged = true;
            }
            if (surfelChanged) this.renderRequested = true;
          }
      let indexChanged = false;
      for (const streaming of this.pointCloudIndexes.values()) {
        if (streaming.update(this.activeCamera, viewportHeightPx, fovY)) indexChanged = true;
      }
      if (indexChanged) this.renderRequested = true;
    }
    if (cameraSettled && this.pointCloudSettleCb) {
      for (const [handle, pointCloud] of this.pointClouds) {
        const nodeIds = pointCloud.nearestLeafNodeIds(this.activeCamera, this.exaggeration, 2);
        const key = `${handle}:${nodeIds.join(',')}`;
        if (nodeIds.length > 0 && key !== this.lastPointCloudSettleKey) {
          this.lastPointCloudSettleKey = key;
          this.pointCloudSettleCb({ handle, nodeIds });
        }
      }
    }

    if (doRender) {
      this.updateClipPlanes();
      this.renderScene();
      this.renderGizmo();
      this.emitZoomChanged();

      if (this.statsCb) {
        // Only meaningful for consecutive frames (render-on-demand goes idle otherwise).
        if (dt > 0 && dt < 250) this.statsCb(1000 / dt);
      }
    }
    if (this.mode === 'hover' && this.hoverKeys.size > 0) this.scheduleFrame();
  };

  private markCameraMotion(): void {
    this.lastCameraMotionAt = performance.now();
  }

  private renderScene(): void {
    if (!this.edlEnabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.activeCamera);
      return;
    }
    this.postQuad.material.uniforms['cameraNear'].value = (this.activeCamera as THREE.PerspectiveCamera).near;
    this.postQuad.material.uniforms['cameraFar'].value = (this.activeCamera as THREE.PerspectiveCamera).far;
this.postQuad.material.uniforms['edlOrtho'].value = this.activeCamera instanceof THREE.OrthographicCamera ? 1 : 0;
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.activeCamera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCamera);
  }

  /** Corner north gizmo: overlay pass in its own viewport — live-rotates with the camera. */
  private renderGizmo(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w < GIZMO_SIZE * 2 || h < GIZMO_SIZE * 2) return;

    // World→view rotation: counter-rotate the gizmo by the camera quaternion.
    const q = new THREE.Quaternion();
    (this.activeCamera as THREE.PerspectiveCamera).getWorldQuaternion(q);
    this.gizmoGroup.quaternion.copy(q.invert());

    const x = w - GIZMO_MARGIN - GIZMO_SIZE;
    const y = GIZMO_MARGIN; // GL viewport origin = bottom-left
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(x, y, GIZMO_SIZE, GIZMO_SIZE);
    this.renderer.setScissor(x, y, GIZMO_SIZE, GIZMO_SIZE);
    this.renderer.render(this.gizmoScene, this.gizmoCamera);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.autoClear = true;
  }

  private updateDraggedVertex(clientX: number, clientY: number): void {
    if (
      !this.draggingVertex ||
      this.editTool !== 'editPoint' ||
      !this.editSurfaceHandle ||
      this.selectedVertexId === null ||
      !this.dragStartXYZ
    ) {
      return;
    }
    const surface = this.surfaces.get(this.editSurfaceHandle);
    if (!surface) return;
    const next = this.dragMoveTarget(clientX, clientY);
    const result = surface.applyVertexMove(this.selectedVertexId, next, true);
    if (result.blocked) {
      this.editMessageCb?.("can't cross triangle boundary here");
      return;
    }
    if (!result.changed) return;
    this.editMessageCb?.(null);
    this.emitEditSelection();
    this.scheduleLabelRefresh();
    this.requestRender();
  }

  private finishDraggedVertexCommit(): VertexEditCommand | null {
    if (
      !this.draggingVertex ||
      this.editTool !== 'editPoint' ||
      !this.editSurfaceHandle ||
      this.selectedVertexId === null ||
      !this.dragStartXYZ
    ) {
      this.draggingVertex = false;
      this.editDragCb?.(false);
      this.dragStartXYZ = null;
      return null;
    }
    const surface = this.surfaces.get(this.editSurfaceHandle);
    const oldXYZ = this.dragStartXYZ;
    const nextXYZ = surface?.sourceXYZ(this.selectedVertexId) ?? oldXYZ;
    this.draggingVertex = false;
    this.editDragCb?.(false);
    this.dragStartXYZ = null;
    if (
      !surface ||
      (nextXYZ[0] === oldXYZ[0] && nextXYZ[1] === oldXYZ[1] && nextXYZ[2] === oldXYZ[2])
    ) {
      return null;
    }
    surface.model.dirty = true;
    surface.model.provenance = 'modified';
    return {
      type: 'moveVertex',
      surfaceId: this.editSurfaceHandle,
      sourcePointId: surface.sourcePointId(this.selectedVertexId),
      vertexId: this.selectedVertexId,
      oldXYZ,
      newXYZ: nextXYZ,
    };
  }

  /** Debounced (camera-at-rest) label pool refresh across all surfaces (07 Phase 6). */
  private scheduleLabelRefresh(): void {
    if (this.disposed) return;
    if (this.labelRefreshTimer !== null) clearTimeout(this.labelRefreshTimer);
    this.labelRefreshTimer = setTimeout(() => {
      this.labelRefreshTimer = null;
      if (this.disposed) return;
      let pausedNote: string | null = null;
      const camera = this.activeCamera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
      camera.updateMatrixWorld();
      // Distance cull radius: a multiple of the camera→target distance in orbit mode;
      // in top mode the ortho frustum already bounds the candidate set laterally.
      const controls = this.mode === 'top' ? this.topControls : this.orbitControls;
      const targetDist = camera.position.distanceTo(controls.target);
      const maxDist = this.mode === 'top' ? Number.POSITIVE_INFINITY : targetDist * 2.5;
      for (const s of this.surfaces.values()) {
        const status = s.refreshLabels(camera, this.exaggeration, maxDist);
        // Lazily created label groups parent at the UNSCALED scene root (text must not
        // inherit the exaggeration matrix).
        if (s.labelGroup && !s.labelGroup.parent) this.scene.add(s.labelGroup);
        if (status === 'paused') pausedNote = 'Labels paused — too many vertices in view';
      }
      this.labelStatusCb?.(pausedNote);
      this.requestRender();
    }, 120);
  }

  private updateCursorReadout(): void {
    if (!this.cursorCb || !this.sceneOrigin) return;
    this.raycaster.setFromCamera(this.pointerNdc, this.activeCamera);
    this.raycaster.firstHitOnly = true; // three-mesh-bvh fast path
    if (this.editSurfaceHandle) {
      this.updateEditHover();
    }
    let hit: THREE.Intersection | null = null;
    const active = this.activeHandle ? this.surfaces.get(this.activeHandle) : undefined;
    const targets = active ? [active] : [...this.surfaces.values()]; // active surface drives the readout (C3)
    for (const s of targets) {
      if (!s.pickMesh || !s.group.visible) continue;
      const hits = this.raycaster.intersectObject(s.pickMesh, false);
      const h = hits[0];
      if (h && (!hit || h.distance < hit.distance)) hit = h;
    }
    if (!hit) {
      this.cursorCb(null);
      return;
    }
    // Convert rebased render coords back to ORIGINAL survey coords (Float64 origin + local).
    // Z divides out the exaggeration matrix first — readout shows TRUE elevation (07 Phase 2).
    const [ox, oy, oz] = this.sceneOrigin;
    this.cursorCb({
      e: hit.point.x + ox,
      n: hit.point.y + oy,
      z: hit.point.z / this.exaggeration + oz,
    });
  }

  private updateEditHover(): void {
    const surface = this.editSurfaceHandle ? this.surfaces.get(this.editSurfaceHandle) ?? null : null;
    if (!surface?.pickMesh || !surface.vertexPickObject) {
      this.setHoveredVertex(null);
      return;
    }
    const faceHit = this.raycaster.intersectObject(surface.pickMesh, false)[0];
    if (!faceHit) {
      this.setHoveredVertex(null);
      return;
    }
    const camera = this.activeCamera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const tolerance =
      worldUnitsPerPixel({
        projection: this.mode === 'top' ? 'orthographic' : 'perspective',
        viewportHeightPx: this.container.clientHeight,
        distanceToPoint: faceHit.distance,
        fovDeg: camera instanceof THREE.PerspectiveCamera ? camera.fov : undefined,
        orthoSpan:
          camera instanceof THREE.OrthographicCamera
            ? (camera.top - camera.bottom) / camera.zoom
            : undefined,
        exaggeration: this.exaggeration,
      }) * 14;
    this.raycaster.params.Points.threshold = tolerance;
    const hits = this.raycaster.intersectObject(surface.vertexPickObject, false);
    const candidates = hits
      .filter((hit) => hit.index !== undefined)
      .map((hit) => {
        const point = hit.point.clone().project(camera);
        return {
          id: hit.index!,
          x: (point.x * 0.5 + 0.5) * this.container.clientWidth,
          y: (1 - (point.y * 0.5 + 0.5)) * this.container.clientHeight,
        };
      });
    this.setHoveredVertex(
      pickClosestScreenPoint(
        { x: this.pointerPx.x, y: this.pointerPx.y },
        candidates,
        14,
      ),
    );
  }

  private setHoveredVertex(vertexId: number | null): void {
    if (this.hoverVertexId === vertexId) return;
    this.hoverVertexId = vertexId;
    const surface = this.editSurfaceHandle ? this.surfaces.get(this.editSurfaceHandle) : null;
    surface?.setHoverVertex(vertexId);
    this.requestRender();
  }

  private emitEditSelection(): void {
    if (!this.editSelectionCb || !this.editSurfaceHandle || this.selectedVertexId === null) {
      this.editSelectionCb?.(null);
      return;
    }
    const surface = this.surfaces.get(this.editSurfaceHandle);
    if (!surface) {
      this.editSelectionCb(null);
      return;
    }
    const [e, n, z] = surface.sourceXYZ(this.selectedVertexId);
    this.editSelectionCb({
      surfaceHandle: this.editSurfaceHandle,
      vertexId: this.selectedVertexId,
      sourcePointId: surface.sourcePointId(this.selectedVertexId),
      e,
      n,
      z,
      precisionHint: surface.model.precisionHint,
    });
  }

  private dragWorldUnitsPerPixel(): number {
    const camera = this.activeCamera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    return worldUnitsPerPixel({
      projection: this.mode === 'top' ? 'orthographic' : 'perspective',
      viewportHeightPx: this.container.clientHeight,
      distanceToPoint:
        this.mode === 'top'
          ? camera.position.distanceTo(this.topControls.target)
          : camera.position.distanceTo(this.orbitControls.target),
      fovDeg: camera instanceof THREE.PerspectiveCamera ? camera.fov : undefined,
      orthoSpan:
        camera instanceof THREE.OrthographicCamera ? (camera.top - camera.bottom) / camera.zoom : undefined,
      exaggeration: this.exaggeration,
    });
  }

  private dragMoveTarget(clientX: number, clientY: number): [number, number, number] {
    const [startE, startN, startZ] = this.dragStartXYZ!;
    const units = this.dragWorldUnitsPerPixel();
    const dx = clientX - (this.downPos?.x ?? clientX);
    const dy = clientY - (this.downPos?.y ?? clientY);
    const camera = this.activeCamera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    right.z = 0;
    up.z = 0;
    if (right.lengthSq() === 0) right.set(1, 0, 0);
    if (up.lengthSq() === 0) up.set(0, 1, 0);
    right.normalize();
    up.normalize();
    const planar = right.multiplyScalar(dx * units).add(up.multiplyScalar(-dy * units));
    const nextZ = startZ + (this.dragStartPointerY - clientY) * units * 0.5;
    return [startE + planar.x, startN + planar.y, nextZ];
  }

  private pickNearestEdge(): [number, number] | null {
    if (!this.editSurfaceHandle) return null;
    const surface = this.surfaces.get(this.editSurfaceHandle);
    if (!surface?.pickMesh) return null;
    const hit = this.raycaster.intersectObject(surface.pickMesh, false)[0];
    if (!hit?.face) return null;
    const point = hit.point;
    const candidates: [number, number][] = [
      [hit.face.a, hit.face.b],
      [hit.face.b, hit.face.c],
      [hit.face.c, hit.face.a],
    ];
    let winner: [number, number] | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const [a, b] of candidates) {
      const [ax, ay, az] = surface.localXYZ(a);
      const [bx, by, bz] = surface.localXYZ(b);
      const dist = point.distanceTo(new THREE.Line3(
        new THREE.Vector3(ax, ay, az * this.exaggeration),
        new THREE.Vector3(bx, by, bz * this.exaggeration),
      ).closestPointToPoint(point, true, new THREE.Vector3()));
      if (dist < best) {
        best = dist;
        winner = [a, b];
      }
    }
    return winner;
  }

  private applySwapEdgeCommand(command: VertexEditCommand): boolean {
    if (command.type !== 'swapEdge' || !command.edgeVertices) return false;
    const surface = this.surfaces.get(command.surfaceId);
    if (!surface) return false;
    const result = surface.swapInteriorEdge(command.edgeVertices[0], command.edgeVertices[1]);
    if (!result.ok) return false;
    this.requestRender();
    return true;
  }
}
