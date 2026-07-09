# Reality Render NOW Phase Stage-Completeness Review

Date: 2026-07-07

Scope: read-only stage-completeness review of the Reality Render NOW phase against `_DOCS/REALITY_RENDER_PLAN.md` Section 6. No source code changed. No builds, regens, or test runs were performed in this session. Per owner instruction, the accepted test record is owner-confirmed: `npm test` passed `242/242` across `23` files. Per owner instruction, surfel reopen fidelity in-app is also accepted as already confirmed and was not re-tested here.

Decision trail read before this review:

- `_DOCS/SURFEL_MERGE_REVIEW_PHASE5_3.md`
- `_DOCS/SURFEL_RENDER_DEFECT_REVIEW.md`
- `_DOCS/SURFEL_DEFECT_IMPLEMENTATION_NOTE.md`
- `_DOCS/SURFEL_ORIENTATION_REGRESSION_REVIEW.md`
- `_DOCS/SURFEL_RESTORATION_IMPLEMENTATION_NOTE.md`
- `_DOCS/SURFEL_END_STATE_REVIEW.md`
- `_DOCS/SURFEL_ENDSTATE_IMPLEMENTATION_NOTE.md`

Settled decisions from that trail were treated as closed and not reopened here: world-fixed disc orientation, Phase 4.5 sizing restored through spacing-bounded floors with `K = 10`, merge demoted to a `2`-doubling cap by default, mega-disc protections F1-F3 retained, and the surfel display-size slider intentionally isolated and session-only.

## 1. Executive conclusion

Conclusion: the Reality Render NOW phase is stage-complete against the current controlling plan.

All nine NOW items listed in `_DOCS/REALITY_RENDER_PLAN.md` Section 6 are present in code and backed by either direct tests, adjacent integration tests, or owner-confirmed runtime evidence where the owner explicitly reserved that validation to Windows. I did not find a blocking gap that would keep the phase open.

The strongest evidence is concentrated in four places:

- WPI index model, generation, truth, and reopen behavior are implemented through `electron/pointcloud-index-builder.ts`, `src/shared/pointcloud-index.ts`, `electron/project-service.ts`, and `tests/pointcloud-index-service.test.ts`.
- Streaming indexed-full display and camera-driven refinement are implemented through `src/viewer/pointCloudStreaming.ts`, `src/viewer/StreamingPointCloud.ts`, and the streaming tests.
- Analytic surfel generation, persistence, reopen, missing-artifact handling, and renderer wiring are implemented through `electron/analytic-surfel-builder.ts`, `src/shared/analytic-surfels.ts`, `electron/project-service.ts`, `src/viewer/StreamingSurfels.ts`, and the surfel service/tests.
- The manifest and lifecycle invariants remain enforced through `src/shared/manifest-schema.ts`, `src/shared/workbench-types.ts`, `electron/project-service.ts`, and `tests/projectLifecycle.test.ts` plus `tests/pointcloud-index.test.ts`.

One evidence note, not a phase blocker: the points-to-surfels user control is implemented as independent layer visibility rather than a single dedicated mode switch. That still satisfies the plan's requirement that users can return to the measured-point view, because preview/index layers and surfel layers are separate layer kinds with separate visibility state.

## 2. NOW item review

### 2.1 WPI v1 index model + generation

Status: DONE

What this means in plain English: the app can build and store a full internal point-cloud index that keeps the measured points intact, organized into octree tiles for streaming.

Code evidence:

- `electron/pointcloud-index-builder.ts` builds the WPI index in two passes, writes per-node gzip tiles, writes `index.json`, and writes a completion marker only after the output is complete.
- `src/shared/pointcloud-index.ts` defines the WPI asset model, truth rules, versioning, staleness checks, and the streaming-valid gate.
- `src/shared/manifest-schema.ts` enforces that `pointCloudIndex` metadata exists exactly when the asset kind is `point-cloud-index` and truth is `indexed-full`.
- `electron/project-service.ts` stages index builds into `derived/<assetId>/index.staging`, swaps into `derived/<assetId>/index` only on success, and registers the resulting asset and simulation layer only after a complete build.

Test evidence:

- `tests/pointcloud-index-service.test.ts` covers successful build, manifest registration, staging-dir cleanup, reopen survival, regeneration replacement instead of duplication, build-failure rollback, hierarchy load, tile load, and cancellation.
- `tests/pointcloud-index.test.ts` covers schema validity, staleness semantics, outdated-format warnings, and the streaming-valid gate.

Assessment: complete and well-covered.

### 2.2 SSE tile streaming

Status: DONE

What this means in plain English: the viewer chooses which tiles to load based on camera distance and on-screen error, so it streams more detail where it matters instead of trying to draw everything at once.

Code evidence:

- `src/viewer/pointCloudStreaming.ts` implements the screen-space-error selection math, budgeted refinement, stale request cancellation, LRU eviction, settled detection, and indexed-full disclosure text.
- `src/viewer/StreamingPointCloud.ts` is the live indexed-full renderer that consumes that selection logic and exposes disclosure state back to the UI.
- `src/main.ts` loads index hierarchies and tiles through `window.workbench.loadPointCloudIndexHierarchy` and `window.workbench.loadPointCloudIndexTiles`, then refreshes disclosure while streaming is active.

Test evidence:

- `tests/pointcloud-streaming.test.ts` covers SSE math, node selection, fetch order, budget-limited refinement, eviction, stale request cancellation, settled state, and refining-versus-settled disclosure.
- `tests/streaming-pointcloud.test.ts` covers renderer-level behavior: root-first loading, deeper refinement on zoom, eviction under budget pressure, stale in-flight drop, and settled disclosure.

Assessment: complete and directly tested.

### 2.3 Densification demotion

Status: DONE

What this means in plain English: the old near-camera "grab extra source points" path is no longer the main refinement path. It is now a fallback only when no valid full index is available.

Code evidence:

- `src/main.ts` gates `requestNearCameraDensification` with `hasValidIndexForStreaming(indexAsset)`. If a valid index exists, densification does not fire.
- `src/shared/pointcloud-index.ts` defines `hasValidIndexForStreaming` so stale indexes are treated as absent for this gate, while a missing-source warning alone does not disable streaming.
- `src/main.ts` also emits the fallback disclosure text only when preview plus densified points are actually being shown.

Test evidence:

- `tests/pointcloud-index.test.ts` directly verifies the gate behavior for clean, stale, missing-source, non-index, and outdated-format cases.
- `tests/projectLifecycle.test.ts` verifies the missing-source preview path and warning semantics that keep fallback behavior honest.

Assessment: complete. The demotion rule is explicit in code, not just implied by UX.

### 2.4 Indexed-full truth path

Status: DONE

What this means in plain English: once the full index exists, it is recorded and disclosed as a separate truth state, without pretending that the source LAS stopped being the source of truth.

Code evidence:

- `src/shared/workbench-types.ts` defines `indexed-full` as a distinct truth status and gives index assets their own metadata shape.
- `src/shared/manifest-schema.ts` enforces that truth and payload match: index assets must be `point-cloud-index` with `truthStatus = indexed-full`.
- `electron/project-service.ts` registers the built index asset with `truthStatus: 'indexed-full'` and creates a `point-cloud-index` simulation layer.
- `src/main.ts` disclosure text explicitly says `truth indexed-full; source asset remains source`.

Test evidence:

- `tests/pointcloud-index-service.test.ts` asserts the generated asset kind, truth status, metadata, and reopen survival.
- `tests/pointcloud-index.test.ts` asserts schema acceptance for valid index assets and rejection for mislabeled or malformed ones.

Assessment: complete and aligned with the plan's honesty requirement.

### 2.5 Analytic surfel derived layer (model + minimal render)

Status: DONE

What this means in plain English: the app can build a separate surfel layer from measured points, store it as a derived artifact, stream it back in tile form, and render it as world-space discs.

Code evidence:

- `src/shared/analytic-surfels.ts` defines the derived surfel asset kind, versioning, and staleness-warning helpers.
- `electron/analytic-surfel-builder.ts` builds surfel tiles and a surfel manifest from either a WPI index or preview fallback, records merge metrics, and writes a completion marker.
- `electron/project-service.ts` registers surfel assets with `truthStatus: 'derived'`, creates `derived-surfel` layers, loads hierarchies, loads tiles, and rebases positions for rendering.
- `src/viewer/StreamingSurfels.ts` streams and renders surfel tiles, including world-fixed orientation for non-billboarded discs and per-layer disclosure text.
- `src/main.ts` loads surfel hierarchies and tiles into the viewer and keeps the surfel layer independent from point layers.

Test evidence:

- `tests/analytic-surfels.test.ts` covers derivation behavior, merge behavior, radius rules, orientation flags, tile-format round-trips, eigenvalue output, and versioning.
- `tests/pointcloud-index-service.test.ts` covers preview-fallback surfel generation, index-backed surfel generation, hierarchy load, tile load, surfel-cell-scale plumbing, and reopen survival.

Assessment: complete. This is not a placeholder layer anymore; it is a real streamed derived asset class.

### 2.6 Points to surfels toggle

Status: DONE

What this means in plain English: users can show the measured-point view, show the surfel view, hide either one, and return to measured points whenever needed.

Code evidence:

