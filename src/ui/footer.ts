// src/ui/footer.ts - frame footer strip: cursor N/E/Z + units readout on the
// left; on the right a strip of small per-dial buttons - clicking one reveals
// that one control. Camera-mode aware: Walk adds speed and eye-height dials.
// Global display controls live here (EDL / fog / VE); lighting is a disabled
// shell this phase because the engine exposes no public lighting toggle hook.

export interface FooterDeps {
  setEdl(on: boolean): void
  setFog(on: boolean): void
  setVerticalExaggeration(k: number): void
  setWalkSpeed(value: number): void
  setWalkEyeHeight(value: number): void
}

export interface FooterInitialState {
  edl: boolean
  fog: boolean
  verticalExaggeration: number
  walkSpeed: number
  walkEyeHeight: number
}

export interface FooterApi {
  setCursor(pos: { e: number; n: number; z: number } | null): void
  setUnits(label: string): void
  setCameraMode(mode: 'orbit' | 'top' | 'walk'): void
  syncWalkSpeed(value: number): void
  syncWalkEyeHeight(value: number): void
  getWalkEyeHeight(): number
}

export const DEFAULT_WALK_EYE_HEIGHT = 5
export const DEFAULT_WALK_SPEED = 15

export function renderFooterHtml(initial: FooterInitialState): string {
  return `
    <div class="footer-readout" id="footer-readout">
      <span class="footer-coord" id="footer-n">N --</span>
      <span class="footer-coord" id="footer-e">E --</span>
      <span class="footer-coord" id="footer-z">Z --</span>
      <span class="footer-units" id="footer-units">units: --</span>
    </div>
    <div class="footer-reveal" id="footer-reveal" hidden>
      <label class="footer-slider" id="footer-slider-ve" hidden>VE
        <input id="footer-ve" type="range" min="1" max="3" step="0.05" value="${initial.verticalExaggeration}" />
        <span class="footer-slider-value" id="footer-ve-value">${initial.verticalExaggeration.toFixed(2)}x</span>
      </label>
      <label class="footer-slider" id="footer-slider-speed" hidden>Speed
        <input id="footer-walk-speed" type="range" min="1" max="60" step="1" value="${initial.walkSpeed}" />
        <span class="footer-slider-value" id="footer-walk-speed-value">${initial.walkSpeed}</span>
      </label>
      <label class="footer-slider" id="footer-slider-eye" hidden>Eye height
        <input id="footer-walk-eye" type="range" min="2" max="60" step="0.5" value="${initial.walkEyeHeight}" />
        <span class="footer-slider-value" id="footer-walk-eye-value">${initial.walkEyeHeight}</span>
      </label>
    </div>
    <div class="footer-dials" id="footer-dials">
      <button class="footer-dial${initial.edl ? ' dial-on' : ''}" id="dial-edl" title="Depth shading (EDL-like)">EDL</button>
      <button class="footer-dial${initial.fog ? ' dial-on' : ''}" id="dial-fog" title="Distance fog">Fog</button>
      <button class="footer-dial planned-control" id="dial-light" disabled title="Planned - no engine lighting hook yet">Light</button>
      <button class="footer-dial" id="dial-ve" title="Vertical exaggeration">VE</button>
      <button class="footer-dial walk-only" id="dial-speed" title="Walk speed" hidden>Speed</button>
      <button class="footer-dial walk-only" id="dial-eye" title="Walk eye height" hidden>Eye</button>
    </div>
  `
}

