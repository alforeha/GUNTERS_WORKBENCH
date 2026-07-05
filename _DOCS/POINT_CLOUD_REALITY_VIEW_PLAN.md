# Point Cloud Reality View — Current Plan

Status: **CURRENT** — supersedes `DRAFT_3DGS.md` (historical reference; do not delete).
Phase: Point Cloud Reality View Manager phase, following scaffold gate pass (131 tests green).

## 1. Framing

**Reality Simulation is data-source agnostic.** It is the project-level composition / interpretation / review space. It is a top-level manifest object — not an asset, owns no source file, has no hash, and stores no layer IDs.

**Point clouds are the first Reality Simulation entry point**, not the simulation itself. Future entry points (DWG/DXF, GIS, imagery, photos, field reports) are out of scope now.

**Source LAS/LAZ/E57 files are assets.** They register in `assets[]` with truth `source`, immutable, under copy/reference policy. A `simulationLayers[]` record links display to the primary simulation via `simulationId` and to the asset via `assetId`.

## 2. Truth mapping

| Data | Truth status |
|---|---|
| Original LAS/LAZ file | `source` |
| Normalized/indexed point data | `source-normalized` / `indexed-full` |
| Sampled display point set | `preview-sampled` |
| Analytic splat/surfel render | `derived` |

Display LOD is allowed **only if disclosed**. Sampled/capped display must never be presented as full survey truth. Full-source data remains available (the source file is never consumed or replaced).

## 3. What exists already (donor code)

The scaffold already contains browser-beta donor code, unwired to the project model:

- `src/core/las/metadata.ts` — LAS header/VLR/attribute parsing (LAS 1.x incl. 1.4 64-bit counts)
- `src/workers/las.worker.ts` — worker parse, sampling (1M cap), octree build, fast/balanced/all-detail tiers
- `src/viewer/RenderPointCloud.ts` + `pointCloudLod.ts` — 2–5M point render budget, distance LOD, rgb/intensity/elevation display modes
- Tests: `las-metadata.test.ts`, `pointcloud-lod.test.ts`, `perf-large.test.ts`

This phase is primarily **integration**: wire donor code to asset registry, IPC import, simulationLayers, and save/reopen — with honest truth labeling.

## 4. Index/display strategy decision (Phase 4)

**Recommendation: Option D — Hybrid.**

- **Now:** honest `preview-sampled` display. Full-file **strided sampling from disk (streamed)** into the existing octree/LOD path, capped point budget, with a visible "Preview — sampled N of M points" disclosure. Never load the whole file into memory (reference file is 13.7 GB / 381.8M points).
- **NEXT (deferred):** project-side index or COPC pipeline (`indexed-full`), possibly via PDAL/untwine-style tooling. COPC is the long-term fit but too large for this phase.
- **Rejected as final path:** Option A (browser-style preview only) — acceptable only as this phase's disclosed stopgap.

Truth labels: sampled display set → `preview-sampled` (cache, disposable, regenerable). Future index → `indexed-full` (derived, regenerable). Source file stays `source`.

## 5. Reference test asset

`_REFS/BATCH_2/CO25013_PNT CLD_250903.las` — LAS 1.4, PDRF 7 (RGB), 381,812,261 points, 13.7 GB.
Bounds: X 2,893,803–2,895,893; Y 1,658,128–1,659,595; Z 10,741–11,010 (survey feet, large offsets → origin rebase required).

## 6. Scope classification

- **NOW:** import/reference point cloud source asset; dense disclosed display; truth badges; simulation layer registration; save/reopen fidelity; this plan doc.
- **NEXT:** source-snapped marker/polyline/measurement; full-source point picking; COPC/project-side index; analytic surfel/splat derived layer; LAZ if not landed this phase.
- **RESERVED:** DWG/DXF simulator entry; edge-to-linework; texture-to-hatching; feature extraction; surface/object separation.
- **FUTURE:** satellite imagery starter; parcels; PLSS; NGS monuments; GIS overlays; exported web scenes.

## 7. Invariants (must not regress)

Single primary Reality Simulation; layer membership only in `simulationLayers[]` via `simulationId`; truth/status on assets only; layer lifecycle (`active`/`hidden`/`error`) separate from asset truth; sources immutable; derived regenerable; cache disposable; save/reopen fidelity is a trust gate.