- `src/main.ts` resolves preview, index, and surfel layers as separate simulation-layer kinds.
- `src/main.ts` applies visibility independently through `setLayerVisibility`, `applyLoadedLayerVisibility`, `ensureIndexLayerLoaded`, and `ensureDerivedSurfelLayerLoaded`.
- `src/viewer/ViewerEngine.ts` has separate add/remove/display methods for indexed points and analytic surfels.
- `src/shared/workbench-types.ts` and `src/shared/manifest-schema.ts` keep point-cloud-index and derived-surfel as separate layer kinds with their own `active|hidden|error` lifecycle.

Evidence note:

- The control is implemented as separate layer toggles rather than one exclusive switch. That is still sufficient for the plan wording, which requires a return path to measured points, not a specific widget shape.

Test evidence:

- No single dedicated test is named "points to surfels toggle," but the layer model, load paths, visibility plumbing, and reopen behavior are covered by the service and lifecycle tests.
- Owner-confirmed runtime behavior that surfel persistence survives reopen further supports this as a finished user-facing path.

Assessment: complete, with evidence spread across layer wiring rather than one isolated test.

### 2.7 Disclosure (four banner states)

Status: DONE

What this means in plain English: the viewer tells the user whether they are seeing sampled preview points, preview plus fallback densification, indexed-full streaming that is still refining or has settled, or a derived surfel render that is not measured points.

Code evidence:

- `src/main.ts` assembles disclosure lines for preview, preview-plus-densification fallback, indexed-full, and derived surfels.
- `src/viewer/pointCloudStreaming.ts` formats indexed-full disclosure with refining versus settled state.
- `src/viewer/StreamingSurfels.ts` exposes `Analytic surfel render (derived) - streaming ... - not measured points`.

Test evidence:

- `tests/pointcloud-streaming.test.ts` verifies indexed-full disclosure wording and refining-versus-settled state.
- `tests/streaming-pointcloud.test.ts` verifies settled disclosure from the renderer surface.
- Derived-disclosure wording is code-backed and exercised through the surfel loading path, though I did not find a dedicated unit assertion that snapshots the exact derived string.

Assessment: complete. Disclosure behavior exists for all planned states. Test coverage is strongest on indexed-full and more indirect on the derived string.

### 2.8 Persistence

Status: DONE

What this means in plain English: the project remembers these assets and layers across save, close, and reopen, and it downgrades missing derived artifacts into a recoverable error instead of crashing.

Code evidence:

- `electron/project-service.ts` writes manifests atomically with backup and journal support.
- `electron/project-service.ts` registers index and surfel assets in the manifest and restores them through open-time checks.
- `electron/project-service.ts` marks missing surfel artifacts with a friendly regenerate warning and sets the layer to `error` instead of failing project open.
- `src/main.ts` reloads derived surfel and point-cloud layers on project open.

Test evidence:

- `tests/pointcloud-index-service.test.ts` verifies index reopen, surfel reopen, and missing-artifact reopen handling.
- `tests/projectLifecycle.test.ts` verifies save/backup/reopen behavior, unclean-shutdown detection, preview-cache persistence, and missing-source recovery behavior.
- Owner-confirmed evidence, accepted as controlling for this review: surfel data persists through reopen and the in-app restart fidelity check passed.

Assessment: complete.

Important boundary note:

- The surfel display-size slider is intentionally session-only by owner decision and belongs to a later display stage. That is not a NOW-phase persistence gap.

### 2.9 Metrics

Status: DONE

What this means in plain English: index builds and surfel builds produce structured numbers that describe what was built, how large it is, and how the surfel merge output behaved.

Code evidence:

- `src/shared/workbench-types.ts` defines `PointCloudIndexMetricsSummary` and `AnalyticSurfelMetricsSummary`.
- `electron/project-service.ts` returns index metrics and surfel metrics from the generation APIs.
- `electron/pointcloud-index-builder.ts` reports point count, stored point count, tile count, index size, depth used, wall time, and peak buffered bytes.
- `electron/analytic-surfel-builder.ts` reports surfel count, node count, input point count, output size, wall time, and merge metrics including histograms, radius percentiles, screen-aligned fraction, clamp count, and largest-surface diagnostics.
- `src/main.ts` surfaces completion summaries in the UI after index and surfel generation.

Test evidence:

- `tests/pointcloud-index-service.test.ts` asserts returned index metrics and surfel metrics are present and sensible.
- `tests/analytic-surfels.test.ts` exercises merge metrics and versioned surfel output.

Assessment: complete.

## 3. Section 5 invariants audit

Result: no Section 5 invariant appears regressed in the current code.

### 3.1 Single primary Reality Simulation, strict top-level shape

Status: HOLDING

Evidence:

- `src/shared/manifest-schema.ts` keeps `realitySimulation` as a strict object and validates all membership through separate top-level arrays.
- `tests/projectLifecycle.test.ts` rejects a manifest that tries to place membership IDs inside `realitySimulation` and rejects unknown top-level keys.

