// src/ui/buildingModel.test.ts - building view-models: enriched list rows,
// the envelope detail editor (face rows with dims/slope, hosted-feature rows
// with host names), and the pending-fit formatting.

import { describe, expect, it } from 'vitest'
import { makeManifest } from '../../tests/ui-fixtures'
import type { BuildingComponentsRecord } from '../shared/building-catalog'
import type { FeatureRecord, ProjectManifest } from '../shared/workbench-types'
import { fitFaceFromEvidence } from '../viewer/buildingGenerators'
import type { Vec3 } from '../viewer/geometry'
import type { BuildingFaceFitView } from './buildingController'
import { buildBuildingEditorModel, buildBuildingRowsModel, buildingSummary } from './buildingModel'

const ENVELOPE: Vec3[] = [
  [0, 0, 100],
  [40, 0, 100],
  [40, 30, 100],
  [0, 30, 100],
]

const WALL_POINTS: Vec3[] = [
  [40, 0, 100],
  [40, 30, 100],
  [40, 30, 112],
  [40, 0, 112],
]

const ROOF_POINTS: Vec3[] = [
  [0, 0, 112],
  [40, 0, 112],
  [0, 15, 120],
  [40, 15, 120],
]

function makeComponents(): BuildingComponentsRecord {
  const wall = fitFaceFromEvidence(WALL_POINTS)!
  const roof = fitFaceFromEvidence(ROOF_POINTS)!
  return {
    faces: [
      {
        id: 'face-wall',
        name: 'Wall 1',
        kind: 'wall',
        plane: wall.plane,
        extents: wall.extents,
        fitRms: wall.fitRms,
        evidence: { count: 4, representative: WALL_POINTS },
        visible: true,
        createdAt: '2026-07-16T00:00:00.000Z',
      },
      {
        id: 'face-roof',
        name: 'Roof plane 1',
        kind: 'roof',
        plane: roof.plane,
        extents: roof.extents,
        fitRms: roof.fitRms,
        evidence: { count: 4, representative: ROOF_POINTS },
        visible: false,
        createdAt: '2026-07-16T00:00:00.000Z',
      },
    ],
    faceFeatures: [
      {
        id: 'bfeat-door',
        faceId: 'face-wall',
        name: 'Door 1',
        type: 'door',
        offsetU: 13.5,
        offsetV: 0,
        width: 3,
        height: 7,
        depth: 0.5,
        visible: true,
        createdAt: '2026-07-16T00:00:00.000Z',
      },
    ],
  }
}

function addBuilding(manifest: ProjectManifest, overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  const feature: FeatureRecord = {
    id: 'feat-bldg-1',
    simulationId: manifest.realitySimulation.id,
    type: 'polyline',
    name: 'Building 1 (envelope)',
    geometry: { footprint: ENVELOPE },
    createdAt: '2026-07-16T00:00:00.000Z',
    modifiedAt: '2026-07-16T00:00:00.000Z',
    family: 'building',
    templateId: 'building.envelope',
    subtype: 'envelope',
    parameters: {},
    evidenceRefs: [{ kind: 'asset-point', coordinate: [40, 0, 100] }],
    display: { visible: true },
    metadata: {
      building: makeComponents(),
    },
    ...overrides,
  }
  manifest.features.push(feature)
  return feature
}

describe('buildBuildingRowsModel + buildingSummary', () => {
  it('enriches envelope rows with pill label, component summary, and visibility', () => {
    const manifest = makeManifest()
    addBuilding(manifest)
    const rows = buildBuildingRowsModel(manifest)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ typeLabel: 'Envelope', visible: true })
    expect(rows[0]!.summary).toContain('4-pt envelope')
    expect(rows[0]!.summary).toContain('1 wall')
    expect(rows[0]!.summary).toContain('1 roof plane')
    expect(rows[0]!.summary).toContain('1 feature')
  })

  it('labels legacy massing buildings by their roof subtype', () => {
    const manifest = makeManifest()
    addBuilding(manifest, {
      id: 'feat-legacy',
      subtype: 'gable',
      templateId: 'building.gable',
      geometry: { footprint: ENVELOPE, roofType: 'gable' },
      metadata: {},
    })
    const rows = buildBuildingRowsModel(manifest)
    expect(rows[0]!.typeLabel).toBe('gable roof')
    expect(buildingSummary(manifest.features[0]!)).toContain('gable roof - 4 footprint vertices')
  })
})

