# Gunter's Workbench — UI/UX + Simulation Model Design Report

Status: **DESIGN DRAFT — settled with owner (AL) over a live design session, 2026-07-07.**
Scope: planning/design only. No code was changed. This report captures the
conceptual model and near-term UI direction agreed during the session, and hands
off to an implementation manager.

Manager phase name: **UI/UX + Simulation Model Design.**

---

## 0. How to read this

This is the settled output of a back-and-forth design session, not a top-down
spec. Where the owner deferred something to a later round it is marked
**LATER** or **AUTOMATION (deferred)**. Where a decision is firm it is stated
plainly. The model is deliberately **point-cloud-first**; other data types
(DXF, surface, imagery, PDF) are modeled consistently but will be detailed as
they become relevant.

Codebases / docs inspected to ground this design:

- `GUNTERS_WORKBENCH` — current desktop app. Read: `src/shared/manifest-schema.ts`,
  `src/shared/workbench-types.ts`, `src/main.ts` (UI shell), `src/style.css`,
  `_DOCS/REALITY_RENDER_PLAN.md`, `_DOCS/REALITY_RENDER_STAGE_COMPLETENESS_REVIEW.md`,
  and the surfel end-state decision trail.
- `GUNTERS_FIRST` — prior TIN Viewer / web deployment. Read: `src/ui/App.tsx`,
  `App.module.css`, the `left-panel/` and `right-panel/` component sets, and the
  TIN Viewer handoff docs. This is where the owner's layout instincts and the
  drape/DXF/surface prior art live.

Platform comparisons considered (for vocabulary and UX patterns only, not copied):
Blender (splittable/detachable editor areas, on-canvas gizmos, corner nav gizmo),
Cesium / Google Earth (floating compass, on-canvas controls), Autodesk ViewCube /
Civil 3D (orientation + CAD-layer familiarity for the survey audience),
VS Code / Figma (dockable / tear-off panels, collapsible chrome), CloudCompare /
Potree (asset-centered DB tree over point clouds). Guiding borrow: **Blender's
"the cockpit lives on the canvas; panels are removable furniture"** philosophy.

---

## 1. Core object model (the recommended model)

The existing manifest already implements the spine correctly and does **not**
need a rewrite. Confirmed in `manifest-schema.ts` / `workbench-types.ts`:

- `realitySimulation` is a **single, strict, top-level object** with no source
  file and no embedded membership IDs.
- Membership lives in **flat arrays keyed by `simulationId`**: `simulationLayers`,
  `features`, `reviewFlags`, `comparisonRefs`, `analysisResults`.
- **`truthStatus` lives on assets only**; layer lifecycle (`active | hidden |
  error`) is separate from truth.
- `simulationLayerKind` already distinguishes `asset | point-cloud-preview |
  point-cloud-index | derived-surface | derived-surfel`.

The design's job was to define the **UX model on top of that spine** and to
extend the **feature model** (which is currently only `marker | polyline |
measurement`). The core loop the whole app is built around:

> **File → Asset → added to the Sim as a role → hosts/authors Features →
> Features carry Reality + CAD + Report representations → Export re-crystallizes
> sim state into a new Asset.**

This is a closed loop with multiple entry points (import, extract, export).

### 1.0 Owner's framing (the mental model that governs everything)

- **The Sim is the environment and the workspace — not an assembly of assets.** It
  does not *contain* a TIN or a DWG. Its environment **has a surface**, and
  **"export surface" and "export DWG" are export functions/features** — outputs the
  sim can produce, not parts it is made of. Likewise the sim "isn't a DWG but it
  will have an export function."
- **All user consideration happens *to the Sim*.** Calcing points, drafting,
  defining regions — the user works on the sim. The sim is *what and where* user
  decisions are made.
- **Assets are databases.** Supplemental, standardized formats that sim components
  draw on to create themselves. They feed the sim; they are not the sim.
- **Near-term ignores the asset→sim rail.** We get the **user-created sim first**;
  generating the sim from assets is a later automation (§10).

### 1.1 The four terms (asset / asset layer / sim layer / feature)

