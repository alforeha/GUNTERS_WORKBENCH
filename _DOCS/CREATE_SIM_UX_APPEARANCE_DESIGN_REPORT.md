# Gunter's Workbench - Create Sim UX + Reality Appearance Design Report

Manager phase name: **Create Sim UX + Reality Appearance Design Manager**.
Date: 2026-07-09.
Scope: design-only beta polish pass. No implementation code changed.

This report responds to the owner's side-by-side visual concern: the desired
direction is a clean, survey-readable reality view that suggests grass,
pavement, gravel, concrete, buildings, objects, lines, and markers without
pretending to be photoreal source truth. The current authored Sim is functional,
but too much of it still reads as colored CAD blocks floating in a dark viewer.

Final target for the next pass: **Level 2 appearance** - procedural material
cues, outlines, simple lighting response, object symbols/primitives, edit
handles, and honest evidence/authorship disclosure.

---

## 1. Docs/code inspected

Inspected design docs:

- `_DOCS/UI_UX_SIMULATION_MODEL_DESIGN_REPORT.md`
- `_DOCS/CREATE_SIM_DESIGN_REPORT.md`
- `_DOCS/CREATE_SIM_V1_IMPLEMENTATION_PLAN.md`
- `_DOCS/GUNTERS_SIMULATION_VOCABULARY.md` by reference from the above docs

Inspected implementation files:

- `src/ui/rightPanel.ts`
- `src/ui/features.ts`
- `src/ui/model.ts` by dependency path from the right panel
- `src/shared/template-catalog.ts`
- `src/viewer/RenderFeatures.ts`
- `src/viewer/generators.ts`
- `src/style.css`
- `tests/ui-sim-shell.test.ts`

Observed current implementation posture:

- Create Sim V1 is now broadly live for region, building, object, line, and
  marker authoring.
- Feature params persist and generated geometry is regenerated from params.
- Region display is still mostly translucent fill + outline color.
- Building display is a generic gray mass with line sets.
- Object and marker display are currently simple line primitives, not
  recognizable reality objects.
- Sim/DWG remains a single display-mode selector with DWG staged, which is
  correct.

---

## 2. Owner concerns confirmed

The concern is valid. The current display communicates "something was authored,"
but not yet "what kind of reality thing this represents."

The screenshot target on the left shows a readable built environment: material
separation, roof/wall contrast, trees/grass/pavement context, soft lighting, and
object scale. The current view on the right shows dark space, flat tinted
regions, glassy/simple building masses, and little semantic material signal.

The right framing is not photorealism. Gunter's should not try to become a game
renderer or replace source evidence. It should become a **survey-useful authored
reality diagram**: realistic enough that a user can instantly read material,
feature type, height, footprint, evidence confidence, and selected/edit state.

---

## 3. UI/UX friction findings

Current friction:

- The right Sim panel is technically live but visually dense; the user has to
  infer the workflow from text rows instead of seeing a strong "I am now drawing
  a region/building/object" state.
- Authoring state appears inside the panel rather than as a true viewer tool
  rail. The handoff model wants the panel to launch work and the viewer rail to
  host active tools.
- Finish/cancel is present, but the distinction between border phase, review
  phase, and breakline phase is too text-dependent.
- Feature selection is row-driven first. Viewer selection/hover/edit feedback
  needs to become equally legible.
- Evidence badges are useful, but "snapped/free" is not enough as the visual
  vocabulary grows. The user needs source-snapped, feature-snapped, manual, and
  derived/assisted states to be scannable.
- Sim/DWG is architecturally correct, but the UI should explain through visual
  mode behavior: Sim is material/primitive/shaded; DWG is flatter, layer-colored,
  hatch/symbol/lineweight-biased.
- Delete is available in detail, but should require a confirm once features
  carry more work.

Recommended UX posture:

- The right panel remains the feature inventory and detail editor.
- The viewer tool rail becomes the active authoring cockpit.
- The viewer itself must show strong hover/selected/edit handles, because
  authored geometry is spatial work, not just list work.

---

## 4. Region/material appearance recommendation

Regions are the highest-priority polish item. They are the ground/material model,
so if they look like flat blocks the whole Sim feels primitive.

V1.1 region display should use **procedural material patterns now**. They should
sit between CAD hatches and reality materials:

- Grass: green base with fine directional/noise strokes and slight height hint
  controlled by `verticalScale`.
