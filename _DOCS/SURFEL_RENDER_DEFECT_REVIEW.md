# Surfel Render Defect Review — Phase 5.3 (shipped state)

Read-only defect review of the shipped Phase 5.3 analytic surfel build (45M surfels / 970 MB, merge histogram `[16.1M, 17.2M, 9.4M, 2.76M, 764K, 198K, 53K, 17K, 7K, 3051, 1521, 410, 4893]`, 91.4% screen-aligned reported). Scope is errors only; the merge design, thresholds, and LOD character are frozen. Two owner-observed defects: (1) two discs larger than the entire site, (2) no legibility improvement on close zoom. This document root-causes (1), audits for related degenerate outputs and renderer defects, and specifies a minimal fix package. Aesthetic/character items are explicitly excluded.

---

## 1. Root cause of the mega-discs

### The mechanism in one paragraph

A cell that never finds a merge partner is not emitted at its true size — it is re-keyed upward every doubling with `cellSize × 2` and an **unchanged accumulator** (`src/core/pointcloud/analytic-surfels.ts:212–217`). The pyramid loop never terminates early while any cell survives (`parentLevel.size === 0` at line 253 is unreachable when cells remain), so every survivor is dumped into `terminal` after exactly `MAX_MERGE_DOUBLINGS = 12` doublings (lines 257–259) carrying `cellSize = fineCell × 4096` — regardless of whether it ever merged once. Emission then computes radius from that bookkeeping `cellSize`, not from the population's actual extent (lines 336–340):

```
localSpacing = bucketCellSize / max(√count, 1)          // line 336
radius = max(localSpacing × 0.9, radiusFromVariance, bucketCellSize × 0.22)   // line 340
```

For a count-1 pass-through cell: `localSpacing = cellSize` → **radius = 0.9 × 4096 × fineCell ≈ 3686 fine cells**. For count 2–11: still ≥ `0.27 × 4096 × fineCell ≈ 1100 fine cells` via `localSpacing`, and never below the unconditional floor `0.22 × 4096 × fineCell ≈ 901 fine cells`. There is **no absolute radius cap anywhere** in generation, tile format, or renderer — the grep for a clamp comes up empty in `analytic-surfels.ts`, `analytic-surfel-builder.ts`, `analytic-surfel-format.ts`, and `StreamingSurfels.ts`.

### Why such cells exist and survive to level 12

Three paths, in order of contribution:

**P1 — Single-child pass-through (lines 212–217).** No gate of any kind: not occupancy, not planarity, not residual, not count. A fine cell with no occupied sibling inside its 2×2×2 parent at *any* of 12 doublings rides to level 12 untouched. In dense ground data this requires extreme isolation — i.e., outlier returns (birds, atmospheric hits, multipath) far from the site body. But in the **strided interior/root index nodes** (prior review G6: owner-partition interior nodes hold subsampled points at coarser-than-global spacing, while their fine cell size is floored at `globalCellSize`, `electron/analytic-surfel-builder.ts:78, 322–331`), sparse occupancy is *systematic*, so pass-through-to-high-level is common, not exceptional.

**P2 — Unconditional sparse-merge acceptance (lines 223–226).** `if (merged.count < MIN_MERGE_POINTS)` accepts the merge with **no planarity or residual test** and doubles `cellSize`. A scatter of 2–11 outlier points spread across an arbitrarily large volume merges level after level, staying under 12 points, accumulating `cellSize` all the way to 4096×. When such a group finally crosses 12 points at some high level and *fails* the gates, its children are pushed to `terminal` (lines 232–247) — but those children already carry inflated `cellSize` from the sparse-accept levels below, so gate rejection at the top does not undo the damage.

**P3 — Singleton retention at emission (lines 267–272).** The survivor filter keeps any cell with `cellSize > fineCellSize` regardless of count: `if (cell.cellSize > fineCellSize) return true`. So a **single outlier point** that rode the pyramid is emitted — with `count = 1`, zero covariance, `planarity = 0` → flagged `ANALYTIC_SURFEL_SCREEN_ALIGNED` (lines 342–345) → rendered as a camera-facing disc of radius `0.9 × 4096 × fineCell`. Camera-facing means it presents its full area from every viewpoint — exactly the owner's "dominating the view at any zoom."

### Magnitude arithmetic against the shipped histogram

