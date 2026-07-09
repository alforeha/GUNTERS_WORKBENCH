// tests/ui-sim-shell.test.ts - right panel: the Sim shell must communicate the
// future model without faking it (disabled + Add, one-option Sim/DWG display
// mode, no render twin), and the opened-asset work surface must stay a detail
// view with staged later rows.

import { describe, expect, it } from 'vitest'
import { buildSimPanelModel, buildWorkSurfaceModel } from '../src/ui/model'
import { renderSimPanelHtml, renderWorkSurfaceHtml } from '../src/ui/rightPanel'
import { SOURCE_ASSET_ID, deepFreeze, makeFeature, makeManifest } from './ui-fixtures'

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

  it('keeps every + Add action visibly disabled/planned', () => {
    for (const tab of buildSimPanelModel(makeManifest()).tabs) {
      const html = renderSimPanelHtml(buildSimPanelModel(makeManifest()), { activeTab: tab.id, simVisible: true })
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
