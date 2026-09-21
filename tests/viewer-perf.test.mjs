import assert from 'node:assert/strict';
import test from 'node:test';
import { createPerfProbe } from '../viewer-perf.js';

function createForbiddenProxy(name) {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'then' || prop === 'prototype') return undefined;
      throw new Error(`Forbidden access to ${name}.${String(prop)}`);
    }
  });
}

test('disabled probe is safe no-op with valid snapshot', () => {
  let nowTime = 1000;
  const probe = createPerfProbe({
    enabled: false,
    now: () => nowTime,
    documentRef: null,
    windowRef: null,
    navigatorRef: null
  });

  assert.equal(probe.enabled, false);
  probe.mark('test', { foo: 'bar' });
  const end = probe.begin('step');
  nowTime += 50;
  const dur = end();
  assert.equal(dur, 0);
  probe.frame({ rendered: true, splatUpdateMs: 10 });
  probe.resolutionSwitch(2);
  probe.asset({ path: 'scene.splat?token=abc#frag', bytes: 12345 });
  probe.visibility(true);
  assert.equal(probe.installHud(), null);

  const snap = probe.snapshot();
  assert.equal(snap.version, 1);
  assert.equal(snap.enabled, false);
  assert.equal(snap.events.length, 0);
  assert.equal(snap.frames.renderedFrames, 0);
  assert.equal(snap.frames.samples, 0);
  assert.equal(snap.splatUpdate.count, 0);
  assert.equal(snap.resolutionSwitches, 0);
  assert.equal(snap.asset.selected, null);
  probe.dispose();
});

test('enabled probe tracks marks, begin/end durations and sanitizes extra', () => {
  let currentTime = 100;
  const probe = createPerfProbe({
    enabled: true,
    quality: { tier: 'high', options: { lod: 2 } },
    now: () => currentTime
  });

  probe.mark('init', { ok: true, nested: { arr: [1, 2, () => {}] }, fn: () => {} });
  currentTime = 142.5;
  const finish = probe.begin('renderPass', { pass: 1 });
  currentTime = 167.5;
  const measured = finish({ drawCalls: 10 });

  assert.equal(measured, 25);
  const snap = probe.snapshot();
  assert.equal(snap.events.length, 3);
  assert.equal(snap.events[0].name, 'init');
  assert.equal(snap.events[0].t, 0);
  assert.deepEqual(snap.events[0].extra, { ok: true, nested: { arr: [1, 2, null] } });
  assert.equal(snap.events[1].name, 'renderPass:start');
  assert.equal(snap.events[2].name, 'renderPass:end');
  assert.equal(snap.events[2].extra.durationMs, 25);
  assert.equal(snap.events[2].extra.drawCalls, 10);
});

test('ring buffer caps at 240, calculates percentiles and excludes hidden frames', () => {
  let t = 0;
  const probe = createPerfProbe({
    enabled: true,
    now: () => t
  });

  t = 10;
  probe.frame({ rendered: true });
  for (let i = 1; i <= 300; i++) {
    t += 10 + (i % 5);
    probe.frame({ rendered: true, moving: true });
  }
  assert.equal(probe.snapshot().frames.samples, 240);

  t += 16.6;
  probe.frame({ hidden: true });
  t += 5000;
  probe.frame({ rendered: true });

  const snap = probe.snapshot();
  assert.equal(snap.frames.hiddenFrames, 1);
  assert.ok(snap.frames.p50Ms > 0);
  assert.ok(snap.frames.p95Ms >= snap.frames.p50Ms);
  assert.ok(snap.frames.p99Ms >= snap.frames.p95Ms);
  assert.ok(snap.frames.maxMs >= snap.frames.p99Ms);
});

test('asset strips query/hash and sanitizes path', () => {
  const probe = createPerfProbe({ enabled: true, now: () => 10 });
  probe.asset({ path: 'https://example.com/models/test-scene.splat?key=secret#123', bytes: 9999 });
  const snap = probe.snapshot();
  assert.equal(snap.asset.selected, 'test-scene.splat');
  assert.equal(snap.asset.bytes, 9999);
});

test('renderer best-effort extraction with fallbacks', () => {
  const mockRenderer = {
    getPixelRatio: () => 1.5,
    getDrawingBufferSize: (target) => Object.assign(target, { width: 1920, height: 1080 }),
    info: {
      render: { calls: 42, triangles: 1000 },
      memory: { textures: 4, geometries: 8 }
    }
  };
  const probe = createPerfProbe({ enabled: true, renderer: mockRenderer });
  probe.resolutionSwitch(1.5);
  const snap = probe.snapshot();
  assert.equal(snap.renderer.pixelRatio, 1.5);
  assert.equal(snap.renderer.width, 1920);
  assert.equal(snap.renderer.height, 1080);
  assert.equal(snap.renderer.drawCalls, 42);
  assert.equal(snap.renderer.triangles, 1000);
  assert.equal(snap.renderer.textures, 4);
  assert.equal(snap.renderer.geometries, 8);
  assert.equal(snap.resolutionSwitches, 1);
});

