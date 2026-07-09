// tests/ui-display-manager.test.ts - left panel view-models and card render:
// asset-centered grouping over the flat manifest, master pill sub-state
// preservation, truth badge presence, and staged/disabled controls.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYER_APPEARANCE,
  buildPointCloudCards,
  buildSurfaceCards,
  computeMasterToggleUpdates,
} from '../src/ui/model'
import { renderLeftPanelHtml, type LeftPanelRenderModel, type LeftPanelViewState } from '../src/ui/leftPanel'
import {
  INDEX_LAYER_ID,
  PREVIEW_LAYER_ID,
  SOURCE_ASSET_ID,
  SURFEL_LAYER_ID,
  deepFreeze,
  makeManifest,
} from './ui-fixtures'

function renderModel(view: Partial<LeftPanelViewState> = {}, manifest = makeManifest()): LeftPanelRenderModel {
  return {
    hasProject: true,
    status: { projectLine: 'Project: C:/projects/north', recoveryLine: 'Recovery note: clean state.' },
    pointCloudCards: buildPointCloudCards(manifest),
    surfaceCards: buildSurfaceCards(manifest),
    appearance: () => ({ ...DEFAULT_LAYER_APPEARANCE }),
    view: { activeTab: 'point-clouds', expandedAssetId: null, confirmRemoveAssetId: null, ...view },
  }
}

describe('buildPointCloudCards', () => {
  it('groups source + index + surfel layers under one asset card', () => {
    const cards = buildPointCloudCards(deepFreeze(makeManifest()))
    expect(cards).toHaveLength(1)
    const card = cards[0]
    expect(card.assetId).toBe(SOURCE_ASSET_ID)
    expect(card.extLabel).toBe('LAS')
    expect(card.views.map((v) => v.viewKind)).toEqual(['preview', 'index', 'surfel'])
    expect(card.views.map((v) => v.truthLabel)).toEqual(['preview-sampled', 'indexed-full', 'derived'])
    expect(card.groupAssetIds).toHaveLength(3)
    expect(card.missingViews).toHaveLength(0)
  })

  it('reports master on when any view is active and off when none are', () => {
    const on = buildPointCloudCards(makeManifest())[0]
    expect(on.masterOn).toBe(true)

    const manifest = makeManifest()
    for (const layer of manifest.simulationLayers) layer.status = 'hidden'
    const off = buildPointCloudCards(manifest)[0]
    expect(off.masterOn).toBe(false)
  })

  it('lists not-yet-built index/surfel views as discoverable missing rows', () => {
    const cards = buildPointCloudCards(makeManifest({ includeIndex: false, includeSurfels: false }))
    expect(cards[0].views.map((v) => v.viewKind)).toEqual(['preview'])
    expect(cards[0].missingViews.map((v) => v.viewKind)).toEqual(['index', 'surfel'])
    expect(cards[0].missingViews[0].hint).toContain('Open this asset')
  })

  it('never reports classification data (no asset metadata carries classes yet)', () => {
    expect(buildPointCloudCards(makeManifest())[0].hasClassification).toBe(false)
  })
})

