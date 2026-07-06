# Display Quality Review — Reality Render, post-Phase 5

Status: review report (read-only pass; no code changed). Repo: `main` @ Phase 5 accepted, 214/214 green.
Scope: owner-observed defects 1–6 on the 381.8M-pt LAS (8,477 index tiles, 4.3M surfels), plus the desired end-state evaluation.

---

## A. Root-cause diagnosis per defect

### Defect 1 — Surfel "donuts" (colored rims, black centers)

**Root cause: an inverted `smoothstep` in the surfel fragment shader — not directional shading.** There is no lighting in the shader at all, so one-sided shading was never the mechanism.

`src/viewer/StreamingSurfels.ts:131`:

```glsl
float dist = dot(vCorner, vCorner);          // 0 at center → 1 at rim
if (dist > 1.0) discard;
float edge = smoothstep(1.0, 0.7, 1.0 - dist);   // ← arguments feed the wrong variable
float alpha = mix(0.55, 0.95, clamp(vConfidence, 0.0, 1.0)) * edge;
```

At the disk **center**, `dist = 0` so `1.0 - dist = 1.0` → `edge = 0` → `alpha = 0`. With `alphaTest: 0.12` (line 137) the center fragments are discarded entirely, punching a hole through to the dark background. From `dist ≥ 0.3` outward `edge = 1`, so only an annulus renders at full alpha. That is the donut, exactly as observed. (Strictly, `smoothstep` with `edge0 > edge1` is undefined GLSL, so this is also undefined behavior that happens to render as a donut on the owner's GPU.)

The intended line is `float edge = smoothstep(1.0, 0.7, dist);` — opaque interior, soft rim.

Secondary contributor: `alpha = mix(0.55, 0.95, confidence)` makes even correct surfels semi-transparent with `depthWrite: true` and no sorting, producing dark stippled blending against the background. See R1/R8.

### Defect 2 — Visible tile grid in surfel sizes

**Root cause: per-node spacing estimated from the octree cube volume, which is discontinuous across tile borders and across levels.**

`src/core/pointcloud/analytic-surfels.ts:48–55`:

```ts
const volume = Math.max(dx * dy * dz, 1e-9);
return Math.cbrt(volume / pointCount);
```

`electron/analytic-surfel-builder.ts:94–99` calls `deriveAnalyticSurfels` per index node with `bounds: node.bounds` — the node's full **octree cube**, not the extent points actually occupy. Three compounding errors:

1. On a flat lot the points occupy a thin slab, but `dz` is the full cube edge, so the cubic-volume density is wildly overestimated → spacing overestimated, by an amount that depends on the cube size (i.e., the node's level).
2. Neighboring index nodes on the same flat ground can sit at different levels or have different point counts (capacity-split timing is file-order-driven), so `spacing` — and therefore `cellSize = spacing * 1.5` (line 59) and the radius floor `max(spacing * 0.85, …, cellSize * 0.35)` (line 145) — jumps at every tile border.
3. The aggregation grid is anchored at `bounds.min{X,Y,Z}` of each node (lines 67–69), so the cell lattice **phase** also changes at every tile border; cells straddling a border are split into two half-populated cells, one per tile, producing seam surfels with offset centroids and degraded PCA.

### Defect 3 — Perpendicular (edge-on) disks along curbs/edges, with high confidence

**Root cause: the confidence formula measures anisotropy, not planarity — it scores linear clusters (poles, curb lines, edges) as ~1.0 while their normal is unconstrained.**

`src/core/pointcloud/analytic-surfels.ts:180`:

```ts
const confidence = (values[largest] - values[smallest]) / trace;
```

For a plane (λ₃ ≈ λ₂ ≫ λ₁) this is high — correct. But for a **line** (λ₃ ≫ λ₂ ≈ λ₁) it is also ≈ 1.0, while the "normal" (smallest eigenvector) is degenerate: λ₁ ≈ λ₂ means any direction perpendicular to the line is an equally valid eigenvector, and Jacobi returns an arbitrary one. Cells straddling a curb (two surfaces meeting) or containing a post produce exactly this eigenstructure. Result: a randomly-oriented disk, often edge-on, rendered at maximum-confidence alpha, and — because confidence ≥ 0.35 — **not** given the `ANALYTIC_SURFEL_SCREEN_ALIGNED` fallback (line 146), which exists precisely for this case but is gated on the broken metric.

The standard fix is the Weinmann/Demantké dimensionality features on ascending-sorted eigenvalues λ₁ ≤ λ₂ ≤ λ₃: planarity `(λ₂ − λ₁)/λ₃` (high only for true planes) and linearity `(λ₃ − λ₂)/λ₃` (high for poles/edges).

### Defect 4 — Banding tracking ~1-ft contours on gentle slopes

**Root cause: the aggregation cells are cubes — the grid quantizes z.** `analytic-surfels.ts:67–69` bins `iz = floor((z - minZ)/cellSize)` exactly like x and y. On a gentle slope the ground surface crosses a horizontal z-boundary of the cell lattice along a contour line. Cells along that line are split into two thin slabs: each slab's centroid is biased toward its slab middle, its PCA sees a squashed distribution, and its variance-derived radius shrinks. The result is a stripe of displaced, smaller, differently-oriented surfels at every z-boundary — i.e., banding at intervals of `cellSize` in elevation, which at the observed data density lands near 1 ft. Defect 2's per-tile `cellSize` differences make the stripes additionally inconsistent tile to tile.

### Defect 5 — Indexed point display: black patches, worse than preview

Two distinct causes; the owner's u16-vs-8-bit suspicion checks out as *possible* but is probably not the operative one for this dataset.

**5a. RGB scaling parity — verified equal, but both paths share a latent 8-bit-RGB bug.** The indexed tile path shifts `decoded.r >> 8` (`electron/project-service.ts:711–713`), and the preview path shifts identically at LAS read time (`src/workers/las.worker.ts:551–553, 706–708`). So there is **no parity difference** — if this dataset's RGB were 8-bit-stored-in-u16 (a common LAS deviation), *both* paths would render near-black, and the owner reports preview looks good. Conclusion: parity holds for this data; however, any 8-bit-RGB LAS will go black in both paths because neither consults the already-computed `rgbRange` metadata (`src/core/las/metadata.ts:340`, `contract.ts:291`) to decide whether to shift. Worth fixing as a guard (R7), but it does not explain "index worse than preview" here.

**5b. The operative cause: owner-partition coarse tiles are file-order prefixes, not spatial samples.** `electron/pointcloud-index-builder.ts:190–214` (`insertPoint`): a node owns the **first `capacity` (100,000) points that arrive in file order**; only overflow routes to children. LAS files are written in scan/flightline order, so the root tile contains ~the first few seconds of the scan — a spatially clustered streak, not a summary of the site. Every interior level has the same bias. When the viewer shows a wide view, SSE selection (`pointCloudStreaming.ts:108`, threshold 400 px) serves mostly coarse levels within the 2–5M budget, so large regions of the site have **no points at all at that detail stage** → black patches against the background, uneven coverage, and hard density popping when refinement arrives. The preview path, by contrast, fills its nodes by **strided sampling across the whole file** (`las.worker.ts:355–360`, `sampleStride` per depth) — spatially even — which is exactly why the owner rates preview best-looking today. This is the single most important indexed-display finding.

Note this is a *display* defect only: the index remains lossless (union of tiles = source); it's the per-level partition that is unrepresentative.

### Defect 6 — Signs and posts read as "incomplete bodies" in all modes

Compound, all above causes converging on thin vertical objects:

1. **Points, coarse levels:** file-order partition (5b) means a post's few hundred points may be entirely absent from the levels actually rendered at typical viewing distance; refinement to leaf level is region-wide and expensive, so posts stay incomplete until the camera is close.
2. **Surfels:** a post is a linear cluster → defect 3 gives it an arbitrarily-oriented, often edge-on (invisible) disk with bogus high confidence; the z-cubic cells (defect 4) chop it into per-cell fragments; and the radius floor derives from *ground* spacing, so fragments are small.
3. **Point rendering:** `alphaTest: 0.35` against the radial-gradient disk texture (`StreamingPointCloud.ts:446–449`) shrinks each point's effective footprint; isolated pole points barely register at world sizes 0.04–0.18 (`worldPointSize`, line 431).
4. **Honest floor:** a scanned post genuinely has few points; under the no-hallucinated-fill rule, "complete body" can only ever mean "every measured point visible and legible," not solid geometry.

---

## B. Ranked recommendations

Ranking = owner-visible impact ÷ (effort × risk). "Rerun" = does it require regenerating the full-scale artifact.

| # | Change | Effort | Arch risk | Rerun |
|---|--------|--------|-----------|-------|
| R1 | Fix inverted smoothstep; opaque interiors | S | none | none |
| R2 | Planarity/linearity confidence; linear cells → screen-aligned | S | none | surfels only |
| R3 | Global spacing + world-anchored cell grid | S–M | none | surfels only |
| R4 | Column-clustered (2.5D) aggregation | M | low | surfels only |
| R5 | Per-level point splat sizing + persistent coarse base | S–M | none | none |
| R6 | Uniform per-level ownership in the index | M–L | low | **full index + surfels** |
| R7 | 8-bit RGB guard via `rgbRange` in both paths | S | none | none* |
| R8 | Combined-view compositing pass | S–M | none | none |

**R1 — Fix the donut shader (StreamingSurfels.ts:131).**
Change to `float edge = smoothstep(1.0, 0.7, dist);`. While there: make the interior fully opaque and stop mapping confidence → alpha (map it to nothing for now, or to size later); keep `alphaTest` for the rim only. Expected effect: surfels become solid colored disks — the single largest visual change available, one line minimum. Semi-transparent surfels with `depthWrite: true` and no sorting are a standing blend-order hazard; opaque interiors also fix the combined-view fighting (R8).

**R2 — Correct confidence; render linear cells as screen-aligned orbs (analytic-surfels.ts:163–187, 146).**
Replace confidence with planarity `(λ₂−λ₁)/λ₃`; compute linearity `(λ₃−λ₂)/λ₃`; when linearity dominates, set the `SCREEN_ALIGNED` flag (the renderer already handles it, StreamingSurfels.ts:104–115) and derive the radius from λ₃ along the line so posts render as chains of camera-facing orbs. Expected effect: curb/edge perpendicular disks disappear; poles, sign posts, and fence lines become readable dotted columns — directly serving "signs/posts/fences readable" while keeping the abstract character. Kills defect 3 and half of defect 6.

**R3 — One spacing to rule the tiles (analytic-surfel-builder.ts:94–99; analytic-surfels.ts:57–69).**
(a) Compute a single global `cellSize` once (from the index manifest's point density over the *occupied* footprint — surface density `sqrt(area/count)`, not cubic) and pass it as `input.cellSize` to every node. (b) Anchor the cell lattice to the world/index origin instead of `bounds.min`, so cells align across tile borders and levels. Expected effect: uniform disk radii across the flat lot; tile grid vanishes; border-seam surfels align. Kills defect 2. Requires surfel regeneration only (4.3M disks from 8,477 tiles — the cheap rerun, not the index).

**R4 — 2.5D column aggregation with z-clustering (analytic-surfels.ts:63–103).**
Bin by (ix, iy) only; within each column, sort z and split into clusters at gaps > k·cellSize (k ≈ 1.5). Each cluster becomes one surfel candidate. Ground on a slope becomes one cluster per column regardless of where global z-planes fall — banding gone; vertical structures still separate into multiple clusters (a post yields a column of clusters, complementing R2). Expected effect: continuous ground surfaces, contour stripes eliminated. This replaces the fixed z-binning rather than patching it; it is the "continuous surfaces" item. Moderate effort, low risk (pure function, well-tested already, same output contract).

**R5 — Coarse-level splat sizing + persistent base layer (StreamingPointCloud.ts:126–135, 431; update loop).**
Today one `PointsMaterial` with a single world size serves all nodes at all levels. Give coarse levels larger splats — either one cloned material per level (there are ≤ ~10 levels) with size ∝ node cube edge / ∛pointCount, or a per-vertex size attribute via a small ShaderMaterial. Additionally: pin levels 0–2 as never-evicted, always-visible base (a few hundred k points), so the site is *always* fully covered by something. Expected effect: "orbs touching" at every detail stage; refinement changes crispness, not coverage; black-background show-through gone even before R6. No rerun; renderer-only.

**R6 — Uniform per-level ownership in the index builder (pointcloud-index-builder.ts:190–230).**
Change pass-1 ownership from first-arrival to a deterministic decimation: a node keeps arrival `i` iff `i % strideForLevel == phase` (or reservoir-style with a seeded PRNG — but the stride form keeps pass-2 `routePoint` reproducible, which the two-pass design requires). Every level then holds a spatially/temporally even sample; the union across levels is still exactly the source point set — losslessness and the manifest schema are untouched, so architecture risk is low, but this is the **full-scale rerun** (381.8M points, both passes) and surfels must regenerate after. Expected effect: coarse views look like the preview path (even coverage), popping becomes gentle sharpening, black patches gone at the root cause. This is the structural fix behind R5's cosmetic one; ship R5 first, R6 when a rerun window exists.

**R7 — 8-bit RGB guard (project-service.ts:711, las.worker.ts:551, analytic-surfel-builder.ts:85).**
All three sites unconditionally `>> 8`. Metadata already computes `rgbRange`; thread it through and skip the shift when max ≤ 255. For the WPI path, record the detected RGB bit depth in `index.json` at build time. Prevents whole-file blackouts on 8-bit-RGB LAS. (*Existing indexes built from such files would need a rebuild; the owner's current dataset appears 16-bit, so no rerun for it.)

**R8 — Combined-view compositing (StreamingSurfels.ts material; viewer scene).**
After R1 makes surfel interiors opaque: set `transparent: false`, keep `alphaTest` for rim antialiasing, retain `depthWrite: true`. Points and surfels then compose by depth like any two opaque layers — they blend spatially instead of alpha-fighting, and layer on/off independence is preserved (no ordering dependence, nothing replaces anything). Optionally offer a "surfels as base + points on top" preset — that is purely a layer-visibility preset, no new architecture, and is an honest way to get the "complete summarized view" feel: derived base clearly labeled derived, measured points on top.

---

## C. Recommended "Phase 5.1 tuning" package

Ship together: **R1 + R2 + R3 + R8, plus R7 as a guard.**

- One shader fix, one pure-function math change, one parameter-plumbing change, one material-flag change. All small, all `none`-risk to accepted architecture, all covered by existing unit-test patterns (`analytic-surfels` is pure and Node-testable).
- Requires **one surfel regeneration** (the cheap artifact — 4.3M disks) and **no index rebuild**.
- Owner-visible outcome: donuts → solid disks; tile grid gone; curb/edge disks gone; signs/posts readable as orb columns; combined view stops fighting. That is defects 1, 2, 3, and the surfel half of 6 resolved, and the biggest half of the "legible, keeps the character" ask.

Fast-follow (Phase 5.2, when a rerun window exists): **R4** (banding, defect 4 — surfel rerun) then **R5 → R6** (indexed-display coverage, defects 5b/6 — R5 immediately, R6 with the full index rerun).

### Honesty notes on the desired end-state

- "Orbs touching, even coverage, no visible popping" within a 2–5M budget on a 381.8M-pt cloud: **even coverage and orbs-touching are achievable** (R5 + R6 — coarse levels become representative and sized to close gaps; gaps remain only where the scan has gaps, which is the stated requirement). **Zero visible popping is not achievable** under streaming refinement — detail arriving will always change the image. It can be reduced to "gentle sharpening" (R5's persistent base guarantees coverage never changes, only crispness) and further softened later with cross-fade on tile swap (defer; cosmetic).
- Signs/posts as "complete bodies": R2/R4/R6 make every measured point on a post visible and legible. Solid-looking posts beyond the measured points would be hallucinated fill and are off the table per the hard limits. Recommend saying so in the UI copy for the derived layer rather than trying to fake it.

## D. Deferred (out of scope for 5.1/5.2)

- **UX/UI round:** popping cross-fade animation; per-layer opacity sliders; confidence→size mapping controls; disclosure-banner copy for the surfels-base preset; a debug "color tiles by level" toggle (recommend building this one early — it makes 5b visible in one screenshot and validates R6).
- **Sim Layer manager (future):** anything semantic — pole/sign detection as first-class derived objects, curb linework, classification-driven surfel styling. R2's linearity flag is the analytic seed for that work; do not grow it into object detection inside the render layer.
- **Not recommended at all:** normal-based lighting/photorealistic shading on surfels (owner likes the abstract look; lighting would also re-introduce the one-sided-shading class of bug the donuts were initially suspected to be).

---

*Verification notes: donut math checked against GLSL smoothstep semantics (undefined for edge0 > edge1; observed behavior matches clamped-reverse interpolation → alpha 0 at center with alphaTest 0.12 discard). RGB parity confirmed by reading both shift sites. Owner-partition file-order bias confirmed in `insertPoint`/`routePoint`; preview's strided sampler confirmed in `las.worker.ts` (`sampleStride`, `nodeSampleCap`). Eigen-degeneracy claim follows from λ₁ ≈ λ₂ for linear clusters; Jacobi output direction is then rotation-history-dependent.*
