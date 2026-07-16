// tests/buildings-tab.test.ts - the Buildings tab render path: enriched list
// rows with visibility pills, the envelope authoring rail wording, and the
// building detail with envelope/faces/features sections, the fit rail, and
// the shared isolate + evidence machinery.

import { describe, expect, it } from 'vitest'
import type { FeatureRecord, ProjectManifest } from '../src/shared/workbench-types'
import { fitFaceFromEvidence } from '../src/viewer/buildingGenerators'
import type { Vec3 } from '../src/viewer/geometry'
import { buildBuildingEditorModel, buildBuildingRowsModel } from '../src/ui/buildingModel'
import { renderBuildingsListHtml } from '../src/ui/buildingsPanel'
import { buildFeatureDetailModel } from '../src/ui/model'
import { renderBuildingsTabHtml, type BuildingsTabView } from '../src/ui/rightPanel'
import { makeManifest } from './ui-fixtures'

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

function addEnvelopeBuilding(manifest: ProjectManifest, withComponents = false): FeatureRecord {
  const wall = withComponents ? fitFaceFromEvidence(WALL_POINTS)! : null
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
    evidenceRefs: WALL_POINTS.map((coordinate) => ({ kind: 'asset-point', coordinate: [...coordinate] as [number, number, number] })),
    display: { visible: true },
    metadata: {
      building: wall
        ? {
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
        : { faces: [], faceFeatures: [] },
    },
  }
  manifest.features.push(feature)
  return feature
}

function makeView(manifest: ProjectManifest, overrides: Partial<BuildingsTabView> = {}): BuildingsTabView {
  return {
    templates: [
      { id: 'building.envelope', displayName: 'Building (envelope)' },
      { id: 'building.gable', displayName: 'Gable roof' },
    ],
    authoring: null,
    list: buildBuildingRowsModel(manifest),
    detail: null,
    ...overrides,
  }
}

describe('buildings list', () => {
  it('renders enriched rows with a visibility pill and keeps the add controls', () => {
    const manifest = makeManifest()
    addEnvelopeBuilding(manifest)
    const html = renderBuildingsTabHtml(makeView(manifest))
    expect(html).toContain('id="building-template-select"')
    expect(html).toContain('data-action="building-add"')
    expect(html).toContain('data-action="feature-visibility"')
    expect(html).toContain('Envelope')
    expect(html).toContain('4-pt envelope')
    expect(html).toContain('Building total: 1')
  })

  it('renders items without enrichment (legacy view-model shape) via fallbacks', () => {
    const html = renderBuildingsListHtml(
      [
        {
          id: 'feat-legacy',
          name: 'Building 1 (gable)',
          subtype: 'gable',
          footprintVertexCount: 4,
          snappedEvidenceCount: 4,
          freeEvidenceCount: 0,
        },
      ],
      [{ id: 'building.gable', displayName: 'Gable roof' }],
    )
    expect(html).toContain('gable roof')
    expect(html).toContain('4 footprint vertices')
  })
})

describe('envelope authoring rail', () => {
  it('speaks envelope during envelope authoring', () => {
    const manifest = makeManifest()
    const html = renderBuildingsTabHtml(
      makeView(manifest, {
        authoring: {
          phase: 'footprint',
          templateId: 'building.envelope',
          subtype: 'envelope',
          activeVertexCount: 2,
          footprintVertexCount: 0,
          canCloseFootprint: false,
          snappedCount: 1,
          freeCount: 1,
        },
      }),
    )
    expect(html).toContain('draw the envelope boundary')
    expect(html).toContain('Close envelope')
  })

  it('keeps the massing wording for legacy subtypes', () => {
    const manifest = makeManifest()
    const html = renderBuildingsTabHtml(
      makeView(manifest, {
        authoring: {
          phase: 'review',
          templateId: 'building.gable',
          subtype: 'gable',
          activeVertexCount: 0,
          footprintVertexCount: 4,
          canCloseFootprint: false,
          snappedCount: 4,
          freeCount: 0,
        },
      }),
    )
    expect(html).toContain('massing and an exclusion zone')
  })
})

