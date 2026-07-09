# UI/UX Display Implementation - Implementer Report

Status: **IMPLEMENTED - awaiting review agent + owner acceptance.**
Date: 2026-07-09.
Controlling references: `_DOCS/UI_UX_SIMULATION_MODEL_DESIGN_REPORT.md`,
`_DOCS/GUNTERS_SIMULATION_VOCABULARY.md`.

Scope delivered: the frame (slim collapsible header / viewer cockpit overlays /
footer strip), asset-centered left Display Manager, right Sim panel shell,
per-layer appearance controls, and the point-cloud asset work surface - with
all existing point cloud / index / surfel behavior preserved. No simulation
generation, extraction, classification editing, DWG export, or other
out-of-scope systems were built; everything staged is visibly disabled and
labeled "planned"/"later".

---

## 1. What was implemented, per phase

### Phase 1 - Frame shell
- `src/main.ts` is now a thin bootstrap (231 lines). The old innerHTML shell is
  gone; `src/ui/frame.ts` mounts header / main row (left panel, viewer wrap,
  right panel) / footer.
- Viewer overlays: top-left banner mount, top-right contextual tool-rail mount
  (empty, hidden shell), mid-height left/right edge buttons that open/close the
  panels, and a bottom-center walk-hint element. The compass/gizmo was NOT
  rebuilt - `ViewerEngine` already renders it inside the canvas at the
  bottom-right (scissored viewport, `src/viewer/gizmo.ts`); the frame keeps
  that corner clear.
- Header: menu button (New / Open / Save / Close, debug items, Data Manager
  planned-disabled, About), title (`Gunter's Workbench` / `[Project] Workbench`),
  view-mode dropdown, Reset view, DETACH button rendered visibly disabled with
  a "planned - float-in-window" tooltip, and a collapse toggle (collapsed =
  menu + title + the collapse toggle itself, so it can be reopened).
- Panels are flex columns, not overlays, so the canvas is never obscured; the
  engine's own ResizeObserver handles panel open/close resizes.

### Phase 2 - Header navigation
- 3D orbit -> `setCameraMode('orbit')`, Top -> `setCameraMode('top')`, Reset ->
  `resetView()`.
- Walk is labeled **Walk (basic)** and uses an armed-entry flow: selecting Walk
  shows a hint ("click a surface point in the viewer to start; X exits"); a
  true click (not a drag; 5px threshold) attempts `enterHoverAtPointer(eyeHeight)`.
  On failure the hint honestly reports that Walk needs a surface (the engine's
  `pickActiveSurfaceAtPointer` raycasts surfaces only - point clouds cannot
  anchor Walk yet). Escape cancels arming; the engine's X-key exit
  (`onRequestExitHover`) returns to the previous mode.
- Footer walk dials (speed, eye height) appear only in Walk mode and stay in
  sync with the engine's wheel/Q/E adjustments via `onHoverSpeedChange` /
  `onHoverHeightChange`.

### Phase 3 - Left Display Manager
- Tabs in priority order: Point Clouds, Surfaces/TINs, Drawings, Documents,
  Images, GIS. Only Point Clouds has real content; the rest are visibly-empty
  placeholders - EXCEPT Surfaces/TINs, which shows a minimal card (name +
  truth badge + visibility toggle) when a derived-surface asset exists. That is
  a deliberate deviation from "placeholder only": the placeholder-derived-
  surface layer is existing behavior and hiding its toggle would be a
  regression against the "keep all current behavior" bar.
- Asset-centered accordion cards over the flat manifest (grouped by
  `sourceAssetId` via `resolveLayerKind` + the registries; presentation-only,
  no schema change). Collapsed card = extension pill (master eye) + name +
  brief detail + truth badge. Pill strikes through / loses color and the card
  dims when off.
- Master pill preserves per-layer sub-state: remembered visibility lives in UI
  memory (`masterMemory` in the controller); off hides active layers, on
  restores the exact remembered set (default all non-error views on). All
  writes route through the one `setLayerVisibility` path (batched:
  `setLayersVisibility` does one manifest write + one save for a master toggle).