- **Asset** = stored data the project has. Either imported evidence (LAS, DWG,
  LandXML/TIN, GeoTIFF, PDF) or generated/exported data (a WPI index, a surfel
  set, a sim-exported DWG or TIN). Assets are what the **left panel** manages.
  Assets are immutable-as-source or regenerable-as-derived; caches are disposable.
- **Asset layer** = a meaningful internal view *hosted by an asset*. A point
  cloud asset hosts preview / index / surfel / classification views. A DWG asset
  hosts CAD layers. A surface asset hosts triangles / edges / breaklines /
  boundaries. In the manifest, some of these are literally derived assets linked
  by `sourceAssetId`; in the UI they are presented **grouped under the source
  asset's card** (see §3).
- **Sim layer** = the Reality Simulation's *use of* an asset/view in the scene
  (a member row keyed by `simulationId`). "This cloud is shown," "this TIN is the
  ground," "this image drapes." Membership is a deliberate act, distinct from an
  asset merely existing.
- **Feature** = an interpreted / user- or system-authored object, area, line,
  surface, note, or measurement that can bridge the Reality Simulation, DWG,
  reports, and exports. Features are what the **right (Sim) panel** manages.

### 1.2 Assets appear to host their own layers in the UI — yes

The left panel presents an **asset-centered tree**: the collapsed card shows the
source asset (with a master on/off pill); the expanded card shows that asset's
own layers/views. This is purely a **presentation grouping** over the flat
manifest (source asset + its derived assets + their sim layers). The flat
implementation model and the asset-hosted UX model are reconciled by rendering
the flat records **grouped by `sourceAssetId`**. No schema change required.

### 1.3 View ≠ sim membership (settled)

The **left panel is a pure display/data manager**. Toggling an asset there means
"show this raw data in the viewer," not "this is part of the sim." The **sim has
simultaneous access to all project data**: the viewer shows cloud + sim (and any
other visible assets) at once, governed entirely by the left panel and honored by
**draw order** (surface faces → draped image → draped DWG linework → TIN edges →
points). When authoring, the user **snaps to whatever data is visible** — cloud
points, imported survey points, DXF elements alike. Some cloud points will
naturally render above/below sim geometry; that is expected. Being *used by* the
sim (this TIN is the ground; this DWG seeds features) is a separate explicit act
in the right panel.

---

## 2. Representations, not render twins (settled)

A **Simulation Feature owns multiple representations of one truth**, rather than
the app maintaining separate "Reality Render" and "DWG Render" scenes:

- **Reality representation** — material / color / mass / geometry shown in the sim.
- **CAD (DWG/plan) representation** — layer, color, linetype/lineweight, hatch
  pattern, block/symbol, point code — bound to project standards (§7).
- **Report representation** — area / quantity / count / note.
- **Export representation** — how it crystallizes when exported to an asset.

The Sim has exactly **two display modes: Sim OR DWG** (never both at once — same
principle as a cloud being colored RGB *or* classification, not both). If the
user wants reality + plan linework on screen together, they **export the sim to a
DWG asset** and manage it as an ordinary asset in the left panel. (Export is
near-term via "Export as assets"; live overlay of a sim-exported DWG is a natural
consequence, not a separate system.) The word "twin"/"doppelganger" is retired in
favor of **display mode** + **representations**.

Risk if representations drift: none by construction — there is one source object
(the feature) with derived views, so the Reality and CAD views cannot disagree
unless code lets them. Export snapshots are explicitly **sourced from the sim
state at export time** and thereafter live as independent assets.

---

## 3. Left panel — asset & layer manager (settled)

Pure display manager. **Tabbed by asset data type** (Point cloud, Surface,
DXF/CAD, Imagery, PDF). Only show tabs for types the project actually has.

**Row grammar (identical across all types):**

- Collapsed card = an **extension pill** (e.g. `LAS`, `DWG`) that acts as the
  **master on/off eye** + file name + brief details. Pill loses color + strikes
  through when off; the card dims.
- The **master pill controls whole-asset display and preserves sub-state**: if
  only the index layer was on, turning the asset off then on again restores
  index-only. It overrides but does not mutate per-layer visibility.
