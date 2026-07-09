# Surfel End-State Implementation Note

Date: 2026-07-07

Scope completed for the approved end-state package from `_DOCS/SURFEL_END_STATE_REVIEW.md`:

- P1: spacing-bounded radius floor
- P3: diagnostics repair
- P2: merge demotion, Option B default

Settled items were left untouched as directed:

- R1 orientation rule
- R3 Phase 4.5 radius coefficients
- F1-F3 mega-disc protections
- F6 black-center fix

No full-scale build or regen was run in this session. Validation was limited to focused tests, the full repo suite, and the requested bbox subset runs against the existing indexed project with `--skip-index`.

## Implemented

### P1: spacing-bounded radius floor

The restored floor terms now cap their floor-driving size against observed point spacing before the Phase 4.5 coefficients are applied.

Implemented rule:

`floorBasis = min(radiusCellSize, observedPointSpacing * 10)`

Applied only to the restored floor terms:

- `0.85 * floorBasis`
- `0.35 * floorBasis`

Left unchanged:

- variance term: `sqrt((λ2 + λ3) * 0.5) * 1.5`
- F2 hard clamp: `0.5 * nodeEdge`

Observed spacing source:

- defined from each node's actual decoded point positions in the builder
- not derived from node geometry
- passed into surfel derivation explicitly

Effect:

- coarse/root-node floors no longer ride inflated merge geometry into the hundreds-of-feet tail
- legitimate LOD growth remains available when observed spacing itself grows

### P3: diagnostics repair

`scripts/build-surfel-diag.mts` now uses builder-time `mergeMetrics.largestSurfels` as the authoritative `topLargestSurfels` summary.

That fixes:

- real `level` values instead of `-1`
- real `count` values instead of `0`
- preservation of builder-time metadata already known at emit time

Kept unchanged:

- exact percentile computation still comes from the post-build tile scan

Added:

- `topLargestSurfelsUniqueByAncestry`

This view collapses obvious ancestor/descendant repeats for tuning review while leaving the raw `topLargestSurfels` list intact.

### P2: merge demotion, Option B default

Accepted merge doublings are now hard-capped at `2` by default.

Behavior:

- level 0 fine cells may merge to level 1
- level 1 cells may merge to level 2
- deeper accepted merges are not attempted
- current cells terminate with their earned size beyond that point

F1 provenance semantics remain intact because cells keep the earned `radiusCellSize` they already reached before termination.

## K value choice

Chosen `K = 10`.

No retune was needed, because the first owner-requested bbox checks already met the review's acceptance criteria.

### Outlier-centered bbox

Command output file:

- `_DOCS/SURFEL_ENDSTATE_BBOX_OUTLIER.json`

Command bbox:

- `2894954.5,1658987.75,10807.74,2895154.5,1659187.75,10867.74`

Result after P1+P2+P3 with `K = 10`:

- `surfelCount = 1,037,157`
- `mergeLevelHistogram = [694982, 202675, 139500]`
- `p50 = 0.2285`
- `p90 = 0.4569`
- `p99 = 1.0286`
- `max = 29.9192 ft`
- `perLevelMaxRadius = [14.24, 19.48, 29.92]`
- `clampedRadiusCount = 0`

Interpretation:

- the prior `522 ft` coarse outlier collapsed into the expected tens-of-feet band
- no hundreds-of-feet coarse entries survived

### Wide bbox

Command output file:

- `_DOCS/SURFEL_ENDSTATE_BBOX_WIDE.json`

Command bbox:

- `2894300,1658525,10860,2894360,1658585,10890`

Result after P1+P2+P3 with `K = 10`:

- `surfelCount = 672`
- `mergeLevelHistogram = [404, 142, 126]`
- `p50 = 0.2285`
- `p90 = 1.7937`
- `p99 = 5.6710`
- `max = 17.3506 ft`
- `perLevelMaxRadius = [5.67, 1.79, 17.35]`
- `clampedRadiusCount = 0`

Interpretation:

- histogram mass is confined to levels `0-2` as required by Option B
- coarse maxima remain in the tens-of-feet regime
- nothing in the hundreds survived

## Tests

### Focused surfel tests

`tests/analytic-surfels.test.ts` passed: `22/22`.

