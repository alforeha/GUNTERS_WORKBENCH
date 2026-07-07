# Surfel Orientation Regression Review — Phase 4.5 (OLD_) vs Current

Date: 2026-07-07. Read-only compare of `_DOCS/OLD_ANALYTIC-SURFELS.ts`, `_DOCS/OLD_ANALYTIC-SURFEL-BUILDER.ts`, `_DOCS/OLD_STREAMINGSURFELS.ts` against `src/core/pointcloud/analytic-surfels.ts`, `electron/analytic-surfel-builder.ts`, `src/viewer/StreamingSurfels.ts`. No code changed, no builds run.

Owner ground truth accepted as controlling: in the Phase 4.5 build, discs lay flat on surfaces, stayed put under camera motion, and had readable sizes; the only defect was black disc centers. The current build reports ~91.4% camera-facing billboards. Where `SURFEL_MERGE_REVIEW_PHASE5_3.md` and `SURFEL_RENDER_DEFECT_REVIEW.md` treated the billboard rate as frozen "character," that framing is overruled here.

---

## 1. Why the old discs were flat and stable

### Plain language

Both versions decide orientation the same mechanical way: the builder computes a PCA normal per grid cell and sets a per-surfel `ANALYTIC_SURFEL_SCREEN_ALIGNED` flag; the vertex shader (identical in both versions for this branch) either anchors the quad to `instanceNormal` (flat, world-fixed) or to `cameraRight`/`cameraUp` (billboard). The regression is **entirely in who gets the flag**, driven by two CPU-side changes:

1. **The flag rule got much stricter.** The old rule flagged a surfel as billboard only when PCA outright failed or its *anisotropy* score was below 0.35 — a score that is high for almost any non-spherical point cluster, including thin lines and 2-point cells. In practice nearly everything kept its PCA normal, so nearly everything rendered flat and world-stable. The new rule demands genuine *planarity* ≥ 0.35 AND planarity ≥ linearity. Fine cells holding 2–3 points can never satisfy that (2 points → planarity exactly 0; 3 points → noise decides linearity vs planarity; scan-line striping makes small cells systematically linear), so the bulk of surfels get billboarded.

2. **Cells got starved.** The old builder let each node compute its own cell size from `cbrt(nodeVolume / pointCount)`. For real scans — a 2D surface inside a mostly-empty 3D node — the cube-root volume estimate *over*-estimates spacing, producing fat cells that capture dozens of points each: enough for a trustworthy PCA normal. The current builder uses a global 2D-area spacing plus `nodeLevelCellSize`, which the Phase 5.3 review itself measured at ~2–3 points per fine cell. Starved cells produce junk eigenvalue splits, which the strict new rule then converts into billboards.

A subtle but important point: even where the old PCA normal was low-quality (a 2-point cell has a mathematically arbitrary normal), it was **fixed in world space**, so the disc never moved. Stable-but-imperfect reads as a solid surface; the current billboards recompute against the camera every frame and swim. The owner's preference for the old behavior is consistent with how splatting renderers are usually judged.

### File/line detail

