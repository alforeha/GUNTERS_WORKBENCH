// tests/ui-sim-shell.test.ts - right panel: regions are LIVE (Create Sim
// IMP-3) - listing, authoring tool rail, and feature detail - while every
// other family tab keeps the honest staged shell (disabled + Add, one-option
// Sim/DWG display mode, no render twin). The opened-asset work surface stays
// a detail view with staged later rows.

import { describe, expect, it } from 'vitest'
import type { FeatureRecord } from '../src/shared/workbench-types'
import type { BuildingAuthoringView, RegionAuthoringView } from '../src/ui/features'
import {
  buildBuildingListModel,
  buildFeatureDetailModel,
  buildLineListModel,
  buildMarkerListModel,
  buildObjectListModel,
  buildRegionListModel,
  buildSimPanelModel,
  buildWorkSurfaceModel,
} from '../src/ui/model'
import {
  renderSimPanelHtml,
  renderWorkSurfaceHtml,
  type BuildingsTabView,
  type RegionsTabView,
  type SimpleTabView,
} from '../src/ui/rightPanel'
import { SOURCE_ASSET_ID, deepFreeze, makeFeature, makeManifest } from './ui-fixtures'

function makeRegionFeature(id = 'feat-region-1'): FeatureRecord {
  return {
    ...makeFeature(id, 'polyline'),
    name: 'Region 1 (grass)',
    family: 'region',
    templateId: 'region.grass',
    subtype: 'grass',
    authorship: 'authored',
    geometry: {
      border: [
        [0, 0, 10],
        [10, 0, 10],
        [10, 10, 10],
      ],
      closed: true,
      breaklines: [
        [
          [1, 1, 10],
          [9, 9, 10],
        ],
      ],
    },
    evidenceRefs: [
      { kind: 'asset-point', coordinate: [0, 0, 10], assetId: SOURCE_ASSET_ID },
      { kind: 'asset-vertex', coordinate: [10, 0, 10], featureId: 'feat-other' },
      { kind: 'picked-coordinate', coordinate: [10, 10, 10] },
    ],
    parameters: { heightBehavior: 'drape', verticalScale: 0.2 },
    representations: { cad: { layer: 'SURF-GRASS', hatch: 'GRASS' } },
  }
}

function makeBuildingFeature(id = 'feat-building-1'): FeatureRecord {
  return {
    ...makeFeature(id, 'polyline'),
    name: 'Building 1 (gable)',
    family: 'building',
    templateId: 'building.gable',
    subtype: 'gable',
    authorship: 'authored',
    geometry: {
      footprint: [
        [0, 0, 10],
        [40, 0, 10],
        [40, 20, 10],
        [0, 20, 10],
      ],
      roofType: 'gable',
    },
    evidenceRefs: [
      { kind: 'asset-point', coordinate: [0, 0, 10], assetId: SOURCE_ASSET_ID },
      { kind: 'picked-coordinate', coordinate: [40, 0, 10] },
      { kind: 'picked-coordinate', coordinate: [40, 20, 10] },
      { kind: 'picked-coordinate', coordinate: [0, 20, 10] },
    ],
    parameters: { height: 10, roofPitch: 30, overhang: 1 },
    representations: {
      cad: {
        layers: {
          footprint: 'BLDG-FOOTPRINT',
          face: 'BLDG-FACE',
          overhang: 'BLDG-OVERHANG',
          roof: 'BLDG-ROOF',
          ridge: 'BLDG-RIDGE',
        },
      },
    },
  }
}

function makeObjectFeature(id = 'feat-object-1'): FeatureRecord {
  return {
    ...makeFeature(id, 'marker'),
    name: 'Box 1',
    family: 'object',
    templateId: 'object.box',
    subtype: 'box',
    authorship: 'authored',
    geometry: { point: [1, 2, 3] },
    evidenceRefs: [{ kind: 'asset-point', coordinate: [1, 2, 3], assetId: SOURCE_ASSET_ID }],
    parameters: { width: 6, depth: 6, height: 6, rotationYaw: 0 },
  }
}

