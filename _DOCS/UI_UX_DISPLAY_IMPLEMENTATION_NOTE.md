# UI/UX Display Implementation Note

Manager: UI/UX Display Implementation Manager.
Phase: UI/UX Display Implementation (first build phase after the UI/UX +
Simulation Model Design session).
Date: 2026-07-09.
Status: PASSED (implementer report + review round 1 + owner full test run).

This is the manager's record of the phase. Companion to the implementation report
(implementer-authored) and the design report/vocabulary addenda. Handoffs for this
phase were delivered inline to the implementer and review sessions, not stored as
documents, per owner preference.

---

## What was built

A new Workbench UI shell around the settled design model, point-cloud-first and
display-focused, with no regression to existing point cloud / index / surfel
behavior. src/main.ts was thinned from 793 lines to a 241-line bootstrap; the UI
was split into a src/ui/ module set (frame, header, footer, banner, leftPanel,
rightPanel, model, layers), all under the ~1000-line rule (largest: layers.ts at
795). Delivered: slim constant header (Menu, title, View dropdown, Reset view);
viewer cockpit overlays (two-channel banner top-left, tool-rail mount top-right,
compass bottom-right, edge panel buttons); footer with N/E/Z + units and per-dial
reveal controls; asset-centered left Display Manager with master pill + per-layer
appearance controls + Open/Remove; right Sim panel shell (master toggle, Sim/DWG
switch shell, ground strip, feature tabs by subtype, +Add shells, "..." export
shell); and a point cloud asset work surface.

## Owner rulings folded in during review round 1

1. Root-cause fix for the `hidden` bug: one global `[hidden] { display: none
   !important; }` rule in style.css, replacing the broken per-element handling that
   caused menu-open-on-start, the always-visible Sim "..." box, footer reveal
   sliders, and the tool-rail mount to misbehave (all one shared CSS-overrides-hidden
   cause).
2. Header is constant - collapse button and collapsed state removed. Detach removed
   from the header.
3. Detach is per-panel: each panel header (Display Manager, Sim, asset work surface)
   carries its own disabled "Detach" planned-pill. Model is independent per-panel
   float-in-window detach (deferred build).
4. Panels overlay the viewer as absolute overlays at max(320px, 33vw); the canvas
   never resizes or reflows. Edge buttons ride the open panel's inner edge so an open
   panel can always be closed.
5. Import Point Cloud (LAS) added to the header menu (Point Clouds tab button remains).
6. Sim "..." menu reworked: "Generate from assets" removed (it is an asset-side
   action, not a sim-side one); replaced with the staged export set - Export all,
   Export asset maps, Export sim for web viewer (.gsim) - all disabled shells.

## Verification (manager spot-check + owner run)

- Owner full suite: 294 passed (242 baseline + 52 UI), 28 files, 4.24s. No
  regressions.
- Manager code spot-checks confirmed: global [hidden] rule present; header has no
  collapse/detach; disabled/planned detach pills in left + right + work-surface;
  panels absolute-overlay; 5 new UI test files (ui-frame-shell, ui-display-manager,
  ui-sim-shell, ui-disclosure, ui-manifest-drift); no manifest schema drift (feature
  enum still marker|polyline|measurement); no non-ASCII in src/ui or style.css; all
  UI files under the ~1000-line rule.
- Owner-run visual check requested and folded: menu / "..." dropdowns toggle
  correctly; panels overlay without the viewer shifting.

## Decisions recorded

- Detach staged as disabled per-panel pills; float-in-window is the intended model,
  build deferred.
- Sim/DWG remains one display-mode selector shell over one feature model - no render
  twin introduced.
- Feature tabs, +Add, and export/generate are shells; no manifest schema types added.
- "Generate from assets" reframed as asset-side and removed from the Sim menu.

## Hold items carried forward (not this phase)

- Walk v2: walk by Sim / surface / cloud with indexed-data lowest-nearest anchoring.
  Needs ViewerEngine work; scoped as its own task.
- View-switch / Top polish: deferred to after Sim Creation.
- Exported-TIN-as-asset and a possible left-panel Sim tab: design work for the Sim
  Creation stage.

## Next manager

Create Sim Design Manager - define the user-authored simulation model (feature
library, regions, objects, buildings, utilities, ground surface model, feature
creation UX, and the reality / CAD-DWG / report-export representations). Do not
start Create Sim implementation before that design pass.
