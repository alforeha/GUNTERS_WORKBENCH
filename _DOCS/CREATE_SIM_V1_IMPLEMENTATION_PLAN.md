# Create Sim v1 — Implementation Plan

Companion to `_DOCS/CREATE_SIM_DESIGN_REPORT.md`. This turns the design into a
buildable v1 scope for the **Create Sim V1 Implementation Manager**. It is a
plan, not code; no implementation files are changed by the design phase.

Design invariants that must survive implementation: singleton `realitySimulation`
with no child IDs; membership in flat arrays keyed by `simulationId`; assets carry
`truthStatus`, features carry `authorship`; ground is a derived sim property;
Sim/DWG is one display-mode toggle, not a render twin.

---

## 0. Standing project conventions (carried from prior phases)

These are established Workbench rules, not new to this phase — the implementer
inherits them:

- **~1000-line file cap.** Every source file stays under the ~1000-line rule
  (largest current UI file is `layers.ts` at 795). Split modules before they grow
  past it; favor the pure-core + thin-wirer split already used in `rightPanel.ts`.
- **ASCII-only in source.** No non-ASCII characters in `src/` (including
  `src/ui/` and `style.css`) — enforced in prior phases and checked. Prose docs
  in `_DOCS/` may use em-dashes/arrows; source may not.
- **Owner runs the full test suite.** The owner executes the complete suite as
  the acceptance gate (baseline: **294 passed, 28 files** at display-impl phase).
  The implementer adds tests alongside each slice and must land **no regression**
  to that baseline; the owner's full run is the sign-off, so keep the suite green
  and fast.
- **Node-testable pure cores.** Math/logic cores (snap, authoring state machine,
  parametric generators, schema) carry no Three.js imports so they run under
  Vitest in Node, matching `editing.ts` / `geometry.ts`.
- **No manifest schema drift without intent.** Schema changes are additive and
  covered by `tests/ui-manifest-drift.test.ts`; legacy records must still
  validate.

## 1. v1 scope (in)

- Widen `featureSchema` additively (existing `marker|polyline|measurement`
  records must still validate).
- Bundle a **JSON catalog** of parametric templates; wire it into the Add tools.
- **Snap-target system**: cloud-point + DWG vertex/endpoint.
- **Contextual tool rail** per family + **right-panel feature detail**.
- Five thin authoring flows: **Region** (border+breakline), **Building**
  (footprint+roof), **Object** (place+scale), **Line/breakline**, **Marker/
  control point**.
- **Parametric generators** (pure, Node-testable): mass, roof, region patch,
  object primitive.
- **Evidence links**: mandatory picked-coordinate + rich snap refs.
- **Save / reopen / restart** with regenerated display geometry.

## 2. v1 non-goals (staged later — do not build)

Auto-extraction/detection from the cloud; ground stitch/TIN engine + contours +
imported-TIN blending (Surface Manager); DWG export engine + codelist editor
(Export/DWG Manager); building openings/decks/multi-plane roofs/editable faces
(Building v2); "Add to catalog" custom-template editor (Catalog Editor phase);
**corridor/"roadway" generator** (line centerline + left/right profile → emits
parallel curb/surface/gutter regions + breaklines + striping — a later
line-driven generator); classification editing, registration, merge,
imagery, reports, mobile.

---

## 3. Schema changes (`src/shared/manifest-schema.ts`)

Extend `featureSchema` (all new fields optional or defaulted for back-compat):

```
family        z.enum([...]).optional()          // region|object|building|utility|line|marker|measurement
templateId    z.string().nullable().optional()
subtype       z.string().optional()
authorship    z.enum(['authored','assisted','derived','edited','imported']).optional()
confidence    z.enum(['low','medium','high']).optional()
lifecycleStatus z.enum(['draft','authored','reviewed','flagged']).optional()
evidenceRefs  z.array(evidenceRefSchema).default([])
parameters    z.record(z.string(), z.unknown()).default({})
representations z.object({ reality, cad, report, export }).partial().optional()
display       z.object({ visible: z.boolean().default(true), ... }).optional()
parentFeatureId z.string().nullable().optional()  # forward-compat: generated child features
metadata      z.record(z.string(), z.unknown()).default({})
```

`parentFeatureId` is cheap forward-compat for the **feature-generates-features**
pattern (building sub-features today; the deferred corridor generator that emits
curb/surface regions from a centerline+profile tomorrow). Optional and unused by
v1's five flows, but reserving it now avoids a later migration.

