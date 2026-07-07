# Surfel Merge Failure Review — Phase 5.3 (pre-fix)

Read-only review of the Phase 5.3 analytic surfel merge falsification: predicted 1–8M surfels / 30–150 MB, actual 68,577,261 surfels / 916 MB on the 381.8M-pt LAS — statistically identical to the pre-merge build (67M). Merging is inert at scale. This document identifies the exact gates, explains why 236/236 fixture tests pass anyway, and specifies the fix package.

---

## 1. Why the merge doesn't fire

### The headline: the all-8-children gate is geometrically impossible on planar data

`src/core/pointcloud/analytic-surfels.ts:194–223`. A parent 2×2×2 block merges only if **all 8 children exist** (`all8`, lines 194–208; merge attempted only `if (all8)`, line 210).

A flat surface is 2D. Its points occupy a slab whose vertical thickness (noise + roughness, ~0.02–0.1 ft) is far smaller than the fine cell size. Within a world-anchored 2×2×2 block, a horizontal surface therefore occupies **at most one z-layer = at most 4 of 8 children**. `all8` fails for essentially every block over exactly the geometry the merge was designed for. The only exception is where the surface elevation happens to cross a grid z-plane inside the block — a set of thin contour strips, a measure-zero fraction of the site. Sloped surfaces fare no better: each xy column of the block still occupies 1–2 z-cells, and all 4 columns must straddle simultaneously. Vertical surfaces (fences) have the same problem rotated into x or y.

**Why tests pass:** the fixtures manufacture the exception. `tests/analytic-surfels.test.ts:187–197` places the plane exactly at the z-cell boundary (`zBoundary ± RMS_PLANE_EPSILON * 0.3`) so both z-layers are occupied and all 8 children exist. Real ground never sits precisely on a grid plane. The fixtures test the merge arithmetic; they never tested the occupancy geometry.

This single gate is sufficient to explain "count unchanged vs pre-merge build." The remaining gates are also real and would each degrade merging, but they are currently masked because the pipeline rarely reaches them.

### The full gate inventory

**G1 — all8 occupancy requirement.** `analytic-surfels.ts:194–210`. As above. Kills ~100% of merge attempts on real surfaces. This is the primary defect.

**G2 — singleton cells dropped before merging.** `analytic-surfels.ts:75` (`minPointsPerSurfel` defaults to 2; the builder passes none, `electron/analytic-surfel-builder.ts:100–108`) and `analytic-surfels.ts:121` (filter). Fine cells with 1 point are removed from the merge map entirely. Two consequences: (a) those points silently vanish from the surfel layer, and (b) every dropped singleton punches a hole in the occupancy grid, making `all8` fail even in blocks that would otherwise straddle a z-plane. Given fine-cell occupancy of ~2–3 pts (see G6), singletons are common.

**G3 — absolute residual threshold below the physical noise floor.** `analytic-surfels.ts:37` (`RMS_PLANE_EPSILON = 0.05` ft) applied at line 218 (`√λ₁ ≤ 0.05`). λ₁ of a merged patch includes sensor ranging noise (typically 0.02–0.1 ft RMS for ALS/MLS), surface roughness (gravel/chip-seal asphalt: 0.02–0.08 ft RMS at 1–10 ft patch scale), registration error between passes, and plane-fit deviation from slope curvature that grows with patch extent. An absolute 0.05 ft budget is consumed by noise alone on many scanners before roughness or curvature contribute anything. Even if G1 were fixed, merging would stall after 0–2 doublings on real pavement and never approach "one disc per flat region."

