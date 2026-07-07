# Surfel Restoration Implementation Note

Date: 2026-07-07

Scope completed in code for R1-R5 from `_DOCS/SURFEL_ORIENTATION_REGRESSION_REVIEW.md`, with F1-F3 retained from `_DOCS/SURFEL_DEFECT_IMPLEMENTATION_NOTE.md`.

No full-scale regen was run in this session. Agent-side validation was limited to unit tests, the full repo suite, and tight `--bbox` subset runs.

## Implemented

### R1: Old orientation rule restored

- The surfel billboard flag now follows the old Phase 4.5 anisotropy rule again.
- Billboarding now happens only when PCA fails or `anisotropy = (λ3 - λ1) / trace < 0.35`.
- The current `planarity < 0.35 || linearity > planarity` flag rule was removed.
- Generator-only change; shader orientation branch remains untouched.

### R2: Cell population restored via `surfelCellScale`

- The existing `surfelCellScale` knob was used, per owner decision C2.
- Recommended default is now `2x`.
- The builder defaults to `2x` when no explicit scale is passed.
- The UI surfel-generation action also passes the default `2x` scale explicitly.

### R3: Phase 4.5 radius coefficients restored

Confirmed against the `OLD_` reference files and restored exactly as code expressions, while keeping F1 provenance and F2 clamping intact:

- spacing floor: `radiusCellSize * 0.85`
- variance term: `sqrt((λ2 + λ3) * 0.5) * 1.5`
- cell floor: `radiusCellSize * 0.35`

The `sqrt(count)` division was removed from the spacing floor as required.

### R4: No-op confirmed

- The old fragment shader was not re-imported.
- The F6 black-center fix remains intact.

### R5: Surfel-only display scale restored

- A separate `Surfel size` UI slider now controls a surfel-only display uniform.
- The old 0.7–1.7 lerp behavior was restored on the surfel renderer.
- It is deliberately not wired to the point-size slider, so the prior slider leak is not reintroduced.

## Tests

### Focused surfel tests

- `tests/analytic-surfels.test.ts` passed: `20/20`.

Added/updated fixture coverage:

- 2-point cell stays oriented, not billboarded.
- genuinely isotropic blob billboards.
- restored radius coefficients are asserted directly.
- previous F1-F3 regression fixture for isolated-point radius remains green.

### Full suite

- `npm test` passed: `240/240`.

## Behavior-Contract Test Change

Owner sign-off required and explicitly called out here.

This session rewrote the test that encoded the orientation regression itself.

Old assertion:

```ts
expect(surfels.flags[0] & ANALYTIC_SURFEL_SCREEN_ALIGNED).toBe(ANALYTIC_SURFEL_SCREEN_ALIGNED);
```

New assertion:

```ts
expect(surfels.flags[0] & ANALYTIC_SURFEL_SCREEN_ALIGNED).toBe(0);
```

File: `tests/analytic-surfels.test.ts`

Meaning: linear clusters are once again world-oriented under the restored anisotropy contract, matching the accepted Phase 4.5 behavior.

## Subset Evidence

### Before vs after on the known tight bbox

Before restoration reference:

- file: `_DOCS/SURFEL_DEFECT_AFTER_BBOX_1.json`
- state: F1-F3 shipped, before R1-R3 restoration
- screen-aligned percent: `93.3%`
- radius percentiles: `p50 0.8481`, `p90 3.3923`, `p99 5.8756`, `max 11.7513`
- clamp count: `0`

After restoration at the recommended `2x` scale:

- file: `_DOCS/SURFEL_RESTORE_BBOX_SCALE2.json`
- screen-aligned percent: `0.0%`
- points per surfel mean: `5.8`
- merge histogram: `[6, 0, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 3]`
- radius percentiles: `p50 1.3873`, `p90 5.5492`, `p99 5.5492`, `max 11.0984`
- clamp count: `0`

Interpretation: billboard rate collapsed from a near-total majority to none on this subset, radii moved back toward the Phase 4.5 size character, and the max stayed bounded without using the clamp.

### R2 comparison: `2x` vs `3x`

Tight bbox comparison:

- files: `_DOCS/SURFEL_RESTORE_BBOX_SCALE2.json` and `_DOCS/SURFEL_RESTORE_BBOX_SCALE3.json`
- result: identical outputs on that very small bbox

Broader still-local representative subset:

- files: `_DOCS/SURFEL_RESTORE_BBOX_WIDE_SCALE2.json` and `_DOCS/SURFEL_RESTORE_BBOX_WIDE_SCALE3.json`

`2x`:

- input points: `10198`
- surfels: `646`
- points per surfel mean: `15.79`
- screen-aligned percent: `0.6%`
- merge histogram: `[404, 142, 64, 14, 11, 1, 0, 0, 0, 0, 0, 0, 10]`
- radius percentiles: `p50 0.2285`, `p90 1.7937`, `p99 11.0984`, `max 88.7874`
- clamp count: `0`

`3x`:

- input points: `10198`
- surfels: `481`
- points per surfel mean: `21.20`
- screen-aligned percent: `1.5%`
- merge histogram: `[324, 93, 38, 7, 6, 0, 4, 0, 0, 0, 0, 0, 9]`
- radius percentiles: `p50 0.3427`, `p90 1.7937`, `p99 11.0984`, `max 88.7874`
- clamp count: `0`

### Recommendation

Recommend `surfelCellScale = 2`.

Reason:

- `3x` reduces surfel count and raises points-per-surfel as expected, but it does not improve the upper-radius tail on the tested subset.
- `3x` slightly worsens the billboard fraction on the broader subset.
- `2x` preserves more detail while still collapsing the billboard rate to a small minority.

### Sanity check on large discs

The broader subset still contains a small number of large discs in the top tail, but they are localized to one center family and repeated across ancestor node keys (`0-0-0-0`, `1-0-0-0`, `2-*`, `3-*`), which is consistent with a single flat patch appearing across LOD hierarchy rather than unexpected large discs scattered across rough surface.

No widespread large-disc outbreak was observed in the subset validation used for this session.

## Owner-Run Commands

Run these outside the agent session. No full-scale regen was run here.

### 1. Post-restoration full-LAS JSON at the recommended scale

```powershell
npm exec tsx scripts/build-surfel-diag.mts -- --project-folder="C:\Users\Owner\AppData\Local\Temp\wb-surfel-diag-S2x9vR\surfel-diag" --asset-id="point-cloud-1783384561123" --skip-index --surfel-cell-scale=2 --json="_DOCS\SURFEL_RESTORE_AFTER_FULL_SCALE2.json"
```

### 2. Pre-restoration comparison JSON

Run this from a preserved pre-restoration checkout/project if you want a like-for-like full-LAS before/after diff for the R-package:

```powershell
npm exec tsx scripts/build-surfel-diag.mts -- --project-folder="<pre-restoration-project-folder>" --asset-id="<pre-restoration-point-cloud-asset-id>" --skip-index --surfel-cell-scale=1 --json="_DOCS\SURFEL_RESTORE_BEFORE_FULL.json"
```

## Owner-Run TODOs

### TODO: Full-LAS before/after diff

- before placeholder: `_DOCS/SURFEL_RESTORE_BEFORE_FULL.json`
- after placeholder: `_DOCS/SURFEL_RESTORE_AFTER_FULL_SCALE2.json`

Fill in:

- billboard rate before vs after
- radius percentile table before vs after
- merge histogram diff before vs after
- points-per-surfel mean before vs after
- top-10 largest surfels before vs after

### TODO: In-app check

- orbit the owner dataset and confirm discs stay world-fixed under camera motion
- confirm the billboard rate subjectively reads as a small minority
- confirm the chosen `2x` size feels right before any full-scale pick-up to `3x`

## Files Produced In This Session

- `_DOCS/SURFEL_RESTORE_BBOX_SCALE2.json`
- `_DOCS/SURFEL_RESTORE_BBOX_SCALE3.json`
- `_DOCS/SURFEL_RESTORE_BBOX_WIDE_SCALE2.json`
- `_DOCS/SURFEL_RESTORE_BBOX_WIDE_SCALE3.json`
- `_DOCS/SURFEL_RESTORATION_IMPLEMENTATION_NOTE.md`