test('longtask PerformanceObserver captures durations and disconnects on dispose', () => {
  let observedTypes = null;
  let callback = null;
  let disconnected = false;
  class FakeObserver {
    constructor(cb) { callback = cb; }
    observe(opts) { observedTypes = opts.entryTypes; }
    disconnect() { disconnected = true; }
  }

  const probe = createPerfProbe({
    enabled: true,
    PerformanceObserverClass: FakeObserver
  });

  assert.deepEqual(observedTypes, ['longtask']);
  callback({ getEntries: () => [{ duration: 65 }, { duration: 110 }] });
  const snap = probe.snapshot();
  assert.equal(snap.longTasks.count, 2);
  assert.equal(snap.longTasks.totalMs, 175);
  assert.equal(snap.longTasks.maxMs, 110);

  probe.dispose();
  assert.equal(disconnected, true);
});

test('snapshot immutability and deep isolation of quality', () => {
  const quality = { tier: 'ultra', lod: 1 };
  const probe = createPerfProbe({ enabled: true, quality });
  const snap1 = probe.snapshot();
  quality.tier = 'low';
  snap1.quality.tier = 'modified';
  snap1.events.push({ name: 'injected' });
  const snap2 = probe.snapshot();
  assert.equal(snap2.quality.tier, 'ultra');
  assert.equal(snap2.events.length, 0);
});

test('HUD installation, DOM refresh throttling, clipboard copy and disposal', () => {
  let clipboardText = '';
  let currentTime = 1000;
  const domNodes = new Set();
  function createEl(tag) {
    const node = {
      tagName: tag.toUpperCase(),
      style: {},
      children: [],
      parentNode: null,
      textContent: '',
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        domNodes.add(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) this.children.splice(idx, 1);
        child.parentNode = null;
        domNodes.delete(child);
        return child;
      },
      querySelector(selector) {
        if (selector === 'pre') return this.children.find(c => c.tagName === 'PRE') || null;
        return null;
      }
    };
    domNodes.add(node);
    return node;
  }

  const mockDoc = {
    body: createEl('body'),
    createElement: (tag) => createEl(tag)
  };
  const mockNav = {
    clipboard: {
      writeText: async (t) => { clipboardText = t; }
    }
  };

  const probe = createPerfProbe({
    enabled: true,
    documentRef: mockDoc,
    navigatorRef: mockNav,
    now: () => currentTime
  });

  const panel = probe.installHud();
  assert.ok(panel);
  assert.equal(panel.parentNode, mockDoc.body);
  const pre = panel.querySelector('pre');
  assert.ok(pre.textContent.includes('[Perf Probe]'));

  currentTime += 600;
  probe.resolutionSwitch(2);
  probe.refreshHud();
  assert.ok(pre.textContent.includes('DPR: 2'));

  const copyBtn = panel.children.find(c => c.tagName === 'BUTTON');
  copyBtn.onclick();
  assert.ok(clipboardText.includes('"version": 1'));

  probe.dispose();
  assert.equal(panel.parentNode, null);
});

test('zero telemetry verification: no network or storage touched', () => {
  const forbiddenWindow = {
    fetch: createForbiddenProxy('fetch'),
    localStorage: createForbiddenProxy('localStorage'),
    sessionStorage: createForbiddenProxy('sessionStorage')
  };
  const forbiddenNav = {
    sendBeacon: createForbiddenProxy('sendBeacon')
  };
  const forbiddenDoc = {
    cookie: 'forbidden'
  };
  Object.defineProperty(forbiddenDoc, 'cookie', {
    get() { throw new Error('Forbidden access to document.cookie'); }
  });

  const probe = createPerfProbe({
    enabled: true,
    windowRef: forbiddenWindow,
    navigatorRef: forbiddenNav,
    documentRef: forbiddenDoc,
    PerformanceObserverClass: class { observe() {} disconnect() {} }
  });

  probe.mark('mark-test');
  probe.frame({ rendered: true });
  const snap = probe.snapshot();
  assert.equal(snap.enabled, true);
  probe.dispose();
});


test('memory sampling prefers user-agent memory and falls back to JS heap without throwing', async () => {
  const uas = createPerfProbe({ enabled: true, performanceRef: { measureUserAgentSpecificMemory: async () => ({ bytes: 12345678 }) } });
  const sample = await uas.sampleMemory('after-splat');
  assert.equal(sample.bytes, 12345678);
  assert.equal(uas.snapshot().memory.source, 'uas-memory');
  const heap = createPerfProbe({ enabled: true, performanceRef: { memory: { usedJSHeapSize: 7654321 } } });
  await heap.sampleMemory('boot');
  assert.equal(heap.snapshot().memory.lastBytes, 7654321);
  const blocked = createPerfProbe({ enabled: true, performanceRef: { measureUserAgentSpecificMemory: async () => { throw new Error('denied'); } } });
  assert.equal(await blocked.sampleMemory(), null);
  assert.equal(blocked.snapshot().memory.samples, 0);
});


test('rendered and moving-rendered FPS are based on recent render timestamps, not total load time', () => {
  let t=0; const probe=createPerfProbe({enabled:true,now:()=>t});
  for (let i=0;i<6;i++) { t += 20; probe.frame({rendered:true,moving:i>=1}); }
  const snap=probe.snapshot();
  assert.equal(snap.frames.approxRenderedFps,50);
  assert.equal(snap.frames.movingRenderedFps,50);
  assert.equal(snap.frames.movingP50Ms,20);
  assert.equal(snap.frames.movingP95Ms,20);
});
