# Create Sim Design Manager — Final Report to Project Assistant

Date: 2026-07-09. Phase: **design-only** (no implementation code changed).
Deliverables: `_DOCS/CREATE_SIM_DESIGN_REPORT.md` (full model) +
`_DOCS/CREATE_SIM_V1_IMPLEMENTATION_PLAN.md` (buildable v1 scope). This note is
the manager's handoff summary; the two reports are authoritative.

---

## 1. Manager phase name

Create Sim Design Manager — define the user-authored Reality Simulation creation
model before any Create Sim implementation begins.

## 2. Docs / code inspected

`_DOCS/GUNTERS_SIMULATION_VOCABULARY.md`,
`_DOCS/UI_UX_SIMULATION_MODEL_DESIGN_REPORT.md`,
`_DOCS/UI_UX_DISPLAY_IMPLEMENTATION_NOTE.md`; `src/shared/manifest-schema.ts`
(feature enum still `marker|polyline|measurement`, singleton `realitySimulation`,
flat arrays keyed by `simulationId`, `superRefine` FK checks);
`src/ui/rightPanel.ts` (Sim panel shell: family tabs, +Add, Sim/DWG switch,
ground strip, "…" export — all disabled shells); `src/viewer/ViewerEngine.ts`,
`editing.ts`, `geometry.ts` (existing raycast/hover-snap/screen-pick/vertex-edit
math). 294-test baseline confirmed.

## 3. Docs created / updated

Created `_DOCS/CREATE_SIM_DESIGN_REPORT.md` and
`_DOCS/CREATE_SIM_V1_IMPLEMENTATION_PLAN.md`. No implementation code modified.

## 4. Core model decisions

- **Parametric authoring is the governing idea:** a feature = authored
  parameters + evidence; the engine *generates* reality geometry, plan/CAD
  linework, and quantities. "Procedural from the user's parameters," **not**
  auto-extraction from the cloud (deferred until further surfel work).
- **Feature authorship ≠ asset truth.** Assets keep `truthStatus`; features
  carry `authorship` (authored/assisted/derived/edited/imported) + `confidence`.
  Never mixed.
- **Manifest invariants preserved:** singleton sim, no child IDs on the sim, flat
  arrays keyed by `simulationId`, ground as a derived property, Sim/DWG as one
  display-mode toggle (no render twin).
- **Catalog = parametric templates** (type + param schema + representation refs);
  per-instance parameter values. Short trusted JSON seed now; "Add to catalog"
  editor deferred.
