import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const base = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, base), 'utf8');
const viewer = read('viewer3d.js');
const config = JSON.parse(read('sites/landcros/data/config.json'));
const lite = new URL('sites/landcros/assets/site-lite.splat', base);
const full = new URL('sites/landcros/assets/site.splat', base);

function splatBounds(fileUrl) {
  const bytes = readFileSync(fileUrl);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < bytes.length; i += 32) {
    for (let axis = 0; axis < 3; axis++) {
      const value = bytes.readFloatLE(i + axis * 4);
      assert.ok(Number.isFinite(value));
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

test('LANDCROS staff editor prioritises the verified static-viewer lite model with full fallback', () => {
  assert.deepEqual(config.assets.splat.slice(0, 2),
    ['./assets/site-lite.splat', './assets/site.splat']);
  const liteBytes = statSync(lite).size;
  const fullBytes = statSync(full).size;
  assert.equal(liteBytes % 32, 0);
  assert.equal(fullBytes % 32, 0);
  assert.ok(liteBytes < fullBytes);
  assert.ok(liteBytes / fullBytes >= 0.75 && liteBytes / fullBytes <= 0.85,
    'lite model retains roughly 80% of the original splats');
  const liteBounds = splatBounds(lite);
  const fullBounds = splatBounds(full);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(liteBounds.min[axis] - fullBounds.min[axis]) < 0.01);
    assert.ok(Math.abs(liteBounds.max[axis] - fullBounds.max[axis]) < 0.01);
  }
});

test('LANDCROS satellite background reuses the static viewer compressed WebP', () => {
  assert.equal(config.assets.satellite, './assets/satellite.webp');
  const image = new URL('sites/landcros/assets/satellite.webp', base);
  const png = new URL('sites/landcros/assets/satellite.png', base);
  const webpBytes = readFileSync(image);
  assert.equal(webpBytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(webpBytes.toString('ascii', 8, 12), 'WEBP');
  assert.ok(webpBytes.length < statSync(png).size / 5,
    'compressed texture should transfer substantially less data');
});

test('raster quality matches the static viewer: tier-aware, 1x drag and 45-frame idle restore', () => {
  assert.match(viewer, /Math\.min\(px, 1\.5\)/);
  assert.match(viewer, /Math\.min\(px, 1\.2\)/);
  assert.match(viewer, /_RESTORE_AFTER_IDLE_FRAMES = 45/);
  assert.match(viewer, /_MIN_SWITCH_INTERVAL_MS = 400/);
  assert.match(viewer, /sharedMemoryForWorkers: sharedMemOk/);
  assert.match(viewer, /gpuAcceleratedSort: gpuSortOk/);
});

test('moving resolution changes preserve idle restoration cooldown and immediate drag response', () => {
  const from = viewer.indexOf('const _DRAG_PIXEL_RATIO = ');
  const to = viewer.indexOf('// Match the static viewer', from);
  assert.ok(from > 0 && to > from);
  let tick = 0;
  let dpr = 1.5;
  let resizes = 0;
  const switches = [];
  const sandbox = {
    _Q: { pixelRatio: 1.5 },
    _perfDragDpr: null,
    performance: { now: () => tick },
    renderer: {
      setPixelRatio: x => { dpr = x; },
      getPixelRatio: () => dpr,
    },
    resize: () => { resizes++; },
    _perf: { resolutionSwitch: x => switches.push(x) },
  };
  runInNewContext(viewer.slice(from, to) + '\nthis.toggle = _setLowRes;', sandbox);
  sandbox.toggle(true);
  assert.equal(dpr, 1);
  tick = 100;
  sandbox.toggle(false);
  assert.equal(dpr, 1);
  tick = 500;
  sandbox.toggle(false);
  assert.equal(dpr, 1.5);
  tick = 501;
  sandbox.toggle(true);
  assert.equal(dpr, 1);
  assert.equal(resizes, 3);
  assert.deepEqual(switches, [1, 1.5, 1]);
});

test('background editor stops scheduling animation frames, then resumes once visible', () => {
  const from = viewer.indexOf('let _pageHidden = document.hidden');
  const to = viewer.indexOf('function animate()', from);
  assert.ok(from > 0 && to > from);
  const events = {};
  const scheduled = [];
  const cancelled = [];
  let seq = 0;
  const sandbox = {
    document: {
      hidden: false,
      addEventListener: (name, fn) => { events[name] = fn; },
    },
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    requestAnimationFrame: fn => { scheduled.push(fn); return ++seq; },
    cancelAnimationFrame: id => cancelled.push(id),
    _idleFrames: 15,
    _lastRenderMs: 100,
    _perf: { visibility: () => {} },
  };
  runInNewContext(viewer.slice(from, to) +
    '\nfunction animate() {}\nthis.queue = _queueViewerFrame; this.visibility = _setViewerPageVisibility;',
    sandbox);
  sandbox.queue();
  sandbox.queue();
  assert.equal(scheduled.length, 1, 'only one animation frame should be queued');
  sandbox.document.hidden = true;
  events.visibilitychange();
  assert.deepEqual(cancelled, [1]);
  sandbox.queue();
  assert.equal(scheduled.length, 1, 'hidden pages cannot queue new frames');
  sandbox.document.hidden = false;
  events.visibilitychange();
  assert.equal(scheduled.length, 2);
  assert.equal(sandbox._idleFrames, 0);
  assert.equal(sandbox._lastRenderMs, 0);
});

test('shared opt-in performance metrics do not impose a probe on normal visitors', () => {
  assert.match(viewer, /_perfParams\.get\('perf'\) === '1'/);
  assert.match(viewer, /import\('\.\/viewer-perf\.js'\)/);
  assert.match(viewer, /window\.__sitenavPerf = Object\.freeze/);
  assert.match(viewer, /_perf\.frame\(\{ rendered: true/);
  assert.match(viewer, /_perf\.asset\(\{ path: splatPath/);
});
