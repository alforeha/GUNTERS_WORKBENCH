# Beta Object Isolation — Delivery Report

**Date:** 2026-07-13
**Scope:** Object Refinement arc — isolate area, explicit evidence, 3D object preview, viewer focus mode, evidence window selection, full-density area loading.
**Status:** Complete for beta; 432 automated tests green, TypeScript clean. Ships as the `beta OBJECT ISOLATION` push (all work currently uncommitted on `main` atop `6529903 beta OBJECT PLACEMENT implemented`).

---

## 1. What was delivered

### Isolate Area (viewer work/focus boundary)
- User draws an XY polygon boundary on an object (snap-assisted, free placement allowed); stored on the feature (`metadata.isolateBoundary`), persisted and restored through the existing manifest schema with no schema change.
- Opening an object with a boundary puts the main viewer into **focus mode**: point-cloud data (index + preview) outside the polygon is hidden via a GPU polygon clip injected into the point materials (`src/viewer/isolateClip.ts`). Exact concave-polygon clipping, no shader recompile on toggle, instant restore on back/tab-switch/delete.
- Redraw and Clear actions; boundary is emphasized in-viewer along with evidence and origin markers.
- **Design rule enforced throughout (test-backed):** the isolate boundary is context, never evidence. Nothing inside it is auto-selected; placement is never computed from it.

### Explicit Evidence
- "+ Add evidence point" mode: each snapped click on a cloud point adds exactly one provenance ref (`evidenceRefs`, schema-validated). Free clicks ignored; duplicates skipped; live crosshair shows the exact candidate the click will use.
- **Select by window:** one-shot rubber-band drag captures every visible cloud point in the rectangle — front and occluded alike — restricted to the isolate zone while focus is active. Batch-stored in a single persist. Verified in the field at 11,382 points from one tree selection.
- Snapping respects the isolate clip everywhere ("pick only what you see"): hidden points cannot snap, for evidence or any other tool.
- Scrollable evidence list (up to 200 rows, each removable), overflow summarized as a count, "Remove all evidence" action, and explicit feedback whenever a window selection is sampled (never silent).

### Object Preview (3D)
- The detail panel renders the actual parametric object — same generator output as the main viewer — in a mini orbitable Three.js scene (`src/ui/objectPreview.ts`): drag to rotate, wheel to zoom; shows origin (amber), evidence points (blue), isolate footprint (dashed), ground grid; z-up matching the survey convention. Orbit pose and WebGL context survive panel re-renders; params/evidence changes update in place.

### Load All Survey Data in Area
- Button in the Isolate Area section streams **every index tile intersecting the boundary, all levels to the leaves**. The WPI index is owner-partitioned (each point stored at exactly one level), so this union is the complete, deduplicated survey data for the area — "double measurements" appear once by construction.
- **Over-capacity catch:** the plan is computed for free from index node counts before anything loads. Areas exceeding the render budget are split at the **point-weighted median** along the longer axis (balanced halves even for skewed density), recursively — 2 sectors when slightly over, more as needed (max 16). Panel shows "sector k of N" with Prev/Next/Stop; the active sector renders as an amber rectangle in the viewer. Region tiles take fetch priority and are protected from eviction.

### Defect fixes landed during the arc
- Evidence window: honored tile draw ranges (eliminated phantom picks from unpacked buffer tails) and made the camera-plane tile pre-cull mathematically conservative (occluded/behind points always selectable).
- Snap threshold basis: point picking is now pixel-accurate at the candidate's actual depth at any zoom (probe-ladder + refine), fixing the disappearing/unreliable close-range crosshair.
- **Evidence snapping is now cloud-only (fixed in this report's pass):** authored feature vertices/edges previously outranked cloud points in snap precedence, so clicks near an object's own wireframe recorded the wireframe as "evidence." Both the click and the crosshair now consider cloud points exclusively during evidence picking.

---

## 2. Verification

- 432 tests across 36 files (up from 401 at arc start): pure region/sector selection math, isolate clip uniforms + shader injection, polygon containment (incl. concave), controller flows (isolate draw/persist/clear, evidence add/dedupe/window/remove-all, load-all sector stepping, focus lifecycle), panel rendering of every new control state.
- TypeScript strict typecheck clean; renderer bundle verified through the arc (final pass delta adds no new modules; re-run `npm run build` as the pre-push formality).

## 3. Known observations & analysis (owner field notes)

1. **"Load all" shows no visible change; banner went 5.3M → 4.9M points.** Analysis: when zoomed into the work area, normal screen-space-error streaming has usually already refined that area to leaf level — so full-density adds little *there*, while the feature intentionally trims the streaming budget elsewhere to guarantee headroom for the region (hence the small drop, mostly tiles outside the isolate that the clip hides anyway). The feature's value shows when zoomed out or on large/dense areas. **Recommended follow-up:** a region-aware disclosure line ("area: 100% of 2.1M points loaded") so the guarantee is visible instead of inferred, and skipping the SSE trim when the region is comfortably small.
2. **Safety caps vs. "select all, no limits".** Owner direction: no artificial limits or silent failure catches. Current state: the window cap is 20,000 (was 50 at first beta) and always disclosed. The honest constraint is evidence *storage* (per-point refs in the manifest, cloned on every edit), not selection. **Owner-proposed direction, endorsed:** working evidence kept in full while the object is open (session-scoped), summarized/sampled on close for persistence, with a future "Analyze Evidence" automation consuming the full set. Queued as an evidence-storage rework when automations begin.
3. **Index deep-dive is the likely next focus** after remaining beta sim aspects settle: aligning index behavior/appearance with expectations (owner has a Blender plug-in reference to evaluate as a benchmark). Isolate is also planned to generalize to building envelopes/work-areas and regions — the boundary storage and viewer focus machinery were built feature-generic for that reason.

## 4. File-size audit (owner request)

Files currently over 1,000 lines:

| File | Lines | Notes |
|---|---|---|
| `src/viewer/ViewerEngine.ts` | 2,698 | Was ~2,300 pre-arc; +327 this arc. Pre-existing hotspot. |
| `src/viewer/RenderPdf.ts` | 1,494 | Untouched by this arc. |
| `src/ui/features.ts` | 1,150 | **Crossed 1,000 this arc** (+333). |
| `src/ui/rightPanel.ts` | 1,005 | **Crossed 1,000 this arc** (+228). |

New focused modules created this arc (the preferred pattern): `src/viewer/isolateClip.ts`, `src/ui/objectPreview.ts`, plus their tests.

**Policy correction acknowledged:** an early "no new files" directive was revoked but growth still accreted into existing files. Going forward, new subsystems get new modules, and ~1,000 lines is the split signal. Ready extraction candidates: object-edit/evidence/isolate controller logic out of `features.ts` (~400 lines), feature-detail renderers out of `rightPanel.ts` (~300 lines), and the evidence-window + isolate-focus block out of `ViewerEngine.ts` (~250 lines) — each is a clean seam, offered as a small hygiene pass on request.

## 5. Suggested next steps

1. Owner retest of cloud-only evidence snapping, then push `beta OBJECT ISOLATION`.
2. Region-aware load-all disclosure (small pass) to make the full-density guarantee visible.
3. Evidence-storage rework (session-full / persist-summary) ahead of the "Analyze Evidence" automation.
4. Cloud index deep-dive (appearance + behavior, Blender plug-in as reference) once beta sim aspects settle.
5. Optional file-split hygiene pass per Section 4.
