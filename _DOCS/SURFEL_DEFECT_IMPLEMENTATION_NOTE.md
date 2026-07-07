# Surfel Defect Fix Implementation Note

Date: 2026-07-07

Scope completed in code for F1-F6 from `_DOCS/SURFEL_RENDER_DEFECT_REVIEW.md`, with agent-side validation limited to unit tests and tight `--bbox` subset harness runs.

## Implemented

### F1: Radius provenance

- `CellEntry` now carries `mergedCellSize`, which records the last accepted real merge size.
- Single-child pass-through no longer inflates radius floors, because pass-through and late sparse termination preserve the previous evidenced merge size.
- Emission now derives `localSpacing` and the `0.22 * cellSize` floor from `mergedCellSize`, not the pyramid bookkeeping `cellSize`.

### F2: Hard radius cap

- The builder now clamps emitted radii to `0.5 * node edge` before tile write.
- `mergeMetrics.clampedRadiusCount` is aggregated as a regression alarm.
- All agent-side bbox validations in this session reported `clampedRadiusCount = 0`.

### F3: Sparse accept restricted to early doublings

- The unconditional `merged.count < MIN_MERGE_POINTS` accept path is now limited to the first 2 doublings.
- Above that, under-populated groups terminate with their F1-correct size instead of inheriting ever-growing bookkeeping size.

### F4: Metrics repairs

- `screenAlignedCount` is now tallied once per emitted surfel instead of double-counting null-normal cases.
- `rejectionReasons.occupancy` now increments on `children.length < 2` pass-through.
- `levelHistogram` is now computed after the singleton filter so it reflects emitted surfels.

### F5: Harness wiring and diagnostics

- `scripts/build-surfel-diag.mts` now wires `--bbox` and `--max-points` into the analytic surfel build path.
- Existing indexed projects can now be opened via `--project-folder` and `--asset-id`, so `--skip-index` works for diagnostic reuse.
- The harness summary now emits:
  - `screenAlignedCount`
  - `emittedCount`
  - `radiusPercentiles`
  - `perLevelMaxRadius`
  - `topLargestSurfels`
  - `clampedRadiusCount`

### F6: Renderer nits

- `StreamingSurfels.ts` now implements the intended feather path via explicit fragment discard instead of dead alpha math.
- The fetch-failure catch now clears stale `dropped` keys alongside `inFlight` cleanup.

## Agent-Side Validation

### Focused tests

- Focused surfel test file passed: `18/18` in `tests/analytic-surfels.test.ts`.
- Full repo suite passed once: `238/238`.

### New regression fixture

- Added a regression test for: isolated point plus distant plane in one node.
- Assertion: emitted isolated-point radius stays bounded to a few fine cells instead of exploding to bookkeeping size.

### Tight bbox repros

These runs are the agent-side validation ceiling for F1-F3. They are sufficient to falsify the mega-disc defect without owner-run full-scale regen.

#### BBox repro 1

- Baseline full-LAS top surfel: radius `24066.61328125`, center `[2894332, 1658559.625, 10872.4951171875]`, node `4-4-3-1`.
- Post-fix bbox run file: `_DOCS/SURFEL_DEFECT_AFTER_BBOX_1.json`.
- Post-fix exact surfel at the same node/center family: radius `5.875638008117676`, node `4-4-3-1`.
- Post-fix bbox-local maximum: radius `11.751276016235352`.
- Clamp counter: `0`.

#### BBox repro 2

- Baseline full-LAS top surfel: radius `13686.9501953125`, center `[2895517, 1658642.25, 10872.380859375]`, node `4-13-3-0`.
- Post-fix bbox run file: `_DOCS/SURFEL_DEFECT_AFTER_BBOX_2.json`.
- Post-fix bbox-local maximum: radius `19.158374786376953`.
- Clamp counter: `0`.

Interpretation: both site-scale failures collapsed into bounded, node-local values, and neither bbox run relied on the hard cap firing.

## Behavior-Contract Test Edit

Owner sign-off required on this fixture change.

Reason: F3 intentionally changes the sparse high-level behavior. The old test encoded indefinite sparse convergence, which is no longer the intended contract.

Old assertion:

```ts
expect(merged.cells.length).toBe(1);
```

New assertion:

```ts
expect(merged.cells.length).toBeGreaterThanOrEqual(1);
expect(merged.metrics.levelHistogram.length).toBeGreaterThan(0);
```

File: `tests/analytic-surfels.test.ts`

Meaning: sparse isolated cells may now stop after the early provisional doublings instead of always converging to one terminal merged cell.

## Owner-Run TODOs

The following full-scale work was intentionally left to the owner.

### TODO: Full-LAS histogram diff

- Baseline JSON placeholder: `_DOCS/SURFEL_DEFECT_BASELINE_FULL.json`
- Post-fix JSON placeholder: `_DOCS/SURFEL_DEFECT_AFTER_FULL.json`

Expected signal to confirm:

- level-12 bin drops below level-11
- levels 0-9 remain within noise of baseline
- `clampedRadiusCount = 0`

### TODO: Full-LAS top-10 table

- Fill in before/after top-10 largest surfels from the two full JSON files.
- Confirm the two known mega-disc populations no longer appear as site-scale outliers.

## Owner Commands

Run these outside the agent session.

### 1. Full-LAS baseline JSON

If you want to recapture the pre-fix baseline from a preserved pre-fix project/index:

```powershell
npm exec tsx scripts/build-surfel-diag.mts -- --project-folder="<pre-fix-project-folder>" --asset-id="<pre-fix-point-cloud-asset-id>" --skip-index --json="_DOCS\SURFEL_DEFECT_BASELINE_FULL.json"
```

### 2. Full post-fix regen + JSON

If the index already exists and you only want to rebuild surfels:

```powershell
npm exec tsx scripts/build-surfel-diag.mts -- --project-folder="<post-fix-project-folder>" --asset-id="<post-fix-point-cloud-asset-id>" --skip-index --json="_DOCS\SURFEL_DEFECT_AFTER_FULL.json"
```

If the index must also be rebuilt, remove `--skip-index`.

### 3. App check

- Open the owner dataset in-app.
- Confirm the two site-scale mega-discs are gone.
- Confirm close-zoom node-blanketing discs are no longer dominating the view.

## Files Produced In This Session

- `_DOCS/SURFEL_DEFECT_BASELINE_FULL.json`
- `_DOCS/SURFEL_DEFECT_AFTER_BBOX_1.json`
- `_DOCS/SURFEL_DEFECT_AFTER_BBOX_2.json`
- `_DOCS/SURFEL_DEFECT_IMPLEMENTATION_NOTE.md`