function makeLineFeature(id = 'feat-line-1'): FeatureRecord {
  return {
    ...makeFeature(id, 'polyline'),
    name: 'Line 1 (curb)',
    family: 'line',
    templateId: 'line.curb',
    subtype: 'curb',
    authorship: 'authored',
    geometry: { vertices: [[0, 0, 0], [3, 4, 0]] },
    evidenceRefs: [
      { kind: 'asset-point', coordinate: [0, 0, 0], assetId: SOURCE_ASSET_ID },
      { kind: 'picked-coordinate', coordinate: [3, 4, 0] },
    ],
    parameters: { isBreakline: true, breaklineType: 'curb' },
  }
}

function makeMarkerFeature(id = 'feat-marker-1'): FeatureRecord {
  return {
    ...makeFeature(id, 'marker'),
    name: 'Marker 1 (spot-elevation)',
    family: 'marker',
    templateId: 'marker.spot-elevation',
    subtype: 'spot-elevation',
    authorship: 'authored',
    geometry: { point: [5, 6, 7] },
    evidenceRefs: [{ kind: 'picked-coordinate', coordinate: [5, 6, 7] }],
    parameters: { surfaceConstraint: true },
  }
}

function makeRegionsView(overrides: Partial<RegionsTabView> = {}): RegionsTabView {
  return {
    templates: [
      { id: 'region.grass', displayName: 'Grass' },
      { id: 'region.pavement', displayName: 'Pavement' },
    ],
    authoring: null,
    list: [],
    detail: null,
    ...overrides,
  }
}

function makeBuildingsView(overrides: Partial<BuildingsTabView> = {}): BuildingsTabView {
  return {
    templates: [
      { id: 'building.flat', displayName: 'Flat roof' },
      { id: 'building.gable', displayName: 'Gable roof' },
      { id: 'building.hip', displayName: 'Hip roof' },
    ],
    authoring: null,
    list: [],
    detail: null,
    ...overrides,
  }
}

function makeSimpleView(family: 'object' | 'line' | 'marker', overrides: Partial<SimpleTabView> = {}): SimpleTabView {
  const templates =
    family === 'object'
      ? [
          { id: 'object.box', displayName: 'Box' },
          { id: 'object.cylinder', displayName: 'Cylinder' },
        ]
      : family === 'line'
        ? [{ id: 'line.curb', displayName: 'Curb' }]
        : [{ id: 'marker.spot-elevation', displayName: 'Spot elevation' }]
  return { family, templates, authoring: null, list: [], detail: null, ...overrides }
}

function makeAuthoringView(overrides: Partial<RegionAuthoringView> = {}): RegionAuthoringView {
  return {
    phase: 'border',
    templateId: 'region.grass',
    subtype: 'grass',
    activeVertexCount: 0,
    borderVertexCount: 0,
    breaklineCount: 0,
    canCloseBorder: false,
    canFinishBreakline: false,
    snappedCount: 0,
    freeCount: 0,
    ...overrides,
  }
}

function makeBuildingAuthoringView(overrides: Partial<BuildingAuthoringView> = {}): BuildingAuthoringView {
  return {
    phase: 'footprint',
    templateId: 'building.gable',
    subtype: 'gable',
    activeVertexCount: 0,
    footprintVertexCount: 0,
    canCloseFootprint: false,
    snappedCount: 0,
    freeCount: 0,
    ...overrides,
  }
}

