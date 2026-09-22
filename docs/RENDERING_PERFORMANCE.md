# Mobile rendering performance lane

This is a measurement and optimization lane for the existing SiteNav/Three.js/Gaussian-splat viewer. It does **not** authorize a GIS conversion or rendering-engine rewrite. Preserve the public guide interaction, label positions, building cards and site semantics while improving first-use latency, interaction smoothness, memory pressure and battery/network efficiency on phones and lower-end devices.

## What is already in the viewer

The viewer already adapts to coarse hardware/network signals: low/medium/high tiers, capped device-pixel ratio, antialias disabled below high tier, low-tier CSS blur removal, low-tier scenery/PBR reductions, Save-Data/2G splat bypass, camera-motion DPR reduction, idle rendering throttle and cross-origin-isolated shared worker memory when available. It also avoids redundant label transform writes and has browser-specific protection around GPU splat sorting.

These mechanisms should be measured and refined rather than replaced speculatively.

## Opt-in on-device probe

Open the viewer with:

```text
?perf=1
```

A local HUD appears with quality tier, current DPR, moving-frame metrics, long-task time, splat update cost, memory when the browser exposes it, and the selected model asset. **No data is uploaded, persisted, sent to analytics, written to localStorage/cookies, or sent with `sendBeacon`.** `Copy JSON` copies the current snapshot locally.

For measurement without HUD compositing overhead:

```text
?perf=1&perfHud=0
```

For an experimental moving-resolution A/B test only:

```text
?perf=1&dragDpr=0.75
```

`dragDpr` is ignored during normal sessions and must not become a new default until physical-phone testing confirms both the performance gain and acceptable moving-image clarity.

The probe records: device-tier inputs, effective connection/Save-Data state, asset path/bytes, splat fetch/bounds-scan/module/add-scene timings, viewer/visual-ready marks, rAF/render counts, moving rendered FPS and p50/p95, resolution switches, splat-update duration, Long Tasks, renderer counters/drawing-buffer size, visibility changes, and best-effort browser memory samples. Hidden pages skip viewer updates and force an active frame on return.

## Constrained Chromium harness

`tests/render-performance.py` runs the **real viewer** under synthetic low-end/mobile hints, CPU throttling and network throttling, then collects the same `?perf=1` data. It is for request/tiering/startup/regression evidence. Headless Chromium/SwiftShader is **not** a physical-phone GPU benchmark and its FPS must never be reported as real phone FPS.

The harness writes explicit top-level `readinessMs` (`baseGuideReady`, `visualReady`, `splatReady`) and `splatTimingsMs` fields. On the progressive vanilla public route, `visualReady` means the base guide is usable; **full-splat candidate comparisons must use `splatReady`**, not `visualReady`. Output is labelled `synthetic-headless-regression` to keep that provenance visible in downstream summaries.

Example:

```sh
PORT=50170 node tests/preview-server.cjs
python tests/render-performance.py \
  --base-url http://127.0.0.1:50170 \
  --profiles low-save-data,low-4g

# Experimental motion-resolution comparison:
python tests/render-performance.py \
  --base-url http://127.0.0.1:50170 \
  --profiles low-4g --drag-dpr 0.75
```

## 22 Sep 2026 measured findings

All figures below are synthetic constrained-browser measurements unless explicitly described otherwise. They are useful for identifying bottlenecks and comparing changes, not for claiming physical-phone FPS.

### 1. Base-map transfer was a major low-network blocker

The original LANDCROS satellite texture was a 1934×1236 PNG at **3,285,175 bytes**. In the low-tier/Save-Data profile (4× CPU slowdown, 120 ms latency, synthetic 2 Mbps), splats are intentionally skipped but visual readiness still took approximately **14.43 s**. `coreSceneBuilt` was approximately 13.63 s, matching the expected transfer cost of the satellite PNG.

A same-resolution quality-90 WebP is **238,676 bytes**, a **92.7% byte reduction**. The source PNG remains in the repository as a fallback/reference. With LANDCROS configured to use the WebP, the same synthetic profile measured:

- `coreSceneBuilt`: ~**2.04 s**
- `visualReady`: ~**2.85 s**
- splat GET count: **0**, as required by Save-Data

This is a safe default optimization because pixel dimensions and map geometry are unchanged. Real-device visual inspection is still required before release qualification.

### 2. Full 3D startup is now dominated by the splat

Current preferred model: `site-lite.splat`, **8,743,168 bytes** (~273k 32-byte splat records).

In the synthetic low-tier 8 Mbps profile after the satellite reduction, one representative **pre-progressive-reveal** trace recorded approximately:

- splat transfer: **8.9 s**
- bounds scan: **24 ms** under 4× CPU throttling
- splat module import: **0.26 s**
- `addSplatScene`: **2.49 s**
- then-`visualReady` (which still waited for the full splat): **13.3 s**

The bounds scan is therefore not the first optimization target. Model bytes, library/scene construction and moving GPU cost matter much more. A prior PNG run observed ~16.8 s visual-ready, but exact full-path deltas are affected by parallel downloads/cache/network-emulation variation and should not be attributed solely to the satellite change.