Added coverage:

- coarse geometry no longer drives restored floors above `observedPointSpacing * 10`
- deep flat-plane merges stop at `2` doublings by default

### Full suite

`npm test` passed: `242/242`.

## Test-contract notes for owner sign-off

### P1 contract addition

There was no prior test asserting that restored floor terms must be bounded by observed spacing rather than coarse geometry. A new contract was added.

New assertion:

```ts
expect(surfels.radii[0]).toBeCloseTo(expected, 6);
expect(surfels.radii[0]).toBeLessThan(coarseRadiusCellSize * 0.2);
```

Meaning:

- restored floor terms now honor `observedPointSpacing * 10`
- coarse node geometry no longer dominates the floor

### P2 contract addition

There was no prior fixture encoding a deep-mergeable plane beyond two doublings. A new contract was added rather than rewriting an old one.

New assertion:

```ts
expect(surfels.count).toBe(4);
expect(surfels.mergeMetrics?.levelHistogram[2]).toBe(4);
expect(surfels.mergeMetrics?.levelHistogram.slice(3).every((count) => count === 0)).toBe(true);
```

Meaning:

- an `8x8` flat plane now terminates at level `2`
- no accepted merges continue into levels `3+`

## Owner-run command

Run this outside the agent session. No full-scale regen was run here.

```powershell
npm exec tsx scripts/build-surfel-diag.mts -- --project-folder="C:\Users\Owner\AppData\Local\Temp\wb-surfel-diag-S2x9vR\surfel-diag" --asset-id="point-cloud-1783384561123" --skip-index --surfel-cell-scale=2 --json="_DOCS\SURFEL_ENDSTATE_AFTER_FULL.json"
```

## Owner-run TODOs

### Full-scale directional diff (filled)

- source after: `_DOCS/SURFEL_ENDSTATE_AFTER_FULL.json`
- source restored baseline: `_DOCS/SURFEL_RESTORE_AFTER_FULL.json`
- both are full-scale, `surfelCellScale = 2`, `indexBuilt = false`, same 381,812,261 input points

Results (restored baseline -> end-state after):

- `clampedRadiusCount`: `3521 -> 0`
- max radius: `1006.28 ft -> 15.72 ft`
- surfel count: `29,020,295 -> 32,007,819` (+2,987,524, +10.3%)
- output size: `732.9 MB -> 796.4 MB`
- `p50 / p90 / p99`: `0.2285 / 0.4616 / 1.9653` -> `0.2285 / 0.4878 / 0.9871` (p99 tail cut roughly in half)
- merge histogram (baseline): `[14258109, 9497905, 3706800, 1126604, 292583, 91700, 26404, 9145, 3692, 1634, 615, 390, 4714]`
- merge histogram (after): `[14258109, 9497905, 8251805]`
- `perLevelMaxRadius` (after): `[5.55, 7.86, 15.72]` ft — no level above 2 survives

Top largest surfels — raw and ancestry-deduped agree:

- all ten entries are `radius = 15.72 ft`, `level = 2`, real `count` values (14-29 points), `nodeKey = 0-0-0-0`
- the baseline's `level -1 / count 0` mega-discs (1006 ft, 522 ft) are gone; P3 diagnostics now report real levels/counts

Direction confirmed against expectation:

- `clampedRadiusCount` collapsed to exactly `0`
- max radius fell from `1006 ft` into the tens-of-feet regime (15.72 ft)
- surfel count rose above `29.0M` (to `32.0M`) as Option B decomposes deep merges into levels `0-2`
- levels `3-12` (which held the entire hundreds-of-feet tail) are fully eliminated

### TODO: In-app visual check

- confirm rough color-varied areas still read richly under the level `0-2` cap
- confirm flat pads no longer grow coarse anchor discs in the hundreds of feet
- confirm the remaining chunk/LOD growth still reads as intentional rather than pathological

## Files produced in this session

- `_DOCS/SURFEL_ENDSTATE_BBOX_OUTLIER.json`
- `_DOCS/SURFEL_ENDSTATE_BBOX_WIDE.json`
- `_DOCS/SURFEL_ENDSTATE_IMPLEMENTATION_NOTE.md`