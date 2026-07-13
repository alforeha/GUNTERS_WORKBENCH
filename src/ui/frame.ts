// src/ui/frame.ts - the persistent cockpit: header / viewer / footer scaffold,
// viewer overlays (banner, contextual tool rail, compass note), panel columns,
// and the mid-height edge buttons that open/close the panels.
//
// The compass/gizmo itself is rendered by ViewerEngine inside the canvas at the
// bottom-right (see src/viewer/gizmo.ts); the frame only guarantees nothing
// overlaps that corner.

export interface FrameRefs {
  headerMount: HTMLElement
  footerMount: HTMLElement
  leftPanelMount: HTMLElement
  rightPanelMount: HTMLElement
  viewerHost: HTMLElement
  bannerMount: HTMLElement
  toolRailMount: HTMLElement
  leftEdgeButton: HTMLButtonElement
  rightEdgeButton: HTMLButtonElement
  setLeftPanelOpen(open: boolean): void
  setRightPanelOpen(open: boolean): void
  isLeftPanelOpen(): boolean
  isRightPanelOpen(): boolean
}

export function renderFrameHtml(): string {
  return `
    <div class="frame">
      <header class="frame-header" id="frame-header"></header>
      <div class="frame-main" id="frame-main">
        <aside class="side-panel left-panel" id="left-panel" aria-label="Display Manager"></aside>
        <section class="viewer-wrap" id="viewer-wrap">
          <div id="viewer-host"></div>
          <div class="viewer-banner" id="banner-mount"></div>
          <div class="tool-rail" id="tool-rail" aria-label="Tool rail" hidden></div>
          <button class="edge-button edge-button-left" id="edge-left" title="Display Manager" aria-label="Toggle Display Manager">&#124;&lt;</button>
          <button class="edge-button edge-button-right" id="edge-right" title="Sim panel" aria-label="Toggle Sim panel">&gt;&#124;</button>
        </section>
        <aside class="side-panel right-panel" id="right-panel" aria-label="Sim panel"></aside>
      </div>
      <footer class="frame-footer" id="frame-footer"></footer>
    </div>
  `
}

export function mountFrame(app: HTMLElement): FrameRefs {
  app.innerHTML = renderFrameHtml()

  const headerMount = app.querySelector<HTMLElement>('#frame-header')
  const footerMount = app.querySelector<HTMLElement>('#frame-footer')
  const leftPanelMount = app.querySelector<HTMLElement>('#left-panel')
  const rightPanelMount = app.querySelector<HTMLElement>('#right-panel')
  const viewerWrap = app.querySelector<HTMLElement>('#viewer-wrap')
  const viewerHost = app.querySelector<HTMLElement>('#viewer-host')
  const bannerMount = app.querySelector<HTMLElement>('#banner-mount')
  const toolRailMount = app.querySelector<HTMLElement>('#tool-rail')
  const leftEdgeButton = app.querySelector<HTMLButtonElement>('#edge-left')
  const rightEdgeButton = app.querySelector<HTMLButtonElement>('#edge-right')

  if (
    !headerMount ||
    !footerMount ||
    !leftPanelMount ||
    !rightPanelMount ||
    !viewerWrap ||
    !viewerHost ||
    !bannerMount ||
    !toolRailMount ||
    !leftEdgeButton ||
    !rightEdgeButton
  ) {
    throw new Error('Frame mount failed')
  }

  let leftOpen = true
  let rightOpen = true

  function applyPanelState(): void {
    leftPanelMount!.classList.toggle('panel-closed', !leftOpen)
    rightPanelMount!.classList.toggle('panel-closed', !rightOpen)
    viewerWrap!.style.setProperty('--viewer-left-overlay-inset', leftOpen ? 'var(--panel-width)' : '0px')
    viewerWrap!.style.setProperty('--viewer-right-overlay-inset', rightOpen ? 'var(--panel-width)' : '0px')
    leftEdgeButton!.textContent = leftOpen ? '<|' : '|<'
    rightEdgeButton!.textContent = rightOpen ? '|>' : '>|'
    leftEdgeButton!.classList.toggle('edge-button-open', leftOpen)
    rightEdgeButton!.classList.toggle('edge-button-open', rightOpen)
  }

  leftEdgeButton.addEventListener('click', () => {
    leftOpen = !leftOpen
    applyPanelState()
  })
  rightEdgeButton.addEventListener('click', () => {
    rightOpen = !rightOpen
    applyPanelState()
  })
  applyPanelState()

  return {
    headerMount,
    footerMount,
    leftPanelMount,
    rightPanelMount,
    viewerHost,
    bannerMount,
    toolRailMount,
    leftEdgeButton,
    rightEdgeButton,
    setLeftPanelOpen(open) {
      leftOpen = open
      applyPanelState()
    },
    setRightPanelOpen(open) {
      rightOpen = open
      applyPanelState()
    },
    isLeftPanelOpen: () => leftOpen,
    isRightPanelOpen: () => rightOpen,
  }
}