- Pavement/asphalt: dark gray base with speckle/noise, light cracks/patch
  variation controlled by `decay`.
- Gravel: tan/gray base with small pebble speckles.
- Dirt: muted earth fill with grain and low color variation.
- Concrete: light gray slabs or subtle panel lines plus low speckle; `decay`
  adds stain/crack variation.
- Landscape: mixed green/brown irregular mottling.
- Water: blue/teal fill with subtle ripple lines, flatter and more transparent.
- Unknown: neutral desaturated fill with diagonal hatch-like pattern.

Region borders should be emphasized, but not louder than selected linework:

- Normal: thin darker material-colored outline.
- Hover: brighter edge glow and mild fill lift.
- Selected: double signal - solid outline plus vertex handles.
- Edit: vertices and active segment are clear, with snapped vertices marked
  differently from free vertices.

Region material style should be controlled primarily by template, with per-feature
params affecting pattern intensity. Global display mode can choose `clean`,
`rich`, or later `cad-like`, but v1.1 should ship a single tasteful rich default
plus a simpler fallback.

Region appearance must remain separate from DWG hatch metadata. DWG hatch stays a
representation reference; Sim material is display rendering.

V1.1 minimum improvement over color blocks:

- Add material-pattern fill generation or shader uniforms for all region
  templates.
- Add border/selected/hover/edit style hierarchy.
- Add a brighter, visible ground plane/background so regions do not disappear
  into black.

---

## 5. Building appearance recommendation

V1 buildings should stay parametric masses, but they need wall/roof separation
and simple shading.

Sim mode building style:

- Walls: warm off-white/light gray material with vertical face shading.
- Roof: separate darker material, subtype-aware geometry readable from orbit and
  top view.
- Roof edges: thin dark eave outline.
- Ridge/hip lines: visible but lighter than selection lines.
- Overhang: subtle ghost/offset outline.
- Footprint/exclusion: visible in edit/selected state, not always loud.
- Height: selected buildings show a vertical height handle or dimension cue.

DWG mode building style:

- No shaded mass by default.
- Footprint, face, overhang, roof, ridge/hip line sets drawn as layer-colored
  plan linework.
- Optional translucent footprint fill only when selected.

Minimum improvement without Building v2:

- Split wall and roof materials.
- Apply simple directional/ambient shading.
- Make ridge/hip/eave/overhang lines deliberate line styles instead of generic
  geometry lines.
- Use roof type as a first-class visual: flat reads flat, gable reads ridge,
  hip reads hip planes.

Do not build windows, doors, decks, dormers, editable roof planes, or multi-plane
roof editing in this polish pass.

---

## 6. Object appearance recommendation

Objects should be hybrids: symbolic enough for survey work, primitive enough to
read in 3D.

Top view should bias toward CAD symbols:

- Tree: canopy circle/dripline plus center point.
- Sign/pole/hydrant/valve/manhole/inlet: recognizable plan symbol or compact
  icon.
- Generic object: neutral square/diamond with center point.

3D view should bias toward simple reality primitives:

- Tree: trunk stem plus canopy volume/billboard sized by `height`, `dripline`,
  and `leafCoverage`.
- Sign: post plus rectangular sign face.
- Pole: vertical cylinder/line with base point.
- Hydrant: short colored stacked primitive.
- Valve/manhole: flush disc at ground.
- Inlet: flush rectangular box/grate.
- Generic: low box or cross marker.

Every object should always show a base point at high zoom or when selected,
because the survey-relevant location is the point anchor. Evidence/source-snapped
status should appear as a tiny ring or badge at the base, not as a large label.

V1.1 minimum:

- Replace generic cross/stem-only object display with subtype-specific procedural
  primitives.
- Preserve CAD-symbol intent for top/DWG mode.
- Add selected scale/height handles for object params.

---

## 7. Line/breakline appearance recommendation

Breaklines should look different from ordinary linework. They are surface
constraints, not just drawn polylines.

Recommended line vocabulary:

- Curb: warm orange/brown solid line, medium thickness.
- Flowline: blue/teal solid line, slight directional ticks optional.
- Ridge: yellow/gold solid or long-dash line.
- Ditch: green/blue dashed line.
- Wall top: dark solid line with high emphasis.
- Wall bottom: dark dashed line.
- Edge of pavement: gray/white solid line.
- Fence: lighter dashed line with post ticks.
- Generic breakline: orange solid line.

