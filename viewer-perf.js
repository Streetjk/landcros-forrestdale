function sanitizeExtra(val, depth = 0) {
  if (val === null || val === undefined) return val;
  const type = typeof val;
  if (type === 'number' || type === 'string' || type === 'boolean') return val;
  if (type === 'bigint') return Number(val);
  if (type !== 'object' || depth >= 3) return undefined;
  if (Array.isArray(val)) {
    const arr = [];
    const limit = Math.min(val.length, 20);
    for (let i = 0; i < limit; i++) {
      const s = sanitizeExtra(val[i], depth + 1);
      arr.push(s !== undefined ? s : null);
    }
    return arr;
  }
  const out = {};
  for (const k of Object.keys(val)) {
    if (typeof k !== 'string') continue;
    const s = sanitizeExtra(val[k], depth + 1);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

function sanitizePath(p) {
  if (typeof p !== 'string') return '';
  const clean = p.split(/[?#]/)[0];
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}

function calcPercentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

function summarizeDurations(values) {
  if (!values.length) return { samples: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    samples: values.length,
    avgMs: Number((values.reduce((sum, n) => sum + n, 0) / values.length).toFixed(2)),
    p50Ms: calcPercentile(sorted, 50),
    p95Ms: calcPercentile(sorted, 95),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2))
  };
}

export function createPerfProbe({
  enabled = false,
  gpuTiming = false,
  gpuContext = null,
  quality = {},
  renderer = null,
  now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()),
  documentRef = typeof globalThis !== 'undefined' ? globalThis.document : undefined,
  windowRef = typeof globalThis !== 'undefined' ? globalThis.window : undefined,
  navigatorRef = typeof globalThis !== 'undefined' ? globalThis.navigator : undefined,
  PerformanceObserverClass = typeof globalThis !== 'undefined' ? globalThis.PerformanceObserver : undefined,
  performanceRef = typeof globalThis !== 'undefined' ? globalThis.performance : undefined
} = {}) {
  const t0 = Number(now());
  const qualitySnapshot = sanitizeExtra(quality) || {};
  const events = [];
  const intervals = [];
  const renderTimes = [];
  const movingRenderTimes = [];
  const MAX_INTERVALS = 240;
  const MAX_EVENTS = 200;
  const MAX_GPU_PENDING = 6;
  const GPU_SAMPLE_STRIDE = 8; // Opt-in: approximately three GPU queries per second at 25 FPS.

  let lastFrameTime = null;
  let renderedFrames = 0;
  let movingFrames = 0;
  let hiddenFrames = 0;
  let isHidden = false;
  let visibilityChanges = 0;
  let resolutionSwitches = 0;
  let currentPixelRatio = 1;

  let splatCount = 0;
  let splatTotalMs = 0;
  let splatMaxMs = 0;
  const renderCpuTimes = [];
  const labelCpuTimes = [];
  const gpuTimes = { splatUpdate: [], render: [] };
  const gpuRequested = enabled && gpuTiming === true;
  let gpuGl = null;
  let gpuExt = null;
  let gpuReason = gpuRequested ? 'extension-unavailable' : 'not-requested';
  let gpuMovingFrames = 0;
  let gpuSampleThisFrame = false;
  let gpuActive = null;
  const gpuPending = [];
  let gpuDisjointEvents = 0;

  let longTaskCount = 0;
  let longTaskTotalMs = 0;
  let longTaskMaxMs = 0;

  const memorySamples = [];
  let selectedAsset = null;
  let assetBytes = null;

  let observer = null;
  let hudElement = null;
  let lastHudUpdate = 0;

  // WebGL timer queries measure work on the GPU rather than the JS time spent
  // submitting draw commands. The WebGL2 extension is optional; collecting
  // results is asynchronous and never waits for the GPU to finish a frame.
  // Queries are enabled only with ?perf=1&gpuPerf=1, never on normal visits.
  if (gpuRequested) {
    try {
      gpuGl = gpuContext || renderer?.getContext?.() || null;
      gpuExt = gpuGl?.getExtension?.('EXT_disjoint_timer_query_webgl2') || null;
      if (gpuExt && typeof gpuGl.createQuery === 'function' &&
          typeof gpuGl.beginQuery === 'function' && typeof gpuGl.endQuery === 'function') {
        gpuReason = 'collecting';
      } else {
        gpuGl = null;
        gpuExt = null;
      }
    } catch {
      gpuGl = null;
      gpuExt = null;
      gpuReason = 'query-initialization-error';
    }
  }

  function rememberDuration(values, milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    if (values.length >= MAX_INTERVALS) values.shift();
    values.push(milliseconds);
  }

  function gpuFrameStart(moving) {
    gpuSampleThisFrame = false;
    if (!gpuExt || !moving) return;
    gpuMovingFrames++;
    gpuSampleThisFrame = gpuMovingFrames % GPU_SAMPLE_STRIDE === 0;
  }

  function gpuBegin(stage) {
    if (!gpuSampleThisFrame || !gpuExt || gpuActive || gpuPending.length >= MAX_GPU_PENDING ||
        !Object.hasOwn(gpuTimes, stage)) return;
    let query = null;
    try {
      query = gpuGl.createQuery();
      if (!query) return;
      gpuGl.beginQuery(gpuExt.TIME_ELAPSED_EXT, query);
      gpuActive = { stage, query };
    } catch {
      if (query) { try { gpuGl.deleteQuery(query); } catch {} }
      gpuReason = 'query-error';
      gpuSampleThisFrame = false;
    }
  }

  function gpuEnd(stage) {
    if (!gpuActive || gpuActive.stage !== stage) return;
    const active = gpuActive;
    gpuActive = null;
    try {
      gpuGl.endQuery(gpuExt.TIME_ELAPSED_EXT);
      gpuPending.push(active);
    } catch {
      try { gpuGl.deleteQuery(active.query); } catch {}
      gpuReason = 'query-error';
      gpuSampleThisFrame = false;
    }
  }

  function gpuPoll() {
    if (!gpuExt || !gpuPending.length) return;
    try {
      if (gpuGl.getParameter(gpuExt.GPU_DISJOINT_EXT)) {
        gpuDisjointEvents++;
        for (const pending of gpuPending.splice(0)) gpuGl.deleteQuery(pending.query);
        return;
      }
      for (let i = 0; i < gpuPending.length;) {
        const pending = gpuPending[i];
        if (!gpuGl.getQueryParameter(pending.query, gpuGl.QUERY_RESULT_AVAILABLE)) { i++; continue; }
        const nanoseconds = gpuGl.getQueryParameter(pending.query, gpuGl.QUERY_RESULT);
        gpuGl.deleteQuery(pending.query);
        gpuPending.splice(i, 1);
        if (Number.isFinite(nanoseconds) && nanoseconds >= 0) {
          rememberDuration(gpuTimes[pending.stage], nanoseconds / 1e6);
        }
      }
    } catch {
      gpuReason = 'result-error';
      for (const pending of gpuPending.splice(0)) {
        try { gpuGl.deleteQuery(pending.query); } catch {}
      }
      gpuExt = null;
    }
  }

  function getRelTime() {
    return Number(Math.max(0, now() - t0).toFixed(2));
  }

  function recordEvent(name, extra = {}) {
    if (!enabled) return;
    const entry = { name: String(name), t: getRelTime() };
    const sanitized = sanitizeExtra(extra);
    if (sanitized && Object.keys(sanitized).length > 0) {
      entry.extra = sanitized;
    }
    if (events.length >= MAX_EVENTS) {
      events.shift();
    }
    events.push(entry);
  }

  if (enabled && typeof PerformanceObserverClass === 'function') {
    try {
      observer = new PerformanceObserverClass((list) => {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i++) {
          const d = entries[i].duration || 0;
          longTaskCount++;
          longTaskTotalMs += d;
          if (d > longTaskMaxMs) longTaskMaxMs = d;
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch (e) {}
  }

  function mark(name, extra = {}) {
    if (!enabled) return;
    recordEvent(name, extra);
  }

  function begin(name, extra = {}) {
    if (!enabled) return () => 0;
    const startT = now();
    recordEvent(`${name}:start`, extra);
    return (endExtra = {}) => {
      const dur = Number(Math.max(0, now() - startT).toFixed(2));
      const combined = Object.assign({}, endExtra, { durationMs: dur });
      recordEvent(`${name}:end`, combined);
      return dur;
    };
  }

  function frame({ rendered = false, moving = false, hidden = false, splatUpdateMs = 0,
    renderCpuMs = 0, labelCpuMs = 0 } = {}) {
    if (!enabled) return;
    const t = now();
    if (hidden) {
      hiddenFrames++;
      isHidden = true;
      lastFrameTime = null;
    } else {
      isHidden = false;
      if (lastFrameTime !== null) {
        const delta = Math.max(0, t - lastFrameTime);
        if (intervals.length >= MAX_INTERVALS) intervals.shift();
        intervals.push(delta);
      }
      lastFrameTime = t;
    }
    if (rendered) {
      renderedFrames++;
      if (!hidden) {
        if (renderTimes.length >= MAX_INTERVALS) renderTimes.shift();
        renderTimes.push(t);
        if (moving) {
          if (movingRenderTimes.length >= MAX_INTERVALS) movingRenderTimes.shift();
          movingRenderTimes.push(t);
        }
      }
    }
    if (moving) movingFrames++;
    if (rendered && moving) {
      rememberDuration(renderCpuTimes, renderCpuMs);
      rememberDuration(labelCpuTimes, labelCpuMs);
    }
    if (splatUpdateMs > 0) {
      splatCount++;
      splatTotalMs += splatUpdateMs;
      if (splatUpdateMs > splatMaxMs) splatMaxMs = splatUpdateMs;
    }
  }

  async function sampleMemory(label = '') {
    if (!enabled) return null;
    let bytes = null, source = null;
    try {
      if (performanceRef && typeof performanceRef.measureUserAgentSpecificMemory === 'function') {
        const result = await performanceRef.measureUserAgentSpecificMemory();
        if (result && Number.isFinite(result.bytes)) { bytes = result.bytes; source = 'uas-memory'; }
      } else if (performanceRef?.memory && Number.isFinite(performanceRef.memory.usedJSHeapSize)) {
        bytes = performanceRef.memory.usedJSHeapSize; source = 'js-heap';
      }
    } catch {}
    if (!Number.isFinite(bytes)) return null;
    const entry = { t: getRelTime(), bytes: Math.max(0, Math.round(bytes)), source, label: String(label || '') };
    if (memorySamples.length >= 20) memorySamples.shift();
    memorySamples.push(entry);
    recordEvent('memory', { bytes: entry.bytes, source, label: entry.label });
    return { ...entry };
  }

  function resolutionSwitch(pixelRatio) {
    if (!enabled) return;
    resolutionSwitches++;
    currentPixelRatio = Number(pixelRatio) || currentPixelRatio;
    recordEvent('resolutionSwitch', { pixelRatio: currentPixelRatio });
  }

  function asset({ path = '', bytes = null, phase = '', status = '' } = {}) {
    if (!enabled) return;
    const cleanName = sanitizePath(path);
    selectedAsset = cleanName;
    assetBytes = typeof bytes === 'number' ? bytes : null;
    recordEvent('asset', {
      path: cleanName,
      bytes: assetBytes,
      phase: phase ? String(phase) : undefined,
      status: status ? String(status) : undefined
    });
  }

  function visibility(hidden) {
    if (!enabled) return;
    visibilityChanges++;
    isHidden = Boolean(hidden);
    if (isHidden) lastFrameTime = null;
    recordEvent('visibility', { hidden: isHidden });
  }

  function snapshot() {
    const elapsed = getRelTime();
    const sorted = intervals.slice().sort((a, b) => a - b);
    const samples = intervals.length;
    const p50 = calcPercentile(sorted, 50);
    const p95 = calcPercentile(sorted, 95);
    const p99 = calcPercentile(sorted, 99);
    const maxMs = sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : 0;
    const fpsFromTimes = times => times.length >= 2 && times[times.length - 1] > times[0]
      ? Number((((times.length - 1) * 1000) / (times[times.length - 1] - times[0])).toFixed(1)) : 0;
    const deltasFromTimes = times => times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
    const movingDeltas = deltasFromTimes(movingRenderTimes);
    const approxFps = fpsFromTimes(renderTimes);

    const nav = navigatorRef || {};
    const conn = nav.connection || {};
    const win = windowRef || {};
    const dpr = win.devicePixelRatio !== undefined ? win.devicePixelRatio : null;

    let rInfo = {
      pixelRatio: currentPixelRatio,
      width: 0,
      height: 0,
      drawCalls: 0,
      triangles: 0,
      textures: 0,
      geometries: 0
    };

    if (renderer) {
      try {
        if (typeof renderer.getPixelRatio === 'function') {
          rInfo.pixelRatio = renderer.getPixelRatio();
        }
        if (typeof renderer.getDrawingBufferSize === 'function') {
          try {
            const target = { width: 0, height: 0, x: 0, y: 0, set(x, y) { this.x = x; this.y = y; this.width = x; this.height = y; return this; } };
            const res = renderer.getDrawingBufferSize(target) || target;
            rInfo.width = res.width || res.x || 0;
            rInfo.height = res.height || res.y || 0;
          } catch {}
        }
        if ((!rInfo.width || !rInfo.height) && renderer.domElement) {
          rInfo.width = renderer.domElement.width || 0;
          rInfo.height = renderer.domElement.height || 0;
        }
        if (renderer.info) {
          const r = renderer.info.render;
          const m = renderer.info.memory;
          if (r) {
            rInfo.drawCalls = r.calls || 0;
            rInfo.triangles = r.triangles || 0;
          }
          if (m) {
            rInfo.textures = m.textures || 0;
            rInfo.geometries = m.geometries || 0;
          }
        }
      } catch (e) {}
    }

    const qCopy = JSON.parse(JSON.stringify(qualitySnapshot));

    return {
      version: 1,
      enabled,
      elapsedMs: elapsed,
      quality: qCopy,
      device: {
        deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
        hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
        devicePixelRatio: typeof dpr === 'number' ? dpr : null,
        effectiveType: typeof conn.effectiveType === 'string' ? conn.effectiveType : null,
        saveData: Boolean(conn.saveData),
        crossOriginIsolated: typeof win.crossOriginIsolated === 'boolean' ? win.crossOriginIsolated : false
      },
      frames: {
        samples,
        renderedFrames,
        movingFrames,
        hiddenFrames,
        p50Ms: p50,
        p95Ms: p95,
        p99Ms: p99,
        maxMs,
        approxRenderedFps: approxFps,
        movingRenderedFps: fpsFromTimes(movingRenderTimes),
        movingP50Ms: calcPercentile(movingDeltas, 50),
        movingP95Ms: calcPercentile(movingDeltas, 95)
      },
      splatUpdate: {
        count: splatCount,
        totalMs: Number(splatTotalMs.toFixed(2)),
        maxMs: Number(splatMaxMs.toFixed(2)),
        avgMs: splatCount ? Number((splatTotalMs / splatCount).toFixed(2)) : 0
      },
      cpu: {
        render: summarizeDurations(renderCpuTimes),
        labels: summarizeDurations(labelCpuTimes),
      },
      gpu: {
        requested: gpuRequested,
        supported: gpuExt !== null,
        reason: gpuReason,
        sampleStride: GPU_SAMPLE_STRIDE,
        pending: gpuPending.length,
        disjointEvents: gpuDisjointEvents,
        splatUpdate: summarizeDurations(gpuTimes.splatUpdate),
        render: summarizeDurations(gpuTimes.render),
      },
      resolutionSwitches,
      longTasks: {
        count: longTaskCount,
        totalMs: Number(longTaskTotalMs.toFixed(2)),
        maxMs: Number(longTaskMaxMs.toFixed(2))
      },
      memory: {
        samples: memorySamples.length,
        lastBytes: memorySamples.length ? memorySamples[memorySamples.length - 1].bytes : null,
        maxBytes: memorySamples.length ? Math.max(...memorySamples.map(x => x.bytes)) : null,
        source: memorySamples.length ? memorySamples[memorySamples.length - 1].source : null
      },
      renderer: rInfo,
      asset: {
        selected: selectedAsset,
        bytes: assetBytes
      },
      events: events.map(e => ({
        name: e.name,
        t: e.t,
        ...(e.extra ? { extra: JSON.parse(JSON.stringify(e.extra)) } : {})
      }))
    };
  }

  function refreshHud() {
    if (!enabled || !hudElement) return;
    const nowMs = now();
    if (nowMs - lastHudUpdate < 500) return;
    lastHudUpdate = nowMs;
    const s = snapshot();
    const tier = s.quality.tier || s.quality.preset || 'default';
    const dpr = s.renderer.pixelRatio || 1;
    const p50 = s.frames.p50Ms;
    const p95 = s.frames.p95Ms;
    const fps = s.frames.movingRenderedFps || s.frames.approxRenderedFps;
    const lt = s.longTasks.totalMs;
    const assetName = s.asset.selected || 'none';
    const splatAvg = s.splatUpdate.avgMs;
    const gpuRender = s.gpu.render.samples ? `${s.gpu.render.p50Ms}ms` : (s.gpu.requested ? s.gpu.reason : 'off');
    const memoryMb = s.memory.lastBytes == null ? 'n/a' : (s.memory.lastBytes / 1048576).toFixed(1) + 'MB';

    const text = `[Perf Probe]\nTier: ${tier} | DPR: ${dpr}\nMoveFPS: ${fps} | p50: ${s.frames.movingP50Ms || p50}ms | p95: ${s.frames.movingP95Ms || p95}ms\nLongTask: ${lt}ms | SplatAvg: ${splatAvg}ms\nGPU render p50: ${gpuRender} | CPU render p50: ${s.cpu.render.p50Ms}ms\nMemory: ${memoryMb} | Asset: ${assetName}`;
    const pre = hudElement.querySelector('pre');
    if (pre) pre.textContent = text;
  }

  function installHud({ parent = null } = {}) {
    if (!enabled) return null;
    const doc = documentRef;
    if (!doc || typeof doc.createElement !== 'function') return null;
    const container = parent || (doc.body ? doc.body : null);
    if (!container || typeof container.appendChild !== 'function') return null;

    const panel = doc.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:10px;left:10px;background:rgba(0,0,0,0.85);color:#0f0;font-family:monospace;font-size:11px;padding:8px;border-radius:4px;z-index:999999;max-width:320px;pointer-events:auto;';

    const pre = doc.createElement('pre');
    pre.style.cssText = 'margin:0 0 6px 0;white-space:pre-wrap;';
    pre.textContent = '[Perf Probe] Initializing...';
    panel.appendChild(pre);

    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Copy JSON';
    btn.style.cssText = 'background:#222;color:#fff;border:1px solid #444;font-size:10px;cursor:pointer;padding:2px 6px;';
    btn.onclick = () => {
      const data = JSON.stringify(snapshot(), null, 2);
      if (navigatorRef && navigatorRef.clipboard && typeof navigatorRef.clipboard.writeText === 'function') {
        navigatorRef.clipboard.writeText(data).catch(() => {});
      }
    };
    panel.appendChild(btn);

    container.appendChild(panel);
    hudElement = panel;
    lastHudUpdate = 0;
    refreshHud();
    return panel;
  }

  function dispose() {
    if (gpuActive) {
      try { gpuGl.endQuery(gpuExt.TIME_ELAPSED_EXT); } catch {}
      try { gpuGl.deleteQuery(gpuActive.query); } catch {}
      gpuActive = null;
    }
    for (const pending of gpuPending.splice(0)) {
      try { gpuGl.deleteQuery(pending.query); } catch {}
    }
    if (observer && typeof observer.disconnect === 'function') {
      observer.disconnect();
      observer = null;
    }
    if (hudElement && hudElement.parentNode && typeof hudElement.parentNode.removeChild === 'function') {
      hudElement.parentNode.removeChild(hudElement);
      hudElement = null;
    }
  }

  return {
    enabled,
    mark,
    begin,
    frame,
    gpuFrameStart,
    gpuBegin,
    gpuEnd,
    gpuPoll,
    resolutionSwitch,
    sampleMemory,
    asset,
    visibility,
    snapshot,
    installHud,
    refreshHud,
    dispose
  };
}
