import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'viewer3d.js'), 'utf8');

test('tour lifecycle has one guarded cleanup path', () => {
  assert.match(source, /let _activeTour = null;/);
  assert.match(source, /function _cancelActiveTour\(expectedTour = null\)/);
  assert.match(source, /if \(expectedTour && tour !== expectedTour\) return false;/);
  assert.match(source, /clearTimeout\(tour\.hudTimeout\)/);
  assert.match(source, /controls\.removeEventListener\('start', tour\.interrupt\)/);
  assert.match(source, /tour\.timeline\.kill\(\)/);
  assert.match(source, /controls\.enabled = true;/);
  assert.match(source, /_camAnimating = false;/);
  assert.match(source, /_resetTourHud\(\);/);
});

test('pin replacement and list return cancel an active tour first', () => {
  assert.match(source,
    /async function selectPoint\(pt, options = \{\}\) \{\n  _cancelActiveTour\(\);/);
  assert.match(source,
    /window\.showPointList = function\(options = \{\}\) \{\n  _cancelActiveTour\(\);/);
});

test('startNav replaces prior owners and protects newer tours from stale callbacks', () => {
  const start = source.indexOf('window.startNav = function(pt) {');
  const end = source.indexOf('// ── Point list panel', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const nav = source.slice(start, end);

  assert.match(nav, /window\.startNav = function\(pt\) \{\n[\s\S]{0,180}_cancelActiveTour\(\);\n  stopAutoOrbit\(\);/);
  assert.match(nav,
    /const tour = \{ timeline: null, interrupt: null, hudTimeout: null \};\n  _activeTour = tour;/);
  assert.match(nav,
    /tour\.hudTimeout = setTimeout\(\(\) => \{\n      if \(_activeTour === tour\) _cancelActiveTour\(tour\);/);
  assert.match(nav, /const interruptTour = \(\) => _cancelActiveTour\(tour\);/);
  assert.match(nav,
    /if \(_activeTour === tour\) tour\.timeline = null;\n      _cancelActiveTour\(tour\);/);
  assert.match(nav, /tour\.timeline = tl;/);
});

test('tour cleanup resets progress chrome instead of leaving stale state', () => {
  assert.match(source, /navProgress\.classList\.remove\('visible'\)/);
  assert.match(source, /navBar\.style\.width = '0%';/);
  assert.match(source, /navLabel\.textContent = '—';/);
});

test('stale no-waypoint timer cannot tear down a newer guided tour', () => {
  const start = source.indexOf('let _activeTour = null;');
  const end = source.indexOf('// ── Point list panel', start);
  const lifecycle = source.slice(start, end);
  const nodes = new Map();
  const node = id => nodes.get(id) || nodes.set(id, {
    style: {}, textContent: '',
    classList: { values: new Set(), add(v) { this.values.add(v); }, remove(v) { this.values.delete(v); }, contains(v) { return this.values.has(v); } },
  }).get(id);
  const listeners = new Set();
  const controls = {
    enabled: true,
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  };
  const timers = [];
  const timelines = [];
  const make = new Function(
    'document', 'controls', 'gsap', 'window', 'THREE', 'setTimeout', 'clearTimeout', 'stopAutoOrbit',
    `let _camTween = null; let _camAnimating = false;
     const camera = { position: { clone() { return {}; } } };
     ${lifecycle}
     return { startNav: window.startNav, active: () => _activeTour, animating: () => _camAnimating };`,
  );
  const api = make(
    { getElementById: node }, controls,
    { timeline(options) { const tl = { options, killed: false, kill() { this.killed = true; }, to() { return this; } }; timelines.push(tl); return tl; } },
    {}, { Vector3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } } },
    fn => { const id = timers.length; timers.push({ fn, cleared: false }); return id; },
    id => { if (timers[id]) timers[id].cleared = true; },
    () => {},
  );

  api.startNav({ label: 'No route', routeWaypoints3d: [] });
  assert.ok(api.active());
  assert.equal(listeners.size, 1);
  [...listeners][0]();
  assert.equal(api.active(), null);
  assert.equal(listeners.size, 0);
  assert.equal(node('nav-progress').classList.contains('visible'), false);

  api.startNav({ label: 'No route again', routeWaypoints3d: [] });
  const staleTimer = timers.at(-1);
  assert.ok(api.active());
  api.startNav({ label: 'Guided', routeWaypoints3d: [{ x: 1, y: 0, z: 1 }] });
  const firstGuidedTour = api.active();
  const firstTimeline = timelines.at(-1);
  assert.equal(staleTimer.cleared, true);
  assert.equal(node('nav-progress').classList.contains('visible'), true);

  staleTimer.fn();
  assert.equal(api.active(), firstGuidedTour);
  assert.equal(api.animating(), true);

  api.startNav({ label: 'Guided restart', routeWaypoints3d: [{ x: 2, y: 0, z: 2 }] });
  const newerTour = api.active();
  const newerTimeline = timelines.at(-1);
  assert.notEqual(newerTour, firstGuidedTour);
  assert.equal(firstTimeline.killed, true);
  firstTimeline.options.onComplete();
  assert.equal(api.active(), newerTour);
  assert.equal(node('nav-progress').classList.contains('visible'), true);
  assert.equal(api.animating(), true);

  newerTimeline.options.onComplete();
  assert.equal(api.active(), null);
  assert.equal(api.animating(), false);
  assert.equal(listeners.size, 0);
  assert.equal(node('nav-progress').classList.contains('visible'), false);
  assert.equal(node('nav-bar-fill').style.width, '0%');
  assert.equal(node('nav-pos-label').textContent, '—');
});