describe('building detail', () => {
  function detailView(manifest: ProjectManifest, feature: FeatureRecord): BuildingsTabView {
    return makeView(manifest, {
      detail: buildFeatureDetailModel(manifest, feature.id),
      buildingEditor: buildBuildingEditorModel(feature),
      objectEdit: null,
      isolateLoad: null,
    })
  }

  it('renders envelope, faces, features, isolate, and evidence sections', () => {
    const manifest = makeManifest()
    const feature = addEnvelopeBuilding(manifest, true)
    const html = renderBuildingsTabHtml(detailView(manifest, feature))
    expect(html).toContain('Envelope')
    expect(html).toContain('4 boundary vertices')
    expect(html).toContain('Faces / Roof Planes')
    expect(html).toContain('data-action="building-face-visibility"')
    expect(html).toContain('data-action="building-face-remove"')
    expect(html).toContain('Face Features')
    expect(html).toContain('data-action="building-feature-add"')
    expect(html).toContain('data-action="building-feature-param"')
    expect(html).toContain('on Wall 1')
    // Shared refinement machinery is live for buildings; isolation is
    // envelope-backed and never optional.
    expect(html).toContain('Isolate Area')
    expect(html).toContain('(building envelope)')
    expect(html).toContain('Draw custom boundary')
    expect(html).not.toContain('Reset to envelope')
    expect(html).not.toContain('No isolate area yet')
    expect(html).toContain('data-action="feature-evidence-start"')
    // Building params surface through the generic parameter renderer.
    expect(html).toContain('Roof type')
    // No 3D preview card for buildings (object/utility only).
    expect(html).not.toContain('object-preview-3d-mount')
  })

  it('offers Reset to envelope only when a custom boundary overrides it', () => {
    const manifest = makeManifest()
    const feature = addEnvelopeBuilding(manifest)
    feature.metadata!.isolateBoundary = {
      polygon: [
        [10, 10, 100],
        [20, 10, 100],
        [20, 20, 100],
      ],
    }
    const html = renderBuildingsTabHtml(detailView(manifest, feature))
    expect(html).toContain('(custom boundary)')
    expect(html).toContain('Reset to envelope')
    expect(html).toContain('Redraw custom boundary')
    expect(html).not.toContain('Clear isolate area')
  })

  it('gates the fit buttons on evidence and shows fit rail wording', () => {
    const manifest = makeManifest()
    const feature = addEnvelopeBuilding(manifest, false)
    const html = renderBuildingsTabHtml(detailView(manifest, feature))
    expect(html).toContain('data-action="building-face-fit"')
    expect(html).toContain('data-face-kind="wall"')
    expect(html).toContain('data-face-kind="roof"')
    expect(html).not.toContain('data-face-kind="wall" disabled')

    feature.evidenceRefs = []
    const gated = renderBuildingsTabHtml(detailView(manifest, feature))
    expect(gated).toContain('data-face-kind="wall" disabled')
    expect(gated).toContain('Select 3+ evidence points first')
  })

  it('renders the pending fit preview with accept/cancel', () => {
    const manifest = makeManifest()
    const feature = addEnvelopeBuilding(manifest, false)
    const fitted = fitFaceFromEvidence(WALL_POINTS)!
    const html = renderBuildingsTabHtml(
      makeView(manifest, {
        detail: buildFeatureDetailModel(manifest, feature.id),
        buildingEditor: buildBuildingEditorModel(feature, { featureId: feature.id, kind: 'wall', fitted }),
      }),
    )
    expect(html).toContain('Wall fitted to 4 evidence points')
    expect(html).toContain('data-action="building-face-accept"')
    expect(html).toContain('data-action="building-face-cancel"')
    expect(html).toContain('30 along face')
    expect(html).toContain('12 high')
    expect(html).toContain('360 sf (fitted rect)')
  })
})
