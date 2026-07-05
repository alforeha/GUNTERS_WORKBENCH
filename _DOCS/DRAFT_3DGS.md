# GUNTER'S WORKBENCH — 3DGS / REALITY-MODEL FIRST BUILD
**Design report** · 2026-07-04 · Assumes the Workbench scaffold gate (§12 of the scaffold report) is met
**Grounding:** current codebase (LAS worker, octree LOD, Float64/origin-rebase viewer) + 2026 3DGS tooling landscape (sources at end)

---

## 0. The honest technical framing (read this first)

One fact shapes this entire design: **"3DGS" as practiced is a photogrammetric technique.** Real Gaussian-splat training optimizes millions of Gaussians against *posed photographs* (SfM/camera poses + photometric loss). **You have a point cloud, not an image set.** There is no mainstream turnkey tool that trains splats from LiDAR alone; the research that exists (LiDAR-constrained 3DGS, Gaussian-surfel completion like SurfFill) uses LiDAR as a *constraint* alongside imagery, or is not product-ready.

That is not bad news — it validates the owner's instinct about "simple arithmetic or custom approaches." What a survey point cloud supports directly is **analytic point-to-Gaussian conversion**: each point (or aggregated neighborhood) becomes a Gaussian whose position is exact, whose color comes from RGB/intensity/elevation, whose scale comes from local point spacing, and whose orientation comes from local surface fit (PCA normal → flattened disc "surfel"). No training, no GPU optimization, no black box — deterministic math over survey-truth positions, producing a scene that renders through completely standard splat renderers and exports to completely standard splat formats.

Consequences:
- **Visual ceiling:** an analytic splat scene looks like a *solid, navigable, hole-free reality surface* — dramatically more legible than points — but not like a photoreal drone-flythrough. Photoreal quality requires imagery; if the owner later flies photos of a site, image-trained 3DGS can join as a second generator behind the same derived-asset slot.
- **Survey-trust win:** analytic conversion is *better* for the product's trust story than trained 3DGS. Every Gaussian sits on a measured point; nothing is hallucinated between measurements. Trained splats invent geometry to please photographs — exactly what a measurement environment must not do silently.
- The proof should therefore test: **can analytic splats make a real site legible and navigable at scale, with survey overlay and interaction?** — not "can we reproduce Inria's pipeline."

---

## 1. Executive recommendation

**Scope:** Import the real project LAS into a Workbench project → index to full-resolution COPC (derived, disk-resident, complete) → render source points via streaming LOD with full disclosure → run an **in-app analytic point→Gaussian converter** (no external ML pipeline) → render splats through a standard splat renderer → toggle points/splats → place markers, draw one polyline, measure — all snapped to *source* data — → save/reopen as a derived asset → publish feasibility numbers.

**Integration:** **Build inside the Workbench repo from day one,** behind the scaffold's asset registry — not an isolated spike. The earlier review recommended isolation *when the main app was the fragile browser beta*; the scaffold changes that calculus: the registry/derived-asset machinery now exists precisely so this feature has a home, the renderer slot (`RenderSplats` beside `RenderSurface`/`RenderPointCloud`) is the app's own pattern, and an isolated spike would re-derive origin rebasing and asset plumbing only to throw it away. What stays isolated: **any experiment with image-trained 3DGS tooling** (if attempted at all this phase — recommended: no).

**Riskiest assumption to kill first:** that analytic splats at 50–150M input points can render at interactive rates on the owner's GPU. Phase the build so this is answered in the first two weeks (§11), before any polish.

---

## 2. Data flow

