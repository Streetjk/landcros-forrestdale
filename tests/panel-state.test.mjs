import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function createMockDom() {
  function createClassList() {
    const classes = new Set();
    return {
      add(...names) { names.forEach((n) => classes.add(n)); },
      remove(...names) { names.forEach((n) => classes.delete(n)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        if (force === true) {
          classes.add(name);
          return true;
        } else if (force === false) {
          classes.delete(name);
          return false;
        }
        if (classes.has(name)) {
          classes.delete(name);
          return false;
        } else {
          classes.add(name);
          return true;
        }
      },
      get length() { return classes.size; },
      values() { return Array.from(classes); }
    };
  }

  function createElement(id) {
    return {
      id,
      classList: createClassList()
    };
  }

  const elements = new Map();
  const listeners = {};

  const doc = {
    getElementById(id) {
      return elements.get(id) || null;
    }
  };

  const win = {
    innerWidth: 1024,
    document: doc,
    addEventListener(evt, fn) {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(fn);
    },
    removeEventListener(evt, fn) {
      if (!listeners[evt]) return;
      listeners[evt] = listeners[evt].filter((cb) => cb !== fn);
    },
    _listeners: listeners,
    _setElement(id, el) {
      elements.set(id, el);
    }
  };

  return { win, doc, createElement };
}

function loadFreshAdapter(win) {
  global.window = win;
  global.document = win.document;
  const resolved = require.resolve('../panel-state.js');
  delete require.cache[resolved];
  return require('../panel-state.js');
}

test('init validation, idempotence, and conflict checks', () => {
  const { win } = createMockDom();
  const adapter = loadFreshAdapter(win);

  assert.throws(() => adapter.init({ mode: 'invalid' }), /mode must be 'sheet' or 'fold'/);
  assert.throws(() => adapter.init(), /mode must be 'sheet' or 'fold'/);

  assert.doesNotThrow(() => adapter.init({ mode: 'sheet' }));
  assert.doesNotThrow(() => adapter.init({ mode: 'sheet' }));
  assert.throws(() => adapter.init({ mode: 'fold' }), /conflicting re-init/);
});

test('attaches only one resize listener even across multiple init calls', () => {
  const { win } = createMockDom();
  const adapter = loadFreshAdapter(win);

  adapter.init({ mode: 'sheet' });
  adapter.init({ mode: 'sheet' });
  assert.equal(win._listeners['resize']?.length, 1);
});

test('snapshot fields match exact expected keys and truthiness', () => {
  const { win, createElement } = createMockDom();
  const app = createElement('app');
  const panel = createElement('side-panel');
  win._setElement('app', app);
  win._setElement('side-panel', panel);

  const adapter = loadFreshAdapter(win);
  adapter.init({ mode: 'sheet' });

  const snap = adapter.snapshot();
  const expectedKeys = ['mode', 'compact', 'desktopOpen', 'detailOpen', 'expanded', 'folded', 'appMirrorOpen'];
  assert.deepEqual(Object.keys(snap).sort(), expectedKeys.sort());
  assert.equal(snap.mode, 'sheet');
  assert.equal(snap.compact, true);
  assert.equal(snap.desktopOpen, false);
  assert.equal(snap.detailOpen, false);
  assert.equal(snap.expanded, false);
  assert.equal(snap.folded, true);
  assert.equal(snap.appMirrorOpen, false);
});

test('sheet mode: toggle, openDetail full/non-downgrade, collapse, and expand', () => {
  const { win, createElement } = createMockDom();
  const app = createElement('app');
  const panel = createElement('side-panel');
  win._setElement('app', app);
  win._setElement('side-panel', panel);

  const adapter = loadFreshAdapter(win);
  adapter.init({ mode: 'sheet' });

  adapter.toggle();
  assert.equal(panel.classList.contains('sheet-mid'), true);
  assert.equal(app.classList.contains('sheet-open'), true);
  assert.equal(adapter.snapshot().detailOpen, true);

  adapter.toggle();
  assert.equal(panel.classList.contains('sheet-mid'), false);
  assert.equal(app.classList.contains('sheet-open'), false);
  assert.equal(adapter.snapshot().folded, true);

  adapter.openDetail();
  assert.equal(panel.classList.contains('sheet-mid'), true);
  assert.equal(panel.classList.contains('sheet-full'), false);

  adapter.openDetail({ full: true });
  assert.equal(panel.classList.contains('sheet-full'), true);
  assert.equal(panel.classList.contains('sheet-mid'), false);
  assert.equal(adapter.snapshot().expanded, true);

  adapter.openDetail({ full: false });
  assert.equal(panel.classList.contains('sheet-full'), true);
  assert.equal(panel.classList.contains('sheet-mid'), false);

  adapter.collapseList();
  assert.equal(panel.classList.contains('sheet-full'), false);
  assert.equal(panel.classList.contains('sheet-mid'), false);
  assert.equal(app.classList.contains('sheet-open'), false);

  adapter.expandFull();
  assert.equal(panel.classList.contains('sheet-full'), true);
  assert.equal(panel.classList.contains('sheet-mid'), false);
  assert.equal(app.classList.contains('sheet-open'), true);
});

test('fold mode: toggle, openDetail, collapse preserves state', () => {
  const { win, createElement } = createMockDom();
  const app = createElement('app');
  const panel = createElement('side-panel');
  panel.classList.add('panel-folded');
  win._setElement('app', app);
  win._setElement('side-panel', panel);

  const adapter = loadFreshAdapter(win);
  adapter.init({ mode: 'fold' });

  assert.equal(app.classList.contains('panel-is-folded'), true);
  assert.equal(adapter.snapshot().folded, true);

  adapter.toggle();
  assert.equal(panel.classList.contains('panel-folded'), false);
  assert.equal(app.classList.contains('panel-is-folded'), false);
  assert.equal(adapter.snapshot().folded, false);
  assert.equal(adapter.snapshot().detailOpen, true);

  adapter.collapseList();
  assert.equal(panel.classList.contains('panel-folded'), false);
  assert.equal(app.classList.contains('panel-is-folded'), false);

  panel.classList.add('panel-folded');
  adapter.sync();
  assert.equal(app.classList.contains('panel-is-folded'), true);
  adapter.openDetail();
  assert.equal(panel.classList.contains('panel-folded'), false);
  assert.equal(app.classList.contains('panel-is-folded'), false);
});

test('desktop toggles only panel-open; sync clears mobile mirrors on desktop', () => {
  const { win, createElement } = createMockDom();
  const app = createElement('app');
  const panel = createElement('side-panel');
  win.innerWidth = 1200;
  panel.classList.add('sheet-mid');
  app.classList.add('sheet-open');
  win._setElement('app', app);
  win._setElement('side-panel', panel);

  const adapter = loadFreshAdapter(win);
  adapter.init({ mode: 'sheet' });

  assert.equal(app.classList.contains('sheet-open'), false);
  assert.equal(panel.classList.contains('sheet-mid'), true);

  adapter.toggle();
  assert.equal(app.classList.contains('panel-open'), true);
  assert.equal(adapter.snapshot().desktopOpen, true);

  adapter.toggleDesktop();
  assert.equal(app.classList.contains('panel-open'), false);

  adapter.openDetail();
  assert.equal(app.classList.contains('panel-open'), false);

  adapter.expandFull();
  assert.equal(panel.classList.contains('sheet-mid'), true);
});

test('breakpoint crossing clear semantics match legacy behaviors', () => {
  const { win, createElement } = createMockDom();
  const app = createElement('app');
  const panel = createElement('side-panel');
  win.innerWidth = 1200;
  app.classList.add('panel-open');
  win._setElement('app', app);
  win._setElement('side-panel', panel);

  const adapter = loadFreshAdapter(win);
  adapter.init({ mode: 'sheet' });
  assert.equal(app.classList.contains('panel-open'), true);

  win.innerWidth = 800;
  adapter.handleBreakpointChange();
  assert.equal(app.classList.contains('panel-open'), false);

  panel.classList.add('sheet-full');
  adapter.sync();
  assert.equal(app.classList.contains('sheet-open'), true);

  win.innerWidth = 1280;
  adapter.handleBreakpointChange();
  assert.equal(panel.classList.contains('sheet-full'), false);
  assert.equal(app.classList.contains('sheet-open'), false);
});

test('missing DOM nodes are handled safely with false snapshot defaults', () => {
  const { win } = createMockDom();
  const adapter = loadFreshAdapter(win);
  adapter.init({ mode: 'sheet' });

  assert.doesNotThrow(() => adapter.toggle());
  assert.doesNotThrow(() => adapter.toggleDesktop());
  assert.doesNotThrow(() => adapter.openDetail());
  assert.doesNotThrow(() => adapter.collapseList());
  assert.doesNotThrow(() => adapter.expandFull());
  assert.doesNotThrow(() => adapter.sync());
  assert.doesNotThrow(() => adapter.handleBreakpointChange());

  const snap = adapter.snapshot();
  assert.equal(snap.desktopOpen, false);
  assert.equal(snap.detailOpen, false);
  assert.equal(snap.appMirrorOpen, false);
});
