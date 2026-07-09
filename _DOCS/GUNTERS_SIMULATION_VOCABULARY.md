# Gunter's Simulation Vocabulary

Companion to `_DOCS/UI_UX_SIMULATION_MODEL_DESIGN_REPORT.md`. This is the shared
project vocabulary settled with the owner (AL) on 2026-07-07. When a word here
conflicts with informal usage, this file wins. Terms are grouped, not
alphabetized, so related ideas sit together.

---

## The core loop

**File → Asset → added to the Sim as a role → hosts/authors Features → Features
carry Reality + CAD + Report representations → Export re-crystallizes sim state
into a new Asset.** A closed loop with multiple entry points (import, extract,
export).

---

## Data-side terms

**Asset** — Stored data the project has. Either imported evidence (LAS, DWG,
LandXML/TIN, GeoTIFF, PDF) or generated/exported data (a WPI index, a surfel set,
a sim-exported DWG or TIN). **Assets are databases** — supplemental, standardized
formats that sim components draw on to create themselves. They *feed* the sim;
they are not the sim, and the user does not work "on" an asset the way they work on
the sim. Managed in the **left panel**. Sources are immutable; derived assets are
regenerable; caches are disposable.

**Asset layer** — A meaningful internal view *hosted by* an asset, shown inside
its expanded card. Point cloud: preview / index / surfel / classification.
DWG: CAD layers. Surface: triangles / edges / breaklines / boundaries. Some asset
layers are literally derived assets in the manifest (linked by `sourceAssetId`)
but are **presented grouped under the source asset**.

**Source asset** — The original imported file. Immutable truth. Everything derived
points back to it via `sourceAssetId`.

**Derived asset** — Regenerable data computed from a source (WPI index, analytic
surfel set, exported TIN). Carries `derived` (or `indexed-full`) truth status.

**Preview** — A sampled, disposable display cache of a point cloud (`preview-
sampled`). An honest stopgap; not the measured truth.

**Index (WPI)** — The Workbench Point Index: an internal, COPC-shaped, lossless
octree over the source cloud (`indexed-full`). The reliable full-detail streaming
path.

**Surfel** — An analytic disc derived from measured points (radius / normal /
confidence computed analytically). An **abstraction / impression, not the model** —
meant to read as surface, forgiving of fuzz. `derived`.

**Master pill** — The extension-labeled on/off eye on an asset's collapsed card.
Controls whole-asset display and **preserves per-layer sub-state** when toggled
off and back on. Overrides but never mutates layer visibility.

**Truth status** — A property of assets only: `source | source-normalized |
preview-sampled | indexed-full | derived | authored | edited | export`. Separate
from a layer's lifecycle (`active | hidden | error`).

---

## Simulation-side terms

**Reality Simulation (Sim)** — The single, top-level, self-determined interpretive
workspace **and environment** — *what and where all user consideration happens*
(calcing points, drafting, defining regions are all done *to the sim*). It is
**not an assembly of assets**: it does not contain a TIN or a DWG. Its environment
**has a surface**; **"export surface" and "export DWG" are export features**
(outputs it produces), not components it holds. Not an asset; owns no source file;
stores no membership IDs internally. Managed in the **right panel**. Has
**simultaneous access to all project data** and is authored by snapping to
whatever the viewer shows.

**Sim layer** — The Sim's *use of* an asset/view in the scene (a membership row
keyed by `simulationId`). Distinct from an asset simply existing/being visible.

**Feature** — An interpreted, user- or system-authored object, area, line,
surface, note, or measurement that bridges the Sim, DWG, reports, and exports.
Every feature carries **representations** (below), **authorship**, and **sources**.

**Authorship** — How a feature came to be: **user-created** or **generated**
(system/automation). Replaces the old phrase "drawn, snapped to cloud."

**Sources** — The evidence a feature is sourced from: **any combination** of cloud,
survey points, DXF, imagery, or manual placement.

**Representation** — One of a feature's parallel views of a single truth:
- **Reality representation** — material / color / mass / geometry in the sim.
- **CAD (DWG/plan) representation** — layer, color, linetype/lineweight, hatch,
  block/symbol, point code (bound to standards).
- **Report representation** — area / quantity / count / note.
- **Export representation** — how it crystallizes into an exported asset.
Features own multiple representations; there are **no separate render "twins."**

**Display mode (Sim / DWG)** — The Sim shows **one representation at a time**:
Sim *or* DWG, never both (same principle as RGB *or* classification on a cloud).
To see reality + plan together, export the sim to a DWG asset and view it as an
ordinary asset.

---

## Feature taxonomy