describe('buildSimPanelModel', () => {
  it('exposes the feature taxonomy tabs with zero counts and no schema additions', () => {
    const model = buildSimPanelModel(deepFreeze(makeManifest()))
    expect(model.tabs.map((tab) => tab.id)).toEqual([
      'regions',
      'objects',
      'buildings',
      'utilities',
      'lines',
      'notes',
      'measurements',
    ])
    expect(model.tabs.filter((tab) => ['regions', 'objects', 'buildings', 'utilities'].includes(tab.id)).every((tab) => tab.count === 0)).toBe(true)
    expect(model.groundLabel).toBe('Ground: not set')
  })

  it('maps legacy feature types onto their nearest future groups', () => {
    const model = buildSimPanelModel(
      makeManifest({ features: [makeFeature('f1', 'marker'), makeFeature('f2', 'polyline'), makeFeature('f3', 'measurement')] }),
    )
    expect(model.featureCount).toBe(3)
    expect(model.tabs.find((tab) => tab.id === 'lines')?.count).toBe(1)
    expect(model.tabs.find((tab) => tab.id === 'notes')?.count).toBe(1)
    expect(model.tabs.find((tab) => tab.id === 'measurements')?.count).toBe(1)
  })

  it('counts a region under regions only - its legacy polyline type does not double-count as a line', () => {
    const model = buildSimPanelModel(makeManifest({ features: [makeRegionFeature(), makeFeature('f2', 'polyline')] }))
    expect(model.tabs.find((tab) => tab.id === 'regions')?.count).toBe(1)
    expect(model.tabs.find((tab) => tab.id === 'lines')?.count).toBe(1)
  })

  it('counts a building under buildings only - its legacy polyline type does not double-count as a line', () => {
    const model = buildSimPanelModel(makeManifest({ features: [makeBuildingFeature(), makeFeature('f2', 'polyline')] }))
    expect(model.tabs.find((tab) => tab.id === 'buildings')?.count).toBe(1)
    expect(model.tabs.find((tab) => tab.id === 'lines')?.count).toBe(1)
  })
})

describe('region list + feature detail view-models', () => {
  it('lists regions with geometry counts and the snapped/free evidence split', () => {
    const list = buildRegionListModel(makeManifest({ features: [makeRegionFeature()] }))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'feat-region-1',
      name: 'Region 1 (grass)',
      subtype: 'grass',
      borderVertexCount: 3,
      breaklineCount: 1,
      snappedEvidenceCount: 2,
      freeEvidenceCount: 1,
    })
  })

  it('builds a detail model with params, cad reference names, and evidence summary', () => {
    const detail = buildFeatureDetailModel(makeManifest({ features: [makeRegionFeature()] }), 'feat-region-1')
    expect(detail).toMatchObject({
      family: 'region',
      subtype: 'grass',
      templateId: 'region.grass',
      authorship: 'authored',
      evidenceTotal: 3,
      evidenceSnapped: 2,
      evidenceFree: 1,
    })
    expect(detail?.params.find((param) => param.name === 'heightBehavior')).toMatchObject({
      label: 'Height behavior',
      value: 'drape',
      type: 'enum',
      editable: true,
    })
    expect(detail?.evidenceBadges).toEqual(['authored', 'snapped-to-cloud', 'snapped-to-feature', 'free-placement'])
    expect(detail?.cadRefs).toContainEqual({ name: 'hatch', value: 'GRASS' })
    expect(buildFeatureDetailModel(makeManifest(), 'feat-missing')).toBeNull()
  })
})

describe('building list + feature detail view-models', () => {
  it('lists buildings with footprint counts and the snapped/free evidence split', () => {
    const list = buildBuildingListModel(makeManifest({ features: [makeBuildingFeature()] }))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'feat-building-1',
      name: 'Building 1 (gable)',
      subtype: 'gable',
      footprintVertexCount: 4,
      snappedEvidenceCount: 1,
      freeEvidenceCount: 3,
    })
  })

  it('builds a generic detail model for a building', () => {
    const detail = buildFeatureDetailModel(makeManifest({ features: [makeBuildingFeature()] }), 'feat-building-1')
    expect(detail).toMatchObject({
      family: 'building',
      subtype: 'gable',
      templateId: 'building.gable',
      evidenceTotal: 4,
      evidenceSnapped: 1,
      evidenceFree: 3,
    })
    expect(detail?.params.find((param) => param.name === 'height')).toMatchObject({ label: 'Height', value: '10', editable: true })
  })
})