### 3. Lower moving DPR is promising, but remains an experiment

Under the same synthetic low-tier full-splat conditions:

| Motion setting | Moving rendered FPS | Moving p50 | Moving p95 |
| --- | ---: | ---: | ---: |
| Current default moving DPR 1.0 | ~10.5 | ~21.5 ms | ~50.5 ms |
| Perf-only moving DPR 0.75 | ~12.3 | ~17.3 ms | ~34.5 ms |

This is directional evidence only because software/headless rendering does not reproduce a phone GPU. Repeat this exact A/B on representative phones before changing the default.

## Physical-device qualification protocol

At minimum test:

1. lower-end Android, ideally 2–4 GB RAM;
2. mid-range Android;
3. an older supported iPhone/Safari device;
4. a recent iPhone or high-end Android as the reference ceiling.

For each device, test cold cache and warm cache on Wi-Fi and a constrained/mobile connection where practical:

1. open `/?perf=1` and record first visible/usable map and 3D-model-ready times;
2. orbit continuously for 10–15 seconds;
3. pinch/zoom repeatedly for 10–15 seconds;
4. open a permanent building card and a shared pin;
5. leave the app/background tab for 30 seconds, then resume;
6. copy the JSON snapshot;
7. repeat the motion test with `?perf=1&dragDpr=0.75`;
8. visually compare label legibility and splat clarity while moving.

Record device/browser/OS, memory if exposed, network, cold/warm cache, quality tier, DPR, selected asset, moving p50/p95/FPS, long-task count/max, splat-update average/max, readiness marks, resolution-switch count and memory samples.

## Provisional budgets — calibrate on real phones

These are engineering targets, not current-product claims:

- Base guide usable with splats skipped: **≤4 s** on constrained mobile; warm cache target **≤2 s**.
- Low-end moving frame time: target **≤33 ms median**, **≤50 ms p95**.
- Avoid post-ready Long Tasks **>500 ms**; aim for interaction Long Tasks <50 ms.
- Static idle rendering: **≤5–10 rendered fps**, with no unnecessary sorting/update work.
- Resolution changes: no framebuffer-thrashing; normally one downshift and one restore per gesture.
- Hidden tab: no viewer rendering/splat update work beyond browser scheduling; one clean resume frame.
- Splat request: one selected model GET, no duplicate full model transfer.
- Current lite splat is the baseline ceiling at ~8.74 MB. A future **4–6 MB** experiment is worth evaluating only if visual/site-recognition quality remains acceptable.

## Next rendering experiments, in order

1. **Real-phone DPR A/B.** Validate 1.0 vs 0.75 moving DPR before any default change.
2. **Smaller splat candidate.** Produce a reduced `site-lite` variant and compare site recognition, label alignment, load time and physical-device motion performance. Do not replace the current model solely on file size.
3. **Earlier usable UI while 3D finishes — implemented on the development branch.** The vanilla public route can reveal the base guide while the splat continues in the background; deep/share/debug routes remain blocking. Keep qualifying this behavior, but use `splatReady` for full-model timing.
4. **Static splat-update experiment.** Verify whether `GaussianSplats3D.Viewer.update()` can be skipped when camera/splat state is unchanged without stale sorting or visual artifacts. Only then reduce idle updates.
5. **Model-format/streaming research.** SOG/streamed splats or hierarchical LOD may be valuable when multiple/larger sites justify the complexity. This is an experiment, not a reason to rewrite the current app.
6. **Measure satellite/other texture GPU memory.** The WebP reduces transfer bytes but not decoded texture dimensions/GPU memory. If physical memory pressure remains high, test a separate lower-resolution texture for low-tier devices.

Performance work should remain evidence-led: each change needs before/after measurements, visual comparison and a rollbackable development-branch checkpoint. Do not use headless FPS as release evidence.

## Alpha-filtered lite-splat experiment — 22 Sep 2026

This is an **experiment and qualification tool**, not a production/default asset change. The canonical `site-lite.splat` remains the configured model until a physical-phone review confirms the visual trade-off.

The current `.splat` file uses fixed 32-byte records; its alpha byte distribution showed that a large fraction of records are low-opacity. `scripts/filter-splat.mjs` now provides a deterministic, dependency-free way to copy only records at or above a requested alpha threshold while preserving every surviving record byte-for-byte and in original order. It writes optional deterministic metadata with source/output SHA-256, record counts and byte counts. Generated candidates should remain outside tracked source until they pass qualification.

Example:

```sh
node scripts/filter-splat.mjs \
  sites/landcros/assets/site-lite.splat \
  /tmp/site-lite-a96.splat \
  --min-alpha 96 \
  --metadata /tmp/site-lite-a96.json
```

`tests/render-performance.py` accepts `--splat-asset ./assets/...` for local benchmark-only configuration interception and `--capture-presets` for fixed-camera canvas captures. This does not edit the checked-in site config.

### Candidate population