```txt
 P:\...\CO25013_PNT CLD.las                      (original, untouched)
        │  import (copy or reference >1GB, hash, units assert)
        ▼
 sources/pc_0002_….las                            asset: pointcloud-las, truth: source
        │  index: untwine/PDAL (child_process) → COPC
        ▼
 derived/pc_0002.copc.laz                         truth: indexed-full  ← EVERY point, octree-ordered
        │  ├─ renderer streams visible octree nodes → point display (LOD, disclosed)
        │  └─ converter walks ALL leaf nodes → analytic Gaussians
        ▼
 derived/gs_0005/scene.ply (+ tiles/ if chunked)  asset: splats-3dgs, truth: derived
        │  render via splat renderer in the existing Three.js scene (rebased coords)
        ▼
 user geometry (markers/polylines/measurements)   asset: authored, provenance-tagged, survey coords
        │  save → manifest records + files; reopen → stream COPC + load splats, no reprocessing
        ▼
 (later) exports/scene_pkg/ (SPZ/SOG + overlays)  truth: export — Viewer-facing
```

Key data-flow decisions:
- **COPC replaces the bespoke in-memory octree as the persistence/indexing layer.** COPC is LAZ with an embedded octree (industry standard: PDAL, QGIS, CloudCompare all read it), generated by `untwine` — parallel, proven on billion-point files, and it is *lossless/complete*: the full dataset, spatially indexed, on disk. This single choice discharges the "full quality" principle: the app always *has* every point; display chooses how many to *draw*. The existing octree/LOD display logic carries over conceptually but reads nodes from COPC instead of rebuilding a sampled in-memory tree per session.
- **Conversion is a batch pass over the complete COPC**, not over the display sample — the splat scene derives from all points (aggregation is a resolution parameter, not a silent truncation).
- **Intermediate format:** none beyond COPC. LAZ→COPC is the only preprocessing; the converter reads COPC directly.
- **Splat storage:** PLY (standard Gaussian-splat PLY) as the archival format in `derived/` — lossless, readable by every tool in the ecosystem (SuperSplat, splat-transform, all web renderers); compressed formats (SPZ/SOG) are *export* transforms, not storage (§9).

## 3. Candidate technical approaches

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Point rendering first (streaming LOD from COPC)** | Reuses existing render knowledge; needed regardless (source-truth view, snapping); de-risks IO/GPU path early | Not the reality-model goal by itself | **Do first — it is the proof's foundation, not a detour** |
| **B. Analytic point→Gaussian conversion (in-app)** | Deterministic, survey-honest, no training, no CUDA dependency, preserves exact positions, tunable (scale/aggregation/color), fully local | Visual ceiling below photo-trained 3DGS; needs kNN/normal estimation pass (compute-heavy but batch) | **Core of the proof** |
| **C. Image-trained 3DGS (Brush/gsplat/OpenSplat via external process)** | Photoreal ceiling; mature tools | **Requires posed imagery you don't have**; GPU/CUDA variance; black-box density behavior invents geometry — trust hazard | **Not this phase.** Design the generator slot so it can plug in later when a project has drone imagery |
| **D. Hybrid points + splats, toggle/overlay** | The trust story made visible: "measured points" vs "derived skin"; costs little once A+B exist | Two renderers resident = VRAM pressure | **In scope — the toggle is proof requirement #7's soul** |
| **E. External converter tool vs in-app converter** | External (PDAL pipeline + custom): isolates compute, restartable | In-app (worker): no process plumbing, direct reuse of contract types | **Split:** indexing external (`untwine` — don't rewrite a solved problem); conversion in-app in workers (it's your novel value and must stay tunable) |
| **F. Tiled/chunked splats** | Needed above roughly 10–20M Gaussians; enables per-tile load/unload | Complexity; sorting across tiles | **Chunk by COPC node from the start** (the octree hands you tiles for free); single-file only if the scene proves small |
| **G. Fallback if splats disappoint** | — | — | **Graceful:** approach A already yields a professional streaming point-cloud viewer with full-source trust — a shippable Workbench feature on its own. The proof cannot total-loss |

Sub-decisions requested by the handoff: **RGB** — use if present; else intensity grayscale or elevation ramp (both survey-legible; record which in generator settings). **Normals** — estimate per-neighborhood via PCA during conversion (needed for surfel orientation); don't require them in source. **Classification** — don't *require*; if present, offer class filters at conversion (e.g., exclude noise class 7/18) and record the filter in the recipe. Ground/non-ground separation: not needed for V1 rendering; matters later for TIN extraction, and COPC preserves classifications untouched. **Global vs tiled generation** — tiled (per COPC node), merged bookkeeping in the derived asset. **Multiple LOD for splats** — V1: one quality level per generated asset (generate `preview` fast, `standard` overnight if needed); hierarchical splat LOD is a later optimization, the schema's `quality` field already accommodates it.

