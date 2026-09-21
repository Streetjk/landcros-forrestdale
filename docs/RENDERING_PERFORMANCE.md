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

In the synthetic low-tier 8 Mbps profile after the satellite reduction, one representative trace recorded approximately:

- splat transfer: **8.9 s**
- bounds scan: **24 ms** under 4× CPU throttling
- splat module import: **0.26 s**
- `addSplatScene`: **2.49 s**
- `visualReady`: **13.3 s**

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
3. **Earlier usable UI while 3D finishes.** Test revealing the base map/labels/controls before splat completion while keeping a non-blocking “3D model loading” indicator. Preserve intro/camera behavior and test slow/error fallback.
4. **Static splat-update experiment.** Verify whether `GaussianSplats3D.Viewer.update()` can be skipped when camera/splat state is unchanged without stale sorting or visual artifacts. Only then reduce idle updates.
5. **Model-format/streaming research.** SOG/streamed splats or hierarchical LOD may be valuable when multiple/larger sites justify the complexity. This is an experiment, not a reason to rewrite the current app.
6. **Measure satellite/other texture GPU memory.** The WebP reduces transfer bytes but not decoded texture dimensions/GPU memory. If physical memory pressure remains high, test a separate lower-resolution texture for low-tier devices.

Performance work should remain evidence-led: each change needs before/after measurements, visual comparison and a rollbackable development-branch checkpoint. Do not use headless FPS as release evidence.