- Keep existing `type` (marker|polyline|measurement) valid; `family` is the new
  primary axis, `type` becomes legacy/derivable.
- New `evidenceRefSchema` (discriminated on `kind`): `picked-coordinate` |
  `asset-point` | `asset-vertex` | `asset-edge` | `surface-hit` | `manual-note`,
  each with `coordinate` + optional `assetId`/`assetLayerId`/`sourceClass`/
  `sourceRGB`.
- Add `exclusionZones[]` (or a `superRefine`-derived view from building/object
  features) keyed by `simulationId` + owning feature id.
- Extend the `superRefine` FK loop to validate new arrays point at the singleton
  `simulationId` and that `templateId`/`assetId` references resolve.
- **Catalog**: prefer a bundled read-only JSON asset (not manifest-embedded) so
  the app catalog isn't versioned per-project; add an optional
  `projectCatalogOverrides` record for later. Confirm with implementer.

Add/extend tests in `tests/ui-manifest-drift.test.ts` and a new
`feature-schema.test.ts`: back-compat of legacy records, new-field validation,
FK integrity, exclusion-zone linkage.

---

## 4. Viewer / engine changes (`src/viewer/`)

- **`snap.ts` (new, pure math + a thin engine bridge):** a `SnapTarget`
  interface with providers for cloud points, DWG vertices/endpoints,
  **authored-feature vertices/edges (region-to-region, for watertight shared
  boundaries)**, and (later) surfaces. Returns the best snap within a pixel
  tolerance; reuses the existing `raycaster`, `pointerNdc`, and
  `pickClosestScreenPoint`/`worldUnitsPerPixel` helpers already in
  `ViewerEngine.ts` + `editing.ts`.
- **`authoring.ts` (new, Node-testable state machine):** `idle → placing →
  addingVertex → closing → complete/cancel`, emitting draft geometry + evidence
  refs. No Three.js in the pure core.
- **Parametric generators (new, pure):**
  - `buildFootprintMass(footprint, height)` → wall geometry.
  - `buildRoof(footprint, roofType, pitch, ridgeAxis, overhang)` → roof planes +
    outline/ridge/hip polylines (plan lines).
  - `buildRegionPatch(border, breaklines)` → draped patch geometry.
  - `buildObjectPrimitive(template, params)` → scaled symbol/primitive.
  - `buildMaterial(template, params)` → reality appearance (tint + param-driven
    pattern/shader: asphalt `decay` → patchiness, grass `verticalScale` →
    displacement height, tree `dripline`/`leafCoverage` → canopy shape).
  Each returns display geometry/material only; nothing persisted.

  **Sourcing decision (owner-settled):** these visuals are **built procedurally,
  not scraped.** A parametric model requires generators that honor params;
  downloaded static meshes/textures would go inert. Optional later polish: layer
  CC0 seamless textures (ambientCG/Poly Haven) under region materials. CAD
  blocks/hatches are export-time (later manager), name-referenced only in v1.
- **`RenderFeatures.ts` (new):** render authored features with correct draw
  order (surface → draped image → draped linework → TIN edges → points);
  selection highlight; vertex handles (reuse `editing.ts`).

Keep every new pure module under the ~1000-line rule and Node-testable (no
Three imports in the math cores), matching the existing `editing.ts`/`geometry.ts`
pattern.

---

## 5. UI changes (`src/ui/`)

- **`rightPanel.ts`:** make family tabs + `+Add` live; add a **feature detail**
  sub-view (name/rename, authorship badge, confidence, parameter editor bound to
  the template `paramSchema`, evidence summary, delete). Replace the placeholder
  strings with real lists + counts.
- **Tool rail (viewer overlay mount, top-right):** render the **contextual
  per-family tool set** with the **subtype dropdown selector**; wire
  start/add-vertex/close/cancel to `authoring.ts`.
- **Sim/DWG toggle:** leave as display-mode selector; DWG stays disabled until
  the export phase (no render twin).
- Follow the existing pure-renderer + mount-and-wire split already used in
  `rightPanel.ts` (testable `renderXHtml` functions + a `mountX` wirer).

New UI tests beside the existing `ui-sim-shell` set: tool-rail rendering,
feature-detail param editing, add-flow wiring, snap-marker display.

---

## 6. Catalog JSON (bundled)