Assessment: the app still has one strict top-level simulation record, not a container full of embedded membership IDs.

### 3.2 Membership only in flat arrays keyed by `simulationId`

Status: HOLDING

Evidence:

- `src/shared/workbench-types.ts` and `src/shared/manifest-schema.ts` model `simulationLayers`, `features`, `reviewFlags`, `comparisonRefs`, and `analysisResults` as separate arrays.
- `src/shared/manifest-schema.ts` verifies those records point back to the primary simulation ID.

Assessment: membership remains flat and externalized.

### 3.3 Truth/status on assets only; layer lifecycle separate from truth

Status: HOLDING

Evidence:

- `src/shared/workbench-types.ts` separates asset `truthStatus` from layer `status`.
- `src/shared/manifest-schema.ts` validates both independently.
- `electron/project-service.ts` sets layer status to `error` for missing source or missing surfel artifact without rewriting the asset's truth claim.

Assessment: the code still distinguishes "what this data is" from "whether this layer is currently healthy/visible."

### 3.4 Sources immutable; derived regenerable; cache disposable

Status: HOLDING

Evidence:

- `src/shared/pointcloud-index.ts` and `src/shared/analytic-surfels.ts` treat index and surfel outputs as derived assets linked back to immutable source assets.
- `electron/project-service.ts` rebuilds index/surfel outputs into staging directories and swaps them in on success.
- `tests/pointcloud-index.test.ts` explicitly verifies that deleting the preview cache does not invalidate the index.
- `tests/projectLifecycle.test.ts` covers cache rewrite and corrupt-cache recovery.

Assessment: source truth remains separate, derived outputs are replaceable, and preview cache remains disposable.

### 3.5 Save, reopen, restart fidelity

Status: HOLDING

Evidence:

- `electron/project-service.ts` uses temp-write plus backup plus journal.
- `tests/projectLifecycle.test.ts` covers save, backup, clean reopen, and unclean-shutdown detection.
- `tests/pointcloud-index-service.test.ts` covers reopen for both index and surfel assets.
- Owner-confirmed runtime evidence accepts surfel reopen and restart fidelity as passed.

Assessment: invariant still holds for the current stage.

### 3.6 Origin rebase for large survey coordinates

Status: HOLDING

Evidence:

- `electron/project-service.ts` computes an index origin from bounds center and rebases point and surfel tile payloads relative to that origin before rendering.
- `src/viewer/ViewerEngine.ts` applies the shared scene origin to both indexed points and surfels.

Assessment: the renderer still avoids drawing raw world-scale coordinates directly.

### 3.7 No sampled or derived display presented as measured source truth

Status: HOLDING

Evidence:

- `src/main.ts` disclosure explicitly labels preview as `preview-sampled`, indexed-full as `indexed-full`, and surfels as derived and not measured points.
- `src/shared/manifest-schema.ts` enforces truth-specific metadata coupling for source, index, and surfel assets.

Assessment: the honesty line remains intact.

## 4. Gaps, risks, and non-blockers

### 4.1 Blocking gaps

None found for NOW scope.

### 4.2 Non-blocking evidence notes

- The derived surfel disclosure string is implemented clearly in code, but I did not find a dedicated test that snapshots that exact text. This is a test-depth note, not a stage-completeness gap.
- The points-to-surfels user path is implemented through separate layer visibility rather than one dedicated exclusive mode switch. That still satisfies the plan language.
- Historical docs in the surfel trail contain earlier test counts such as `236`, `238`, and `240`. I treated those as historical checkpoints only. The accepted record for this review is the owner's current `242/242` report.

## 5. Carry-forward boundary

The following remain outside NOW and should stay in the next-stage backlog exactly as framed by the owner:

- disc appearance and fuzz-absorption round, including any future decision on surfel-size-slider persistence
- color-homogeneity merge gate
- node-edge disc orientation at chunk borders
- surfel manager and manual merge-delete tooling
- boundary traces overlay
- smaller deferred technical items such as float32 world-absolute precision follow-up, `screenAlignedFrac` weighting refinement, and the `--max-points` harness follow-up

These are future design or refinement items, not evidence that the NOW phase is incomplete.

## 6. Final verdict

Reality Render NOW is complete as scoped in `_DOCS/REALITY_RENDER_PLAN.md` Section 6.

All planned NOW items are present. The truth model is honest. The fallback densification path is demoted behind indexed-full streaming. The derived surfel layer is a first-class persisted asset. Disclosure is present for all planned states. The Section 5 invariants remain intact. The remaining surfel backlog is refinement work for later stages, not unfinished NOW work.

REALITY RENDER NOW PHASE STAGE-COMPLETENESS REVIEW COMPLETE