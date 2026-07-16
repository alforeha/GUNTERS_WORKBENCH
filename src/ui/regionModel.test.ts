import { describe, expect, it } from 'vitest'
import type { FeatureRecord } from '../shared/workbench-types'
import { buildRegionEditorModel } from './regionModel'
import { renderRegionsTabHtml, type RegionsTabView } from './regionsPanel'

function makeRegion(): FeatureRecord {
  return {
    id: 'feat-region-1',
    simulationId: 'sim-1',
    type: 'polyline',
    name: 'Region 1',
    geometry: {
      border: [
        [0, 0, 10],
        [10, 0, 10],
        [10, 10, 10],
        [0, 10, 10],
      ],
      closed: true,
      breaklines: [[[1, 1, 10], [9, 9, 11]]],
    },
    createdAt: '2026-07-16T00:00:00.000Z',
    modifiedAt: '2026-07-16T00:00:00.000Z',
    family: 'region',
    templateId: 'region.generic',
    subtype: 'generic',
    parameters: { heightBehavior: 'drape', verticalScale: 0, appearancePreset: 'default' },
    display: { visible: true },
    metadata: {
      region: {
        edgeEvidence: [{ kind: 'asset-point', coordinate: [0, 0, 10] }],
        interiorEvidence: [{ kind: 'asset-point', coordinate: [5, 5, 10] }],
        surfacePoints: [
          { id: 'rsp-1', coordinate: [5, 5, 12], source: 'manual' },
          { id: 'rsp-2', coordinate: [2.5, 2.5, 10], source: 'generated-grid' },
        ],
        surface: {
          positions: [0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10, 5, 5, 12],
          indices: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4],
          generatedAt: '2026-07-16T12:00:00.000Z',
          triangleCount: 4,
          minElevation: 10,
          maxElevation: 12,
          averageElevation: 10.4,
        },
        visibility: {
          boundary: true,
          surface: true,
          surfacePoints: true,
          breaklines: true,
          edgeEvidence: true,
          interiorEvidence: false,
          wireframe: true,
        },
        gridSpacing: 5,
        gridMode: 'generated-flat',
      },
    },
  }
}

describe('regionModel', () => {
  it('builds region detail stats and visibility state from region metadata', () => {
    const model = buildRegionEditorModel(makeRegion())
    expect(model).not.toBeNull()
    expect(model).toMatchObject({
      focused: true,
      boundaryVertexCount: 4,
      breaklineCount: 1,
      breaklineVertexCount: 2,
      edgeEvidenceCount: 1,
      interiorEvidenceCount: 1,
      manualSurfacePointCount: 1,
      gridSurfacePointCount: 1,
      surfaceInputCount: 3,
      gridActionLabel: 'Add generated grid points',
      triangleCount: 4,
      minElevationLabel: '10',
      maxElevationLabel: '12',
      elevationRangeLabel: '2',
    })
  })

  it('renders the region detail controls and visibility toggles', () => {
    const editor = buildRegionEditorModel(makeRegion())!
    const view: RegionsTabView = {
      templates: [{ id: 'region.generic', displayName: 'Generic' }],
      authoring: null,
      list: [],
      detail: {
        id: 'feat-region-1',
        name: 'Region 1',
        family: 'region',
        subtype: 'generic',
        templateId: 'region.generic',
        authorship: 'authored',
        editor,
      },
      edit: null,
    }
    const html = renderRegionsTabHtml(view)
    expect(html).toContain('Boundary / Edge')
    expect(html).toContain('Surface Inputs')
    expect(html).toContain('Generated Surface')
    expect(html).toContain('Source / Provenance')
    expect(html).toContain('data-action="region-show-all"')
    expect(html).toContain('data-action="region-redraw-boundary"')
    expect(html).toContain('data-action="region-add-surface-point"')
    expect(html).toContain('data-action="region-add-grid"')
    expect(html).toContain('data-action="region-generate-surface"')
    expect(html).toContain('Add generated grid points')
    expect(html).toContain('Generated flat grid: 1')
    expect(html).toContain('Boundary edge provenance refs: 1')
  })
})