- Expanding a card **hides sibling cards** (accordion, one at a time).
- Expanded card = a **type-specific manager** (only the body differs):
  - **Point cloud:** Preview / Index / Surfel subsections, each with its **own**
    color mode, point size, and opacity sliders (surfel: scale + opacity). Plus a
    **shared Classification section** (class membership belongs to the points, not
    a single layer) grouped as **Ground/non-ground → Region classifications →
    Object classifications**, each class with visibility, a color control, and a
    point count; source classes read-only, workbench-added classes flagged. Color
    mode is **RGB *or* Classification** (intensity / elevation secondary) — one at
    a time. Not-yet-built layers (e.g. surfel before generation) show as disabled
    "Open to generate" rows so the capability is discoverable.
  - **DWG/CAD:** a CAD layer manager — element-type toggles (lines / hatches /
    blocks / text) + per-layer rows (visibility, color, linetype, lineweight).
  - **Surface/TIN:** faces / edges / breaklines / boundaries / contours toggles +
    material/drape.
  - **Imagery (GeoTIFF/PDF):** the raster + opacity / placement / crop.
- Expanded card footer: **Open** and **Remove**. **Remove requires a confirm
  catch.** **Open** pushes the asset's *work surface* into the right panel (see
  §5); it changes controls only and never changes what the viewer displays.

**Global vs per-layer controls (settled split):** per-layer (in the card) = color
mode, point size, opacity, surfel scale. Global (on the frame footer) = EDL, fog,
lighting, vertical exaggeration.

Panels are **optionally detachable** into their own windows (desktop). If a
detached panel is closed, its edge-button returns. This drives a hard rule: **all
always-needed controls live on the header/footer/viewer overlays, never only in a
panel** (§4).

---

## 4. The frame — header / viewer / footer (settled)

**Header (slim, collapsible):** menu button + title. Title reads
`Gunter's Workbench` when no project is open, and `[Project name] Workbench` when
one is. Menu = New / Open / About + **Data Manager (CAD templates, codelist /
standards)**. Right side = **camera view-mode dropdown (3D orbit / Top / Walk)** +
**reset view**, and a header-collapse toggle (collapsed keeps just menu button +
project name). Project *identity* stays in the header so it survives panel detach;
deeper project *settings* live behind the Data Manager menu.

**Viewer overlays (the cockpit):**

- **Top-left:** stacked status banners on **two channels** — a *live task* channel
  (loading / indexing / surfel build, with a real progress bar + ETA that stays
  put until the task finishes) and a *view-state* channel (disclosure text:
  source / indexed-full / preview-sampled / derived / stale / mixed). They stack
  instead of clobbering each other, and **fade away when nothing is loading or
  changing**. (This fixes the current single-string banner that navigation
  overwrites.)
- **Top-right, down the side:** the **create/edit tool rail**. Contextual — it
  shows the tools for whatever add-action was launched from the right panel (§5).
- **Bottom-right:** the **view compass/gizmo** (kept, floating).
- **Left & right edges (mid-height):** buttons to **open the panels** (which can
  then detach; buttons return if a detached panel is closed).

**Footer:** cursor **N / E / Z** readout + **units** on the left. On the right, a
**strip of small per-dial buttons** (VE, lighting, …) — clicking one reveals *that
one* slider; the strip is **camera-mode aware** (walk mode adds **speed** and
**eye-height** buttons next to the dials). No redundant mode badge (the header
owns camera mode).

**Empty state:** no project → header reads `Gunter's Workbench`, canvas is a
whole-window drop target ("drop a survey / CAD / raster / point cloud file"),
panels closed. (Carries over the whole-window drag-drop from `GUNTERS_FIRST`.)

**Parked frame ideas:** capture-video-along-a-walk-route (future walk-mode
feature). There is **no** saved-views or section/clip concept — explicitly not in
scope (an earlier import from the old brief that the owner rejected).

---

## 5. Right panel — the Sim + opened-asset work surface (settled)

The right panel is **controls**, never a driver of viewer display.

**Sim (default state):**

- Header: **master Sim visibility toggle** (show/hide all authored features as a
  group) + **Sim / DWG** display-mode switch.