- OLD flag rule — `_DOCS/OLD_ANALYTIC-SURFELS.ts:130–146`: `confidence = (λ_max − λ_min) / trace` (`:179–180`), flag set only when `!normalEstimate || confidence < 0.35` (`:139`, `:146`). For a rank-1 (perfectly linear) cell: trace = λ3, score = 1.0 → **oriented**. For a flat patch: score ≈ λ3/(λ2+λ3) ≥ 0.5 → oriented. Only near-isotropic blobs or NaN normals billboard.
- CURRENT flag rule — `src/core/pointcloud/analytic-surfels.ts:404–410`: `!normalEstimate || planarity < 0.35 || linearity > planarity`, with `planarity = (λ2−λ1)/λ3`, `linearity = (λ3−λ2)/λ3` (`:465–466`). Linear/starved cells → billboard, exactly as `SURFEL_MERGE_REVIEW_PHASE5_3.md` §3 (line 96) predicted ("plausibly 60–90%" flagged; the shipped run reported 91.4%, though `SURFEL_RENDER_DEFECT_REVIEW.md` D2 notes that figure was also double-counted pre-F4).
- OLD cell sizing — `_DOCS/OLD_ANALYTIC-SURFELS.ts:48–59`: per-node `spacing = cbrt(volume/count)`, `cellSize = spacing * 1.5`; builder passed no `cellSize`/`gridOrigin` (`_DOCS/OLD_ANALYTIC-SURFEL-BUILDER.ts:94–99`). Volume-based spacing on surface data → fat, well-populated cells.
- CURRENT cell sizing — `electron/analytic-surfel-builder.ts:79–81, 96, 428–446`: global `sqrt(area/count)` spacing, `nodeLevelCellSize = max(globalCellSize, min(0.7·edge/√N, 0.05·edge))` → ~2–3 pts/cell per the Phase 5.3 review (G6); interior strided nodes worse. `src/core/pointcloud/analytic-surfels.ts:94–103` also changed `estimatePointSpacing` itself from cbrt-volume to sqrt-area.
- Shader — `src/viewer/StreamingSurfels.ts:100–115` vs `_DOCS/OLD_STREAMINGSURFELS.ts:102–122`: the orientation branch is **character-for-character identical**. The shader is exonerated; the flag data is the whole story.
- The merge pyramid (`mergeCellsBottomUp`, current `:198–331`) was supposed to promote starved fine cells into well-populated merged cells with good normals. Post-F3, sparse promotion is deliberately capped at 2 doublings (`:42`, `:258`), and the shipped histogram (`SURFEL_RENDER_DEFECT_REVIEW.md` header: `[16.1M, 17.2M, 9.4M, …]` of 45M) shows ~74% of emitted surfels still live at levels 0–1 — i.e., most surfels are exactly the starved cells the strict rule billboards.

---

## 2. Why the old discs had readable sizes

Three multiplicative regressions, all visible in the diff:

1. **Bigger spacing input.** Old radius floor `spacing * 0.85` used the per-node cbrt-volume spacing (large, see above). Current floor is `localSpacing * 0.9` where `localSpacing = radiusCellSize / √count` (`src/core/pointcloud/analytic-surfels.ts:388`) — dividing by √count makes the floor *shrink* as cells get healthier.
2. **Variance term cut ~2.1×.** Old: `sqrt((λ2+λ3)·0.5) · 1.5` ≈ `1.06·sqrt(λ2+λ3)` (`OLD_ANALYTIC-SURFELS.ts:142–145`). Current: `sqrt(λ2+λ3) · 0.5` (`analytic-surfels.ts:389–391`).
3. **Cell floor cut.** Old `cellSize * 0.35` vs current `radiusCellSize * 0.22` (`analytic-surfels.ts:392`), and the current cell size feeding it is itself smaller.

Additionally the old renderer exposed a user size control — `setDisplay(visible, sizeScale)` lerped 0.7–1.7 (`OLD_STREAMINGSURFELS.ts:162–167`); the current `setDisplay(visible)` hard-pins `sizeScale = 1` (`StreamingSurfels.ts:157–161`). Part of "readable" in Phase 4.5 was that the owner could turn discs up.

Note the fairness caveat: the current small radii coefficients plus `radiusCellSize` provenance are partly the F1 mega-disc fix. The restoration below raises coefficients without touching provenance, which is what actually killed the mega-discs.

---

## 3. The black-center defect in the OLD renderer — root cause

`_DOCS/OLD_STREAMINGSURFELS.ts:128–134`:

```glsl
float dist = dot(vCorner, vCorner);
if (dist > 1.0) discard;
float edge = smoothstep(1.0, 0.7, 1.0 - dist);   // ← the bug
float alpha = mix(0.55, 0.95, clamp(vConfidence, 0.0, 1.0)) * edge;
gl_FragColor = vec4(vColor, alpha);
```