**G4 — planarity ≥ 0.35 evaluated on tiny merged populations.** `analytic-surfels.ts:36, 215–219`. When a merge is attempted, the merged accumulator holds the sum of 8 children at ~2–3 pts each (~16–24 pts) in the best case, but the planarity/linearity split of `estimateSurfaceNormal` (lines 346–347) is noisy below roughly a dozen well-spread points, and the first-level merges are the ones that unlock all later levels. Correct instinct (the merge does evaluate merged statistics, which is right); wrong gating (no minimum-count condition, and it inherits G1/G2's starvation).

**G5 — MAX_MERGE_DOUBLINGS = 5.** `analytic-surfels.ts:38, 177`. Even a perfect run caps discs at 32× the fine cell (~32 × ~0.25 ft ≈ 8 ft). "A completely flat black grid section becomes one disc" is unreachable by construction.

**G6 — per-node fine cells hold ~2–3 points, and interior nodes are worse.** `electron/analytic-surfel-builder.ts:299–308` (`nodeLevelCellSize`): `fillCellSize = 0.7·edge/√N` yields a cell *smaller than the mean point spacing* for a 2D surface filling the node footprint (≈0.49 pts/cell); the `max(globalCellSize, …)` floor (line 307, globalCellSize = 1.5×global spacing, lines 76, 310–317) rescues it to ≈2.25 pts/cell. So fine cells hold ~2–3 points: rank-deficient PCA (2 pts → planarity exactly 0; 3 pts → exact plane but noise-random orientation), heavy singleton attrition (G2), and screen-aligned flagging (Section 3). Additionally the WPI index is an owner partition (`electron/pointcloud-index-builder.ts:195–241`): interior nodes own strided samples (`strideK`, lines 229–231, 445), so their effective spacing is coarser than the global estimate used for their cell sizing — even sparser occupancy, same gates.

**G7 — merging cannot cross index-node boundaries.** `analytic-surfel-builder.ts:79–135`: `deriveAnalyticSurfels` is called per node with only that node's points. A uniform region spanning nodes can never become fewer discs than nodes. Structural, not a bug per se — see the honesty check in Section 6.

### Does merging even seed at level 0?

Yes — seeding is not the problem. `mergeCellsBottomUp` (lines 166–177) enrolls every surviving fine cell regardless of its own planarity, and the stop test is evaluated on the merged accumulator (correct design). The failure is entirely in G1/G2 (occupancy) and would next be G3 (threshold) if occupancy were fixed.

### Quantified summary on the real run

381.8M points → 68.6M emitted cells ≈ 5.6 pts per emitted surfel (singleton-dropped points included in the numerator). That is exactly the profile of "fine bucketing with zero merging": the count is the occupied-cell count, and the +1.5M delta vs. the 67M pre-merge build is per-node cell sizing jitter, not merging.

---

## 2. Redesigned stop/seed conditions

Design intent restated: disc size driven entirely by content; a flat uniform region becomes very few, very large discs; fences produce vertical discs; no user knob; deterministic; bounded memory.

### 2.1 Evaluate merges on merged statistics with a count gate

Keep the current (correct) structure of testing the merged accumulator, but add a stability gate: a merge decision is trusted only when `merged.count ≥ MIN_MERGE_POINTS` (recommend 12–16). Below that, the merge is **provisionally accepted** if the parent would still be tested at the next level (the accumulator keeps growing; a bad provisional merge is caught when enough points accumulate) — or, simpler and safer for v1: below the count gate, merge unconditionally on occupancy alone for the first level only, since 2–3-pt cells carry no meaningful plane evidence to violate. Either policy is deterministic; the second is easier to reason about.

### 2.2 Replace all8 with a partial-block policy

Merge whatever children exist. Required conditions:

- At least 2 occupied children (a lone child just gets re-keyed upward, which is fine and free — it's how a sparse region rides the pyramid until it meets neighbors).
- Merged planarity/residual tests pass (below) once the count gate is met.
- Optional anti-bridging guard: reject the merge if the children's centroids are farther from the merged plane than the residual budget — this is already implied by the √λ₁ test, so no extra machinery is needed. A curb step of 0.3 ft still halts merging exactly as the existing curb fixture expects, because the merged λ₁ explodes.

Determinism: iterate children in the fixed (dx, dy, dz) order already present (lines 196–208) so floating-point accumulation order is stable; parent keys remain world-anchored floor-division (line 183). Note `Math.floor(ix/2)` is correct for negative indices; grid indices are non-negative here anyway (origin = cube origin).

### 2.3 Scale-relative residual threshold

Replace the absolute `√λ₁ ≤ 0.05 ft` with:

```
√λ₁ ≤ max(SENSOR_NOISE_FLOOR, RELATIVE_FLATNESS × mergedCellSize)
```

- `SENSOR_NOISE_FLOOR` ≈ 0.05 ft (the current constant, reinterpreted as what it actually is: the noise floor below which flatness cannot be measured). Without this term, small merges over noisy-but-flat gravel fail.
- `RELATIVE_FLATNESS` ≈ 0.01–0.02. This bounds the *sagitta as a fraction of disc size* — the visually meaningful quantity. A 100 ft disc tolerating ~1–2 ft of RMS deviation sounds large in absolute terms but is exactly what "abstract, content-driven" means: the disc's deviation from the true surface stays proportionally small at the scale you view it. It also naturally lets gently crowned roads merge along the crown until curvature outruns the budget.

Planarity threshold: keep ≥ 0.35 but apply it only when the count gate is met (2.1). Empirically tune both with the harness (Section 5), not in fixtures.

### 2.4 Stop dropping singletons before merging

Enroll all occupied fine cells (including count-1) in the merge pyramid. Apply `minPointsPerSurfel` only at **emission**: a terminal fine-level cell with 1 point may be dropped (current behavior preserved for un-merged noise), but a singleton that merges into a parent contributes its point instead of vanishing. Fixes both the data loss and the occupancy holes.

### 2.5 Cap policy for very large discs

Raise `MAX_MERGE_DOUBLINGS` from 5 to effectively unbounded within a node — the pyramid self-terminates when the level map has one cell or no merge fires, and the node extent bounds the disc. Memory is bounded: each level's map is strictly smaller than the previous (merged parents replace ≥2 children; unmerged cells leave the map into `terminal`). Recommend keeping a generous safety cap (e.g., 12 doublings ≈ 4096× fine cell) purely as an infinite-loop guard; on a 100k-pt leaf node the pyramid exhausts long before that.

The true cap is structural: **one disc per index node per LOD** (G7). Accept it for this phase; see Section 6.

### 2.6 Fixture honesty

Rewrite the merge fixtures so the plane sits at an arbitrary z (NOT on a cell boundary), occupying a single z-slab — the case that falsified Phase 5.3. The current straddle fixture (`tests/analytic-surfels.test.ts:187–197`) should be kept as a secondary case, not the primary one. Add: sloped plane (merges), curb step (halts, exists), sparse plane with singleton holes (merges under 2.4), and a genuinely rough surface at the relative-threshold boundary.

---

## 3. Circles vs. discs

Confirmed: the screen-aligned flag rate is the cause, and it follows directly from Section 1's occupancy math.

`analytic-surfels.ts:307–309`: a surfel is flagged `ANALYTIC_SURFEL_SCREEN_ALIGNED` when `planarity < 0.35 || linearity > planarity` (plus the null-normal path at 292–300). With ~2–3-pt fine cells and no merging: a 2-pt cell has rank-1 covariance → planarity = 0, linearity = 1 → flagged; a 3-pt cell fits an exact plane (λ₁≈0) but its λ₂/λ₃ split is noise → `linearity > planarity` flags a large fraction; and any cell whose points happen to be collinear-ish (scan lines!) is flagged. Scan-line striping in ALS/MLS makes small cells *systematically* linear. Expect the harness to report a very high flagged fraction (plausibly 60–90%).

The renderer honors the flag faithfully: `src/viewer/StreamingSurfels.ts:102–113` — flagged instances build their quad from `cameraRight`/`cameraUp` instead of the surfel normal's tangent frame. Flagged surfels are therefore camera-facing circles that re-sort every frame — precisely the owner's "screen-aligned circles, more dots on zoom-in, abstract character absent."

How the redesign fixes it: merged surfels carry accumulators with dozens-to-thousands of points → stable PCA → planarity high on flats, `linearity ≤ planarity` → flag not set → oriented discs from `instanceNormal`. Terminal un-merged fine cells (true clutter: vegetation, edges) remain screen-aligned, which is the correct visual role for them. No shader change needed for this item.

---

## 4. Point-size slider leak

Confirmed leak, three links in the chain:

1. `src/main.ts:757–772` — the point-cloud size slider's `input` handler iterates `derivedSurfelLayers` and calls `viewer.setAnalyticSurfelsDisplay(entry.handle, …, size)` (line 770). Same coupling on layer load/visibility: `main.ts:213`, `main.ts:530`, `main.ts:551` all pass `Number(safePointCloudSizeEl.value)`.
2. `src/viewer/ViewerEngine.ts:869–872` — `setAnalyticSurfelsDisplay` forwards to `StreamingSurfels.setDisplay`.
3. `src/viewer/StreamingSurfels.ts:158–163` — `setDisplay` maps slider 1–5 → `sizeScale` 0.7–1.7 and writes the `sizeScale` uniform, which multiplies `instanceRadius` in the vertex shader (line 114: `… * instanceRadius * sizeScale`).

So the *point* size control rescales *baked* surfel radii by up to ±70%. The surfel layer shares no material with the point renderers (`RenderPointCloud`/`StreamingPointCloud` have their own `pointSize` paths) — the leak is purely this deliberate-but-wrong wiring.

**Isolation fix (minimal):** change `StreamingSurfels.setDisplay(visible: boolean)` to visibility-only; delete the `sizeScale` uniform (or pin it to 1.0 and remove the setter path); drop the size argument from `ViewerEngine.setAnalyticSurfelsDisplay` and from the four `main.ts` call sites; remove surfel iteration from the slider handler entirely. Surfel radii are content — they must render at their baked world size, always. (The owner's future "overlap exaggeration" control would be a *new, surfel-specific* display-time uniform, deliberately separate from the point-size slider — noted, not designed here.)

Risk: trivial. No persisted data touched; pure display wiring.

---

## 5. Iteration harness (mandatory scope)

Extend `scripts/build-surfel-diag.mts` (currently full-pipeline only: import → index → surfels, ~13 min) with a subset mode so threshold tuning runs in seconds on real data.

**CLI:**

```
npx tsx scripts/build-surfel-diag.mts <las> \
  [--bbox=minX,minY,minZ,maxX,maxY,maxZ]   # world-coordinate crop
  [--max-points=N]                          # hard cap, deterministic (first N in file order post-bbox)
  [--skip-index]                            # reuse existing index (already supported)
  [--surfel-cell-scale=S]                   # already supported
  [--json=out.json]                          # machine-readable summary for diffing runs
```

Implementation notes: bbox/max-points filter belongs at the point-ingest boundary — either a filtered re-import in the diag path, or (cheaper) node selection in `buildAnalyticSurfelsFromIndex` by intersecting `node.bounds` with the bbox and skipping non-intersecting tiles. The node-intersection route reuses an existing full index and makes iteration nearly free after the first build; recommend it.

**Required outputs per run:**

- **Merge-level histogram**: surfel count per doubling level. Derivable without format changes: `level = round(log2(cellSize / fineCellSize))` — expose it by having `deriveAnalyticSurfels` return per-level counts (an in-memory metrics side channel; no tile-format change). Level 0 = never merged; this histogram is the single most diagnostic number ("is it still inert?").
- **% screen-aligned**: `flags & 1` fraction, overall and per level.
- **Counts and sizes**: input points, emitted surfels, points-per-surfel mean, dropped-singleton count, radius percentiles (p50/p90/p99/max), output bytes.
- **Planarity/residual distributions** at merge-rejection sites (why did merges stop: occupancy vs. planarity vs. residual — count each rejection reason). This turns tuning from guesswork into reading three numbers.

Acceptance for the fix package: on a representative parking-lot bbox, level-0 fraction drops from ~100% to a minority, % screen-aligned drops correspondingly, and the histogram shows mass at levels ≥ 3.

---

## 6. Fix package

Ordered, minimal set:

| # | Item | Effort | Risk |
|---|------|--------|------|
| 1 | Slider isolation (Section 4) | ~1 hr | Trivial — display wiring only |
| 2 | Diag harness subset mode + metrics (Section 5) | ~0.5–1 day | Low — additive tooling; small metrics side-channel in `deriveAnalyticSurfels` |
| 3 | Merge redesign (Section 2): partial-block policy, count-gated evaluation, scale-relative residual, singleton enrollment, cap raise | ~1–2 days code + tuning runs | Medium — core algorithm; determinism preserved (fixed iteration order, world-anchored keys); memory still bounded (shrinking level maps). Tile format v2 unchanged. Existing fixtures rewritten per 2.6 — expect the straddle fixture to keep passing and the curb fixture to keep halting |
| 4 | Honest fixtures (2.6) | included in #3 | Low |

Do #1 and #2 first — #2 is the instrument that proves #3, and #1 removes a visual confound (any radius change would otherwise be entangled with slider state during owner review).

**Defers:** cross-node merging (see below); overlap-exaggeration display control (owner wish, display-time, design later — but Section 4's fix deliberately leaves a clean slot for it as a surfel-only uniform); any shader work beyond none (oriented discs already render correctly when the flag is honest); LOD/SSE retuning for large discs (current `DEFAULT_SURFEL_SSE_THRESHOLD` selection may pick coarser nodes than ideal once discs are huge — evaluate after #3 with real visuals, don't pre-tune).

**Honesty check — where the single-giant-disc vision hits a wall:** two places.

First, the structural one: surfels are built per index node (G7), and interior nodes own strided point samples by design. A flat black region spanning multiple leaf nodes will render as *at least one disc per selected node*, and the same region appears at multiple LODs with different disc sets. "An entire grid section = one disc" is achievable exactly up to the node boundary (~100k-pt owner partitions) and no further without a cross-node merge pass — which would break the current streaming unit (tile = node) and is correctly out of scope. The owner should expect: parking lot → a handful of very large discs, not literally one. If literal one-disc-per-region is non-negotiable, that is a Phase 6 architecture change (merge across node tiles at build time, with a separate large-disc tile stream), not a threshold tune.

Second, the trust one: the surfel layer is already disclosed as "derived … not measured points" (`StreamingSurfels.ts:167`). A 100-ft disc with `RELATIVE_FLATNESS = 0.02` may hide ~2 ft RMS of real surface variation. That is fine for the abstract reality view; it must never leak into anything measurement-adjacent. The line: surfel radii/planes are display abstractions — no snapping, no measurement, no export of surfel geometry as surface truth. As long as that boundary holds (it does today; keep it explicit in the disclosure string), the relative threshold is honest.

SURFEL MERGE REVIEW COMPLETE