Baseline source SHA-256: `79bc00b5c7bb58ed5e143685554ab418119b986af9ae690dae0b5afe8167a6b0`.

| Candidate | Records | Bytes | Reduction |
| --- | ---: | ---: | ---: |
| Current baseline | 273,224 | 8,743,168 | — |
| alpha ≥48 | 193,933 | 6,205,856 | 29.0% |
| alpha ≥64 | 173,440 | 5,550,080 | 36.5% |
| alpha ≥80 | 156,529 | 5,008,928 | 42.7% |
| alpha ≥96 | 142,209 | 4,550,688 | 48.0% |

Filtering through alpha 96 did not materially change the raw XYZ extent in this file: the dominant span remained ~3.973–3.975 source units, and center changes were small. This reduces the risk of the existing automatic centering/scaling moving the whole site, but it does not prove visual quality at every camera or device.

### Three-run constrained comparison

The table below reports medians from three synthetic `low-4g` runs (4× CPU slowdown, 80 ms synthetic latency, 8 Mbps), using the real viewer and the same scripted gesture. These runs were captured **before progressive base-guide reveal was implemented**, when `visualReady` still waited for the full splat. These numbers are regression evidence only, not physical-phone FPS.

| Metric | Baseline 8.74 MB | alpha ≥80 5.01 MB | alpha ≥96 4.55 MB |
| --- | ---: | ---: | ---: |
| Splat transfer | 8.87 s | 5.24 s | 4.80 s |
| `addSplatScene` | 2.52 s | 1.72 s | 1.59 s |
| Pre-progressive full-model ready (then `visualReady`) | **13.32 s** | **8.79 s** | **8.14 s** |
| Moving rendered FPS | 10.3 | 14.6 | 15.3 |
| Moving p95 | 48.1 ms | 39.0 ms | 39.2 ms |
| Long-task total | 3.77 s | 2.47 s | 2.24 s |

The alpha-96 candidate therefore currently leads the **synthetic** startup/size trade-off. It is not yet the preferred production asset.


### Requalification after progressive base-guide reveal

After the vanilla public route gained progressive base-guide reveal, the same low-4G synthetic comparison was repeated on development head `f0b70fb` with the updated harness. Three-run medians are below. `visualReady` is intentionally **not** the full-model metric anymore; `splatReady` is.

| Metric | Baseline 8.74 MB | alpha ≥80 5.01 MB | alpha ≥96 4.55 MB |
| --- | ---: | ---: | ---: |
| Base guide ready | 0.78 s | 0.70 s | 0.70 s |
| `visualReady` (base guide) | 2.23 s | 2.15 s | 2.14 s |
| **`splatReady` (full model)** | **12.22 s** | **7.45 s** | **6.84 s** |
| Splat transfer | 8.92 s | 5.27 s | 4.84 s |
| `addSplatScene` | 2.65 s | 1.77 s | 1.58 s |
| Moving rendered FPS | 5.1 | 7.4 | 7.6 |
| Moving p95 | 35.1 ms | 35.7 ms | 37.4 ms |
| Long-task total | 3.53 s | 2.50 s | 2.41 s |

These remain **headless/SwiftShader regression measurements**, not phone FPS. Browser memory was not exposed. A repeat baseline fixed-camera capture itself varied at the exit preset by about 0.44% of pixels above an absolute RGB difference of 16, roughly the same scale as the candidate-vs-baseline exit differences. That makes the headless pixel comparison a gross-regression check, not evidence that alpha-80 or alpha-96 is visually indistinguishable on a phone. The default asset therefore remains unchanged; alpha-80 is the conservative first physical-device comparison and alpha-96 remains the smaller synthetic-performance candidate.

### Fixed-camera visual comparison

The harness captured the configured overhead, entry and exit presets after cancelling the intro through the real preset API. Against the baseline headless canvas capture:

- alpha ≥64 was pixel-identical in all three tested presets;
- alpha ≥80 was effectively identical, with only negligible differences;
- alpha ≥96 was identical at overhead/exit and differed only minimally at entry (mean absolute RGB difference ~0.008 on a 0–255 scale in that capture).

These screenshots are useful for catching gross holes/alignment changes, but software/headless rendering can hide device-specific artifacts and does not substitute for human inspection on a real phone. Thin/translucent site detail remains the primary risk of raising the alpha threshold.

### Promotion gate

Before changing `sites/landcros/data/config.json` to any filtered candidate:

1. regenerate it from the canonical baseline using the committed tool and verify the recorded source hash;
2. inspect overhead, entry, exit and real visitor views on at least a low-end Android and an iPhone/Safari device;
3. repeat `?perf=1` cold/warm load and motion tests on those phones;
4. confirm building/site recognizability, alignment, thin structures and low-opacity details are acceptable;
5. compare alpha-80 and alpha-96 rather than assuming the smallest file is better;
6. run the normal public-guide browser regressions;
7. make the asset/config switch as a separate rollbackable development commit.

Custom `.ksplat` compression remains a later independent experiment. Mixing format conversion with alpha filtering now would make the performance/quality attribution less clear.