- Asset-hosted views under the card: Preview points (preview-sampled), Indexed
  points (indexed-full), Surfels (derived). Not-yet-built index/surfel show as
  disabled "Open this asset to build/generate" rows for discoverability.
  Classification renders as a disabled "none detected (display planned)" row -
  no asset metadata carries class data today, so nothing pretends to.
- Card footer: **Open** (pushes the work surface into the right panel and opens
  it; viewer untouched) and **Remove** with an inline confirm catch. Confirmed
  remove deletes the asset + its derived assets (linked by `sourceAssetId`) +
  their simulation layers from the manifest and unloads their viewer handles.
  The confirm text discloses that files on disk are not deleted.

### Phase 4 - Per-layer appearance controls
- Per view row (expanded card): visibility, color mode (RGB / Elevation /
  Intensity, plus a disabled "Classification (planned)" option - one-at-a-time
  selection), point size (preview/index), surfel scale (surfel row). Wired
  through the existing per-handle engine setters (`setPointCloudDisplayMode`,
  `setPointCloudIndexDisplayMode`, `setPointCloudDisplay`,
  `setPointCloudIndexDisplay`, `setAnalyticSurfelsDisplay`), mirroring the old
  global handlers per-card.
- Per-layer opacity: **disabled shell** - the engine exposes no per-layer
  opacity hook for point clouds/surfels.
- Footer globals: EDL -> `setPointCloudEdl`, fog -> `setPointCloudFog`, VE ->
  `setVerticalExaggeration`. **Lighting dial is a disabled shell** per the
  handoff (note for the manager: `ViewerEngine.setSun(azimuthDeg, altitudeDeg)`
  does exist publicly and could power this dial later; the handoff said shell,
  so shell it is - flagging the hook rather than guessing).
- **PERSISTENCE DECISION (recorded):** per-layer display size / color mode /
  surfel scale are **session-only**. Persisting them would require new manifest
  fields (a schema/shape change) precisely when the phase contract is "no
  manifest writes beyond existing status writes". They reset to defaults
  (RGB / size 2 / scale 2) per session; revisit when a display-settings home in
  the manifest is designed deliberately.

### Phase 5 - Right Sim panel shell
- Defaults to the Sim surface: master Sim visibility toggle (UI memory only,
  honestly captioned with the authored-feature count - nothing renders yet),
  Sim/DWG switch as a **one-option shell** (Sim active; DWG disabled with a
  tooltip stating it is a display-mode selector over one feature model, never a
  second render scene), ground strip (`Ground: not set`), feature tabs Regions /
  Objects / Buildings / Utilities / Lines-Breaklines / Notes-Flags /
  Measurements. Legacy `marker | polyline | measurement` records map onto the
  last three tabs as read-only counts; the taxonomy tabs are zero-count shells.
- Every "+ Add [type]" is disabled "(planned)". The "..." menu stages
  "Generate from assets (planned)" and "Export as assets (planned)" as disabled
  items. No feature is created; no schema types added.