- **Ground indicator strip** under the header: `Ground: compiled from regions` /
  `Ground: north_site TIN` / `not set`. Ground is a **sim-level derived property**,
  not a tab (see §6).
- **Tabbed by feature type:** Regions / Objects / Buildings / Utilities. Within a
  tab, features are **grouped by subtype with counts** (Lawn (3), Asphalt (2);
  Signs (5), Poles (4)).
- **+ Add [type]** initiates creation *from the panel*; this summons the matching
  toolset into the viewer's top-right tool rail (Add region → region tools; Add
  building → building tools). The panel drives creation, not the rail.
- Selecting a feature shows its **representations inline**: reality look, CAD
  standard binding, report value, plus **authorship** (user-created vs generated)
  and **sources** (any combination: cloud, survey points, DXF, imagery).
- **"…" menu (sim-level actions):** **Generate from assets** (the deferred
  automation) and **Export as assets** (generate DWG / TIN / texture from the sim).

**Opened asset work surface (e.g. LAS):** replaces the Sim in the panel with a
`‹ sim` back-out. It gives **editing/manipulation controls only**; the viewer is
untouched and the sim stays on. For the LAS it is mostly a **placeholder shell**
for now:

- **Generate (live):** Build/Rebuild **Index**, Generate/Regenerate **Surfels**
  (see §8 for the surfel-control decision), each with metrics.
- **Coming LATER (staged, visible-but-disabled):** **Classify points**,
  **Register to control points**, **Extract features (automation)**.

---

## 6. Surface / TIN model — surface falls out of regions (settled)

This is the key clarification of the session and it resolves the owner's
long-standing hesitation about the surface side.

**Proposed rule, validated: TIN / Surface = the ground model, not the total
reality model.** And crucially:

> **You never author a "surface" separately. You author regions, and the ground
> surface is what falls out.**

- A **Region** is an authored area with a boundary. It **starts as a border**;
  the user then **Adds breaklines** (centerline, ditch, grade breaks) to pull it
  onto the cloud where the border alone doesn't lie well. A region's boundary +
  breaklines, snapped to visible data, carry elevation — so each region is a **3D
  surface patch**, not a flat fill.
- **The sim does not "have" a TIN.** Its environment **has a surface**, compiled
  from the region patches. A **TIN is an export feature** ("export surface"), an
  output the sim produces on demand — not a component it holds. An **imported TIN
  asset** is a *database that feeds* the surface, not the sim's surface itself.
- **Ground surface = the compiled composite** of all ground-level region patches
  stitched along their shared edges (shared edges act as breaklines). Entry points,
  per the owner's recurring theme: **compiled from regions** (near-term), fed by an
  **imported TIN asset**, or later **extracted from a cloud** (deferred automation,
  §9/§10).
- **Objects and buildings are excluded** from the ground TIN — the footprint is an
  **exclusion zone** punched as a hole. A roof plane is its own surface patch, not
  part of the ground.
- **Curbs and walls = vertical breaklines** between regions at grade breaks.
- Cloud **classification informs but never *is* a feature** — region-classified
  points guide region boundaries; object-classified points guide object placement.

Answers to the brief's surface questions: a TIN is the **ground model**; it is a
**surface, and materials/regions are what carry appearance** (so it is "both"
only in the sense that regions are simultaneously surface and material — see §7);
material regions **drape by being the surface patch itself**, not by projecting
onto a foreign mesh; buildings/objects stay out via footprint exclusion; holes /
breaklines / exclusion zones are region-authored; roof planes differ from ground
by being separate patches; and user-approved regions are the surface — no separate
approval step.

---

## 7. Texture / material / hatch model (settled vocabulary: "region")

The owner's "texture" means **material/area representation**, not bitmap texture.
The project term is **Region** (a Region Classification on the cloud side; a
Region feature on the sim side). A region is one object with three faces:

- **Reality representation:** visual material / color / pattern.
- **DWG representation:** hatch / closed (or intentionally open) polyline / layer.
- **Report representation:** area / quantity / note.

