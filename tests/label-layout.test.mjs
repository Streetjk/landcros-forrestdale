import test from 'node:test';
import assert from 'node:assert/strict';
import { labelScaleForZoom, layoutLabels, forwardWheelToTarget } from '../label-layout.js';

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

test('labels remain at their designed screen anchor with zero layout offset', () => {
  const item = { id:'gate', x:400, y:250, width:110, height:42, scale:0.66, priority:40, previousSlot:6 };
  const result = layoutLabels([item], {width:800,height:500}, {gap:7}).get('gate');
  assert.equal(result.visible, true);
  assert.equal(result.slot, 0);
  assert.equal(result.dx, 0);
  assert.equal(result.dy, 0);
});

test('a collision hides the lower-priority label instead of moving either label', () => {
  const items = [
    { id:'gate', x:400, y:250, width:110, height:42, scale:0.66, priority:40 },
    { id:'parts', x:400, y:250, width:120, height:42, scale:0.66, priority:20 },
  ];
  const out = layoutLabels(items, {width:800,height:500}, {gap:7});
  assert.equal(out.get('gate').visible, true);
  assert.equal(out.get('gate').dx, 0);
  assert.equal(out.get('gate').dy, 0);
  assert.equal(out.get('parts').visible, false);
});

test('a label that would be cut off at the viewport edge hides instead of moving', () => {
  const item = { id:'edge', x:45, y:120, width:100, height:40, scale:1, priority:20 };
  const result = layoutLabels([item], {width:320,height:240}, {gap:7,margin:8}).get('edge');
  assert.equal(result.visible, false);
  assert.equal(result.dx, 0);
  assert.equal(result.dy, 0);
});

test('a label fully inside the viewport keeps its exact designed position', () => {
  const item = { id:'safe', x:60, y:120, width:100, height:40, scale:1, priority:20 };
  const result = layoutLabels([item], {width:320,height:240}, {gap:7,margin:8}).get('safe');
  assert.equal(result.visible, true);
  assert.deepEqual(rect(item, result), { left:10, right:110, top:100, bottom:140 });
});

test('layout hides labels when the designed placements cannot all fit', () => {
  const items = Array.from({length:12}, (_,i) => ({
    id:String(i), x:50, y:30, width:90, height:40, scale:0.66, priority:12-i,
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