The level-12 bin (4893) is anomalous: it *exceeds* level 11 (410) by 12×, which is impossible for genuine merge attrition and is exactly the terminal-dump signature — everything still alive after 12 doublings lands there whether or not it ever merged. Every level-12 emission has radius ≥ `901 × fineCell`. A 100k-point leaf node covering a 2D surface has edge ≈ `316 × spacing` while `fineCell ≥ 1.5 × spacing`, so the level-12 radius floor is ≥ `1352 × spacing ≈ 4.3 × the node's own edge`. All 4893 level-12 surfels (and to a lesser degree the 410 at level 11 and 1521 at level 10) are node-scale-or-larger discs. **These oversized discs are also the dominant error-class contributor to owner defect (2):** they are opaque, depth-writing (`StreamingSurfels.ts:131–133`), and blanket the legitimate surfels beneath them at any zoom.

The two *site-scale* discs specifically: radius scales with `fineCell`, and `fineCell` is largest in the biggest nodes — `nodeLevelCellSize` (`analytic-surfel-builder.ts:322–331`) allows up to `0.05 × edge` for sparse nodes, and the root node's edge is the site. A count-1 pass-through in a near-root node yields radius up to `0.9 × 4096 × 0.05 × edge = 184 × node edge`. Two isolated outlier returns (or sub-12-point outlier clusters) in the largest strided nodes are sufficient and, given real LAS data, near-certain. **Exact population**: cells with `count < 12` whose merge path never accumulated `MIN_MERGE_POINTS`, emitted at `cellSize = fineCell × 2^k` for large k; the two visible monsters are the k = 12 instances with the largest `fineCell`. Section 5's harness instrument localizes them to node key and world position for confirmation.

### Verdict on the handoff's three suspects

- *Unconditional `count < 12` acceptance* — *confirmed* (P2), and compounded by the ungated single-child pass-through (P1), which the handoff did not list and which requires no merge at all.
- *Missing absolute radius cap* — *confirmed*; but the deeper defect is that the radius floors consume the pyramid's bookkeeping `cellSize` rather than any measure of populated extent. A cap alone would clip the monsters to "merely huge"; the provenance fix (Section 4, F1) makes them correct.
- *Radius formula on degenerate eigenvalues* — *cleared*. `radiusFromVariance` is guarded (`max(λ,0)`, line 338) and is ≈ 0 for the offending populations; it is the *other two* `Math.max` arms that explode. Degenerate eigenvalues contribute the screen-aligned flag, not the size.

---

## 2. Degenerate-output audit (generation)

**No NaN/zero/negative radii paths found.** Radius is `Math.max` of three non-negative terms with a strictly positive floor (`bucketCellSize × 0.22`, line 340); `normalizeVec3` guards zero-length (lines 468–471); `estimateSurfaceNormal` clamps eigenvalues and rejects non-finite normals (lines 383–388); accumulators are created on first point and merged only from existing children, so `count ≥ 1` always — the centroid divisions at lines 305–307, 311–313, 398 cannot divide by zero. Positions are emitted at true centroids; no wrong-position defect exists.

**D1 — Radii exceed node bounds, violating the streaming contract.** Confirmed and quantified above: every level ≥ 10 emission can exceed its node's edge. Nothing downstream clamps: the tile format stores raw `Float32Array` radii (`analytic-surfel-format.ts`), the loader passes them through (`project-service.ts:770–803`), and the renderer multiplies them into the quad verbatim (`StreamingSurfels.ts:113`). SSE selection and eviction (`pointCloudStreaming.ts` via `StreamingSurfels.ts:193–232`) score by `node.bounds`, which assumes content stays inside the node — an oversized disc can pop in/out of existence as its *source node* crosses the selection threshold, even though the disc itself spans the viewport. Fixing generation (Section 4) restores the contract; no renderer change needed for this.

**D2 — Screen-aligned metric double-counts.** In `emitSurfelsFromCells`, a surfel with a null normal estimate increments `screenAlignedCount` at lines 332–334, then the condition at line 342 (`!normalEstimate || …`) is true again and increments a second time at lines 342–345. The flag OR is idempotent (rendering is unaffected) but the count is not: `screenAlignedFrac` is inflated and can exceed 1.0. The shipped "91.4%" is therefore unreliable as an instrument. Metrics-only defect; no regen needed (computed in-memory at build time).

**D3 — `rejectionReasons.occupancy` is never incremented.** Declared at line 187, reported by the harness, never touched. Dead metric; occupancy rejections are invisible. Trivial.