Examples: grass, pavement/asphalt, gravel, dirt, concrete pad, landscape bed,
water, building-roof material. Region boundaries may be **left open** where the
data simply ends (e.g. a sidewalk that runs off the survey), and **closed** only
where the feature actually terminates.

Because a ground-level region *is* a surface patch (§6), authoring regions is
simultaneously authoring the **surface**, the **materials**, and (via export) the
**hatches**. This is why Regions are the heart of the Sim.

---

## 8. Object / cloud-mass / symbol model + surfel decision

**Object / Building / Utility features** each carry:

- **Evidence / sources:** point-cloud cluster (cloud mass), source points, imported
  survey points, DXF element, photo, or manual placement — any combination.
- **Authorship:** user-created or generated.
- **Reality representation:** 3D object / mass / billboard / procedural symbol /
  simple geometry.
- **DWG representation:** symbol / block / point / linework / footprint /
  annotation.
- **Surface behavior:** excluded from ground TIN (footprint), breakline influence,
  or ignored.
- **Report behavior:** inventory item / review flag / quantity / note.

**Building special case (validated model):** evidence = point-cloud mass / user
boundary / DWG linework; surface behavior = **footprint excluded from ground TIN**;
reality = **simple mass first**, optional faces / roof / decks / details later;
DWG = footprint + face line + overhang line + roof outline + optional block
metadata; report = building note / review item. Buildings get their own Sim tab
because they are a distinct, structured object class.

**Surfel generation decision (owner lean, recorded):** surfels are an
**abstraction / impression, not the model**. Direction: **remove the
generation-time `surfelCellScale` user control** and bake a single tuned default
that behaves like the more forgiving "Phase 4.5" sizing (better at absorbing
fuzz). Keep the **display-size slider** separate (it is already session-only and
display-only). More generation controls may return later. **Action for next
session (inspection, not implementation):** read `electron/analytic-surfel-builder.ts`
line-by-line and document exactly how current generation differs from 4.5 before
the tuning is locked.

---

## 9. Near-term implementation hit list (recommended order)

Point-cloud-first, display-focused, no new heavy engines:

1. **Frame restructure** — header (title logic, view-mode dropdown + reset,
   collapse) / viewer overlay cockpit / footer (N-E-Z + units + per-dial buttons).
   Move the banner into the viewer top-left with the two-channel live/ view-state
   model + fade.
2. **Left panel v1** — tabbed asset manager, type-pill master eye with state
   preservation, expandable point-cloud card (Preview / Index / Surfel subsections
   with per-layer color mode / size / opacity), shared Classification section
   (display + toggles only), Open/Remove with confirm.
3. **Right panel v1 (Sim)** — master toggle, Sim/DWG switch, ground indicator
   strip, feature tabs (Regions/Objects/Buildings/Utilities) grouped by subtype,
   +Add-by-type wiring into the tool rail, selected-feature representation view,
   "…" menu shell (Export as assets stubbed).
4. **Opened LAS work surface** — Index + Surfel generation moved here from the
   current toolbar buttons; placeholders for Classify / Register / Extract.
5. **Detachable panels** — edge-button open, tear-off to window, return-on-close.

## 10. Deferred / future roadmap (explicitly not now)

- **Automations:** Generate Sim from Assets, Extract TIN/ground from cloud
  ("identify ground points"), DWG → sim auto-populate, Extract features. Build
  order the owner wants: author manually → **Generate DWG from sim** (with a
  missing-standards warning list feeding the codelist) → *then* the reverse
  automations.
- **Classification editing tooling** (fence/lasso select, promote-to-class,
  derived-override store). Display of existing classes is near-term; editing is
  later.
- **Region authoring engine** depth (open/closed boundary logic, breakline
  solving, exclusion stitching) — modeled here, built after the panels land.
- **Other data types in depth:** ortho-mosaic-from-images, GeoTIFF vs raw field
  imagery handling, PDF planset vs written-deed distinction, DWG/DXF export engine.
- **Register cloud to control points.**
- **Project lifecycle architecture** — concept-to-delivery chain enabling bidding
  and tracking. Real and wanted, but downstream of the sim; reshapes the "project"
  object later.