### Phase 6 - Opened-asset work surface
- Open on a point cloud card swaps the right panel to the asset detail surface
  with a `< Sim` back control. Shows: name + truth badge, type, copy/reference
  import policy, source/managed paths, units, point count + LAS version + PDRF
  + file size, bounds, asset warnings, index status (WPI version, point count,
  generated-at, staleness from the managed stale-index warnings), and surfel
  status (count, version, generated-at, staleness by comparing the surfel's
  recorded source `headerSha256` against the current source asset's).
- Live actions here: **Build/Rebuild index** and **Generate/Regenerate surfels**
  (the old toolbar buttons moved home; same IPC flows, `DEFAULT_SURFEL_CELL_SCALE`
  untouched). Classify points / Register to control points / Extract features
  are visible-but-disabled "later" rows. Opening changes controls only; the
  viewer is never touched. If the opened asset is removed, the panel falls back
  to the Sim surface.

### Phase 7 - Tests
49 new cases across 5 node-environment files (no DOM/Electron/three runtime -
the UI modules expose pure view-model builders and HTML-string renderers,
which is what the tests assert against). Existing ~245 tests untouched.

### Truth & disclosure
The four-state disclosure moved into the banner's view-state channel intact:
preview lines say "truth preview-sampled; source asset remains source" (with
the mixed "source densification fallback" variant), index lines wrap the
engine's streaming text with "truth indexed-full; source asset remains source",
surfel lines pass through the engine's "derived ... not measured points" text.
The 300ms streaming refresh loop carried over. The `truth-*` badge CSS classes
carried over verbatim and now appear on asset cards, view rows, and the work
surface. Banner behavior: the task channel fades out when a task ends; the
view-state channel dims to 35% opacity after 6s idle but stays readable and
restores on hover/change - truth never fully disappears while layers are
displayed (interpretation of "fades when idle" reconciled with "truth stays
visible").

---

## 2. Shells / disabled (and why)

| Control | State | Why |
| --- | --- | --- |
| Detach panel (header) | disabled, "planned" | Real detach is a later follow-up; target is float-in-window |
| Data Manager (menu) | disabled, "planned" | Standards/codelist schema not designed yet |
| Lighting dial (footer) | disabled, "planned" | Handoff ruling; note `setSun()` exists for later |
| Per-layer opacity | disabled, "planned" | No engine hook for point-cloud/surfel opacity |
| Classification (color mode + section) | disabled, "planned" | No class metadata on assets; display tooling later |
| Sim/DWG switch | one-option shell | Representations not built; must never spawn a render twin |
| + Add [feature type] | disabled, "planned" | Feature creation is the Create Sim phase |
| Generate from assets / Export as assets | disabled, "planned" | Deferred automations |
| Classify / Register / Extract (work surface) | disabled, "later" | Point-cloud manager phase |
| Tool rail (top-right) | empty hidden mount | Populated when +Add wiring lands |
| Walk | functional-but-basic, honest failure | Engine anchors Walk on surfaces only; labeled "Walk (basic)" |

## 3. New/changed files (line counts - 1000-line rule held)

New: `src/ui/model.ts` 580, `src/ui/layers.ts` 795, `src/ui/leftPanel.ts` 378,
`src/ui/rightPanel.ts` 252, `src/ui/footer.ts` 176, `src/ui/header.ts` 129,
`src/ui/frame.ts` 115, `src/ui/banner.ts` 106, `src/ui/panels.css` 425,
`tests/ui-fixtures.ts` 226, `tests/ui-display-manager.test.ts` 164,
`tests/ui-manifest-drift.test.ts` 123, `tests/ui-sim-shell.test.ts` 121,
`tests/ui-frame-shell.test.ts` 96, `tests/ui-disclosure.test.ts` 45.
Rewritten: `src/main.ts` 793 -> 231, `src/style.css` 204 -> 441.
`ViewerEngine.ts` untouched (per handoff). All ASCII; no non-ASCII anywhere in
the new code (the old UI strings' middle-dot separators became "-").

## 4. Manifest-shape changes

**None.** The UI writes are: layer `status` + `modifiedAt` (the existing write,
now via the pure `applyLayerStatusUpdates` / `applyLayerErrorStatus` helpers)
and the disclosed Remove path (deletes asset + derived-asset + layer records;
removes records, adds/renames nothing). `tests/ui-manifest-drift.test.ts`
asserts both and that all view-model builders are read-only over a deep-frozen
manifest. Session-only appearance state never touches the manifest.

## 5. Surprises found in the existing code

- `ViewerEngine.setSun(azimuthDeg, altitudeDeg)` IS public despite the handoff
  saying there is no lighting hook - left as a shell per instructions, but the
  footer lighting dial has a real hook available when wanted.
- Walk/hover entry (`pickActiveSurfaceAtPointer`) and the cursor N/E/Z readout
  raycast **surfaces only** - with a cloud-only scene, Walk cannot anchor and
  the footer readout stays blank. Both are surfaced honestly in the UI; a
  point-pick path would be an engine follow-up.
- `onCursorPosition` emits `{ e, n, z } | null` in original survey coordinates
  (confirmed in-file, as the handoff required).
- The gizmo is not a DOM overlay - it is a scissored second render pass inside
  the canvas, already bottom-right. Nothing to move; the frame just keeps the
  corner clear.
- The placeholder-derived-surface generator was only reachable through the old
  "Generate Surfel Layer" button when no point-cloud asset existed; it now has
  an explicit debug menu item so the behavior stays reachable.

## 6. Tests the owner should run

New UI tests (already run here, 49/49 green, ~0.4s):

```
npx vitest run tests/ui-frame-shell.test.ts tests/ui-display-manager.test.ts tests/ui-manifest-drift.test.ts tests/ui-disclosure.test.ts tests/ui-sim-shell.test.ts
```

Full regression (owner-run): `npm run test` (the ~245 baseline + 49 new =
expected ~294). Also recommended: `npx tsc --noEmit` (clean here),
`npx eslint src electron --ext .ts` (clean here), and a manual smoke pass:
open the existing project, confirm preview/index/surfel display + toggles,
disclosure banner, index/surfel rebuild from the work surface, and
close/reopen.

---

## 7. Owner review round 1 (2026-07-09) - fixes applied

Owner ran the full suite (291/291 green: 242 baseline + 49 new) and reviewed
the build. Findings and fixes:

1. **`hidden` attribute ignored (the one real bug).** The header menu appeared
   open on app start and would not close, and the sim "..." dropdown stayed
   visible. Root cause: author CSS `display: flex` on those elements overrides
   the browser's built-in `[hidden] { display: none }`. Fixed with a global
   `[hidden] { display: none !important; }` in `src/style.css`, which also
   repaired the footer reveal sliders and the (empty) tool-rail mount.
2. **Header is now constant** - collapse button and collapsed/expanded states
   removed. Header: menu, workbench title, view dropdown, reset view.
3. **Detach moved out of the header** into each panel's own header as a staged
   disabled "Detach" pill (per-panel independent detach is the future model).
4. **Panels are overlays** - side panels now float above the viewer at
   `max(320px, 33vw)` wide; the canvas never resizes or reflows when panels
   open/close. Edge buttons ride the open panel's inner edge (z-index above
   the panels) so panels can always be closed.
5. **Import Point Cloud (LAS)** added to the header menu (the Display Manager
   tab button remains).
6. **Sim "..." menu reworked** - "Generate from assets" removed (owner ruling:
   it is an asset-side action); replaced with a staged export set: Export all /
   Export asset maps / Export sim for web viewer (`.gsim`, eventual custom JSON
   snapshot) - all disabled shells.
7. Tests updated for 2/3/5/6 (52 UI cases now). Design report addendum
   (section 14) and vocabulary entries updated to record the owner decisions.

## 8. Hold items (owner-approved, NOT in this round)

- **Walk v2 - walk by asset or sim:** selecting Walk should prompt for what to
  walk (Sim / surface asset / point cloud); cloud walking should use the
  indexed data anchored to the lowest/nearest point. Requires ViewerEngine
  work (point-based walk anchoring; hover entry currently raycasts surfaces
  only). Scoped as a dedicated follow-up task.
- **View-switching and Top-mode polish:** owner has notes; deferred until
  after the Sim Creation stage or asset management lands.
- **Left-panel Sim tab / exported-TIN-as-asset flow:** exported TINs will be
  treated as ordinary assets ("imported from sim", edits isolated from sim
  data); a possible Sim tab in the Display Manager is design work for the Sim
  Creation stage. No change made now - the current minimal Surfaces card
  already treats surfaces as assets.