**D4 — Histogram counts pre-filter cells, not emitted surfels.** The level histogram is tallied over `terminal` (lines 261–265) *before* the singleton filter (lines 267–272), so it includes `singletonDropped` cells that are never emitted — histogram sums ≈ 46.5M vs 45M surfels shipped. Harmless for diagnosis at the top levels (those cells all survive via the `cellSize > fineCellSize` branch) but the level-0 bin overstates emissions. Trivial.

**D5 — Float32 world-absolute coordinates degrade the covariance gates (flag, defer).** The builder bakes absolute world coordinates into `Float32Array` (`analytic-surfel-builder.ts:86–91`). At state-plane magnitudes (~2.9e6 ft per `RenderGeotiff.test.ts` fixtures), float32 ULP is 0.25 ft — position quantization of 0.06–0.25 ft, *above* `SENSOR_NOISE_FLOOR = 0.05`. Additionally, covariance via raw second moments about a ~2.9e6 mean (`covarianceFromAccumulator`, lines 397–410) cancels ~13 orders of magnitude; the residual double-precision error is ~1e-3–1e-2 ft² → ~0.03–0.1 ft of phantom RMS, again comparable to the noise floor. Net effect: planarity/residual gate outcomes at low merge levels are partly numerical noise, and emitted positions/radii carry sub-foot quantization. This distorts merge behavior but does not produce the mega-discs; it is a real defect but the fix (accumulate about a per-node local origin) touches the accumulator plumbing and belongs on the follow-up list, not this package.

---

## 3. Renderer audit (`src/viewer/StreamingSurfels.ts`)

The renderer is **not** a cause of the mega-discs: it faithfully draws baked radii, and the screen-aligned flag path (lines 101–113) is the generation-side flag doing what it is told. Frustum/sorting side effects checked as directed:

**R1 — Frustum culling is fully disabled; bounding sphere is meaningless.** `mesh.frustumCulled = false` (line 288) and `geometry.computeBoundingSphere()` (line 286) computes from the shared unit-quad `position` attribute (±1), not the instances. Today this is internally consistent (culling off, sphere unused), and it is *why* the mega-discs render from everywhere rather than flickering — the defect is upstream. But it is a loaded trap: anyone enabling culling or ray-picking against this geometry gets a 1-unit sphere at the group origin. Not the cause of either owner defect; note-and-keep.

**R2 — The edge-feather/alpha path is dead code; discs render hard-edged.** The fragment shader computes `alpha = 1 − smoothstep(0.7, 1.0, dist)` (lines 124–128) but the material is `transparent: false` (line 131), so alpha is ignored by blending, and `alphaTest: 0.12` (line 132) has **no effect on a raw `ShaderMaterial`** — the alpha-test discard is a built-in shader chunk that custom shaders don't inherit. Net: every disc is opaque with an aliased hard rim (only the `dist > 1.0` discard fires). This is an outright defect distinct from character (the feather was written and silently does nothing) and contributes to close-zoom illegibility via shimmering hard edges. Fix is either implement the discard/feather in the shader or delete the dead math — one line either way.

**R3 — Stale `dropped` entries can discard a wanted tile once.** If `fetchTiles` throws, the catch (lines 257–259) clears `inFlight` but leaves any keys previously marked in `dropped` (line 217). The *next successful* fetch of such a key hits `if (this.dropped.delete(key)) continue;` (line 264) and throws the payload away once. Self-correcting on the following update cycle; a transient hole, not the observed defects. One-line fix (also delete from `dropped` in the catch).

**R4 — Positions/offsets verified correct.** Tiles are rebased to `indexOrigin` in the main process (`project-service.ts:784–786`), the hierarchy carries the same origin (`project-service.ts:748–768`), and the group applies `origin − sceneOrigin` (lines 77–81). No double-offset; instancing attribute wiring (lines 273–294) is correct, including normalized `Uint8` colors.

---

## 4. Minimal defect-fix package

Ordered. None of these touches merge thresholds, gate design, or LOD — they fix size *provenance*, add invariants, and repair instruments.

