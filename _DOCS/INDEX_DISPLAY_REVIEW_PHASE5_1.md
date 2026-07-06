# Index Display Review — Reality Render, post-Phase 5.1

Status: review report (read-only pass; no code changed). Repo: `main`, Phase 5.1 in working tree, 217/217 green.
Scope: index-layer point display vs. the owner's acceptance spec ("orbs merge as view extends, disperse and refine on zoom, final state 1–2 inch orbs; even coverage at every zoom; no flightline streaks; no jarring density pops"), plus the strided-ownership structural design and full-scale build honesty.

Authoritative mental model for the end state: **ping-pong balls on the ground.** Zoomed out, fewer but larger balls, still covering everything the scanner saw. Zoomed in, more and smaller balls, bottoming out at 1–2 inch orbs — and where a sign post or mile marker stands, a vertical column of them.

---

## A. Diagnosis — current coarse-level appearance vs. the spec

Two independent defects stand between today's index display and the spec. They compound, and neither fixes the other.

### A1. Coarse ownership is a file-order prefix, not a spatial sample (structural)

`electron/pointcloud-index-builder.ts:190–214` (`insertPoint`): a node owns the **first 100,000 points that arrive in file order**; only overflow routes to children. LAS files are written in scan/flightline order, so the root tile is ~the first few seconds of the scan — a streak, not a summary. Every interior level inherits the same bias. Phase 5's review flagged this as finding 5b; Phase 5.1 (correctly scoped as the cosmetic package) did not touch it.

Consequence against each clause of the spec:

- *"Even coverage everywhere at every zoom"* — fails at every coarse level. Wide views select mostly coarse nodes within the 2–5M budget (`pointCloudStreaming.ts:selectStreamingNodes`, threshold 400 px), and those nodes simply contain no points for most of the site.
- *"No flightline streaks"* — the coarse levels are literally flightline prefixes; streaks are the defining artifact.
- *"No jarring density pops"* — refinement doesn't sharpen a region, it makes the region **appear**. That is the worst possible pop.
- *"Orbs merge as view extends"* — cannot happen: there is nothing spatially representative to merge into.

### A2. One splat size for all levels (cosmetic)

`src/viewer/StreamingPointCloud.ts`: a single shared `PointsMaterial` (line 126) with one world-space size for every node at every level, `worldPointSize` mapping the UI multiplier to 0.04–0.18 world units (line 431). **Phase 5.1 contains no per-level sizing** — the material is constructed once and shared by every `THREE.Points` built in `buildNode`.

Consequence: at coarse levels the inter-sample spacing is feet-to-tens-of-feet, but orbs stay ~0.1 units, so even a *representative* coarse sample would render as sparse dust with background showing through. At leaf levels the fixed size is roughly right (the 0.04–0.18 range brackets the desired 1–2 inch orb if units are survey feet: 1–2 in ≈ 0.083–0.167 ft), which is why close-up views already look closest to spec.

### A3. What Phase 5.1 did fix (for calibration)

The surfel layer now matches its half of the spec: `StreamingSurfels.ts:127` has the corrected smoothstep (solid disks), `analytic-surfels.ts:191–197` computes true planarity/linearity so linear clusters (posts, mile markers) get screen-aligned orb treatment, and `analytic-surfel-builder.ts:74–75` uses one global spacing/cell size. None of this touches the index point layer's coarse appearance — the two defects above are wholly untreated.