## 4. Full-source availability & display LOD

- **The COPC in `derived/` is the completeness guarantee**: every point, indexed, always openable. Registry records `totalPoints` (from source header) and verifies COPC point count matches — a mismatch is a hard warning.
- **Display is a budgeted traversal** (points-on-screen budget, user-adjustable density) of COPC octree nodes by screen-space error. The status UI states it plainly: *"Displaying 4.2M of 148.0M points (density-limited view — all points remain available)"* — never a bare point count.
- **Picking/snapping consults full data:** a pick ray resolves against displayed points *first for speed*, then refines by querying the COPC leaf node(s) around the hit for the true nearest source point. Snap results therefore come from **all** points, not the drawn subset — this is the concrete mechanism behind "measurements must not silently rely on incomplete data." The derived asset records `snappedTo: source-pointcloud` only when this path ran.
- **Splat view discloses its nature persistently:** a scene badge — *"Derived visualization (generated from 148.0M measured points) — not source data"* — with one click to toggle the source points on.
- Truth statuses used: source LAS = `source`; COPC = `indexed-full`; on-screen point view = `preview-sampled` (density-limited); splat scene = `derived`; user geometry = `authored`.

## 5. Coordinate / precision strategy

Extend the proven pattern; invent nothing:

- **Survey truth stays Float64 + survey units end-to-end in data.** COPC/LAS store int32+scale/offset in original coordinates (state plane, usft) — inherently full precision. User geometry stores Float64 survey N/E/Z in the manifest.
- **Render space = existing `SceneOrigin` rebase.** The first-loaded dataset's bbox center is already the scene origin; the point streamer and the splat renderer both subtract it on load (per-node/per-tile, in Float64, then narrow to Float32) — identical to `RenderSurface` today. The derived splat asset records `rebase.sceneOrigin` **and** its Gaussian positions are stored in a *declared* frame — **recommendation: store splat PLY in origin-rebased coordinates with the origin in the asset record**, because every splat renderer and web viewer assumes small Float32-safe coordinates; reconstruction of survey coords = position + recorded origin. Never write raw state-plane values into a splat PLY (Float32 fields — would corrupt precision silently).
- **Units:** asset units must match project units or carry the scaffold's recorded mismatch warning; the converter refuses mixed-unit generation. US survey foot vs international foot handled at import assert, as scaffolded.
- **Vertical exaggeration:** applies as the existing scene-level Z matrix — works on splat groups too (they're scene children); *but* exaggeration warps splat orientation subtly, so V1: exaggeration auto-locks to 1× while the splat layer is visible, with a status note. (Cheap, honest; revisit later.)
- **Inspection:** cursor readout in true survey N/E/Z works unchanged (same rebase inversion). Every marker/polyline vertex displays and stores survey coordinates; export path (later) is therefore trivial — the data was never in scene units.
- **Alignment with surfaces/DXF/points/PDF:** automatic — everything shares the project CRS and the same rebase. This is the payoff of doing 3DGS *inside* Workbench.

## 6. Object & line control V1

Smallest set that proves "working survey environment, not a picture":

1. **Marker** — click → snap to true nearest source point (COPC-refined, §4) → named point with survey N/E/Z, note field.
2. **Polyline** — sequential snapped (or free) vertices; closable; per-vertex coordinates; length readout.
3. **Measurement** — two picks → horizontal distance, slope distance, Δ elevation, bearing. Ephemeral by default, "keep" saves it as authored geometry.
4. **Snap mode toggle** — `snap to source points` (default) / `free placement on splat surface`. The pick's provenance is recorded per vertex, not per feature.
5. **Points ⇄ splats toggle** (and both-at-reduced-opacity) — the trust view.

Explicit V1 exclusions from interaction: edge *tracing* assist, regions/areas, classification flagging, editing splats, any automation. Rationale: markers + polylines + measurements exercise every hard substrate (picking against streamed full data, provenance, survey coords, persistence); everything else is additive UI on the same substrate.

**Provenance per authored vertex:**

```jsonc
{ "type":"polyline", "id":"geo_0003", "createdBy":"user", "derivedFromContext":["pc_0002","gs_0005"],
  "vertices":[ { "n":…, "e":…, "z":…, "snap":"source-point|splat-surface|free", "sourcePointRef":null } ],
  "confidence":"snapped|manual", "createdAt":"…", "notes":null }
```

`snap:"source-point"` vertices are defensible measurements; `splat-surface`/`free` are sketch-grade — the field exists so a future export/report can say which is which. This one small schema is the seed of the entire future extraction/refinement story.

## 7. Asset / provenance model

Slots directly into the scaffold registry — three records, no new machinery:

```txt
pc_0002  pointcloud-las   truth: source          sources/pc_0002_….las (or referenced)
  └─ index: { path: derived/pc_0002.copc.laz, status: ready, totalPoints, truth: indexed-full,
              tool: "untwine x.y", sourceHashAtGeneration }
gs_0005  splats-3dgs      truth: derived         derived/gs_0005/scene.ply [+ tiles/]
  └─ provenance: { derivedFrom:[pc_0002], generator:{ name:"gunters-analytic-splat", version,
      settings:{ aggregation, scaleK, colorMode, classFilter, … } }, generatedAt,
      sourceHashAtGeneration }   rebase:{ sceneOrigin } quality warnings regenerable:true
geo_0003 authored-geometry truth: authored       manifest-resident (small), §6 provenance
```

Rules: source LAS never modified · COPC and splats are regenerable (stale-flagged if source hash changes, per scaffold) · authored geometry is precious (`edited/`-class, always archived) · deleting a derived asset never touches its source or authored children — children keep `derivedFromContext` ids and get a "context missing" note if referenced assets are gone · future extracted/refined features enter as new `authored`/`derived` records pointing at both the geometry and the generator run that assisted them.

## 8. Performance & success metrics

Test ladder: 5M-point crop → full project LAS (`CO25013_PNT CLD_250903.las`, ~700 MB observed, est. 20–30M points at format 6–7) → a borrowed/merged 150M+ cloud for the stress row. Record on the owner's actual workstation; publish the table in the feasibility memo.

| Metric | Target (pass) | Red line (fail) |
|---|---|---|
| COPC indexing (untwine) | ≤ 1 min per 25M pts | > 5 min per 25M pts |
| Splat generation (analytic, all points) | ≤ 10 min per 25M pts preview quality | > 1 hr per 25M pts |
| Peak RAM (index / generate / view) | ≤ 8 GB / ≤ 12 GB / ≤ 6 GB | swap-death or crash |
| VRAM at target scene | ≤ 6 GB | over budget on owner's GPU |
| Navigation FPS (points view, budgeted) | ≥ 30 sustained, ≥ 60 typical | < 15 |
| Navigation FPS (splat view) | ≥ 30 at preview quality | < 15 |
| Pick→snap latency (COPC-refined) | ≤ 250 ms | > 1 s |
| Project reopen to interactive scene | ≤ 15 s (no reprocessing) | > 60 s or reprocesses |
| Derived splat size on disk | ≤ 3× source LAS | ≥ 10× |
| Disclosure UX | counts + truth badges always visible | any silent reduction found in review |

**Success =** all pass rows at the real project cloud scale **and** the subjective gate: the owner walks the site model, places a marker on a feature he surveyed, and the snapped coordinate matches his record within source-data noise. **Failure handling:** splat-side failure → ship approach A (streaming full-source point viewer) as the phase's product and reassess; point-side failure → the problem is IO/GPU architecture and must be fixed before *any* reality-model ambition, splats or otherwise.

## 9. Web / client viewer export assessment

Feasible, later, and worth designing for now — the ecosystem has matured specifically in this direction:

- **Format path is off-the-shelf:** archival PLY → `splat-transform` (PlayCanvas CLI) → **SOG** (streamed, auto-tiled for >1M Gaussians) or **SPZ** (Niantic's open compressed format, ~10× smaller than PLY) — both designed exactly for browser delivery. Rendering: PlayCanvas engine/SuperSplat, Spark (three.js + SPZ), or GaussianSplats3D (three.js) — three viable open renderers, two of them three.js-native like Gunter's Viewer.
- **Package sketch:** `scene.sog/spz` + `overlays.json` (markers/polylines/labels in rebased coords + recorded origin) + `manifest.json` (project id, generation provenance, disclaimer text) + optional static HTML viewer → runs from any static host **or fully offline from a local folder** — consistent with local-first.
- **Exclude by default:** source LAS/COPC (size + client-doesn't-need-it + data control), full point counts optional, anything PDF/plan unless explicitly added.
- **Measurement in the web viewer:** allow *reading* coordinates and simple distances, but labeled — the exported scene is compressed and derived twice over. **Mandatory footer: "Derived visualization for orientation — not a survey record."** Decide per-export whether measure tools are even enabled (client exhibits: probably off; crew orientation: on).
- **Browser limits:** phones/laptops handle ~1–5M Gaussians comfortably via SOG streaming; export therefore includes a decimation step with disclosure ("web scene: 2.1M of 24M splats").
- **Security/privacy:** local files, user-controlled hosting, no telemetry; the only real exposure is whatever the user chooses to send — which is the point.
- **Cost to keep the door open now:** near-zero — store archival PLY, record the rebase origin, keep overlays in JSON. Do not build the exporter in this phase.

## 10. Risks & mitigations

| Risk | Sev | Mitigation |
|---|---|---|
| Analytic splats look underwhelming vs "3DGS" hype expectations | High | Set expectation in the proof's own framing (§0); success gate is *legibility + trust*, not photorealism; imagery-trained generator stays a documented future slot |
| GPU/VRAM wall at real cloud scale | High | Phase order kills this first (§11 P1–P2); tile-by-COPC-node enables partial residency; density/quality knobs |
| Silent reduction leaks in (display, snap, export) | High (trust) | Truth badges + counts are acceptance criteria, not polish; snap path COPC-refined by design; export decimation always disclosed |
| Precision corruption via Float32 splat files | High (trust) | Rebased-coords-only in PLY + recorded origin (§5); round-trip coordinate test: marker placed → saved → reopened → identical N/E/Z |
| `untwine`/PDAL external-binary friction (packaging, versions) | Med | Pin binaries in app resources; record tool+version in provenance; COPC output verified by point-count match |
| kNN/normal estimation too slow at 100M+ pts | Med | Per-node processing in workers, approximate kNN within node + halo; preview quality uses coarser aggregation; overnight `standard` runs acceptable for V1 |
| Over-scoping: interaction tools breed (regions, tracing, classify-brush…) | High | §6 exclusion list ratified up front; anything beyond markers/polylines/measure = next phase decision |
| Black-box dependency risk (splat renderer lib) | Med | Renderer is swappable (standard PLY in, three.js scene out); the *generator* — your IP and trust surface — is in-house and deterministic |
| Derived-data confusion (client screenshots a splat, treats as survey) | Med | Persistent scene badge; exported images could carry a burned-in corner tag (cheap, decide at export build) |
| Proof drags into a rendering research project | High | Timebox: two decision checkpoints (§11 P2, P5); fallback product (streaming point viewer) declared in advance |

## 11. Build sequence

- **P0 — Gate check (days):** scaffold §12 conditions met; real LAS registered as asset with units/bounds; pin untwine/PDAL binaries.
- **P1 — Index + stream (1–2 wks):** LAS→COPC on import (background, journaled); streaming point renderer reading COPC nodes with screen-space-error LOD + density budget + disclosure counts. *Exit: full project cloud navigates ≥30 fps, reopen ≤15 s.*
- **P2 — CHECKPOINT A (days):** measure P1 against §8. If IO/GPU fails here, stop and fix — nothing downstream matters.
- **P3 — Analytic converter (2–3 wks):** worker-based per-node pass (kNN spacing → scale, PCA → orientation, RGB/intensity/elevation → color, class filter); write standard splat PLY tiles + derived-asset record with full recipe; progress + cancel + resume.
- **P4 — Splat rendering + toggle (1–2 wks):** integrate a three.js-compatible splat renderer as `RenderSplats` (rebased, exaggeration-locked); points⇄splats⇄both toggle; truth badges.
- **P5 — CHECKPOINT B (days):** visual/perf gate on the real site. Owner judgment: "does this make the site legible?" If no → tune recipe once, else invoke fallback.
- **P6 — Interaction (1–2 wks):** marker, polyline, measurement with COPC-refined snapping + provenance records; save/reopen acid test (place → close → reopen → identical coords).
- **P7 — Feasibility memo (days):** §8 table filled with real numbers, limitations, recipe settings, go/no-go recommendation for productization + whether the web-export step is worth scheduling.

Total ≈ 6–10 weeks with two hard checkpoints. Every phase leaves the app better even if the next fails (P1 alone = professional point-cloud viewer with full-source trust).

## 12. Explicit non-goals

Image-trained 3DGS pipelines (Brush/gsplat/OpenSplat integration) · full point management/codelist/lineout/reporting (unchanged from scaffold) · point cloud *editing* (transform/classify/clip — COPC preserves the data for later) · TIN extraction from clouds · automated/assisted planimetric extraction · splat editing/cleanup tools · hierarchical splat LOD · production web viewer + export packaging (schema door open only) · mobile anything · accuracy claims on splat-derived geometry (only `snap:"source-point"` vertices are measurement-grade, and the proof says so) · PDF work of any kind · replacing survey judgment.

---

## FINAL ANSWER — smallest proof with real survey value

**One real point cloud, in a real Workbench project: index it completely (COPC — every point on disk, streamable), view it honestly (budgeted LOD with counts displayed), convert it deterministically (in-app analytic point→Gaussian surfels — no training, no hallucination), walk it, toggle derived skin against measured points, place one marker and one polyline and one measurement that snap to true source points and survive save/reopen with exact survey coordinates — then publish the numbers.**

That proof demonstrates every claim the product needs to make — full-data trust, derived-vs-source discipline, survey-precision interaction inside a navigable reality model — while committing to zero speculative technology: the only novel component is ~1–2 thousand lines of deterministic geometry math you fully own, and the fallback position (a trustworthy streaming point-cloud viewer) is itself a feature worth shipping.

---

**Sources (2026 tooling landscape):**
- [Gaussian Splat Formats: PLY, SOG, SPZ, KSplat — Swyvl](https://swyvl.io/blog/gaussian-splat-formats-ply-spz-ksplat/)
- [3DGS Formats Compared (2026) — Polyvia3D](https://www.polyvia3d.com/formats/gaussian-splatting-formats)
- [playcanvas/splat-transform — conversion CLI](https://github.com/playcanvas/splat-transform)
- [SuperSplat — PlayCanvas](https://developer.playcanvas.com/user-manual/supersplat/)
- [Best Gaussian Splat Viewers in 2026 — Swyvl](https://swyvl.io/blog/best-gaussian-splat-viewers/)
- [COPC specification](https://copc.io/) · [COPC software implementations](https://copc.io/software.html)
- [PDAL — Point Data Abstraction Library](https://pdal.org/en/latest/about.html)
- [Gaussian Splats in surveying/LiDAR — Geo Week News](https://www.geoweeknews.com/blogs/gaussian-splats-3d-scene-representation-surveying-lidar)
- [SurfFill: LiDAR completion via Gaussian surfel splatting (research)](https://arxiv.org/html/2512.03010v1)
- [ARSGaussian: 3DGS with LiDAR constraints (research)](https://www.sciencedirect.com/science/article/abs/pii/S0924271625004101)
