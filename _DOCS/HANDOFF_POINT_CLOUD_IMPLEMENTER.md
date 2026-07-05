# Handoff: Point Cloud Reality View — Implementer

Repo: `GUNTERS_WORKBENCH`. Do **not** commit, branch, or otherwise touch git — the owner manages version control. Edit files only.

Read first: `_DOCS/POINT_CLOUD_REALITY_VIEW_PLAN.md` (current plan), `src/shared/manifest-schema.ts`, `electron/project-service.ts`, `src/main.ts`, `src/workers/las.worker.ts`, `src/viewer/RenderPointCloud.ts`, `src/viewer/pointCloudLod.ts`, `src/core/las/metadata.ts`.

## Mission

Wire the existing donor point-cloud code (LAS parse/octree/LOD viewer) into the Workbench project model so that a user can: import or reference one real LAS file → see it registered as a `source` asset with a truth badge → view it densely in 3D with disclosed sampling → have a `simulationLayers[]` record reference it → save, close, reopen, and see it rehydrate.

Formats: **LAS required.** LAZ only if a decoder (e.g. laz-perf) drops in cleanly; otherwise defer and note it. E57/PLY/XYZ/PTS: out of scope.

## Hard constraints

1. **Never load the whole file.** Acceptance file is `_REFS/BATCH_2/CO25013_PNT CLD_250903.las` — 13.7 GB, LAS 1.4, PDRF 7 (RGB), 381,812,261 points. Stream/slice from disk.
2. **Sampling must span the entire file.** The donor worker's `sampleView` reads only the first `SAMPLE_POINT_LIMIT` records — on the acceptance file that is the first ~0.26% of points, spatially a sliver. Replace with strided reads across the full point-record range (chunked reads, stride computed from total count vs. budget). Preserve the fast/balanced/all-detail quality tiers if practical.
3. **Origin rebasing.** Coordinates are ~2.89M/1.66M survey feet. Rebase to a local origin before building Float32 GPU buffers; keep the offset in metadata so displayed coordinates read as true source values. No visible jitter under orbit/zoom.
4. **Honest disclosure.** The UI must show, unmissably, when display is sampled: e.g. `Preview — sampled 4.2M of 381.8M points`. The sampled display set is truth `preview-sampled` and lives in `cache/` (disposable). The source file record stays `source`. Never label sampled data `source` or `indexed-full`.
5. **No UI freeze.** Parse/sample in the worker or main-process async path; show progress; renderer stays responsive.
6. **Do not violate manifest invariants:** `realitySimulation` stays `.strict()` with no layer IDs; membership only via `simulationLayers[].simulationId`; truth on assets only; layer status limited to `active`/`hidden`/`error`.
7. **No scope creep:** no COPC pipeline, no 3DGS/splat training, no feature extraction, no GIS/parcels/imagery, no DWG entry path, no marker/measurement tools.

## Work items

### A. Asset model (manifest + validation)
- Point cloud asset uses existing `assetRecordSchema` with `kind: 'point-cloud'` (or a tightened kind enum if you prefer — keep schema version discipline; if the manifest schema changes shape, bump appropriately and keep old-manifest rejection friendly).
- Record metadata where readable from the header without a full scan: filename, extension, size, point count, LAS version, point format, bounds, scale/offset, CRS/unit info if present in VLRs; import timestamp; sha256 **of header + size** or full-file hash only if streaming hash is fast enough — do not block import for minutes hashing 13.7 GB; if you hash partially, name the field honestly (e.g. `headerSha256`).
- Unit/CRS warning: donor code assumes usSurveyFoot. If CRS/units can't be confirmed from VLRs, attach a visible unit warning on the asset (existing warning path).

### B. Import/reference flow (IPC)
- New IPC: pick point cloud file (native dialog, `.las`/`.laz` filter), then import with existing copy/reference policy. Copy policy → file goes under `sources/`; reference policy → external absolute path recorded. For multi-GB files, warn or default to reference (owner-visible choice is fine; document what you did).
- Missing referenced file on open → friendly warning, asset shown with warning, layer status `error`, app does not crash.

### C. Display path
- Renderer streams sampled points via the worker (full-file stride per constraint 2), builds octree, renders through existing `RenderPointCloud`/LOD budget (2–5M).
- Display modes: elevation coloring and RGB (PDRF 7 has RGB); intensity if already free in donor code. Point size control if low-cost.
- Truth badge + sampling disclosure visible in the UI.

### D. Simulation layer + persistence
- On import, create `simulationLayers[]` entry: `simulationId` = primary sim id, `assetId` = point cloud asset id, status `active`.
- Save → close → reopen: asset + layer persist, viewer rehydrates the point cloud (re-sample from source or reload cached sample; either is fine if labeled correctly and reopen doesn't freeze).
- Full restart rehydration must also work.

### E. Tests
- Extend existing suites: manifest validation for point cloud assets, import policy behavior, layer round-trip through save/reopen (fixture-scale LAS, not the 13.7 GB file), stride-sampling math unit tests, missing-reference handling. Keep all 131 existing tests green.

## Staging permission

If the full acceptance file proves too heavy for the first pass, Stage A (smaller LAS or fixture, honest `preview-sampled` disclosure) is acceptable — but your report must state exactly what was achieved and what was deferred.

## Report back

Return: files touched; formats supported (LAS? LAZ?); import/reference behavior; metadata captured; truth/status behavior; disclosure UI wording; layer/persistence results (save/reopen/restart, explicitly tested); performance on the acceptance file (load time, memory, FPS notes, sampled count); tests run/results; deviations from this handoff; risks found.
