# Surfel End-State Review

Date: 2026-07-07

Scope: read-only end-state review for surfel sizing and merge behavior. No source code changed. Evidence used: `_DOCS/SURFEL_ORIENTATION_REGRESSION_REVIEW.md`, `_DOCS/SURFEL_RESTORATION_IMPLEMENTATION_NOTE.md`, `_DOCS/SURFEL_DEFECT_IMPLEMENTATION_NOTE.md`, `_DOCS/SURFEL_RESTORE_AFTER_FULL.json`, `_DOCS/SURFEL_DEFECT_AFTER_FULL.json`, `_DOCS/SURFEL_DEFECT_BASELINE_FULL.json`, `_DOCS/SURFEL_RESTORE_BBOX_SCALE2.json`, `_DOCS/SURFEL_RESTORE_BBOX_WIDE_SCALE2.json`, current builder/core/script code, and one additional bbox subset run against the owner-provided existing project with `--skip-index`.

Owner-defined end state accepted as controlling:

- Disc size is driven primarily by local point spread within each cell plus chunk/LOD sizing, in the Phase 4.5 sense.
- Flatness-driven merging is demoted to low or no priority: off by default or capped very low, at most subtle neighbor consolidation.
- Settled and not reopened: world-fixed flat orientation, black-center fix retained, mega-disc protections retained.
- Future design direction to preserve: manual surfel management as a separate user-editable system, and sim-manager boundary traces as a separate overlay layer above the surfel substrate.

## 1. Executive conclusion

The current end-state miss is concentrated in one place: coarse interior/root-node radii are still allowed to inherit merge cell size from node geometry rather than that node's observed point spacing. After the coefficient restore, that geometry-driven floor now saturates the F2 clamp in root and near-root nodes. That is why the full run moved from `clampedRadiusCount = 408` to `3521`, and why the max jumped from `260.64 ft` to `1006.28 ft` while the median stayed small.

The owner-liked behavior and the defect are separable:

- Legitimate LOD scaling is present and desirable. In local subset runs, the same area produces a reasonable coarse chain such as roughly `11 -> 22 -> 44 -> 89 ft` across ancestor nodes.
- The broken tail is different. It produces `227 / 522 / 1006 ft` discs over ordinary ground in root and near-root nodes, with repeated centers across `0-*`, `1-*`, and `2-*` keys. Those values are not expressing local spread; they are the restored floors riding inflated merge cell size until the node-edge clamp stops them.

That mandatory fix should be made first. Merge behavior can then be demoted cleanly without masking the radius bug.

## 2. Mandatory defect: giant coarse-node discs

### 2.1 Verified hypothesis

The hypothesis is correct in substance.

Current radius emission in `src/core/pointcloud/analytic-surfels.ts` is:

`radius = max(0.85 * radiusCellSize, varianceTerm, 0.35 * radiusCellSize)`

where `radiusCellSize` is allowed to grow with accepted merge size. In merged cells, `radiusCellSize` becomes `mergedCellSize`; in sparse pass-through cases it inherits the largest prior accepted merge size. The builder in `electron/analytic-surfel-builder.ts` sets the fine starting cell size with `nodeLevelCellSize(...)`, which is geometry-aware and can already be large for coarse strided nodes. From there, each accepted doubling expands the floor-driving size again.

The current hard cap remains `0.5 * nodeEdge`. That cap is what is now firing 3521 times.

Evidence from the full restored run in `_DOCS/SURFEL_RESTORE_AFTER_FULL.json`:

- `surfelCount = 29,020,295`
- `screenAlignedPercent = 0.3%`
- `radiusPercentiles.p50 = 0.2285`
- `radiusPercentiles.max = 1006.2814`
- `clampedRadiusCount = 3521`
- repeated top entries at `1006.28`, `522.28`, and `503.16 ft`
- all top offenders live in root or near-root keys: `0-0-0-0`, `1-1-1-0`, `1-0-0-0`, `1-1-0-0`

Evidence from the targeted additional bbox run centered on the 1006 ft outlier:

- bbox: `[2894954.5, 1658987.75, 10807.74] - [2895154.5, 1659187.75, 10867.74]`
- `971,978` surfels across `634` intersecting nodes
- `p50 = 0.2285`, `p90 = 0.4569`, `p99 = 1.8277`, `max = 522.2789`
- per-level maxima in that crop: `14.24, 28.49, 21.03, 42.05, 42.05, 22.31, 44.62, 133.41, 32.64, 32.64, 0, 0, 522.28`

