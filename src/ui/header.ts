// src/ui/header.ts - slim, constant header (owner ruling 2026-07-09: no
// collapsed/expanded states): menu button + title on the left, camera
// view-mode dropdown + reset on the right. Detach lives in the panels, not
// here. Project identity stays here so it survives panel close/detach.

import { escapeHtml, headerTitle } from './model'

export type HeaderCameraMode = 'orbit' | 'top' | 'walk'

export interface HeaderDeps {
  onMenuAction(action: HeaderMenuAction): void
  onCameraModeRequested(mode: HeaderCameraMode): void
  onResetView(): void
}

export type HeaderMenuAction =
  | 'new-project'
  | 'open-project'
  | 'save-project'
  | 'close-project'
  | 'import-pointcloud'
  | 'record-unit-warning'
  | 'placeholder-derived-surface'
  | 'about'

export interface HeaderApi {
  setProjectName(name: string | null): void
  setCameraMode(mode: HeaderCameraMode): void
  getCameraMode(): HeaderCameraMode
}

interface MenuItem {
  action?: HeaderMenuAction
  label: string
  disabled?: boolean
  hint?: string
  separatorBefore?: boolean
}

const MENU_ITEMS: MenuItem[] = [
  { action: 'new-project', label: 'New Project' },
  { action: 'open-project', label: 'Open Project' },
  { action: 'save-project', label: 'Save' },
  { action: 'close-project', label: 'Close Project' },
  { action: 'import-pointcloud', label: 'Import Point Cloud (LAS)', separatorBefore: true },
  { action: 'record-unit-warning', label: 'Record Unit Warning (debug)', separatorBefore: true },
  { action: 'placeholder-derived-surface', label: 'Placeholder Derived Surface (debug)' },
  { label: 'Data Manager (planned)', disabled: true, hint: 'CAD templates and codelist standards arrive later', separatorBefore: true },
  { action: 'about', label: 'About' },
]

export function renderHeaderHtml(projectName: string | null): string {
  const menuItemsHtml = MENU_ITEMS.map((item, i) => {
    const sep = item.separatorBefore ? '<div class="menu-separator"></div>' : ''
    const disabledAttr = item.disabled ? ' disabled title="' + escapeHtml(item.hint ?? 'Planned') + '"' : ''
    return `${sep}<button class="menu-item" data-menu-index="${i}"${disabledAttr}>${escapeHtml(item.label)}</button>`
  }).join('')

  return `
    <button class="header-menu-button" id="header-menu-button" title="Menu" aria-label="Menu">Menu</button>
    <div class="header-menu-dropdown" id="header-menu-dropdown" hidden>${menuItemsHtml}</div>
    <div class="header-title" id="header-title">${escapeHtml(headerTitle(projectName))}</div>
    <div class="header-right" id="header-right">
      <label class="header-view-mode">View
        <select id="header-camera-mode">
          <option value="orbit">3D orbit</option>
          <option value="top">Top</option>
          <option value="walk">Walk (basic)</option>
        </select>
      </label>
      <button id="header-reset-view" title="Reframe to content bounds">Reset view</button>
    </div>
  `
}

export function mountHeader(mount: HTMLElement, deps: HeaderDeps): HeaderApi {
  mount.innerHTML = renderHeaderHtml(null)

  const menuButton = mount.querySelector<HTMLButtonElement>('#header-menu-button')
  const dropdown = mount.querySelector<HTMLDivElement>('#header-menu-dropdown')
  const titleEl = mount.querySelector<HTMLDivElement>('#header-title')
  const cameraSelect = mount.querySelector<HTMLSelectElement>('#header-camera-mode')
  const resetButton = mount.querySelector<HTMLButtonElement>('#header-reset-view')
  if (!menuButton || !dropdown || !titleEl || !cameraSelect || !resetButton) {
    throw new Error('Header mount failed')
  }

  let currentMode: HeaderCameraMode = 'orbit'

  menuButton.addEventListener('click', (event) => {
    event.stopPropagation()
    dropdown.hidden = !dropdown.hidden
  })
  document.addEventListener('click', (event) => {
    if (!dropdown.hidden && !dropdown.contains(event.target as Node)) dropdown.hidden = true
  })
  dropdown.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.menu-item')
    if (!target || target.disabled) return
    dropdown.hidden = true
    const item = MENU_ITEMS[Number(target.dataset.menuIndex)]
    if (item?.action) deps.onMenuAction(item.action)
  })

  cameraSelect.addEventListener('change', () => {
    deps.onCameraModeRequested(cameraSelect.value as HeaderCameraMode)
  })
  resetButton.addEventListener('click', () => deps.onResetView())

  return {
    setProjectName(name) {
      titleEl.textContent = headerTitle(name)
    },
    setCameraMode(mode) {
      currentMode = mode
      cameraSelect.value = mode
    },
    getCameraMode: () => currentMode,
  }
}