The feather argument is inverted. With reversed edges, hardware evaluates `smoothstep(1.0, 0.7, x)` as `clamp((1.0 − x)/0.3)` smoothed; substituting `x = 1.0 − dist` gives `edge ≈ clamp(dist/0.3)` smoothed. So **`edge = 0` at the disc center** (dist = 0) ramping to 1 by dist ≥ 0.3: the center is fully transparent and only an annular rim is opaque. Because the material was `transparent: true` with `depthWrite: true` (`:136–138`) and `alphaTest` on a raw `ShaderMaterial` injects nothing into a custom shader, those alpha≈0 center fragments still wrote depth — punching a hole that shows the background (black) and occludes surfels behind. That is the black-center defect, exactly.

The intended expression was `smoothstep(1.0, 0.7, dist)` — opaque center, feathered rim. The current shader (`StreamingSurfels.ts:120–130`, installed as F6) already renders `alpha = 1.0 − smoothstep(0.7, 1.0, dist)` with explicit `discard` below 0.5 and an opaque material — center solid, rim feathered, no blending-order artifacts. **The black-center bug is already fixed in the current renderer; the restoration must simply not re-import the old fragment shader verbatim.** If the old confidence-weighted translucency (`mix(0.55, 0.95, conf)`) is ever wanted back, it needs the corrected smoothstep *and* a solution for unsorted transparent quads with depthWrite — recommend against; keep the current opaque feather.

---

## 4. Restoration package (centerpiece)

Goal: Phase 4.5 orientation and size character, F1–F3 mega-disc fixes intact, black centers fixed. Ordered by payoff. R1 is the regression; R2–R3 are the character; R4–R5 are renderer-only comfort.