**Verdict:** the "final state" (zoomed-in, leaf tiles) is near spec today. Everything from mid zoom outward is not, and cannot be with sizing alone (A2's fix) because the points being sized are the wrong points (A1).

---

## B. Strided ownership — concrete design (WPI v2)

### B1. Core idea

Keep the two-pass streaming builder, the tile byte format, the octree addressing, and the lossless-union invariant exactly as they are. Change only *which* points an interior node owns: instead of the first-`capacity` arrivals, each interior node owns a **deterministic 1-in-k stride of all points that traverse it in file order**, k chosen so ~`capacity` points are kept.

A file-order stride over a scan is the same trick the preview sampler uses (`las.worker.ts:363–364`, `sampleStride` per depth) — and preview is the display the owner rates best today. It is spatially even *in proportion to measured density*: every flightline, every region, every pass over the site contributes samples. Dense areas get more coarse points, empty areas get none — "gaps only where the scan truly has gaps," verbatim.

### B2. Why this avoids the parked branch's 2.5D failure

The parked `phase45-voxel-overview-wip` builder (`insertPoint` with `voxelCellIndex`/`claimVoxel`) sampled **space**: one point per cubic voxel cell, ~47³ cells per node. On 2.5D terrain the surface intersects only a thin slab of those cells (~47² of ~104K), so the root owned ~1.9K points — the observed failure. Strided ownership samples **points**: the stride enumerates the actual measured records, so a node's owned count is `⌈S/k⌉ ≈ capacity` regardless of how the points are distributed inside the cube. Empty air contributes nothing because it was never enumerated. There is no per-node claim grid, hence also none of the parked branch's per-node `Uint8Array` bitsets or their allocation-failure surface area.

### B3. Mechanics, pass by pass

**Pass 1 (topology) — unchanged plus one counter.** Run today's `insertPoint` exactly as-is (same splits, same tree shape — deliberately, so v2's structure is diffable against v1). Additionally increment a per-node `traversed` counter on every node a point visits on its way down. After pass 1, every node knows `S = traversed` (root: S = N). Compute per node: `stride k = max(1, floor(S / capacity))`, stored on the `BuildNode`.

**Pass 2 (distribution) — new `routePoint`.** Per node, keep two counters (`t`, `owned`), both starting at 0:

```
route(point):
  cur = root
  loop:
    if cur has no children: own here (leaf owns everything)   // lossless backstop
    cur.t++
    if cur.t % cur.k == 0 and cur.owned < capacity:
      cur.owned++; own here
    else:
      descend to child by geometry (create the child if absent) // see B4
```

Ownership is defined **entirely within pass 2** by static strides + file order + per-node counters. This is a determinism *simplification* relative to v1: v1's pass 2 had to replay pass 1's arrival-order ownership (`seen < ownCount`); v2's pass 2 depends only on data that is fixed before it starts. Same file ⇒ same topology ⇒ same strides ⇒ same ownership, byte-for-byte reproducible.

