import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../scene-editor.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../editor.html', import.meta.url), 'utf8');
const functions = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

// Small eventful DOM for the list's behavior; geometry is checked in Chromium.
function listHarness() {
  const document = { activeElement: null };
  class Element {
    constructor(tag) {
      Object.assign(this, { tagName: tag.toUpperCase(), children: [], dataset: {},
        attributes: {}, listeners: {}, className: '', scrollTop: 0 });
    }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren() { this.children = []; }
    contains(child) { return child === this || this.children.some(el => el.contains(child)); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return {top:0,bottom:40}; }
    set disabled(value) {
      this._disabled = value;
      if (value && document.activeElement === this) document.activeElement = document.body;
    }
    get disabled() { return this._disabled; }
    querySelectorAll(selector) {
      const selectors = selector.split(',').map(s => s.trim());
      const matches = el => selectors.some(s => s === '[data-focus-key]' ? el.dataset.focusKey :
        el.className.split(' ').includes(s.match(/^\.([\w-]+)/)?.[1]) &&
        (!s.includes('[aria-current=') || el.getAttribute('aria-current') === 'true'));
      return this.children.flatMap(el => [...(matches(el) ? [el] : []), ...el.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    dispatch(type, key) {
      const event = { target: this, key, pending: [], preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; } };
      for (let el = this; el; el = event.stopped ? null : el.parentElement) {
        for (const handler of el.listeners[type] || []) event.pending.push(handler(event));
      }
      return event;
    }
  }
  const ids = Object.fromEntries(['scenes-list', 'editor-scene-count', 'add-scene-btn', 'scene-search-input']
    .map(id => [id, new Element('div')]));
  document.body = new Element('body'); document.activeElement = document.body;
  document.createElement = tag => new Element(tag);
  document.getElementById = id => ids[id];
  const calls = [];
  const context = vm.createContext({ document, calls, SLUG: 'fixture', confirm: () => false,
    apiWrite: async (url, options) => { calls.push(['group', JSON.parse(options.body)]); return { groupId: 'g' }; },
    onRenameSceneGroup() {}, onDeleteSceneGroup() {},
    selectScene: id => calls.push(['select', id]),
    onDuplicateSceneClick: scene => calls.push(['copy', scene.id]),
    onDeleteSceneClick: id => calls.push(['delete', id]),
  });
  vm.runInContext(`let _scenes = [{id:'a',name:'A very long scene title'}, {id:'b',name:'Second scene'}];
    let _currentSceneId = 'a', _sceneActionsId = null, _sceneSearchQuery = '';
    let _sceneGroups = [{id:'g',name:'Facilities'}];
    let _sceneAssignments = new Map(), _foldedSceneGroups = new Set();\n` +
    functions('function addGroupHeading(', 'function showNewSceneGroupForm(') +
    functions('function setSceneSearch(', 'async function selectScene('), context);
  context.renderScenesList();
  return { context, document, calls, list: ids['scenes-list'] };
}

test('scene selection has native semantics, current state and keyboard focus survives a rebuild', () => {
  const h = listHarness();
  const [first, second] = h.list.querySelectorAll('.scene-select');
  assert.equal(first.tagName, 'BUTTON');
  assert.equal(first.getAttribute('aria-current'), 'true');
  first.focus();
  assert.equal(first.dispatch('keydown', 'ArrowDown').defaultPrevented, true);
  assert.equal(h.document.activeElement, second);
  assert.deepEqual(h.calls, [], 'arrow keys focus without switching the canvas');
  second.dispatch('click');
  assert.deepEqual(h.calls, [['select', 'b']]);
  h.list.scrollTop = 75;
  h.context.renderScenesList();
  assert.equal(h.document.activeElement.dataset.focusKey, 'scene:b:select');
  assert.equal(h.list.scrollTop, 75);
  h.document.activeElement.dispatch('keydown', 'Home');
  assert.equal(h.document.activeElement.dataset.focusKey, 'scene:a:select');
  h.document.activeElement.dispatch('keydown', 'End');
  assert.equal(h.document.activeElement.dataset.focusKey, 'scene:b:select');
});

test('scene actions are disclosed individually and Copy/Delete never select a scene', () => {
  const h = listHarness();
  assert.ok(h.list.querySelectorAll('.scene-row-actions').every(el => el.hidden));
  let toggle = h.list.querySelectorAll('.scene-actions-toggle')[0];
  toggle.focus(); toggle.dispatch('click');
  assert.equal(h.document.activeElement.dataset.focusKey, 'scene:a:actions');
  assert.equal(h.document.activeElement.getAttribute('aria-expanded'), 'true');
  h.list.querySelector('.scene-duplicate-btn').dispatch('click');
  h.list.querySelector('.scene-del-btn').dispatch('click');
  assert.deepEqual(h.calls, [['copy', 'a']], 'cancelled deletion must do nothing');
  h.context.confirm = () => true;
  h.list.querySelector('.scene-del-btn').dispatch('click');
  assert.deepEqual(h.calls, [['copy', 'a'], ['delete', 'a']]);
  toggle = h.list.querySelectorAll('.scene-actions-toggle')[1];
  toggle.focus(); toggle.dispatch('click');
  assert.deepEqual(h.list.querySelectorAll('.scene-row-actions').map(el => el.hidden), [true, false]);
  const event = h.list.querySelectorAll('.scene-del-btn')[1].dispatch('keydown', 'Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.document.activeElement.dataset.focusKey, 'scene:b:actions');
  assert.equal(h.document.activeElement.getAttribute('aria-expanded'), 'false');
});

test('removing the focused row restores the current scene, then New scene when the list is empty', () => {
  const h = listHarness();
  h.list.querySelector('.scene-select').focus();
  vm.runInContext("_scenes = [_scenes[1]]; _currentSceneId = 'b'; renderScenesList();", h.context);
  assert.equal(h.document.activeElement.dataset.focusKey, 'scene:b:select');
  vm.runInContext('_scenes = []; renderScenesList();', h.context);
  assert.equal(h.document.activeElement, h.document.getElementById('add-scene-btn'));
});

test('group folding retains focus; moving a scene reveals its destination without selecting it', async () => {
  const h = listHarness();
  const fold = h.list.querySelector('.scene-group-fold');
  fold.focus(); fold.dispatch('click');
  assert.equal(h.document.activeElement.dataset.focusKey, 'group:g:fold');
  assert.equal(h.document.activeElement.getAttribute('aria-expanded'), 'false');
  const toggle = h.list.querySelector('.scene-actions-toggle');
  toggle.focus(); toggle.dispatch('click');
  const select = h.list.querySelector('.scene-group-select');
  select.value = 'g'; select.focus();
  await Promise.all(select.dispatch('change').pending);
  assert.deepEqual(h.calls, [['group', {groupId:'g'}]]);
  assert.equal(h.document.activeElement.dataset.focusKey, 'scene:a:group');
  assert.equal(h.list.querySelector('.scene-group-fold').getAttribute('aria-expanded'), 'true');
});

test('inspector reveals only a changed selection or a reopened mobile drawer', () => {
  const app = { classList: { contains: () => true } };
  const context = vm.createContext({
    _objects: new Map(['a','b'].map(id => [id, {obj:{id},anchor:{}}])),
    _selectedId: null, _selectedPinPhotoPath: null,
    _transformControls: { attach() {} }, _v3d: { invalidateRender() {} },
    window: { matchMedia: () => ({ matches: false }) },
    document: { getElementById: id => id === 'app' ? app : {} },
    reveals: 0, showPropertyPanel() {}, revealPropertyPanel() { context.reveals++; },
  });
  vm.runInContext(functions('function select(id)', 'function revealPropertyPanel('), context);
  context.select('a'); context.select('a');
  assert.equal(context.reveals, 1);
  context.select('b');
  assert.equal(context.reveals, 2);
  context.window.matchMedia = () => ({ matches: true });
  app.classList.contains = () => false;
  context.select('b');
  assert.equal(context.reveals, 3);
});

test('inspector scroll stays within its sidebar and leaves visible fields alone', () => {
  const scrolls = [];
  let panelTop = 700;
  const toolbar = { scrollTop:100, getBoundingClientRect: () => ({bottom:800}), scrollTo: v => scrolls.push(v) };
  const elements = { 'editor-toolbar':toolbar,
    'toolbar-header':{getBoundingClientRect:() => ({bottom:100})},
    'property-panel':{getBoundingClientRect:() => ({top:panelTop})} };
  const context = vm.createContext({ document:{getElementById:id => elements[id]} });
  vm.runInContext(functions('function revealPropertyPanel(', 'function deselect('), context);
  context.revealPropertyPanel();
  assert.equal(scrolls[0].top, 688);
  assert.equal(scrolls[0].behavior, 'auto');
  panelTop = 200; context.revealPropertyPanel();
  assert.equal(scrolls.length, 1);
  panelTop = 50; context.revealPropertyPanel();
  assert.equal(scrolls[1].top, 38);
});

test('mobile drawer makes hidden content inert, contains focus and lets overlays take priority', () => {
  const elements = {};
  const listeners = {};
  const classes = new Set();
  let activeElement;
  const element = id => elements[id] ||= {
    attributes:{}, style:{display:'none'}, listeners:{},
    classList:{ contains:name => classes.has(name), toggle(name,on) { on ? classes.add(name) : classes.delete(name); } },
    contains:el => el === elements['editor-mobile-close'],
    setAttribute(key,value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    addEventListener(name,fn) { this.listeners[name] = fn; },
    focus() { activeElement = this; },
    querySelector() { return null; },
    querySelectorAll() { return [elements['editor-mobile-close']]; },
    getClientRects:() => [1], tabIndex:0,
  };
  const media = {matches:true, addEventListener(name,fn) { this.change = fn; }};
  const document = { getElementById:element, get activeElement() { return activeElement; } };
  const window = { matchMedia:() => media, addEventListener(name,fn) { listeners[name] = fn; } };
  const script = html.match(/<script>\s*\/\/ Mobile scene editor drawer:[\s\S]*?<\/script>/)[0]
    .replace(/^<script>|<\/script>$/g,'');
  vm.runInNewContext(script, {window,document});
  assert.equal(element('editor-toolbar').inert, true);
  element('editor-mobile-open').listeners.click();
  assert.equal(element('editor-toolbar').inert, false);
  assert.equal(element('editor-toolbar').attributes['aria-modal'], 'true');
  assert.equal(element('canvas-wrap').inert, true);
  const tab = {key:'Tab', preventDefault() {this.prevented = true;}};
  listeners.keydown(tab);
  assert.equal(tab.prevented, true, 'Tab wraps at the last visible control');
  const shiftTab = {key:'Tab', shiftKey:true, preventDefault() {this.prevented = true;}};
  listeners.keydown(shiftTab);
  assert.equal(shiftTab.prevented, true, 'Shift+Tab wraps at the first visible control');
  const escape = {key:'Escape', preventDefault() {this.prevented = true;}, stopPropagation() {}};
  element('scripts-modal').style.display = 'flex';
  listeners.keydown(escape);
  assert.equal(escape.prevented, undefined, 'the scripts overlay receives Escape first');
  assert.equal(element('editor-toolbar').inert, false);
  element('scripts-modal').style.display = 'none';
  listeners.keydown(escape);
  assert.equal(escape.prevented, true);
  assert.equal(element('editor-toolbar').inert, true);
  assert.equal(activeElement, element('editor-mobile-open'));
  media.matches = false; media.change();
  assert.equal(element('editor-toolbar').inert, false, 'desktop sidebar stays accessible');
  assert.equal(element('canvas-wrap').inert, false);
  assert.equal(element('editor-toolbar').attributes['aria-modal'], undefined);
  assert.equal(activeElement, element('add-scene-btn'), 'focus leaves hidden mobile controls on desktop');
});

test('deleting the final scene clears the inspector and detaches the selected pin', async () => {
  let deselected = 0;
  const context = vm.createContext({
    _currentSceneId:'a', _scenes:[{id:'a'}], _objects:new Map(), SLUG:'fixture',
    cancelAllPending() {}, apiWrite:async () => ({}),
    deselect() { deselected++; }, disposeEntry() {},
    document:{getElementById:() => ({style:{}})},
    updateAddButtonsEnabled() {}, renderScenesList() {}, selectScene() {},
  });
  vm.runInContext(functions('async function onDeleteSceneClick(', '// ── Load '), context);
  await context.onDeleteSceneClick('a');
  assert.equal(deselected, 1);
  assert.equal(context._currentSceneId, null);
});

test('scripts dialog keeps keyboard focus and Escape returns to its inspector control', () => {
  let closed = 0, deselected = 0;
  const document = {activeElement:null};
  const control = () => ({disabled:false,tabIndex:0,getClientRects:() => [1],focus() {document.activeElement = this;}});
  const first = control(), last = control();
  const modal = {style:{display:'flex'},querySelectorAll:() => [first,last],contains:el => el === first || el === last};
  document.getElementById = () => modal;
  const context = vm.createContext({document,closeScriptsModal() {closed++;},
    _placingKind:null,_selectedId:'pin',deselect() {deselected++;}});
  vm.runInContext(functions('function onKeydown(', '// ── Write helper:'),context);
  last.focus();
  const tab = {key:'Tab',preventDefault() {this.prevented = true;}};
  context.onKeydown(tab);
  assert.equal(tab.prevented,true);
  assert.equal(document.activeElement,first);
  const shiftTab = {key:'Tab',shiftKey:true,preventDefault() {this.prevented = true;}};
  context.onKeydown(shiftTab);
  assert.equal(shiftTab.prevented,true);
  assert.equal(document.activeElement,last);
  context.onKeydown({key:'Escape'});
  assert.equal(closed,1);
  assert.equal(deselected,0);

  const elements = Object.fromEntries(['scripts-modal','scripts-modal-close','new-script-name',
    'new-script-source','manage-scripts-btn'].map(id => [id,{...control(),style:{}}]));
  document.getElementById = id => elements[id];
  context.loadScriptsList = () => {};
  vm.runInContext('let _editingScriptId = null;\n' +
    functions('function openScriptsModal(', 'async function loadScriptsList('),context);
  context.openScriptsModal();
  assert.equal(document.activeElement,elements['scripts-modal-close']);
  context.closeScriptsModal();
  assert.equal(document.activeElement,elements['manage-scripts-btn']);
});


test('scene search filters locally and case-insensitively without disturbing selection or focus', () => {
  const h = listHarness();
  const search = h.document.getElementById('scene-search-input');
  search.focus();
  h.list.scrollTop = 80;
  h.context.setSceneSearch('  SECOND  ');
  const results = h.list.querySelectorAll('.scene-select');
  assert.equal(results.length, 1);
  assert.equal(results[0].textContent, 'Second scene');
  assert.equal(h.document.getElementById('editor-scene-count').textContent, '1 / 2');
  assert.equal(h.list.querySelectorAll('.scene-group-fold').length, 0, 'search results are not hidden by groups');
  assert.equal(h.list.scrollTop, 0);
  assert.equal(h.document.activeElement, search, 'typing must not move keyboard focus away from search');
  assert.deepEqual(h.calls, [], 'filtering never selects or saves a scene');
  assert.equal(vm.runInContext('_scenes.length', h.context), 2, 'all saved scenes remain available');

  h.context.setSceneSearch('missing name');
  assert.equal(h.list.querySelectorAll('.scene-select').length, 0);
  assert.match(h.list.querySelector('.scene-empty-notice').textContent, /No matching scenes/);
  assert.equal(h.document.getElementById('editor-scene-count').textContent, '0 / 2');

  h.context.setSceneSearch('');
  assert.equal(h.list.querySelectorAll('.scene-select').length, 2);
  assert.equal(h.list.querySelectorAll('.scene-group-fold').length, 2);
  assert.equal(h.document.getElementById('editor-scene-count').textContent, '2');
  assert.equal(h.document.activeElement, search);
});

test('search exposes matching scenes inside folded groups without changing their saved fold state', () => {
  const h = listHarness();
  vm.runInContext("_sceneAssignments.set('a','g'); _foldedSceneGroups.add('g'); renderScenesList();", h.context);
  assert.deepEqual(h.list.querySelectorAll('.scene-select').map(el=>el.textContent), ['Second scene']);
  h.context.setSceneSearch('VERY LONG');
  assert.deepEqual(h.list.querySelectorAll('.scene-select').map(el=>el.textContent), ['A very long scene title']);
  assert.equal(vm.runInContext("_foldedSceneGroups.has('g')",h.context),true);
  h.context.setSceneSearch('');
  assert.deepEqual(h.list.querySelectorAll('.scene-select').map(el=>el.textContent), ['Second scene']);
  assert.equal(vm.runInContext("_sceneAssignments.get('a')",h.context),'g');
});

test('new scene creation clears a previous search instead of hiding the newly created scene', async () => {
  const search={value:'old'};
  const name={value:'Brand new scene'};
  const calls=[];
  const context=vm.createContext({
    _sceneSearchQuery:'old', _scenes:[{id:'original',name:'Old'}], SLUG:'landcros',
    document:{getElementById:id=>id==='new-scene-name'?name:search},
    onNewSceneCancel(){calls.push('cancel');},
    apiWrite:async()=>({id:'created',name:'Brand new scene'}),
    selectScene:async id=>calls.push(id),
    showToast(){},
  });
  vm.runInContext(functions('async function onNewSceneConfirm(', '// User-initiated atomic copy'), context);
  await context.onNewSceneConfirm();
  assert.equal(context._sceneSearchQuery,'');
  assert.equal(search.value,'');
  assert.equal(context._scenes.length,2);
  assert.deepEqual(calls,['cancel','created']);
});

test('search is an accessible native search field wired before scene API loading',()=>{
  assert.match(html, /type="search" id="scene-search-input" aria-label="Search scenes"/);
  assert.match(source, /sceneSearch\.addEventListener\('input', \(\) => setSceneSearch\(sceneSearch\.value\)\)/);
  assert.match(source, /event\.key !== 'Escape' \|\| !_sceneSearchQuery/);
  assert.match(source, /event\.stopPropagation\(\);\s*sceneSearch\.value = '';\s*setSceneSearch\(''\)/);
  assert.match(html, /id="editor-scene-count" aria-live="polite"/);
});