describe('buildBuildingEditorModel', () => {
  it('returns null for non-envelope features', () => {
    const manifest = makeManifest()
    const legacy = addBuilding(manifest, { subtype: 'gable', geometry: { footprint: ENVELOPE, roofType: 'gable' } })
    expect(buildBuildingEditorModel(legacy)).toBeNull()
  })

  it('builds envelope info, face rows with dims/slope, and hosted-feature rows', () => {
    const manifest = makeManifest()
    const feature = addBuilding(manifest)
    const editor = buildBuildingEditorModel(feature)!

    expect(editor.envelopeVertexCount).toBe(4)
    expect(editor.envelopeAreaLabel).toBe('1200 sf plan')
    // No override drawn: the envelope resolves as the (non-optional) boundary.
    expect(editor.isolateVertexCount).toBe(4)
    expect(editor.isolateOverride).toBe(false)
    expect(editor.evidenceCount).toBe(1)
    expect(editor.canFit).toBe(false) // needs 3+

    expect(editor.faces).toHaveLength(2)
    const wallRow = editor.faces[0]!
    expect(wallRow).toMatchObject({ kindLabel: 'Wall', visible: true })
    expect(wallRow.dimsLabel).toContain('30 x 12')
    expect(wallRow.dimsLabel).toContain('360 sf')
    expect(wallRow.planeLabel).toContain('Z 100 to 112')
    const roofRow = editor.faces[1]!
    expect(roofRow.visible).toBe(false)
    expect(roofRow.planeLabel).toContain('slope 28.1 deg')
    expect(roofRow.planeLabel).toContain('downhill S')

    expect(editor.features).toHaveLength(1)
    expect(editor.features[0]).toMatchObject({ typeLabel: 'Door', hostFaceName: 'Wall 1' })
    expect(editor.features[0]!.dimsLabel).toBe('3w x 7h x 0.5d')
    const paramNames = editor.features[0]!.params.map((param) => param.name)
    expect(paramNames).toEqual(['offsetU', 'offsetV', 'width', 'height', 'depth'])
    expect(editor.features[0]!.params[1]!.label).toBe('Sill height')

    expect(editor.faceOptions.map((option) => option.id)).toEqual(['face-wall', 'face-roof'])
    expect(editor.featureTypeOptions.map((option) => option.id)).toContain('chimney')
    expect(editor.fit).toBeNull()
  })

  it('flags a drawn boundary as an override of the envelope', () => {
    const manifest = makeManifest()
    const feature = addBuilding(manifest, {
      metadata: {
        building: makeComponents(),
        isolateBoundary: {
          polygon: [
            [10, 10, 100],
            [20, 10, 100],
            [20, 20, 100],
          ],
        },
      },
    })
    const editor = buildBuildingEditorModel(feature)!
    expect(editor.isolateVertexCount).toBe(3)
    expect(editor.isolateOverride).toBe(true)
  })

  it('formats a pending roof fit with slope and an orientation note when kinds disagree', () => {
    const manifest = makeManifest()
    const feature = addBuilding(manifest)
    const fitted = fitFaceFromEvidence(ROOF_POINTS)!
    const roofFit: BuildingFaceFitView = { featureId: feature.id, kind: 'roof', fitted }
    const editor = buildBuildingEditorModel(feature, roofFit)!
    expect(editor.fit).not.toBeNull()
    expect(editor.fit!.pointCount).toBe(4)
    expect(editor.fit!.slopeLabel).toContain('slope 28.1 deg')
    expect(editor.fit!.orientationNote).toBeNull()

    // The same sloped plane declared as a wall earns the mismatch note.
    const wallFit: BuildingFaceFitView = { featureId: feature.id, kind: 'wall', fitted }
    const mismatch = buildBuildingEditorModel(feature, wallFit)!
    expect(mismatch.fit!.orientationNote).toContain('reads more like a roof')

    // A fit for a DIFFERENT building never leaks into this editor.
    const foreign = buildBuildingEditorModel(feature, { ...roofFit, featureId: 'feat-other' })!
    expect(foreign.fit).toBeNull()
  })
})
