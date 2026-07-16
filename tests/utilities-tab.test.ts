// tests/utilities-tab.test.ts - the Utilities tab render path: list + add
// picker, the point/run authoring rails, and the shared feature detail with
// the utility editor sections (type select, placement/alignment, isolate,
// explicit evidence).

import { describe, expect, it } from 'vitest'
import type { SimpleAuthoringView } from '../src/ui/features'
import { buildFeatureDetailModel } from '../src/ui/model'
import { renderUtilitiesTabContentHtml, type SimpleTabView } from '../src/ui/rightPanel'
import { renderUtilitiesTabHtml, renderUtilityAuthoringHtml } from '../src/ui/utilitiesPanel'
import { buildUtilityAddModel, buildUtilityEditorModel, buildUtilityListModel } from '../src/ui/utilityModel'
import type { FeatureRecord, ProjectManifest } from '../src/shared/workbench-types'
import { makeManifest } from './ui-fixtures'

function addUtility(manifest: ProjectManifest, templateId: string, geometry: Record<string, unknown>): FeatureRecord {
  const subtype = templateId.split('.')[1]!
  const feature: FeatureRecord = {
    id: `feat-${subtype}`,
    simulationId: manifest.realitySimulation.id,
    type: geometry.vertices ? 'polyline' : 'marker',
    name: `Storm ${subtype} 1`,
    geometry,
    createdAt: '2026-07-13T00:00:00.000Z',
    modifiedAt: '2026-07-13T00:00:00.000Z',
    family: 'utility',
    templateId,
    subtype,
    parameters: {},
    evidenceRefs: [{ kind: 'asset-point', coordinate: [1, 2, 3] }],
    display: { visible: true },
    metadata: {},
  }
  manifest.features.push(feature)
  return feature
}

function makeAuthoring(overrides: Partial<SimpleAuthoringView>): SimpleAuthoringView {
  return {
    family: 'utility',
    phase: 'placing',
    templateId: 'utility.storm-pipe',
    subtype: 'storm-pipe',
    geometry: 'polyline',
    activeVertexCount: 0,
    vertexCount: 0,
    canReview: false,
    snappedCount: 0,
    freeCount: 0,
    ...overrides,
  }
}

describe('renderUtilitiesTabHtml', () => {
  it('renders the add picker (system + class selects) and the placeholder when empty', () => {
    const html = renderUtilitiesTabHtml({ authoring: null, list: [], add: buildUtilityAddModel('storm') })
    expect(html).toContain('utility-system-select')
    expect(html).toContain('utility-class-select')
    expect(html).toContain('data-action="utility-add"')
    expect(html).toContain('No utilities yet')
    expect(html).toContain('value="storm" selected')
    expect(html).toContain('utility.storm-culvert')
    expect(html).not.toContain('utility.generic-vault')
    // Line classes are tagged as runs in the picker.
    expect(html).toContain('Pipe/Line (run)')
  })

  it('renders rows with a system/class visibility pill and summary', () => {
    const manifest = makeManifest()
    addUtility(manifest, 'utility.storm-manhole', { point: [0, 0, 100] })
    const html = renderUtilitiesTabHtml({
      authoring: null,
      list: buildUtilityListModel(manifest),
      add: buildUtilityAddModel('generic'),
    })
    expect(html).toContain('Storm / Manhole')
    expect(html).toContain('data-action="feature-visibility"')
    expect(html).toContain('data-action="feature-select"')
    expect(html).toContain('Utility total: 1')
  })
})

describe('renderUtilityAuthoringHtml', () => {
  it('shows the pin rail (no review button) for point classes', () => {
    const html = renderUtilityAuthoringHtml(makeAuthoring({ templateId: 'utility.storm-manhole', geometry: 'point' }))
    expect(html).toContain('place the pin')
    expect(html).not.toContain('simple-review')
    expect(html).toContain('region-cancel')
  })

  it('shows the run rail with review gating for line classes', () => {
    const placing = renderUtilityAuthoringHtml(makeAuthoring({ activeVertexCount: 1 }))
    expect(placing).toContain('alignment points')
    expect(placing).toContain('data-action="simple-review" disabled')

    const ready = renderUtilityAuthoringHtml(makeAuthoring({ activeVertexCount: 2, canReview: true }))
    expect(ready).not.toContain('simple-review" disabled')

    const review = renderUtilityAuthoringHtml(makeAuthoring({ phase: 'review', vertexCount: 2 }))
    expect(review).toContain('data-action="simple-finish"')
  })

  it('hints the assumed endpoint for stub runs', () => {
    const html = renderUtilityAuthoringHtml(makeAuthoring({ templateId: 'utility.storm-stub' }))
    expect(html).toContain('assumed end')
  })
})

describe('renderUtilitiesTabContentHtml detail', () => {
  function makeView(feature: FeatureRecord, manifest: ProjectManifest): SimpleTabView {
    return {
      family: 'utility',
      templates: [],
      authoring: null,
      list: buildUtilityListModel(manifest),
      detail: buildFeatureDetailModel(manifest, feature.id),
      objectEdit: null,
      isolateLoad: null,
      utilityAdd: buildUtilityAddModel('generic'),
      utilityEditor: buildUtilityEditorModel(feature),
    }
  }

  it('renders type select, placement, preview, isolate, and evidence for a point utility', () => {
    const manifest = makeManifest()
    const feature = addUtility(manifest, 'utility.storm-manhole', { point: [10, 20, 100] })
    const html = renderUtilitiesTabContentHtml(makeView(feature, manifest))
    expect(html).toContain('data-action="feature-utility-type"')
    expect(html).toContain('below-ground')
    expect(html).toContain('data-action="feature-placement"')
    expect(html).toContain('object-preview-3d-mount')
    expect(html).toContain('Isolate Area')
    expect(html).toContain('data-action="feature-evidence-start"')
    expect(html).toContain('Utility Preview')
    // Storm params surface through the generic parameter renderer.
    expect(html).toContain('Invert in')
  })

  it('renders alignment info instead of placement for a line utility', () => {
    const manifest = makeManifest()
    const feature = addUtility(manifest, 'utility.storm-pipe', { vertices: [[0, 0, 90], [30, 40, 89]] })
    const html = renderUtilitiesTabContentHtml(makeView(feature, manifest))
    expect(html).toContain('Alignment')
    expect(html).toContain('2 points - 50 lf (plan)')
    expect(html).not.toContain('data-action="feature-placement"')
    expect(html).toContain('Flow direction')
  })
})
