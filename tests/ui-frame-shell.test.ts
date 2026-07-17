// tests/ui-frame-shell.test.ts - layout-shell render assertions (pure HTML
// string checks; no DOM runtime needed).

import { describe, expect, it } from 'vitest'
import { renderFrameHtml } from '../src/ui/frame'
import { renderHeaderHtml } from '../src/ui/header'
import { renderFooterHtml } from '../src/ui/footer'
import { renderBannerScaffoldHtml } from '../src/ui/banner'
import { headerTitle } from '../src/ui/model'

describe('frame shell', () => {
  it('renders header, viewer host, overlays, panels, and footer mounts', () => {
    const html = renderFrameHtml()
    expect(html).toContain('id="frame-header"')
    expect(html).toContain('id="viewer-host"')
    expect(html).toContain('id="banner-mount"')
    expect(html).toContain('id="tool-rail"')
    expect(html).toContain('id="edge-left"')
    expect(html).toContain('id="edge-right"')
    expect(html).toContain('id="left-panel"')
    expect(html).toContain('id="right-panel"')
    expect(html).toContain('id="frame-footer"')
  })

  it('keeps the tool rail an empty hidden shell this phase', () => {
    const html = renderFrameHtml()
    expect(html).toMatch(/id="tool-rail"[^>]*hidden/)
  })
})

describe('header', () => {
  it('shows the app title when no project is open', () => {
    expect(headerTitle(null)).toBe("Gunter's Workbench")
    expect(renderHeaderHtml(null)).toContain("Gunter&#39;s Workbench")
  })

  it('shows the project name when a project is open', () => {
    expect(headerTitle('North Site')).toBe('North Site Workbench')
  })

  it('offers 3D orbit / Top / Walk view modes and a reset control', () => {
    const html = renderHeaderHtml(null)
    expect(html).toContain('value="orbit"')
    expect(html).toContain('value="top"')
    expect(html).toContain('value="walk"')
    expect(html).toContain('Walk')
    expect(html).toContain('id="header-reset-view"')
  })

  it('is constant: no collapse or detach controls in the header (owner ruling)', () => {
    const html = renderHeaderHtml(null)
    expect(html).not.toContain('header-collapse')
    expect(html).not.toContain('header-detach')
    expect(html).not.toContain('Detach')
  })

  it('offers Import Point Cloud from the menu', () => {
    const html = renderHeaderHtml(null)
    expect(html).toContain('Import Point Cloud (LAS)')
  })

  it('renders Data Manager as a disabled planned menu item', () => {
    const html = renderHeaderHtml(null)
    expect(html).toContain('Data Manager (planned)')
  })
})

describe('footer', () => {
  const initial = { edl: true, showWithinFt: null, verticalExaggeration: 1, walkSpeed: 15, walkEyeHeight: 5 }

  it('renders the N/E/Z + units readout', () => {
    const html = renderFooterHtml(initial)
    expect(html).toContain('N --')
    expect(html).toContain('E --')
    expect(html).toContain('Z --')
    expect(html).toContain('units: --')
  })

  it('renders global dials with Show Within replacing Fog and the lighting dial as a disabled shell', () => {
    const html = renderFooterHtml(initial)
    expect(html).toContain('id="dial-edl"')
    expect(html).toContain('id="dial-show-within"')
    expect(html).toContain('id="footer-show-within"')
    expect(html).toContain('id="footer-show-within-number"')
    expect(html).toContain('Show within')
    expect(html).toContain('id="dial-ve"')
    expect(html).toMatch(/id="dial-light"[^>]*disabled/)
    expect(html).toContain('Planned - no engine lighting hook yet')
  })

  it('hides walk dials outside walk mode', () => {
    const html = renderFooterHtml(initial)
    expect(html).toMatch(/id="dial-speed"[^>]*hidden/)
    expect(html).toMatch(/id="dial-eye"[^>]*hidden/)
  })
})

describe('banner scaffold', () => {
  it('provides the two stacked channels: live task and view-state', () => {
    const html = renderBannerScaffoldHtml()
    expect(html).toContain('id="banner-task"')
    expect(html).toContain('id="banner-view-state"')
    expect(html).toContain('banner-task-bar')
  })
})