```jsonc
// public/catalog/catalog.v1.json
{
  "version": 1,
  "templates": [
    { "id": "region.asphalt", "family": "region", "subtype": "asphalt",
      "displayName": "Asphalt",
      "paramSchema": [ { "name": "decay", "type": "number", "default": 0, "min": 0, "max": 1 } ],
      "reality": { "material": "asphalt", "bind": { "patchiness": "decay" } },
      "cad": { "layer": "SURF-ASPHALT", "hatch": "AR-CONC" },
      "report": { "quantityKind": "area" } },
    { "id": "region.grass", "family": "region", "subtype": "grass",
      "paramSchema": [ { "name": "verticalScale", "type": "number", "default": 0.2, "min": 0, "max": 3 } ],
      "reality": { "material": "grass", "bind": { "bladeHeight": "verticalScale" } },
      "cad": { "layer": "SURF-GRASS", "hatch": "GRASS" } },
    { "id": "object.tree", "family": "object", "subtype": "tree",
      "paramSchema": [
        { "name": "height", "type": "number", "default": 20 },
        { "name": "dripline", "type": "number", "default": 8 },
        { "name": "leafCoverage", "type": "number", "default": 0.7, "min": 0, "max": 1 } ],
      "reality": { "primitive": "tree-billboard" },
      "cad": { "block": "TREE", "pointCode": "TREE" } },
    { "id": "building.gable", "family": "building", "subtype": "gable",
      "paramSchema": [
        { "name": "height", "type": "number", "default": 10 },
        { "name": "roofPitch", "type": "number", "default": 30 },
        { "name": "overhang", "type": "number", "default": 1 } ],
      "cad": { "layers": { "footprint": "BLDG-FOOTPRINT", "face": "BLDG-FACE",
                           "overhang": "BLDG-OVERHANG", "roof": "BLDG-ROOF" } } }
    // + concrete, gravel, dirt, water; light pole, sign, hydrant, manhole, generic;
    //   flat-roof, hip; curb, flowline, ridge, ditch, edge-of-pavement, fence;
    //   review flag, control point, spot elevation (measured Z surface constraint), generic marker
  ]
}
```

Layer/hatch/block names are seeds for the future codelist — keep them
placeholder-obvious and easy to remap.

---

## 7. Recommended build order (vertical slices)

1. **Schema widening + catalog load + tests** (foundation; no UX yet).
2. **Snap-target system** (cloud + DWG + authored-feature vertices) with a debug
   marker.
3. **Region border+breakline end-to-end** — schema → snap (incl. region-to-region
   endpoint/edge for watertight shared boundaries) → tool rail → detail → render →
   save/reopen. This slice exercises every new subsystem once and de-risks the
   rest. Remember: the region patch **is** the surface/TIN component, and it must
   consume its breaklines + any spot-elevation markers for a correct surface.
4. **Building footprint+roof** — footprint draw + parametric mass/roof/plan
   lines + auto exclusion zone.
5. **Object place+scale** — catalog dropdown, snap-place, per-instance params.
6. **Line/breakline + Marker/control point** — thinnest, reuse the above.
7. **Polish**: in-session undo/cancel, selection editing, feature-detail rename/
   delete, save/reopen/restart hardening.

---

## 8. Verification / review needs

- Unit tests for every pure generator (mass, roof, patch, primitive) with known
  fixtures — e.g. a square footprint + gable → expected ridge + eave lines.
- Snap math tests (tolerance, nearest-of-multiple, cloud-vs-DWG precedence).
- Schema back-compat + FK-integrity tests; manifest-drift test updated.
- Save/reopen round-trip test: author features → serialize → reload → geometry
  regenerates identically from stored primitives + params.
- UI render/wiring tests for tool rail + feature detail.
- **Design review gate before merge:** confirm no asset gains `authorship`, no
  feature gains `truthStatus`, no DWG render twin, ground still derived, surfels
  never `source`.
- Recommend a subagent or reviewer pass on the schema diff specifically (highest
  drift risk).

---

## 9. Definition of done (v1)

A user can, from visible point-cloud or DWG evidence, author a region, a
building (footprint+roof with generated plan lines), an object (scaled), a
line/breakline, and a marker/control point; snap to cloud points and DWG
vertices; edit each feature's parameters in the right panel; see evidence/
authorship disclosed; and save, close, and reopen the project with every feature
and its generated display geometry intact — with no regression to the 294-test
baseline and no violation of the manifest invariants.