**Region** — An authored area (grass, asphalt, concrete, gravel, water, roof
material…). The project term for what the owner called "texture." Starts as a
**border**, refined with **breaklines**. A ground-level region *is* a 3D surface
patch, so authoring regions authors the surface, materials, and (via export)
hatches at once. Boundaries may be **open** (data simply ends) or **closed**
(feature actually terminates).

**Object** — A discrete real-world thing (sign, pole, hydrant, valve, manhole,
tree, light pole…). Evidence = cloud mass / points / DXF / photo / placement.
Excluded from the ground TIN.

**Building** — A structured object special case. Simple mass first; optional
faces / roof / decks / details later. Footprint excludes from ground TIN. DWG =
footprint + face/overhang/roof lines + optional block metadata.

**Utility** — Utility features (overhead lines, underground runs, structures) —
their own Sim tab.

**Note / Measurement / Marker** — Lightweight annotation features (the current
`marker | polyline | measurement` set), for review flags, dimensions, callouts.

---

## Surface terms

**Ground surface / TIN** — The **ground model, not the total reality model.** A
**derived, sim-level property**, not a feature tab. Two entry points: **compiled
from regions** (region patches stitched along shared edges) or an **imported TIN
asset** (or a combination). Objects/buildings are excluded from it.

**Breakline** — Internal linework that shapes a surface where a boundary alone
can't (centerline, ditch, grade break). Added to a region after its border. Shared
region edges act as breaklines when stitching the ground.

**Exclusion zone** — A footprint/area punched as a hole in the ground TIN so
objects, buildings, and non-ground features don't corrupt the ground model.

**Vertical breakline** — Curbs and walls: the vertical faces between regions at a
grade break.

---

## Classification terms

**Classification** — A single value **per point** (ASPRS scheme; one class per
point, not stacked). On a cloud it is a **color mode** (RGB *or* Classification)
and a **per-class visibility filter**, grouped:
- **Ground / non-ground** — the stable base (class 2 vs everything else). Source
  when the LAS carries it; an "identify ground points" method is a deferred
  automation for clouds that don't.
- **Region classifications** — area materials (asphalt, grass, concrete). The
  cloud-side echo of Region features.
- **Object classifications** — discrete things (building, tree, pole). The
  cloud-side echo of Object features.

**Source classification** — Read-only truth as imported (ground/non-ground).

**Workbench classification** — A derived reclassification layer that promotes
subsets into region/object classes without rewriting the source LAS. A point
resolves to its source class unless overridden. **Classification informs features
but is never itself a feature.**

---

## Chrome / layout terms

**Frame** — Header + Viewer + Footer. The persistent cockpit. All always-needed
controls live here (or on viewer overlays), never only in a panel, so the app
still works when panels are detached or closed.

**Left panel** — Pure display/data manager. Tabbed by asset type; asset-centered
cards.

**Right panel** — Controls: the Sim by default, or an **opened asset work surface**
(editing/manipulation controls for one asset; never changes viewer display).

**Open (an asset)** — Push an asset's work surface into the right panel (e.g. Build
Index, Generate Surfels). Controls only.

**Banner** — Viewer top-left status, on two channels: a **live task** channel
(progress bar + ETA, persists until done) and a **view-state** channel (disclosure:
source / indexed-full / preview-sampled / derived / stale / mixed). Fades when idle.

**View mode (camera)** — 3D orbit / Top / Walk, in the header. Distinct from
display mode (Sim/DWG) and from color mode (RGB/classification).

**Draw order** — The viewer z-stack: surface faces → draped image → draped DWG
linework → TIN edges → points.

---

## Round-trip terms

**Generate from assets** — Deferred automation: build sim content from selected
assets (extract TIN, seed features from DWG, create from cloud). *(Updated
2026-07-09, owner review:)* this action belongs to the **asset side** (launched
from an asset's work surface), not the Sim "…" menu. Not built yet.

**Export as assets** — Crystallize sim state into a new asset (Generate DWG from
sim, export TIN, export texture map). The exported asset is a separate copy
**sourced from the sim state at export time**. Missing standards produce a warning
list that feeds the codelist. *(Updated 2026-07-09, owner review:)* the Sim "…"
menu presents this as an **export set**: Export all, Export asset maps, and
Export sim for the web viewer — the latter an eventual custom JSON sim snapshot
format (working name `.gsim`).

**Standards / Codelist** — Project-level mapping of feature type → CAD layer,
color, linetype/lineweight, hatch, block/symbol, point code. Possibly plus an
app-level library of texture and object templates (shape TBD). What the CAD
representation and export read from.
