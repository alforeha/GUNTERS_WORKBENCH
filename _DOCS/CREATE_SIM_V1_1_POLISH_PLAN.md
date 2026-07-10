# Create Sim V1.1 Polish Plan

Companion to `_DOCS/CREATE_SIM_UX_APPEARANCE_DESIGN_REPORT.md`.
Scope: implementation-ready polish plan, not implementation.

Goal: move Create Sim from functional beta display to **survey-readable reality
appearance** without changing the accepted sim architecture.

---

## 1. Priority order

1. **Regions first** - fix the "color blocks" problem with procedural material
   cues, borders, selection, and edit handles.
2. **Scene readability** - background, lighting, and material contrast so the
   Sim reads as authored reality instead of isolated geometry in black space.
3. **Buildings** - wall/roof material split, simple shading, roof/eave/ridge
   hierarchy.
4. **Objects and markers** - subtype-specific primitives/symbols, base points,
   spot/control label behavior.
5. **Lines/breaklines** - subtype colors, dash/thickness styles, surface
   constraint emphasis.
6. **UX polish** - true viewer tool rail, selected sync, delete confirm, hover
   feature readouts.

---

## 2. Region polish slice

Implementation intent:

- Add a material appearance resolver keyed by template `reality.material` and
  feature params.
- Generate or shade low-noise procedural patterns for grass, pavement, gravel,
  dirt, concrete, landscape, water, and unknown.
- Keep DWG hatch metadata separate from Sim material rendering.
- Add normal/hover/selected/edit states.
- Add vertex evidence styling for snapped/free/feature-snapped/manual.

Acceptance check:

- A grass region, pavement region, gravel region, and concrete region are
  visually distinguishable without reading the panel.
- Selected region border and vertices are obvious.
- Evidence state is visible in edit/selected state.
- Generated display is still regenerated from stored primitives and params.

---

## 3. Building polish slice

Implementation intent:

- Split building display into wall material and roof material.
- Add simple ambient/directional shading or material tone variation.
- Style footprint, face, overhang, roof, ridge, and hip line sets separately.
- Show selected height/footprint handles.

Acceptance check:

- Flat, gable, and hip roofs read differently.
- Roof and walls are visually separate.
- DWG display can later flatten the same line sets without new data.

---

## 4. Object/marker polish slice

Implementation intent:

- Replace generic point cross display with subtype-specific procedural
  primitives.
- Keep Top/DWG mode symbol-friendly.
- Show object base point when selected/hovered and at close zoom.
- Add spot elevation Z label defaults and stronger control point symbol.

Acceptance check:

- Tree, pole/sign, hydrant, manhole/valve, inlet, generic object, spot elevation,
  control point, and note marker are visually distinct.
- Object params such as height/dripline/diameter visibly affect display.

---

## 5. Line/breakline polish slice

Implementation intent:

- Add subtype style table for line color, dash, thickness, and selected state.
- Make breaklines visually stronger than ordinary polylines.
- Keep region-owned breaklines subordinate to active region edit geometry.

Acceptance check:

- Curb, flowline, ridge, ditch, wall top/bottom, edge of pavement, fence, and
  generic breakline are distinguishable.
- Selected line vertices and evidence states are clear.

---

## 6. UI polish slice

Implementation intent:

- Present active authoring controls in the viewer tool rail, not only in the
  right panel.
- Add compact authoring phase header: feature family, subtype, phase, evidence
  split.
- Add cancel/finish affordance consistency across families.
- Add delete confirmation.
- Add viewer-to-panel selected feature sync.
- Clarify Sim vs DWG mode through presentation behavior.

Acceptance check:

- It is unmistakable when the user is authoring.
- Finish/cancel path is clear for every family.
- Selecting in the viewer and selecting in the panel land on the same feature
  detail.

---

## 7. Non-goals

Do not include automatic extraction, TIN stitching, contours, DWG export, codelist
editing, photoreal rendering, scraped assets, object detection, or classification
editing in V1.1 polish.

---

## 8. Verification

Recommended checks:

- Unit tests for material/style resolver tables.
- Existing generator tests remain green.
- UI tests for authoring rail state, selected detail sync, and delete confirm.
- Manual visual pass with at least one feature of each family.
- Screenshot comparison before/after for regions and buildings.

Definition of done:

Create Sim still follows the accepted architecture, but the authored scene reads
as a clean reality-style survey visualization instead of flat color blocks.