describe('renderSimPanelHtml', () => {
  const state = { activeTab: 'regions', simVisible: true }

  it('renders the Sim/DWG switch as a one-option shell - no second render scene', () => {
    const html = renderSimPanelHtml(buildSimPanelModel(makeManifest()), state)
    expect(html).toMatch(/>DWG<\/button>/)
    expect(html).toMatch(/disabled[^>]*title="Planned - the DWG display mode/)
    expect(html).toContain('not a second render')
  })

  it('renders the ground indicator strip placeholder', () => {
    const html = renderSimPanelHtml(buildSimPanelModel(makeManifest()), state)
    expect(html).toContain('Ground: not set')
  })

  it('keeps + Add visibly disabled/planned on every tab that is not live yet', () => {
    const regionsView = makeRegionsView()
    for (const tab of buildSimPanelModel(makeManifest()).tabs) {
      if (tab.id === 'regions') continue // live since IMP-3
      if (tab.id === 'buildings') continue // live since IMP-4
      if (['objects', 'lines', 'notes'].includes(tab.id)) continue // live since IMP-5
      const html = renderSimPanelHtml(
        buildSimPanelModel(makeManifest()),
        { activeTab: tab.id, simVisible: true, selectedFeatureId: null },
        regionsView,
        makeBuildingsView(),
        {
          object: makeSimpleView('object'),
          line: makeSimpleView('line'),
          marker: makeSimpleView('marker'),
        },
      )
      expect(html).toMatch(/class="planned-control sim-add-button" disabled/)
      expect(html).toContain(`${tab.addLabel} (planned)`)
    }
  })

  it('stages the sim-level export menu; generate-from-assets moved to the asset side', () => {
    const html = renderSimPanelHtml(buildSimPanelModel(makeManifest()), state)
    expect(html).toContain('Export all (planned)')
    expect(html).toContain('Export asset maps (planned)')
    expect(html).toContain('Export sim for web viewer (.gsim) (planned)')
    expect(html).not.toContain('Generate from assets')
  })

  it('carries a staged per-panel Detach pill in its header', () => {
    const html = renderSimPanelHtml(buildSimPanelModel(makeManifest()), state)
    expect(html).toMatch(/class="panel-detach planned-control" disabled/)
  })
})

describe('live IMP-5 tabs', () => {
  it('lists objects, lines, and markers with evidence badges', () => {
    const manifest = makeManifest({ features: [makeObjectFeature(), makeLineFeature(), makeMarkerFeature()] })
    const simple = {
      object: makeSimpleView('object', { list: buildObjectListModel(manifest) }),
      line: makeSimpleView('line', { list: buildLineListModel(manifest) }),
      marker: makeSimpleView('marker', { list: buildMarkerListModel(manifest) }),
    }
    const objectHtml = renderSimPanelHtml(
      buildSimPanelModel(manifest),
      { activeTab: 'objects', simVisible: true, selectedFeatureId: null },
      makeRegionsView(),
      makeBuildingsView(),
      simple,
    )
    expect(objectHtml).toContain('Object total: 1')
    expect(objectHtml).toContain('+ Add Object')
    expect(objectHtml).toContain('feature-pill-toggle')
    expect(objectHtml).toContain('Generic / Box')
    expect(objectHtml).toContain('Box 1')
    expect(objectHtml).toContain('1 snapped / 0 free')

    const lineHtml = renderSimPanelHtml(
      buildSimPanelModel(manifest),
      { activeTab: 'lines', simVisible: true, selectedFeatureId: null },
      makeRegionsView(),
      makeBuildingsView(),
      simple,
    )
    expect(lineHtml).toContain('id="line-template-select"')
    expect(lineHtml).toContain('curb - 2 vertices - breakline')
    expect(lineHtml).toContain('1 snapped / 1 free')

    const markerHtml = renderSimPanelHtml(
      buildSimPanelModel(manifest),
      { activeTab: 'notes', simVisible: true, selectedFeatureId: null },
      makeRegionsView(),
      makeBuildingsView(),
      simple,
    )
    expect(markerHtml).toContain('id="marker-template-select"')
    expect(markerHtml).toContain('Marker 1 (spot-elevation)')
    expect(markerHtml).toContain('0 snapped / 1 free')
  })

  it('renders line authoring with review gated on two vertices', () => {
    const html = renderSimPanelHtml(
      buildSimPanelModel(makeManifest()),
      { activeTab: 'lines', simVisible: true, selectedFeatureId: null },
      makeRegionsView(),
      makeBuildingsView(),
      {
        line: makeSimpleView('line', {
          authoring: {
            family: 'line',
            phase: 'placing',
            templateId: 'line.curb',
            subtype: 'curb',
            activeVertexCount: 1,
            vertexCount: 0,
            canReview: false,
            snappedCount: 1,
            freeCount: 0,
          },
        }),
      },
    )
    expect(html).toContain('Line (curb): click in the viewer to place vertices')
    expect(html).toMatch(/data-action="simple-review" disabled/)
  })
})

describe('live buildings tab', () => {
  const state = { activeTab: 'buildings', simVisible: true, selectedFeatureId: null }

  it('renders a LIVE + Add building with the roof-type dropdown from the catalog', () => {
    const html = renderSimPanelHtml(buildSimPanelModel(makeManifest()), state, makeRegionsView(), makeBuildingsView())
    expect(html).toContain('id="building-template-select"')
    expect(html).toContain('<option value="building.gable">Gable roof</option>')
    expect(html).toMatch(/<button class="sim-add-button" data-action="building-add">\+ Add building<\/button>/)
    expect(html).not.toContain('+ Add building (planned)')
  })

  it('lists authored buildings with selectable rows and the evidence badge', () => {
    const manifest = makeManifest({ features: [makeBuildingFeature()] })
    const html = renderSimPanelHtml(
      buildSimPanelModel(manifest),
      state,
      makeRegionsView(),
      makeBuildingsView({ list: buildBuildingListModel(manifest) }),
    )
    expect(html).toContain('data-feature-id="feat-building-1"')
    expect(html).toContain('Building 1 (gable)')
    expect(html).toContain('1 snapped / 3 free')
  })

  it('footprint phase: close footprint is gated on the 3-vertex minimum', () => {
    const tooFew = renderSimPanelHtml(
      buildSimPanelModel(makeManifest()),
      state,
      makeRegionsView(),
      makeBuildingsView({ authoring: makeBuildingAuthoringView({ activeVertexCount: 2 }) }),
    )
    expect(tooFew).toContain('click in the viewer to place footprint vertices')
    expect(tooFew).toMatch(/data-action="building-close-footprint" disabled/)

    const enough = renderSimPanelHtml(
      buildSimPanelModel(makeManifest()),
      state,
      makeRegionsView(),
      makeBuildingsView({ authoring: makeBuildingAuthoringView({ activeVertexCount: 3, canCloseFootprint: true }) }),
    )
    expect(enough).toMatch(/data-action="building-close-footprint">Close footprint/)
  })

  it('review phase offers Finish building and discloses the exclusion-zone behavior', () => {
    const html = renderSimPanelHtml(
      buildSimPanelModel(makeManifest()),
      state,
      makeRegionsView(),
      makeBuildingsView({
        authoring: makeBuildingAuthoringView({ phase: 'review', footprintVertexCount: 4, snappedCount: 1, freeCount: 3 }),
      }),
    )
    expect(html).toContain('Footprint closed (4 vertices)')
    expect(html).toContain('exclusion zone')
    expect(html).toContain('data-action="building-finish"')
    expect(html).toContain('1 snapped / 3 free placed')
  })
})

describe('live regions tab', () => {
  const state = { activeTab: 'regions', simVisible: true, selectedFeatureId: null }

  it('renders a LIVE + Add region with the subtype dropdown from the catalog', () => {
    const html = renderSimPanelHtml(buildSimPanelModel(makeManifest()), state, makeRegionsView())
    expect(html).toContain('id="region-template-select"')
    expect(html).toContain('<option value="region.grass">Grass</option>')
    expect(html).toMatch(/<button class="sim-add-button" data-action="region-add">\+ Add region<\/button>/)
    expect(html).not.toContain('+ Add region (planned)')
    expect(html).toContain('No regions yet. Pick a subtype')
  })

  it('lists authored regions with selectable rows and the evidence badge', () => {
    const manifest = makeManifest({ features: [makeRegionFeature()] })
    const view = makeRegionsView({ list: buildRegionListModel(manifest) })
    const html = renderSimPanelHtml(buildSimPanelModel(manifest), state, view)
    expect(html).toContain('data-action="feature-select"')
    expect(html).toContain('data-feature-id="feat-region-1"')
    expect(html).toContain('Region 1 (grass)')
    expect(html).toContain('2 snapped / 1 free')
  })

  it('border phase: place hint + Close border gated on the 3-vertex minimum', () => {
    const tooFew = renderSimPanelHtml(
      buildSimPanelModel(makeManifest()),
      state,
      makeRegionsView({ authoring: makeAuthoringView({ activeVertexCount: 2 }) }),
    )
    expect(tooFew).toContain('click in the viewer to place border vertices')
    expect(tooFew).toMatch(/data-action="region-close-border" disabled/)
    expect(tooFew).toContain('data-action="region-cancel"')

    const enough = renderSimPanelHtml(
      buildSimPanelModel(makeManifest()),
      state,
      makeRegionsView({ authoring: makeAuthoringView({ activeVertexCount: 3, canCloseBorder: true }) }),
    )
    expect(enough).toMatch(/data-action="region-close-border">Close border/)
  })

  it('review phase: offers Add breakline / Finish region and discloses the evidence split', () => {
    const html = renderSimPanelHtml(
      buildSimPanelModel(makeManifest()),
      state,
      makeRegionsView({
        authoring: makeAuthoringView({ phase: 'review', borderVertexCount: 4, breaklineCount: 1, snappedCount: 3, freeCount: 3 }),
      }),
    )
    expect(html).toContain('Border closed (4 vertices, 1 breakline(s))')
    expect(html).toContain('data-action="region-add-breakline"')
    expect(html).toContain('data-action="region-finish"')
    expect(html).toContain('3 snapped / 3 free placed')
  })

  it('breakline phase: Finish breakline gated on the 2-vertex minimum', () => {
    const html = renderSimPanelHtml(
      buildSimPanelModel(makeManifest()),
      state,
      makeRegionsView({ authoring: makeAuthoringView({ phase: 'breakline', activeVertexCount: 1 }) }),
    )
    expect(html).toMatch(/data-action="region-finish-breakline" disabled/)
  })

  it('feature detail: rename input, params, CAD reference names, evidence summary, delete', () => {
    const manifest = makeManifest({ features: [makeRegionFeature()] })
    const detail = buildFeatureDetailModel(manifest, 'feat-region-1')
    const html = renderSimPanelHtml(
      buildSimPanelModel(manifest),
      { ...state, selectedFeatureId: 'feat-region-1' },
      makeRegionsView({ detail }),
    )
    expect(html).toContain('data-action="feature-rename"')
    expect(html).toContain('value="Region 1 (grass)"')
    expect(html).toContain('data-action="feature-param"')
    expect(html).toContain('data-param-name="heightBehavior"')
    expect(html).toContain('GRASS')
    expect(html).toContain('snapped-to-cloud')
    expect(html).toContain('3 refs - 2 snapped, 1 free placed')
    expect(html).toContain('data-action="feature-delete"')
    expect(html).toContain('data-action="feature-back"')
  })

  it('object detail includes the Object Preview section', () => {
    const manifest = makeManifest({ features: [makeObjectFeature()] })
    const detail = buildFeatureDetailModel(manifest, 'feat-object-1')
    const html = renderSimPanelHtml(
      buildSimPanelModel(manifest),
      { activeTab: 'objects', simVisible: true, selectedFeatureId: 'feat-object-1' },
      makeRegionsView(),
      makeBuildingsView(),
      {
        object: makeSimpleView('object', { detail }),
      },
    )
    expect(html).toContain('Object Preview')
    expect(html).toContain('object-preview-box')
  })
})

describe('buildWorkSurfaceModel', () => {
  it('describes metadata, index status, and surfel status for a point cloud asset', () => {
    const model = buildWorkSurfaceModel(deepFreeze(makeManifest()), SOURCE_ASSET_ID)
    expect(model).not.toBeNull()
    expect(model?.pointSummary).toContain('12,400,000 points')
    expect(model?.unitsLabel).toBe('usft')
    expect(model?.index.present).toBe(true)
    expect(model?.index.stale).toBe(false)
    expect(model?.surfels.present).toBe(true)
    expect(model?.index.actionLabel).toBe('Rebuild index')
  })

  it('offers build actions when nothing derived exists yet', () => {
    const model = buildWorkSurfaceModel(makeManifest({ includeIndex: false, includeSurfels: false }), SOURCE_ASSET_ID)
    expect(model?.index.present).toBe(false)
    expect(model?.index.actionLabel).toBe('Build index')
    expect(model?.surfels.actionLabel).toBe('Generate surfels')
  })

  it('surfaces friendly stale warnings for index and surfels', () => {
    const model = buildWorkSurfaceModel(makeManifest({ staleIndexWarning: true, staleSurfelSha: true }), SOURCE_ASSET_ID)
    expect(model?.index.stale).toBe(true)
    expect(model?.index.staleNote).toContain('Rebuild')
    expect(model?.surfels.stale).toBe(true)
    expect(model?.surfels.staleNote).toContain('Regenerate')
  })

  it('returns null for non-point-cloud assets', () => {
    expect(buildWorkSurfaceModel(makeManifest(), 'asset-does-not-exist')).toBeNull()
  })
})

describe('renderWorkSurfaceHtml', () => {
  it('is a detail view with a back-to-sim control and staged later rows', () => {
    const model = buildWorkSurfaceModel(makeManifest(), SOURCE_ASSET_ID)
    if (!model) throw new Error('fixture model missing')
    const html = renderWorkSurfaceHtml(model)
    expect(html).toContain('data-action="back-to-sim"')
    expect(html).toContain('data-action="build-index"')
    expect(html).toContain('data-action="generate-surfels"')
    expect(html).toMatch(/disabled[^>]*>Classify points \(later\)/)
    expect(html).toMatch(/disabled[^>]*>Register to control points \(later\)/)
    expect(html).toMatch(/disabled[^>]*>Extract features \(later\)/)
    expect(html).toContain('truth-badge truth-source')
  })

  it('shows the stale badge when derived layers are out of date', () => {
    const model = buildWorkSurfaceModel(makeManifest({ staleIndexWarning: true }), SOURCE_ASSET_ID)
    if (!model) throw new Error('fixture model missing')
    const html = renderWorkSurfaceHtml(model)
    expect(html).toContain('ws-stale-badge')
    expect(html).toContain('source file changed after this index was built')
  })
})