export function mountFooter(mount: HTMLElement, deps: FooterDeps, initial: FooterInitialState): FooterApi {
  mount.innerHTML = renderFooterHtml(initial)

  const q = <T extends HTMLElement>(selector: string): T => {
    const el = mount.querySelector<T>(selector)
    if (!el) throw new Error(`Footer mount failed: ${selector}`)
    return el
  }

  const nEl = q<HTMLSpanElement>('#footer-n')
  const eEl = q<HTMLSpanElement>('#footer-e')
  const zEl = q<HTMLSpanElement>('#footer-z')
  const unitsEl = q<HTMLSpanElement>('#footer-units')
  const revealEl = q<HTMLDivElement>('#footer-reveal')
  const dialEdl = q<HTMLButtonElement>('#dial-edl')
  const dialFog = q<HTMLButtonElement>('#dial-fog')
  const dialVe = q<HTMLButtonElement>('#dial-ve')
  const dialSpeed = q<HTMLButtonElement>('#dial-speed')
  const dialEye = q<HTMLButtonElement>('#dial-eye')
  const veSlider = q<HTMLLabelElement>('#footer-slider-ve')
  const speedSlider = q<HTMLLabelElement>('#footer-slider-speed')
  const eyeSlider = q<HTMLLabelElement>('#footer-slider-eye')
  const veInput = q<HTMLInputElement>('#footer-ve')
  const veValue = q<HTMLSpanElement>('#footer-ve-value')
  const speedInput = q<HTMLInputElement>('#footer-walk-speed')
  const speedValue = q<HTMLSpanElement>('#footer-walk-speed-value')
  const eyeInput = q<HTMLInputElement>('#footer-walk-eye')
  const eyeValue = q<HTMLSpanElement>('#footer-walk-eye-value')

  let edlOn = initial.edl
  let fogOn = initial.fog
  let openDial: 've' | 'speed' | 'eye' | null = null

  function applyReveal(): void {
    veSlider.hidden = openDial !== 've'
    speedSlider.hidden = openDial !== 'speed'
    eyeSlider.hidden = openDial !== 'eye'
    revealEl.hidden = openDial === null
    dialVe.classList.toggle('dial-open', openDial === 've')
    dialSpeed.classList.toggle('dial-open', openDial === 'speed')
    dialEye.classList.toggle('dial-open', openDial === 'eye')
  }

  function toggleReveal(dial: 've' | 'speed' | 'eye'): void {
    openDial = openDial === dial ? null : dial
    applyReveal()
  }

  dialEdl.addEventListener('click', () => {
    edlOn = !edlOn
    dialEdl.classList.toggle('dial-on', edlOn)
    deps.setEdl(edlOn)
  })
  dialFog.addEventListener('click', () => {
    fogOn = !fogOn
    dialFog.classList.toggle('dial-on', fogOn)
    deps.setFog(fogOn)
  })
  dialVe.addEventListener('click', () => toggleReveal('ve'))
  dialSpeed.addEventListener('click', () => toggleReveal('speed'))
  dialEye.addEventListener('click', () => toggleReveal('eye'))

  veInput.addEventListener('input', () => {
    const k = Number(veInput.value)
    veValue.textContent = `${k.toFixed(2)}x`
    deps.setVerticalExaggeration(k)
  })
  speedInput.addEventListener('input', () => {
    const v = Number(speedInput.value)
    speedValue.textContent = `${v}`
    deps.setWalkSpeed(v)
  })
  eyeInput.addEventListener('input', () => {
    const v = Number(eyeInput.value)
    eyeValue.textContent = `${v}`
    deps.setWalkEyeHeight(v)
  })

  const formatCoord = (value: number): string => value.toFixed(2)

  return {
    setCursor(pos) {
      nEl.textContent = pos ? `N ${formatCoord(pos.n)}` : 'N --'
      eEl.textContent = pos ? `E ${formatCoord(pos.e)}` : 'E --'
      zEl.textContent = pos ? `Z ${formatCoord(pos.z)}` : 'Z --'
    },
    setUnits(label) {
      unitsEl.textContent = `units: ${label}`
    },
    setCameraMode(mode) {
      const walk = mode === 'walk'
      dialSpeed.hidden = !walk
      dialEye.hidden = !walk
      if (!walk && (openDial === 'speed' || openDial === 'eye')) {
        openDial = null
        applyReveal()
      }
    },
    syncWalkSpeed(value) {
      speedInput.value = `${value}`
      speedValue.textContent = `${Math.round(value)}`
    },
    syncWalkEyeHeight(value) {
      eyeInput.value = `${value}`
      eyeValue.textContent = `${value}`
    },
    getWalkEyeHeight: () => Number(eyeInput.value),
  }
}