That crop is the discriminating check: the local fine and mid-level discs sit in the `1-45 ft` range, yet a near-root node over the same area still emits `522 ft`. That is not a legitimate LOD increase. It is the floor exploding on a coarse hierarchical representation.

Evidence from the existing wide bbox `_DOCS/SURFEL_RESTORE_BBOX_WIDE_SCALE2.json` makes the same point more compactly:

- local max chain over the same small area: `5.55 -> 11.10 -> 22.20 -> 44.39 -> 88.79 ft`
- only the root-facing bins go large; local emitted discs remain normal

### 2.2 Distinguishing legitimate LOD scaling from the broken tail

The owner's preferred behavior is preserved by chunk-aware sizing when coarse displayed nodes genuinely have coarser point spacing. That produces discs in the tens of feet, not the hundreds.

The broken tail has three signatures:

- It is concentrated in root and near-root nodes, not scattered across displayed local leaves.
- It moves with hierarchy depth, not with local point spread. The same area is normal in fine tiles and absurd only in coarse ancestors.
- It frequently saturates the `0.5 * nodeEdge` clamp. A clamp hit is proof that the floor source has outrun any meaningful local spread measurement.

In short: bigger far-node discs are fine; clamp-saturated discs several hundred feet wide are not.

### 2.3 Recommended bound

Recommended mandatory fix:

- Keep the restored variance term and the F2 hard clamp.
- Keep per-chunk LOD sizing.
- Stop letting geometry-sized merge cells drive the floor unbounded.
- For interior/coarse nodes, cap the floor-driving size against that node's observed point spacing before applying the `0.85` and `0.35` floors.

The concrete bound to start from is:

`floorBasis = min(radiusCellSize, nodeObservedSpacing * K)`

with `K` starting at `10` and tuned only with bbox subsets.

Why this bound:

- `nodeObservedSpacing` still rises in strided/coarse nodes, so legitimate LOD growth stays intact.
- A `10x` multiplier preserves the current "bigger chunk reads bigger" character in the tens-of-feet range.
- It kills the `522 / 1006 ft` tail, because those values require geometry-sized floors far beyond any plausible spacing in the offending nodes.

Why `10x` is the right starting point, not a guess:

- In the additional outlier bbox, near-root discs that still read plausibly land around `42-45 ft`.
- A spacing-tied cap in roughly the `8x-10x` band preserves that scale while removing the `133 / 227 / 522 ft` escalation.

What not to do:

- Do not remove chunk-aware sizing entirely.
- Do not fall back to a pure node-edge fraction bound; that is the bug source.
- Do not rely on the clamp as the steady-state control. The clamp is a safety rail, not a sizing policy.

### 2.4 Validation for the mandatory fix

Use two bbox checks only, no full regen needed for the first pass:

1. The existing outlier-centered bbox above:
   Expect the `522 ft` outlier to collapse into the same tens-of-feet band as the `42-45 ft` coarse discs already visible in that crop.

2. The existing wide subset in `_DOCS/SURFEL_RESTORE_BBOX_WIDE_SCALE2.json`:
   Expect `88.79 ft` to remain allowed if it still derives from actual coarse spacing, but no entry in the hundreds should survive.

Success criteria:

- `clampedRadiusCount` drops sharply from the current 3521 full-scale alarm trend.
- coarse-node maxima remain in a readable tens-of-feet regime
- local `p50/p90/p99` stay approximately where they are now

## 3. Merge demotion plan

The owner spec is clear: merging should no longer be the primary driver of disc size. The primary driver should be local spread plus chunk/LOD sizing. That means merge policy should now be treated as an optional consolidation layer.

### 3.1 Option A: merge off entirely

Config shape:

- do not run bottom-up merge acceptance at all
- emit from fine cells only
- keep the mandatory spacing-based coarse-node radius bound above

How it reads:

- Rough color-varied site: maximum texture retention, mottled and information-dense, closest to "painted with points turned into discs".
- Unpainted flat pad: reads as a stippled disc field, not as a few broad plates.

BBox validation:

- Wide subset: histogram should collapse to level 0 only.
- Outlier bbox: mandatory radius bound must still suppress the root/near-root tail, because merging is no longer present to blame.

Cost:

- Honest memory/count cost is high.
- The repo already contains two relevant no-or-near-no-merge classes of evidence: roughly `45.0M` in `_DOCS/SURFEL_DEFECT_BASELINE_FULL.json` and the earlier historical `~67M` class called out in prior review notes.
- For planning purposes, merge-off should be treated as a `45M-67M` surfel artifact class, not a `29M` class.