- **Walk-mode capture-video-along-route.**
- Full TIN extraction algorithm, GIS/parcel/PLSS/NGS, work-order/reporting,
  estimating/tracking, image/photo manager, mobile assistant, cloud sync/accounts.

---

## 11. Risks / unresolved questions

- **Surfel generation vs 4.5** — exact current behavior not yet re-read at the
  builder level; tuning decision pending that inspection (§8).
- **Region authoring UX** — border-then-breakline flow is agreed in principle; the
  actual snapping / open-edge / breakline-solve interaction is unspecified and is
  the highest-risk net-new interaction.
- **Ground compilation semantics** — how region patches stitch (shared-edge
  breakline resolution, gaps, overlaps) needs an algorithm design pass before
  build; modeled but not solved.
- **Standards/codelist shape** — project-level standards + app-level texture /
  object templates are agreed to exist; their exact schema and editor are still to
  be designed (owner: "idk how that side plays yet").
- **Detach mechanics** — multi-window detach is desired; needs an Electron
  windowing approach that keeps the cockpit-on-frame rule intact.

---

## 12. Handoff

**Recommended next implementation manager:** a **UI/UX Display Implementation
Manager** to build the frame + left panel + right-panel shells (hit list items
1–4), point-cloud-first, display-focused, using the settled model here. Keep the
manifest spine as-is; extend the `feature` model toward the Region/Object/Building/
Utility taxonomy and representation set described in §1–§8.

**What should NOT be built yet:** any automation (generate/extract), classification
editing tooling, region compilation/stitching engine, DWG export engine, GIS/
parcel systems, work-order/reporting, project-lifecycle/bidding architecture,
photo manager, mobile, or cloud sync. Model them, stage them as visible-but-later,
do not implement.

---

## 13. Session roadmap (owner sequencing)

The owner's intended order of work after this design session:

1. **Moderate UI/UX session** — next. Tighten the frame + panel implementation
   direction (hit list §9 items 1–4) to an actionable spec.
2. **Create Sim design session** — its own design pass on sim authoring: what
   region/object/building/utility creation *could* and *should* do (snapping,
   border-then-breakline, open/closed edges, exclusions, representation binding).
   The owner explicitly wants to run this as a design session, not jump to build.
3. **Point-cloud finalize** — index + surfel appearance finalized, and the
   **point-cloud manager** stood up: classify points, register cloud to control
   points. **Still holding off point-cloud→sim** (extraction automation).
4. **Point management** — complete.
5. **DWG + other asset types** — later.

The asset→sim automations sit *after* a solid user-created sim exists; this whole
sequence gets the manual sim first.

---

## 14. Addendum — owner review updates (2026-07-09, after Display Implementation round 1)

Recorded here so the settled design stays honest; where this addendum conflicts
with earlier sections, the addendum wins.

- **Header is constant** (supersedes the collapsible header in section 4): menu
  button, workbench title, view-mode dropdown, reset view. No collapsed state.
- **Detach lives in the panels, not the header** (refines sections 3-4): each
  panel carries its own detach control (staged this phase); panels detach
  independently; closing a detached panel returns it to the edge-button state.
- **Panels overlay the viewer** (refines section 4): side panels float above the
  canvas at one third of the window width (min 320px), so the center screen
  never resizes or reflows - panels just show or don't.
- **Sim "..." menu is an export set** (supersedes part of section 5): Export
  all / Export asset maps / Export sim for the web viewer (eventual custom JSON
  snapshot, working name `.gsim`). **Generate from assets moves to the asset
  side** (an asset work-surface action), staying a deferred automation.
- **Import Point Cloud is a header-menu item** (in addition to the Display
  Manager's tab action).
- **Walk v2 direction (held for a dedicated task):** selecting Walk should
  prompt for what to walk - the Sim, a surface asset, or a point cloud - and
  cloud walking should ride the indexed data, anchored to the lowest/nearest
  point. Requires ViewerEngine support (point-based walk anchoring); explicitly
  out of the display phase. View-switching and Top-mode polish are further
  deferred until after Sim Creation / asset management.

**DESIGN MODEL READY — PREPARE UI/UX DISPLAY IMPLEMENTATION MANAGER**