Breaklines should visually imply surface influence:

- Normal breakline: colored line slightly above region fills.
- Selected breakline: thicker line plus vertex handles.
- During region edit: region-owned breaklines draw inside the selected region
  and stay visually subordinate to active vertices.

Vertices should show snapped/free/evidence status when selected or editing. Line
direction should not matter for most v1 breaklines, except optional future flow
arrows for drainage/flowline.

DWG mode should flatten these into layer color, linetype, and lineweight.

---

## 8. Marker/spot/control appearance recommendation

Marker types should be visually distinct:

- Generic marker: small pin/cross.
- Note point: pin with small note glyph, label on hover or selected.
- Spot elevation: point cross plus Z label by default in Top/DWG mode; in 3D
  mode label can be zoom/selection dependent.
- Control point: strongest point symbol, square/triangle target, always
  high-contrast and not confused with ordinary markers.

Spot elevations should show Z by default in DWG/Top mode because their purpose is
the elevation. In 3D Sim mode, show Z when selected, hovered, or when a labels
toggle is on.

Control points should use a stronger symbol and should not be visually mixed with
casual notes. Labels should be selective by default: control point labels on,
spot Z labels in plan/top, generic/note labels hover/selected.

---

## 9. Evidence/authorship badge recommendation

Current feature records correctly keep `authorship` separate from asset
`truthStatus`. The visual system should make that separation obvious.

Recommended badge vocabulary:

- Authorship chip in feature detail: `authored`, `edited`, `imported`,
  `assisted`, `derived`.
- Evidence chips: `cloud snap`, `DWG vertex`, `feature snap`, `manual`,
  `surfel-assisted`.
- Confidence chip when present: `low`, `medium`, `high`.

In viewer:

- Source-snapped vertices: small filled point/ring.
- Feature-snapped vertices: linked/chain-style ring.
- Manual/free vertices: hollow point.
- Surfel-assisted evidence: dashed or dotted ring, never source-colored.

Do not add `truthStatus` to features. Do not imply a feature is source truth just
because it looks good.

---

## 10. Sim vs DWG display recommendation

Keep Sim/DWG as one display-mode toggle over the same feature model.

Sim mode should show:

- Procedural material fills.
- Simple shaded masses/primitives.
- Soft outlines.
- Evidence and edit handles on demand.
- Labels selectively.

DWG mode should show:

- Plan-like flattening.
- Layer-colored linework.
- Hatch-like region fills.
- CAD symbols for objects/markers.
- Text labels and point codes where appropriate.

Do not create separate render twins. The mode switch should change presentation,
not data ownership.

---

## 11. Draw order/display hierarchy recommendation

Recommended Sim draw order, back to front:

1. Viewer background/sky or neutral ground backdrop.
2. Source point cloud / surfels, depth-tested.
3. Derived ground base, if present.
4. Region fills/material patches.
5. Region borders and internal material pattern strokes.
6. Buildings and object primitive fills.
7. Building roof/eave/ridge/hip/overhang lines.
8. Lines and breaklines.
9. Markers, spot elevations, control points.
10. Labels.
11. Hover highlights.
12. Selection outlines and handles.
13. Active authoring draft geometry.
14. Measurement overlays and snap cursor.

When authoring, non-relevant visible assets and features should subtly fade, not
vanish. Regions should become more transparent when a dense point cloud is
visible, so evidence remains inspectable.

DWG mode should use a flatter hierarchy:

1. Region hatches/fills.
2. Building/object footprints.
3. Breaklines/linework.
4. Symbols/markers.
5. Text/labels.
6. Selection/edit handles.

---

## 12. Reality appearance levels

Level 1 - Current:

- Flat region colors.
- Simple translucent fills.
- Generic gray building masses.
- Cross/stem object and marker primitives.
- Limited material meaning.

Level 2 - Near-term target:

- Procedural material patterns for regions.
- Wall/roof material separation for buildings.
- Simple ambient/directional shading.
- Subtype-specific object primitives and CAD-symbol top view.
- Distinct breakline/line styles.
- Marker/control/spot symbols.
- Hover/selected/edit states with handles.
- Evidence/authorship cues.
- Better background/lighting so the scene reads as an authored environment.

Level 3 - Later:

- Surfel-informed tinting/material behavior.
- Richer object libraries.
- Better roof/building parts.
- Texture atlases or CC0 material textures where useful.
- Advanced surface stitching/ground compiler visuals.
- More complete DWG mode and export-time hatch/block generation.

This design targets Level 2 only.

---

## 13. Near-term polish hit list

Highest priority:

1. Region material pattern pass for all region templates.
2. Viewer lighting/background pass so authored features are readable outside a
   black void.
3. Region border, hover, selected, edit, and vertex-handle states.
4. Building wall/roof material split and roof-line hierarchy.
5. Subtype-specific object primitives.
6. Line/breakline subtype color + dash/thickness styles.
7. Marker/spot/control symbol set and label defaults.
8. Evidence/authorship visual badges in both detail panel and viewer.

UI polish:

1. Move active authoring controls into a true viewer tool rail presentation.
2. Make authoring mode visually unmistakable with a compact phase header.
3. Add stronger complete/cancel affordances and keyboard escape behavior.
4. Add delete confirmation for authored features.
5. Add selected-feature synchronization between viewer and panel.
6. Add hover cards or compact status readout for feature subtype/evidence.

Implementation guardrails:

- Keep reality appearance procedural and param-driven.
- Do not persist generated geometry.
- Keep CAD hatch/block/layer as references only.
- Preserve strict `realitySimulation` architecture.
- Do not build extraction, TIN stitching, DWG export, or object detection.

---

## 14. Deferred visual/render items

Defer:

- Photoreal materials.
- Texture sourcing/scraping.
- Full object mesh library.
- Automatic surfel/point-cloud material inference.
- Building v2 openings/decks/dormers/editable faces.
- Full surface stitch/TIN compiler.
- Contours.
- DWG export engine.
- Codelist editor.
- Corridor/roadway generator.
- Classification editing.

These are real future needs, but they should not be smuggled into the V1.1
appearance pass.

---

## 15. Risks/unresolved questions

Risks:

- Procedural material patterns can become noisy and reduce survey readability.
  Keep contrast low and outlines clear.
- Pretty materials can imply more truth than exists. Evidence/authorship cues
  must remain visible.
- A dark viewer background makes every material look worse. Fix scene lighting
  and background early.
- DWG mode can drift into a second renderer if not kept as a presentation mode
  over the same model.
- Object primitives can become too toy-like. Keep them simple, scaled, and
  symbolically useful.

Open questions for implementation taste review:

- Should the default material view be `clean` or `rich`? Recommendation: rich
  enough to show material, clean enough for survey review.
- Should region pattern density scale with zoom? Recommendation: yes, eventually;
  v1.1 can use conservative fixed procedural scale.
- Should all labels be globally toggleable? Recommendation: yes, with sensible
  defaults by feature family.
- Should selection handles appear in 3D orbit and Top mode identically?
  Recommendation: same vocabulary, mode-specific placement.

---

## 16. Recommended next implementation manager

Recommended next manager:

**Create Sim V1.1 Polish Implementation Manager**

Suggested first vertical slice:

**Region appearance polish end-to-end** - material presets, procedural patterns,
border hierarchy, selected/edit handles, and evidence vertex styling. This gives
the biggest visual lift and directly addresses the owner's "color blocks"
concern.

Second slice:

**Building/object symbol polish** - wall/roof split, simple lighting, object
primitive library, marker/control symbols.

Third slice:

**Mode and UX polish** - true viewer tool rail, selected sync, delete confirm,
Sim/DWG presentation distinction.

---

## 17. What should not be built yet

Do not build:

- Automatic point-cloud extraction.
- Object detection.
- Classification editing.
- Cloud registration or merge.
- Tiled cloud manager.
- Full Reality Simulator automation.
- Ground stitch/TIN compiler.
- Contour generation.
- DWG export engine.
- Codelist editor.
- GIS/parcel/PLSS/NGS systems.
- Work orders/reports.
- Estimating/tracking.
- Image/photo manager.
- Mobile assistant.
- Cloud sync/accounts.
- Photoreal renderer or scraped asset library.

The next pass should improve authored feature appearance and interaction clarity,
not expand the product boundary.

**CREATE SIM UX/APPEARANCE DESIGN READY — PREPARE CREATE SIM V1.1 POLISH IMPLEMENTATION MANAGER**