**Finalize — unchanged.** Spool, gzip, manifest, `storedPointCount === pointCount` integrity check (the lossless-union invariant's enforcement point) all work as-is because every point is still owned by exactly one node by construction.

### B4. The missing-child case (the one real edge)

In v1, a child exists only where overflow points landed. Under strided ownership a point may descend toward an octant whose child pass 1 never created (all of that octant's points were inside the parent's first-100K). v1's `routePoint` has a defensive "own at current node" branch for this; under v2 it would fire routinely and overfill parents. Fix: **create children on demand in pass 2** and move `collectNodes` to after pass 2 (today it runs between the passes, at builder line 427, but its result is only consumed by the finalize loop — nothing in pass 2 needs it, so this is a safe reorder plus allowing `children[idx] = childNode(...)` in `routePoint`). Node count stays bounded by the same capacity arithmetic (≤ 8× interior nodes; ~10K objects at full scale).

Estimated-count note: manifest `pointCount` per node comes from finalize (actual written records), so `selectStreamingNodes`' budget math is exact, as today. Pass-1 `S` is an *estimate* of pass-2 traversal (the populations differ by which ~capacity points each ancestor absorbs); that only perturbs `k`, so owned counts land near — not exactly at — capacity. Harmless: capacity is a tuning target, not an invariant.

### B5. Format/version/migration story (Phase 1 staleness patterns)

- **Tile format: unchanged.** `wpi-tile.ts` layout, stride, header — untouched. Only the point→tile assignment changes.
- **Manifest:** bump `wpiIndexVersion` to `2` and `POINT_CLOUD_INDEX_VERSION` to `2` (`src/shared/pointcloud-index.ts:15`); add `ownership: 'strided'` (v1 implicitly `'file-order'`); bump `POINT_CLOUD_INDEX_BUILDER_VERSION`.
- **Old indexes are not stale.** `detectIndexStaleness` is about source divergence and must not be overloaded. Add a parallel open-time check: manifest version < current ⇒ new managed warning, e.g. `"Point-cloud index format is outdated (v1); regenerate for improved coarse-level display."` — same `POINT_CLOUD_INDEX_WARNING_PREFIX` dedupe pattern, but **excluded** from `isStaleIndexWarning`, so `hasValidIndexForStreaming` still passes: a v1 index remains lossless, complete, and streamable. The warning offers regeneration; it never gates.
- **Regeneration** is the existing build path (`generatePointCloudIndex`), which already `rm -rf`s and rebuilds under the COMPLETE-marker protocol. Surfels must regenerate afterward (`analytic-surfel-builder.ts` decodes index tiles per node), and should be prompted from the same warning flow.

### B6. Optional refinement (note, don't build now)

A pure file-order stride inherits the scan's temporal spacing; if two flightlines overlap, the overlap region gets ~2× coarse density. That is *honest* (it reflects measured density) and matches the spec as written. If it ever reads as banding, the deterministic upgrade is phase-jittering: own when `(t + hash(node.key)) % k == 0`. Do not reach for spatial (voxel) criteria — that is the parked branch's road.

---

## C. Adaptive splat sizing — implementation plan

### C1. Rendering primitive: keep point sprites

Stay with `THREE.Points` + `PointsMaterial` (`sizeAttenuation: true`, existing disk texture + alphaTest). Instanced quads would sextuple vertex load at a 5M budget (~30M verts) to solve a problem we don't have; the one real sprite limitation — the hardware `gl_PointSize` clamp (commonly 1024 px, can be lower under ANGLE/Metal) — only bites when a huge coarse orb sits near the camera, and in exactly that situation SSE selection has already refined past the coarse level. Accept the clamp; revisit only if walk-mode shows artifacts.

### C2. Mechanism: per-level material cache + per-node assignment

One material per level (≤ ~10–16 levels): clone the existing material, override `size`. `buildNode` assigns `materialForLevel(node.level)` instead of the shared `this.material`; `setDisplay`'s size-multiplier loop updates all cached materials. No shader work, no geometry changes, headless tests unaffected. (A per-vertex size attribute via `ShaderMaterial` is the future path if per-point density-adaptive sizing is ever wanted — not needed for the spec.)

### C3. Size function

For node at level L with cube edge `e_L = cubeSize / 2^L` and manifest `pointCount = n`, the surface-sample spacing on 2.5D terrain is approximately `s = e_L / sqrt(n)` (area, not volume — the parked branch's cubic mistake, inverted, is the lesson here; it is the same fix R3 applied to surfels). Then:

```
radius(node) = clamp(fill × e_L / sqrt(n),  r_min,  r_max_frac × e_L)
```

- `fill ≈ 0.6–0.8` — orbs just touch ("ping-pong balls in a tray"), tune visually.
- `r_min` = the owner's final orb: 1–2 inches ⇒ ~0.08–0.17 in survey-feet units. Derive from manifest `units` rather than hard-coding.
- `r_max_frac ≈ 0.05` — safety cap so a near-empty node can't produce building-sized orbs.
- UI multiplier (1–5) scales the whole result, replacing today's fixed 0.04–0.18 lerp.

Per-node `n` varies within a level, so compute per node and bucket into the level material (or quantize radius to, say, 8 sizes to keep the material count flat). With strided v2 ownership `n ≈ capacity` almost everywhere and per-level sizing becomes nearly exact; with v1 it is still strictly better than one global size.

### C4. Behavior polish in the same package (renderer-only)

- **Shrink-on-refine:** when all of a node's children are loaded and visible, reassign the node's `Points` to the child level's material. Coarse orbs visibly "disperse into" finer ones — the owner's zoom-in verb, nearly free.
- **Pinned base:** never evict levels 0–2 (a few hundred K points; `planEviction` gets a `pinnedKeys` exclusion — pure-function change, unit-testable). Coverage then never regresses during camera motion; refinement only sharpens. Note honestly: with a v1 index the pinned base is a pinned *streak*; this item pays off fully only after the B rebuild.
- **Debug color-by-level toggle:** trivial (`colorFor` short-circuit keyed on a debug flag), and it makes A1 visible in one screenshot — build it first, use it as the before/after for the whole effort.

### C5. Cost

Renderer-only; no index or surfel rebuild; no IPC or format changes. Effort S–M (the material cache and sizing math are small; shrink-on-refine needs child-loaded bookkeeping that `update()` almost has). Test surface: sizing function and eviction-pinning are pure and Node-testable in the existing `streaming-pointcloud`/`pointcloud-streaming` test patterns.

---

## D. Memory and scale honesty — 381.8M-point build projection

Reference points: the v1 builder **has already succeeded at full scale** (381.8M → 8,477 tiles, depth 9, Phase 3/5 accepted); the parked branch died twice on allocation failures with a materially different memory profile.

Current v1 peak composition (all bounded, none proportional to N):

| Component | Bound | At full scale |
|---|---|---|
| Read chunk | 1M pts × record length | ~34 MB rotating |
| Tile spool | `FLUSH_BYTES` hard ceiling | 128 MB + per-write overshoot |
| Spooler idle buffers | ~5.6 KB × node count | ~48 MB at 8.5K nodes |
| Node objects | ~10K `BuildNode`s | < 5 MB |
| Finalize per-tile | one raw tile + gzip | ~2–10 MB transient |

**v2 delta: +one `traversed` counter and +`k` per node in pass 1; +two counters per node in pass 2. ~16–32 bytes × ~10K nodes ≈ 300 KB.** No per-node arrays, no claim grids, no allocation whose count or size scales with point count. Projected peak RSS stays where v1's was — well under 1 GB. Wall time: identical IO profile (two sequential streams of the ~13 GB source) plus ~N×depth integer increments (~3.4B adds, minutes of CPU at worst, likely IO-shadowed).

Why the parked branch died and v2 won't: v1.1 carried per-node ~13 KB voxel bitsets whose *count* exploded before `minOwnedForSplit` existed, plus 64 MB per-node buffer caps — allocation count and size both scaled with tree pathology. v2 allocates nothing new per point and O(bytes, not kilobytes) per node.

**Mandatory diagnostic gate before acceptance:** port the parked branch's `tools/build-index-diag.mts` (5-second snapshots of rss/external/arrayBuffers/heap + node count + spooler size) onto main next to `scripts/build-surfel-diag.mts`, and run the full-scale build under it. Acceptance: completes; `storedPointCount === pointCount`; peak RSS < 2 GB; per-level owned-point histogram shows ~capacity at interior nodes (this histogram is also the direct evidence that A1 is fixed — print it from the manifest).

---

## E. Recommended package split

| Pkg | Contents | Effort | Risk | Rerun required |
|---|---|---|---|---|
| **5.2a — Sizing (cosmetic)** | Debug color-by-level; per-level material cache + size function (C2/C3); shrink-on-refine; pinned base with eviction exclusion | S–M | none | none |
| **5.2b — Strided index (structural)** | v2 `insertPoint` counter + strided `routePoint` + on-demand children (B3/B4); version bump + outdated-format warning (B5); diag script port + full-scale gated run (D); surfel regen | M | low | **full index + surfels** |
| **5.3 — Polish (defer)** | Cross-fade on tile swap; SSE threshold retune (400 px was tuned for coverage-starved coarse tiles; representative+sized coarse levels likely want ~200–300); walk-mode prototyping against the new base | S–M | none | none |

**Ship 5.2a first, but do not oversell it.** Direct answer to the sequencing question: **adaptive sizing alone does not get close enough to the owner's spec to defer the format change.** Sizing fixes how the coarse points look; A1 is about *which* points exist at coarse levels, and no radius function covers a site with a flightline prefix — bigger orbs on a streak is a bigger streak. What 5.2a does deliver alone: the near/final zoom state (1–2 inch orbs, columns at the mile markers — leaf tiles are complete, so this works today), shrink-on-refine feel, and no-coverage-regression during motion. The "orbs merge as view extends / even coverage when zoomed out" clauses land only with 5.2b.

They are also independent and compounding: 5.2a is pure renderer (works unchanged on v1 and v2 manifests), 5.2b is pure builder (improves even today's fixed-size rendering). Recommended order is 5.2a → 5.2b within the same phase window, with the color-by-level screenshot pair as the before/after artifact for both.

One rebuild consolidation note: R7 from the Phase 5 review (record detected RGB bit depth in `index.json`) and any other manifest-touching wishes should ride 5.2b's version bump — full-scale reruns are the scarce resource; spend one, not two.

---

*Verification notes: file-order prefix ownership re-confirmed in `insertPoint`/`routePoint` on main; absence of per-level sizing confirmed (single shared `PointsMaterial`, `worldPointSize` 0.04–0.18); Phase 5.1 presence confirmed in working tree (corrected smoothstep at `StreamingSurfels.ts:127`, planarity/linearity at `analytic-surfels.ts:191–197`, global spacing at `analytic-surfel-builder.ts:74–75`); parked-branch voxel-claim mechanics and bitset allocation read from commit `48aa3a8`; staleness/warning patterns read from `src/shared/pointcloud-index.ts`; ancestor-inclusive union selection confirmed in `selectStreamingNodes` (node added before children queued). S-estimate vs pass-2 traversal divergence bounded by capacity per ancestor as argued in B4.*

INDEX DISPLAY REVIEW COMPLETE