- **Catalog visuals built procedurally, not scraped** (scraped static assets
  can't honor parameters; wrong for a survey/CAD deliverable). CC0 region
  textures optional later.

## 5. Feature type hierarchy

Families: **region, building, object, utility, line/breakline, marker,
measurement.** Each gets its own authoring tool set; subtype chosen via a
dropdown in that tool set (or generic-then-classify). v1 depth is capped per
family (see reports). Utilities reuse Object/Line tools + catalog seeds in v1.

## 6. Region model

Material/area feature; border-first, refined with breaklines; a ground-level
region **is** its surface/TIN patch. **Parametric material** (asphalt `decay`,
grass `verticalScale`, height behavior draped/floating/vertical). Borders may be
open or closed. Hatch is a generated CAD *reference*, not stored geometry.
**Region-to-region endpoint/edge snap** required for watertight shared
boundaries. Corridor/"roadway" is a **deferred line-driven generator** that emits
separate parallel regions (surface, curb, gutter) + breaklines from a centerline
+ profile.

## 7. Object model

Discrete thing; point-anchored + scaled primitive/symbol in v1. **Parametric
scale** (tree height/dripline/leafCoverage; pole height; …). Placed by snapping
to evidence; excluded from ground TIN. Cloud-mass auto-fit deferred.

## 8. Building model

Own **composite family**, not an object subtype. v1 = **footprint + height +
roof type (flat/gable/hip)** → generated mass, roof planes, and the **plan/CAD
lines** the owner prioritizes (footprint, face, overhang offset, roof outline/
ridge/hip, each on its own layer). Footprint auto-registers an **exclusion zone**.
Empty-but-present `subFeatures[]` ramp reserves doors/windows/garages/decks and
editable faces for **Building v2**.

## 9. Utility model

v1: a Sim tab + catalog seeds (overhead line, utility pole, structure) authored
with the **Object** (point) and **Line** (run) tools — no bespoke utility engine.
Underground traces, connectivity, and structures-as-composites deferred.

## 10. Ground surface model

**Derived, sim-level property** (not a feature tab). Inputs = ground-level region
patches (borders), **breaklines (region-owned or standalone)**, **spot-elevation
markers**, imported TIN asset, exclusion zones. All surface constraints are
consumed by the compiler **regardless of which tab created them** (owner ruling).
v1 **renders patches + stores constraints**; the stitch/TIN engine, region
blending, and contour export are a dedicated **Surface Manager** phase — do NOT
build the TIN engine inside Create Sim.

## 11. Representation model

One geometry, parallel views: `reality / cad / report / export`. CAD stores
**reference keys** (layer/hatch/block/point-code) resolved via the codelist;
hatch/blocks/contours generate **at export**. Prevents twin drift. Report is
mostly placeholder in v1 (reviewStatus + label/note).

## 12. Evidence / source-linking model

`EvidenceRef` union: mandatory **picked-coordinate** + optional asset-point /
asset-vertex / asset-edge / surface-hit / manual-note (with assetId, layer,
sourceClass, sourceRGB when the snap resolves). **Surfels are `assisted`/low-
confidence evidence, never `source`.** Authorship + evidence kind drive a
disclosure badge ("snapped to cloud" vs "from DWG" vs "free placement").

## 13. First Create Sim UX recommendation

+Add per family summons that family's **contextual tool set into the viewer tool
rail** (mount already exists) with a **subtype dropdown**. Five thin v1 flows:
Region (border+breakline), Building (footprint+roof), Object (place+scale),
Line/breakline, Marker/control-point/spot-elevation. Features list in the Sim
tabs; selecting one opens a **feature detail** (params editor, evidence badge,
rename/delete). In-session vertex undo + hard cancel. Save/reopen regenerates
display geometry from stored primitives + params.

## 14. Required schema changes

Additive widening of `featureSchema` (legacy `marker|polyline|measurement`
records stay valid): `family, templateId, subtype, authorship, confidence,
lifecycleStatus, evidenceRefs[], parameters, representations, display,
parentFeatureId, metadata`. New `evidenceRefSchema` (discriminated on `kind`).
Add `exclusionZones[]` (or derive). Bundle catalog as read-only JSON. Extend
`superRefine` FK checks. `parentFeatureId` reserved for feature-generates-
features (building sub-parts now, corridor later).

## 15. Required viewer / UI changes

Viewer: **pluggable snap-target system** (cloud point + DWG vertex/endpoint +
authored-feature vertex/edge; surface later); **authoring state machine**
(`authoring.ts`); **parametric generators** (mass, roof, region patch, object
primitive, material — all pure/Node-testable); **feature render layer** with
correct draw order + selection/handles. UI: make family tabs/+Add live; add
**feature detail** sub-view; render contextual tool rail with subtype dropdown;
keep Sim/DWG as display toggle (DWG stays disabled until export phase).

## 16. Risks / unresolved questions

All 12 handoff risks addressed (see report Section 10). Open taste/scope calls
for the implementation phase: reality-material fidelity (flat tint vs richer
shader for decay/grass); roof ridge auto-infer vs always user-set (recommend
infer-with-override); imported-TIN-vs-region ground precedence (→ Surface
Manager); left-panel Sim tab timing.

## 17. Recommended implementation manager

**Create Sim V1 Implementation Manager**, scoped by
`_DOCS/CREATE_SIM_V1_IMPLEMENTATION_PLAN.md`. Recommended build order: (1) schema
widening + catalog load + tests, (2) snap-target system, (3) **Region
border+breakline end-to-end** (de-risks every subsystem once — owner calls this
imperative), (4) Building, (5) Object, (6) Line/Marker, (7) polish +
save/reopen/restart hardening. Verification: unit tests per generator, snap math
tests, schema back-compat + FK tests, save/reopen round-trip, UI wiring tests; a
review gate confirming no asset gains `authorship`, no feature gains
`truthStatus`, no DWG twin, ground stays derived, surfels never `source`.

**Standing conventions the implementer inherits** (consolidated in plan Section
0): ~1000-line file cap; ASCII-only in `src/`; owner runs the full suite as the
acceptance gate (baseline 294 passed, 28 files — land no regression);
Node-testable pure cores (no Three imports in math/logic); additive schema only,
covered by the manifest-drift test.

## 18. What should NOT be built yet

Auto-extraction/detection from the cloud (after further surfel work); the ground
stitch/TIN engine + contours + imported-TIN blending (Surface Manager); the DWG
export engine + codelist editor (Export/DWG Manager); building openings/decks/
multi-plane roofs/editable faces (Building v2); the corridor/roadway line-driven
generator; "Add to catalog" custom-template editor; classification editing,
registration, cloud merge, imagery, reports, mobile.

---

**CREATE SIM DESIGN READY — PREPARE CREATE SIM V1 IMPLEMENTATION MANAGER**
