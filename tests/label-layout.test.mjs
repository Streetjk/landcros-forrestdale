import test from 'node:test';
import assert from 'node:assert/strict';
import { labelScaleForZoom, layoutLabels, forwardWheelToTarget } from '../label-layout.js';

function intersects(a, b, gap = 0) {
  return !(a.right + gap <= b.left || a.left >= b.right + gap ||
           a.bottom + gap <= b.top || a.top >= b.bottom + gap);
}

function rect(item, result) {
  const w = item.width * result.scale;
  const h = item.height * result.scale;
  const cx = item.x + result.dx;
  const cy = item.y + result.dy;
  return { left: cx - w/2, right: cx + w/2, top: cy - h/2, bottom: cy + h/2 };
}

test('label zoom curve caps close labels and preserves readable overhead size', () => {
  assert.equal(labelScaleForZoom(10), 0.66);
  assert.equal(labelScaleForZoom(18), 0.66);
  assert.ok(labelScaleForZoom(30) < 0.66 && labelScaleForZoom(30) > 0.54);
  assert.equal(labelScaleForZoom(50), 0.54);
  assert.ok(labelScaleForZoom(70) >= 0.44 && labelScaleForZoom(70) < 0.54);
});
test('screen-space layout separates colliding labels and preserves priority', () => {
  const items = [
    { id:'gate', x:400, y:250, width:110, height:42, scale:0.66, priority:40, previousSlot:0 },
    { id:'parts', x:400, y:250, width:120, height:42, scale:0.66, priority:20, previousSlot:0 },
  ];
  const out = layoutLabels(items, {width:800,height:500}, {gap:7});
  const gate = out.get('gate');
  const parts = out.get('parts');
  assert.equal(gate.visible, true);
  assert.equal(gate.slot, 0);
  assert.equal(parts.visible, true);
  assert.notEqual(parts.slot, 0);
  assert.equal(intersects(rect(items[0],gate), rect(items[1],parts), 7), false);
});

test('layout keeps a previous non-overlapping slot to avoid label jitter', () => {
  const item = { id:'a', x:300, y:200, width:100, height:40, scale:0.6, priority:20, previousSlot:2 };
  const out = layoutLabels([item], {width:800,height:500}, {gap:7});
  assert.equal(out.get('a').visible, true);
  assert.equal(out.get('a').slot, 2);
});
test('layout hides labels when no collision-free in-viewport placement exists', () => {
  const items = Array.from({length:12}, (_,i) => ({
    id:String(i), x:50, y:30, width:90, height:40, scale:0.66, priority:12-i, previousSlot:0,
  }));
  const out = layoutLabels(items, {width:100,height:60}, {gap:7,margin:8});
  assert.ok([...out.values()].some(v => !v.visible));
});

test('wheel bridge preserves wheel deltas and modifier keys', () => {
  const calls = { prevented:false, stopped:false, event:null };
  const source = {
    deltaX:2, deltaY:120, deltaZ:0, deltaMode:0, clientX:40, clientY:50,
    ctrlKey:true, shiftKey:false, altKey:false, metaKey:false,
    preventDefault(){ calls.prevented=true; },
    stopPropagation(){ calls.stopped=true; },
  };
  class FakeWheelEvent {
    constructor(type, init){ this.type=type; Object.assign(this, init); }
  }
  const target = { dispatchEvent(event){ calls.event=event; return true; } };
  assert.equal(forwardWheelToTarget(source, target, FakeWheelEvent), true);
  assert.equal(calls.prevented, true);
  assert.equal(calls.stopped, true);
  assert.equal(calls.event.type, 'wheel');
  assert.equal(calls.event.deltaY, 120);
  assert.equal(calls.event.ctrlKey, true);
});
