// src/ui/objectPreview.ts - live 3D object preview for the detail panel: the
// actual parametric object (same generator output the main viewer renders),
// its origin, its selected evidence refs, and the optional isolate footprint
// in a mini orbitable Three.js scene. Owned by the right panel mount, which
// re-parents the persistent canvas across innerHTML re-renders so the WebGL
// context and orbit pose survive.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { getTemplate } from '../shared/template-catalog'
import type { FeatureRecord } from '../shared/workbench-types'
import type { Vec3 } from '../viewer/geometry'
import { buildObjectDisplay, isolateBoundaryFromFeature } from '../viewer/generators'

const PREVIEW_WIDTH = 280
const PREVIEW_HEIGHT = 210
const EVIDENCE_COLOR = 0x53c7ff
const ORIGIN_COLOR = 0xffc857
const ISOLATE_COLOR = 0x8ab4ff

export interface ObjectPreview3d {
  readonly element: HTMLElement
  /** Rebuilds scene content from the feature record; keeps the orbit pose. */
  update(feature: FeatureRecord): void
  dispose(): void
}

function objectPreviewColor(feature: FeatureRecord): number {
  const template = feature.templateId ? getTemplate(feature.templateId) : null
  if (template?.objectCategory === 'foliage') return 0x6ea05a
  if (template?.objectCategory === 'site-fixture') return 0xa0aab8
  return 0x7ea4c6
}

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every((axis) => typeof axis === 'number')
}

/**
 * Creates the mini preview scene. All content is positioned relative to the
 * object's origin point so the origin marker sits at (0,0,0) and evidence
 * disagreement reads as literal distance from the object body.
 */
export function createObjectPreview3d(): ObjectPreview3d {
  const element = document.createElement('div')
  element.className = 'object-preview-3d'

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(PREVIEW_WIDTH, PREVIEW_HEIGHT)
  element.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.add(new THREE.AmbientLight(0xffffff, 0.75))
  const sun = new THREE.DirectionalLight(0xffffff, 1.1)
  sun.position.set(3, -2, 5)
  scene.add(sun)

  // Z-up to match the main viewer's survey convention.
  const camera = new THREE.PerspectiveCamera(45, PREVIEW_WIDTH / PREVIEW_HEIGHT, 0.01, 5000)
  camera.up.set(0, 0, 1)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = false
  controls.enablePan = false

  const contentRoot = new THREE.Group()
  scene.add(contentRoot)

  let framed = false
  const renderFrame = (): void => {
    renderer.render(scene, camera)
  }
  controls.addEventListener('change', renderFrame)

  function clearContent(): void {
    for (const child of [...contentRoot.children]) {
      child.removeFromParent()
      const mesh = child as Partial<THREE.Mesh>
      if (mesh.geometry) mesh.geometry.dispose()
      const material = mesh.material
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
      else if (material) material.dispose()
    }
  }

  function update(feature: FeatureRecord): void {
    clearContent()
    const display = buildObjectDisplay(feature)
    const geometry = feature.geometry as { point?: unknown }
    const origin = isVec3(geometry.point) ? geometry.point : null
    if (!display || !origin) {
      renderFrame()
      return
    }
    const rebase = ([x, y, z]: Vec3): Vec3 => [x - origin[0], y - origin[1], z - origin[2]]
    const bounds = new THREE.Box3()
    bounds.expandByPoint(new THREE.Vector3(0, 0, 0))

    if (display.fill && display.fill.indices.length > 0) {
      const fillGeometry = new THREE.BufferGeometry()
      const positions = new Float32Array(display.fill.positions.length)
      for (let i = 0; i < display.fill.positions.length; i += 3) {
        positions[i] = display.fill.positions[i]! - origin[0]
        positions[i + 1] = display.fill.positions[i + 1]! - origin[1]
        positions[i + 2] = display.fill.positions[i + 2]! - origin[2]
      }
      fillGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      fillGeometry.setIndex(new THREE.BufferAttribute(display.fill.indices.slice(), 1))
      fillGeometry.computeVertexNormals()
      const mesh = new THREE.Mesh(
        fillGeometry,
        new THREE.MeshLambertMaterial({ color: objectPreviewColor(feature), side: THREE.DoubleSide }),
      )
      contentRoot.add(mesh)
      bounds.expandByObject(mesh)
    }
    for (const line of display.lines) {
      if (line.length < 2) continue
      const points = line.map(rebase).map(([x, y, z]) => new THREE.Vector3(x, y, z))
      const lineGeometry = new THREE.BufferGeometry().setFromPoints(points)
      contentRoot.add(new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color: 0x1c2733 })))
      for (const point of points) bounds.expandByPoint(point)
    }

    const isolate = isolateBoundaryFromFeature(feature)
    if (isolate) {
      const loop = [...isolate, isolate[0]!].map(rebase).map(([x, y, z]) => new THREE.Vector3(x, y, z))
      const loopGeometry = new THREE.BufferGeometry().setFromPoints(loop)
      contentRoot.add(
        new THREE.Line(loopGeometry, new THREE.LineBasicMaterial({ color: ISOLATE_COLOR, transparent: true, opacity: 0.8 })),
      )
      for (const point of loop) bounds.expandByPoint(point)
    }

    const evidence = (feature.evidenceRefs ?? []).map((ref) => rebase(ref.coordinate))
    if (evidence.length > 0) {
      const pointsGeometry = new THREE.BufferGeometry()
      pointsGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(evidence.flat()), 3))
      contentRoot.add(
        new THREE.Points(
          pointsGeometry,
          new THREE.PointsMaterial({ color: EVIDENCE_COLOR, size: 8, sizeAttenuation: false, depthTest: false }),
        ),
      )
      for (const [x, y, z] of evidence) bounds.expandByPoint(new THREE.Vector3(x, y, z))
    }

    const originGeometry = new THREE.BufferGeometry()
    originGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3))
    contentRoot.add(
      new THREE.Points(
        originGeometry,
        new THREE.PointsMaterial({ color: ORIGIN_COLOR, size: 10, sizeAttenuation: false, depthTest: false }),
      ),
    )

    const size = bounds.getSize(new THREE.Vector3())
    const radius = Math.max(size.length() / 2, 1)
    const gridSpan = Math.max(Math.ceil(radius * 2), 4)
    const grid = new THREE.GridHelper(gridSpan, gridSpan, 0x39465a, 0x232d3c)
    grid.rotation.x = Math.PI / 2 // GridHelper is XZ-planar; the scene is z-up.
    contentRoot.add(grid)

    const center = bounds.getCenter(new THREE.Vector3())
    controls.target.copy(center)
    // Frame once on open; later updates (param edits, evidence adds) keep the
    // user's orbit pose and only re-aim at the refreshed center.
    if (!framed) {
      const dir = new THREE.Vector3(0.65, -0.75, 0.5).normalize()
      camera.position.copy(center).addScaledVector(dir, radius * 2.6)
      framed = true
    }
    controls.update()
    renderFrame()
  }

  function dispose(): void {
    controls.removeEventListener('change', renderFrame)
    controls.dispose()
    clearContent()
    renderer.dispose()
    element.remove()
  }

  return { element, update, dispose }
}
