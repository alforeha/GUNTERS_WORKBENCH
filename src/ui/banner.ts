// src/ui/banner.ts - viewer top-left status banner on two stacked channels:
//   1. live task (progress label + optional pct bar; stays until the task ends)
//   2. view-state (the four-state truth disclosure lines)
// The channels stack instead of clobbering each other. When idle the view-state
// channel dims (never fully hides - truth must stay discoverable; hover restores
// full opacity) and the task channel fades out entirely once cleared.

import { escapeHtml } from './model'

const VIEW_STATE_DIM_DELAY_MS = 6000

export interface BannerApi {
  /** Live-task channel. Pass null when no task is running (fades out). */
  setTask(label: string | null, pct?: number | null): void
  /** View-state channel: one line per active disclosure. Empty array hides it. */
  setViewState(lines: string[]): void
  dispose(): void
}

export function renderBannerScaffoldHtml(): string {
  return `
    <div class="banner-channel banner-task" id="banner-task" hidden>
      <div class="banner-task-label" id="banner-task-label"></div>
      <div class="banner-task-bar" id="banner-task-bar" hidden><div class="banner-task-bar-fill" id="banner-task-bar-fill"></div></div>
    </div>
    <div class="banner-channel banner-view-state" id="banner-view-state" hidden></div>
  `
}

export function createBanner(mount: HTMLElement): BannerApi {
  mount.innerHTML = renderBannerScaffoldHtml()
  const taskEl = mount.querySelector<HTMLDivElement>('#banner-task')
  const taskLabelEl = mount.querySelector<HTMLDivElement>('#banner-task-label')
  const taskBarEl = mount.querySelector<HTMLDivElement>('#banner-task-bar')
  const taskBarFillEl = mount.querySelector<HTMLDivElement>('#banner-task-bar-fill')
  const viewStateEl = mount.querySelector<HTMLDivElement>('#banner-view-state')
  if (!taskEl || !taskLabelEl || !taskBarEl || !taskBarFillEl || !viewStateEl) {
    throw new Error('Banner mount failed')
  }

  let dimTimer: number | null = null
  let lastViewStateKey = ''

  function clearDimTimer(): void {
    if (dimTimer !== null) {
      window.clearTimeout(dimTimer)
      dimTimer = null
    }
  }

  function scheduleDim(): void {
    clearDimTimer()
    dimTimer = window.setTimeout(() => {
      viewStateEl?.classList.add('banner-dimmed')
    }, VIEW_STATE_DIM_DELAY_MS)
  }

  return {
    setTask(label, pct = null) {
      if (label === null || label.length === 0) {
        taskEl.classList.add('banner-fading')
        window.setTimeout(() => {
          if (taskEl.classList.contains('banner-fading')) {
            taskEl.hidden = true
            taskEl.classList.remove('banner-fading')
          }
        }, 450)
        return
      }
      taskEl.hidden = false
      taskEl.classList.remove('banner-fading')
      taskLabelEl.textContent = label
      if (pct !== null && Number.isFinite(pct)) {
        taskBarEl.hidden = false
        taskBarFillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`
      } else {
        taskBarEl.hidden = true
      }
    },

    setViewState(lines) {
      const key = lines.join('\n')
      if (lines.length === 0) {
        viewStateEl.hidden = true
        viewStateEl.innerHTML = ''
        lastViewStateKey = ''
        clearDimTimer()
        return
      }
      viewStateEl.hidden = false
      if (key !== lastViewStateKey) {
        lastViewStateKey = key
        viewStateEl.innerHTML = lines
          .map((line) => `<div class="banner-line">${escapeHtml(line)}</div>`)
          .join('')
        viewStateEl.classList.remove('banner-dimmed')
        scheduleDim()
      }
    },

    dispose() {
      clearDimTimer()
      mount.innerHTML = ''
    },
  }
}