describe('computeMasterToggleUpdates (sub-state preservation)', () => {
  it('turning off remembers exact per-layer visibility and hides only active views', () => {
    const card = buildPointCloudCards(makeManifest({ surfelLayerStatus: 'hidden' }))[0]
    const result = computeMasterToggleUpdates(card.views, null, false)
    expect(result.remember?.get(PREVIEW_LAYER_ID)).toBe(true)
    expect(result.remember?.get(INDEX_LAYER_ID)).toBe(true)
    expect(result.remember?.get(SURFEL_LAYER_ID)).toBe(false)
    expect(result.updates).toEqual([
      { layerId: PREVIEW_LAYER_ID, visible: false },
      { layerId: INDEX_LAYER_ID, visible: false },
    ])
  })

  it('turning back on restores the remembered state, not all-on', () => {
    const manifest = makeManifest({ surfelLayerStatus: 'hidden' })
    const before = buildPointCloudCards(manifest)[0]
    const off = computeMasterToggleUpdates(before.views, null, false)

    for (const layer of manifest.simulationLayers) layer.status = 'hidden'
    const afterOff = buildPointCloudCards(manifest)[0]
    const on = computeMasterToggleUpdates(afterOff.views, off.remember, true)
    expect(on.updates).toEqual([
      { layerId: PREVIEW_LAYER_ID, visible: true },
      { layerId: INDEX_LAYER_ID, visible: true },
    ])
    expect(on.remember).toBeNull()
  })

  it('defaults to all non-error views on when there is no memory', () => {
    const manifest = makeManifest()
    for (const layer of manifest.simulationLayers) layer.status = 'hidden'
    manifest.simulationLayers[1].status = 'error'
    const card = buildPointCloudCards(manifest)[0]
    const on = computeMasterToggleUpdates(card.views, null, true)
    expect(on.updates).toEqual([
      { layerId: PREVIEW_LAYER_ID, visible: true },
      { layerId: SURFEL_LAYER_ID, visible: true },
    ])
  })
})

describe('renderLeftPanelHtml', () => {
  it('renders the asset card with master pill and truth badges', () => {
    const html = renderLeftPanelHtml(renderModel())
    expect(html).toContain('data-action="master-toggle"')
    expect(html).toContain('LAS')
    expect(html).toContain('truth-badge truth-source')
  })

  it('carries a staged per-panel Detach pill in its header', () => {
    const html = renderLeftPanelHtml(renderModel())
    expect(html).toMatch(/class="panel-detach planned-control" disabled/)
  })

  it('shows per-view truth badges and controls when expanded', () => {
    const html = renderLeftPanelHtml(renderModel({ expandedAssetId: SOURCE_ASSET_ID }))
    expect(html).toContain('truth-preview-sampled')
    expect(html).toContain('truth-indexed-full')
    expect(html).toContain('truth-derived')
    expect(html).toContain('data-action="color-mode"')
    expect(html).toContain('data-action="point-size"')
    expect(html).toContain('data-action="surfel-scale"')
  })

  it('renders classification as a disabled planned option, never functional', () => {
    const html = renderLeftPanelHtml(renderModel({ expandedAssetId: SOURCE_ASSET_ID }))
    expect(html).toContain('<option value="classification" disabled>Classification (planned)</option>')
    expect(html).toContain('Classification - none detected in this asset (display planned)')
  })

  it('renders opacity as a visibly disabled shell (no engine hook)', () => {
    const html = renderLeftPanelHtml(renderModel({ expandedAssetId: SOURCE_ASSET_ID }))
    expect(html).toContain('no per-layer opacity hook yet')
  })

  it('requires a confirm catch before remove', () => {
    const collapsed = renderLeftPanelHtml(renderModel({ expandedAssetId: SOURCE_ASSET_ID }))
    expect(collapsed).toContain('data-action="remove-asset"')
    expect(collapsed).not.toContain('data-action="confirm-remove"')

    const confirming = renderLeftPanelHtml(
      renderModel({ expandedAssetId: SOURCE_ASSET_ID, confirmRemoveAssetId: SOURCE_ASSET_ID }),
    )
    expect(confirming).toContain('data-action="confirm-remove"')
    expect(confirming).toContain('Files on disk are not deleted')
  })

  it('renders placeholder tabs for asset types with no content', () => {
    const html = renderLeftPanelHtml({ ...renderModel(), view: { activeTab: 'drawings', expandedAssetId: null, confirmRemoveAssetId: null } })
    expect(html).toContain('No drawing assets yet')
  })

  it('keeps derived-surface visibility reachable from the Surfaces tab', () => {
    const manifest = makeManifest({ includeSurface: true })
    const html = renderLeftPanelHtml({
      ...renderModel({}, manifest),
      view: { activeTab: 'surfaces', expandedAssetId: null, confirmRemoveAssetId: null },
    })
    expect(html).toContain('placeholder_surface')
    expect(html).toContain('data-action="layer-visible"')
  })
})