| # | Change | File / line | Effort | Risk | Regen |
|---|--------|-------------|--------|------|-------|
| **R1** | **Restore the old flag rule.** In `emitSurfelsFromCells`, replace the condition at `src/core/pointcloud/analytic-surfels.ts:404–406` with the Phase 4.5 test: `const anisotropy = (λ3 − λ1) / max(λ1+λ2+λ3, 1e-9); screenAligned = !normalEstimate || anisotropy < 0.35;` (λ's already available from `normalEstimate.eigenvalues`). Keep `planarity` in the `confidence` buffer or switch back to anisotropy — cosmetic either way since the current fragment shader ignores confidence. | analytic-surfels.ts:404–410 | ~1 hr | Low mechanically; behavioral contract change (see Conflict C1) | **Yes** — flags are baked into `.sftile` files |
| **R2** | **Feed cells enough points.** Two options — owner's choice, see Conflict C2. **(a) Minimal:** raise the existing `surfelCellScale` knob (`electron/analytic-surfel-builder.ts:80`, plumbed through `BuildCommonInput:40`) to ~2–3, taking fine cells from ~2–3 pts to ~9–20 pts. Keeps the global grid, grid-phase stability, and the merge pyramid untouched. **(b) Faithful revert:** restore per-node `cbrt(volume/count)` spacing (old `estimatePointSpacing`, `OLD_ANALYTIC-SURFELS.ts:48–55`) and drop `nodeLevelCellSize`/`gridOrigin` from the builder call (`analytic-surfel-builder.ts:96–105`). | builder:79–81, 96, 428–437 (a); + core:94–103 (b) | (a) ~1 hr + tuning runs; (b) ~½ day | (a) Low — shifts counts/level histogram, F1–F3 semantics unchanged; (b) Medium-high — see C2 | **Yes** (same regen as R1) |
| **R3** | **Restore radius character without breaking F1/F2.** At `analytic-surfels.ts:388–392`: variance coefficient `0.5 → 1.06` (old `1.5·sqrt(·/2)`), cell floor `0.22 → 0.35`, and spacing floor `radiusCellSize/√count · 0.9 → radiusCellSize · 0.85·k` (drop the √count divisor; tune k against harness percentiles). **Keep** `radiusCellSize` provenance (F1) and the builder's `0.5·nodeEdge` clamp (F2, `analytic-surfel-builder.ts:453–474`) exactly as they are — those, not the coefficients, are what killed the mega-discs. Watch `clampedRadiusCount` stays 0 in the harness. | analytic-surfels.ts:388–392 | ~1 hr + harness bbox runs | Low-medium — bounded by F2 cap; validate p50/p90/p99 like the F-note did | **Yes** (same regen) |
| **R4** | **Black centers: no action required** — current fragment shader (F6) already correct. Do not restore `OLD_STREAMINGSURFELS.ts:124–142` verbatim; if restoring any of it, fix the feather to `smoothstep(1.0, 0.7, dist)` and drop `transparent: true`. | StreamingSurfels.ts:120–137 (verify only) | 0 | None | No |
| **R5** | *(Optional)* Restore user size scaling: `setDisplay(visible, sizeScale)` with the old 0.7–1.7 lerp (`OLD_STREAMINGSURFELS.ts:162–167`) at `StreamingSurfels.ts:157–161`, plus its call sites. Cheap insurance for "readable sizes" while R3 is tuned. | StreamingSurfels.ts:157–161 + callers | ~1–2 hrs | Trivial | No |

One regen covers R1+R2+R3 (all build-side). R4/R5 are viewer-only.

### Conflicts requiring an owner decision — not silently resolved

**C1 — R1 vs the current behavioral-contract tests.** `tests/analytic-surfels.test.ts:147–161` ("routes linear clusters to the screen-aligned path") asserts a 4-point collinear cluster gets the billboard flag. Under the restored Phase 4.5 rule, that cluster's anisotropy = 1.0 → **oriented**, and the test fails as written. This is not collateral damage; it is the regression itself, encoded as a test. The companion test at `:163–176` (coincident points → billboard) still passes under the old rule (zero covariance → anisotropy 0). Decision needed: re-sign the contract so linear clusters render as world-stable discs with their (arbitrary-but-fixed) PCA normal — the Phase 4.5 behavior you liked — or keep linear clusters billboarded and accept that scan-line-dominated fine cells will keep swimming. The Phase 4.5 evidence says the former; stating it plainly because a reviewer deliberately wrote that test.

**C2 — old cell sizing vs the current merge machinery.** The faithful revert (R2b) conflicts with two things the current code depends on: (1) the shared global grid phase — `gridOrigin` + uniform `cellSize` make surfels identical across tile boundaries (`tests/analytic-surfels.test.ts:123–145`); per-node cbrt sizing reintroduces seam mismatches the grid was built to remove; (2) the bottom-up merge pyramid assumes one fine cell size per derivation, and per-node sizing changes what "level" means across nodes, degrading the level histogram as an instrument and interacting untestedly with F3's doubling cap. R2a (scale the global cell up 2–3×) avoids both conflicts and directly attacks the starvation that G6 documented; it is the recommended path, but it is a tuning knob, not a byte-for-byte return to Phase 4.5. If the owner wants literal Phase 4.5 cell behavior, R2b is the honest route and the grid-phase test plus merge-level metrics must be renegotiated. Choose.

**C3 — flag-bit semantics vs old tiles.** Not a code conflict, a data one: flags, radii, and normals live in `.sftile` payloads, so nothing in R1–R3 shows up in-app until a surfel regen (the F-note's `build-surfel-diag.mts --skip-index` path is sufficient). Renderer-only changes (R4/R5) show up immediately.

### Suggested validation (owner-run, per existing harness)

Re-run the tight bbox repros from `SURFEL_DEFECT_IMPLEMENTATION_NOTE.md`; confirm `clampedRadiusCount = 0`, the two mega-disc sites stay collapsed (radii ~5.9 / ~19.2 scale, not 10³–10⁴), the corrected `screenAlignedFrac` drops from ~0.9 to a small residual (isotropic clutter only), and radius p50/p90 rise by roughly the R3 coefficient ratios. Then one full regen and an in-app orbit check: discs must not reorient with the camera.

---

SURFEL ORIENTATION REGRESSION REVIEW COMPLETE