| # | Item | Change | Effort | Risk | Regen? |
|---|------|--------|--------|------|--------|
| F1 | **Radius provenance: floors from last *evidenced* size, not pyramid bookkeeping** | Add `mergedCellSize` (or `lastRealMergeCellSize`) to `CellEntry`, updated **only** when an actual ≥2-child merge is accepted (lines 220–250); pass-through (line 215) and the sparse-accept path keep the child's value. `emitSurfelsFromCells` uses it for `localSpacing` and the `× 0.22` floor (lines 336–340). A count-1 outlier then emits at fine-cell scale; genuine merged plates keep their earned size (their last accepted merge *is* their size). | ~½ day + fixture | Low — additive field, radius math otherwise unchanged; genuine high-level merges unaffected | **Yes** |
| F2 | **Absolute radius cap as a hard invariant (belt-and-braces)** | In the builder, after `deriveAnalyticSurfels`: clamp `radius ≤ 0.5 × node edge` and count clamps into build metrics. With F1 the clamp should fire ~never; a nonzero count is a regression alarm, which is the point. | ~1 hr | Trivial | **Yes** (same regen as F1) |
| F3 | **Minimum population for high-level sparse acceptance** | Restrict the unconditional `count < MIN_MERGE_POINTS` accept (lines 223–226) to the first N doublings (recommend N = 2, matching the prior review's rationale that 2–3-pt cells carry no plane evidence *at fine scale only*); above N, an under-populated merged group goes to `terminal` carrying its F1-correct size. This closes P2 without touching planarity/residual thresholds. | ~½ day + harness runs | Medium — shifts histogram mass; validate per Section 5 before shipping | **Yes** (same regen) |
| F4 | **Metrics repairs** (D2, D3, D4) | De-duplicate `screenAlignedCount` (single flag-derived tally at the end of the loop); increment `rejectionReasons.occupancy` where `children.length < 2` falls through — or rename/remove; tally histogram post-filter. | ~1 hr | Trivial — instruments only | No |
| F5 | **Harness: wire the dead flags + radius instrumentation** | `scripts/build-surfel-diag.mts` parses `--bbox`/`--max-points` and **never applies them** — `bboxIntersects` (line 23) is dead code and `generateAnalyticSurfels` receives neither (line 73). Implement the node-intersection route from the prior review (filter `indexManifest.nodes` against the bbox inside the diag path). Add radius percentiles (p50/p90/p99/max), per-level max radius, and **top-10 largest surfels with node key + world center** — the mega-disc localizer. | ~½–1 day | Low — tooling only | No |
| F6 | **Renderer nits** (R2, R3) | Add `if (alpha < 0.5) discard;` (or delete the dead feather math — owner's call at review, both are one line); clear `dropped` keys in the fetch catch. | ~1 hr | Trivial | No |

**Defers (documented, not in package):** float32/world-anchored precision (D5 — accumulate about per-node origin; medium effort, gate-behavior change, belongs with the next character pass); R1 bounding-sphere hygiene; anything touching thresholds, screen-aligned rate, or LOD tuning (frozen).

### Validation plan (subset harness)

1. **Before any code change**: run F5's instrumented harness on the full LAS (`--skip-index --json=baseline.json`). Record radius percentiles and the top-10 list — this both confirms the Section 1 prediction (top entries: count < 12, level 12, largest-fine-cell nodes) and pins the two mega-discs to world positions matching what the owner sees.
2. `--bbox` around each mega-disc's source population: expect a handful of points, merge histogram showing pass-through to high level, one mega surfel. This is the minimal repro.
3. Apply F1+F2+F3, regen the bbox subsets: mega surfel gone, max radius ≤ 0.5 × node edge, clamp counter = 0 (F1 doing the work, F2 idle).
4. Full regen + full-LAS harness run, diff vs baseline JSON: level-12 bin collapses toward genuine merges (expect it to drop *below* level 11, restoring monotone attrition); levels 0–9 histogram mass within noise of baseline (proof the frozen character is untouched); radius p99/max bounded; total surfel count ≈ baseline + retained-but-shrunk sparse cells.
5. In-app owner check on real data: mega-discs gone; giant opaque node-scale discs no longer blanket close-zoom views. (Remaining close-zoom character — screen-aligned rate, disc legibility — stays on the frozen follow-up list, now measurable with an honest 91.4% replacement from F4.)
6. `npm test` — 237/237 must stay green; add one fixture: isolated point + distant plane in one node → assert emitted radius ≤ a few fine cells (the P1/P3 regression test that today's suite lacks).

**Regen required: yes** — radii are baked into `.sftile` files; F1–F3 change emitted values. One regen covers all three (ship them together). F4–F6 need no regen.

SURFEL RENDER DEFECT REVIEW COMPLETE