Assessment:

- Cleanest interpretation of the new spec.
- Most expensive in storage, load, and streaming.

### 3.2 Option B: merge capped at 1-2 doublings

Config shape:

- keep bottom-up merge available
- hard-cap accepted merge doublings at `1` or `2`
- preserve current planarity/residual gating, but do not permit deep consolidation
- keep the mandatory spacing-based coarse-node radius bound above

How it reads:

- Rough color-varied site: still textured and varied, with only subtle neighbor cleanup.
- Unpainted flat pad: reads as a quilt of nearby discs rather than a monolithic slab. This matches the owner's stated "at most subtle neighbor consolidation" direction.

BBox validation:

- Wide subset: level histogram should keep mass in levels `0-2` and eliminate the current long tail into higher levels.
- Outlier bbox: top entries should stay in the tens-of-feet range after the mandatory radius fix.

Cost:

- Midpoint cost between merge-off and today's deep-merge artifact.
- Should remain materially smaller than the `45M-67M` merge-off class while avoiding the current deep-merge coarse anchors.

Assessment:

- Best fit for the owner spec.
- Keeps a small amount of neighbor cleanup without reintroducing merge as the main shaper.

### 3.3 Option C: keep merge but gate it harder

Config shape:

- leave deep merge available
- raise thresholds or minimum counts so only very flat/coherent areas merge far
- keep the mandatory spacing-based coarse-node radius bound above

How it reads:

- Rough color-varied site: mostly okay, but still vulnerable to a few large anchor discs where the pad or road surface is coherent.
- Unpainted flat pad: still trends toward large simplified plates if the gates are met.

BBox validation:

- Wide subset: levels `3+` should shrink but will not disappear.
- Outlier bbox: mandatory radius fix may remove the hundreds-of-feet bug, but this option still preserves the conceptual path that made deep pad simplification dominant.

Cost:

- Likely close to today's `29.0M` class, depending on tuning.

Assessment:

- Technically workable, but directionally wrong for the stated end state.
- This is still a merge-primary mindset with stricter gates.

### 3.4 Recommended default

Recommend Option B as the default: cap merge at `2` doublings.

Reason:

- It honors the new rule that sizing is primarily local spread plus chunk LOD.
- It allows only subtle neighbor consolidation.
- It avoids the storage hit of pure merge-off.
- It is future-friendly for manual surfel edits, because the local substrate remains granular enough that user actions are meaningful.

If the owner wants the strongest possible adherence to "merge demoted," Option A is the strict version. Option C should not be the default.

## 4. Forward compatibility: manual surfel management

### 4.1 What manual per-surfel operations would require

Current tile format is optimized for streaming baked arrays, not editable surfel identities. A manual surfel manager would require three things that do not exist yet.

1. Stable surfel IDs

- Today each tile stores only positions, colors, radii, normals, confidence, flags, and eigenvalues.
- There is no persisted per-surfel ID, no merge-level field, no per-surfel source count, and no source-point lineage.
- A tile-local array index is not enough if tiles are regenerated or rewritten.

2. Edit persistence model

- Deletes need tombstones or a sidecar edit log keyed by stable surfel ID.
- User merges need a persisted relationship describing which surfels were combined and what replacement surfel overrides the originals.
- If those edits must survive rebuilds from the same source data, IDs must derive from deterministic lineage, not from current tile ordering.

3. Tile rewrite or delta application strategy

- Current `.sftile` files are gzip-compressed flat arrays, so any true baked edit is effectively a whole-tile rewrite.
- A future editor should choose between:
  - sidecar deltas applied at load time, or
  - explicit rewrite of touched tiles plus manifest/version bookkeeping.
- Sidecar deltas are the safer first design because they avoid churn in the generated artifact and keep user edits clearly separate from derived generation.

### 4.2 What would count as painting us into a corner

The following would make future manual editing harder:

- tying surfel identity to transient tile index order
- continuing to discard per-surfel metadata that would help define identity later
- baking user boundaries or user edits into the surfel generation pass itself

Today's recommended decisions do not paint us into a corner:

- the mandatory radius bound changes sizing policy only
- merge demotion/capping keeps the substrate more local, which actually helps future user edits
- no recommendation here requires changing the tile payload in a way that blocks later stable ID work

### 4.3 Boundary traces as a separate overlay layer

Confirmed: boundary traces as a separate overlay layer imply no surfel-side changes.

Reason:

- They are semantically a user/authored overlay, not a property of the derived surfel substrate.
- They should not participate in surfel merge, surfel sizing, or surfel persistence.
- The current viewer architecture already has separate overlay concepts elsewhere; the correct future direction is another overlay/layer asset, not surfel mutation.

## 5. Instrument bug: `topLargestSurfels`

### 5.1 Root cause of `level = -1` and `count = 0`

The immediate bug is in `scripts/build-surfel-diag.mts`.

`computeExactRadiusDiagnostics(...)` rebuilds the top-largest table by loading tile payloads and pushing entries with:

- `level: -1`
- `count: 0`

hardcoded.

That happens because the tile payload does not contain per-surfel level or source-count metadata, and the script does not try to join those entries back to the builder-time merge metrics.

Important nuance: the builder already has correct level/count at build time. `emitSurfelsFromCells(...)` records them in `mergeMetrics.largestSurfels`, and `electron/analytic-surfel-builder.ts` aggregates those per-node top entries across the build. The diagnostic script then throws that metadata away and replaces the summary's `topLargestSurfels` with the exact-radii reconstruction from tile payloads.

So the metadata bug is not that the builder never knew the answer. The bug is that the diagnostic script discards the only path that knows it.

### 5.2 Root cause of duplicate entries across the full-scale aggregation

There are two duplicate mechanisms.

1. Expected hierarchy duplication

- The diagnostic script scans every node in the surfel hierarchy.
- The same physical area exists in multiple LOD nodes by design.
- Therefore ancestor and descendant representations of the same site area all compete in one global top-10 list.

This is why the same center family repeats across `0-*`, `1-*`, `2-*`, and `3-*` keys in the full JSON.

2. Unresolvable same-center ties in the exact-rebuild path

- Once the script has thrown away level/count/identity and reduced each candidate to radius plus center plus node key, it has no robust way to collapse duplicates or even decide whether two equal-center entries are the same surfel lineage or two separate emitted surfels.

That is why this path degrades tuning quality: it gives exact radius values but strips the metadata needed to interpret them.

### 5.3 Recommended instrumentation fix

For tuning runs, the recommended fix is script-only and does not require a regen format change:

- Use builder-time `mergeMetrics.largestSurfels` as the authoritative `topLargestSurfels` summary so level and count remain correct.
- Keep `computeExactRadiusDiagnostics(...)` only for exact percentile computation.
- Add a second optional view, `topLargestSurfelsUniqueByAncestry`, that collapses obvious ancestor/descendant repeats for human tuning review.

That gives the tuning loop what it actually needs:

- exact percentiles
- correct level/count metadata
- a deduped human-readable top list

If future post hoc analysis must recover surfel-level metadata from baked tiles alone, the tile or sidecar format will need persisted per-surfel level/count/ID fields. That is a larger change and not required for the immediate tuning loop.

## 6. Single recommended implementation package

Stop after this package for owner comment. Do not write the implementation handoff yet.

| Item | Decision | Effort | Risk | Regen |
|---|---|---:|---|---|
| P1 | Mandatory radius fix: cap floor-driving size by node observed spacing before applying restored floors; start with `floorBasis = min(radiusCellSize, nodeObservedSpacing * 10)` | 0.5-1 day including bbox tuning | Low-medium; touches the core size rule but preserves F1-F3 protections | Yes |
| P2 | Demote merge by default: cap merge at `2` doublings | 0.5 day | Low; config/algorithm bound only | Yes |
| P3 | Diagnostic repair: keep exact percentile pass, but source `topLargestSurfels` from builder-time merge metrics and add an ancestry-deduped view | 0.5 day | Low; tooling only | No |
| P4 | Future-proofing note only: do not start manual surfel editing until stable ID, edit persistence, and tile delta strategy are designed | report only | None | No |

Recommended execution order:

1. P1 first. This is the actual defect.
2. P3 second. Fix the numbers used for tuning.
3. P2 third. Demote merge once the radius floor bug is removed and the diagnostics are trustworthy.

## 7. Owner-facing recommendation

Recommended end state:

- local spread plus chunk LOD remain the primary sizing system
- root/near-root radii are spacing-bounded so hundreds-of-feet discs disappear
- merge remains available only for subtle local consolidation, capped at `2` doublings by default
- manual surfel management is preserved as a future separate edit layer with stable IDs and sidecar persistence
- boundary traces stay a separate overlay layer with no surfel changes

That package matches the owner's stated preference more closely than any attempt to retune deep merge behavior.

SURFEL END-STATE REVIEW COMPLETE