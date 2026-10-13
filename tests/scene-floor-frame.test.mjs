import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneGroundFrame, SCENE_PIN_FLOAT_HEIGHT } from '../scene-label-pin.js';

// Thin test doubles avoid coupling renderer geometry tests to a WebGL browser.
class Group {
  children = [];
  name = '';
  parent = null;
  add(mesh) { this.children.push(mesh); mesh.parent = this; }
  remove(mesh) { this.children = this.children.filter(x => x !== mesh); mesh.parent = null; }
}
class BoxGeometry {
  constructor(width, height, depth) { this.parameters = { width, height, depth }; }
  dispose() { this.disposed = true; }
}
class MeshBasicMaterial {
  constructor(opts) {
    Object.assign(this, opts);
    const color = { hex: opts.color, setHex(value) { this.hex = value; } };
    this.color = color;
  }
  dispose() { this.disposed = true; }
}
class Mesh {
  constructor(geometry, material) {
    this.geometry = geometry;
    this.material = material;
    this.position = { x: 0, y: 0, z: 0, set(x,y,z) { Object.assign(this, { x,y,z }); } };
    this.renderOrder = 0;
  }
}
const THREE = { Group, BoxGeometry, MeshBasicMaterial, Mesh };

test('scene labels use existing SiteNav floating-pin height and four-sided floor frame', () => {
  const frame = createSceneGroundFrame(THREE);
  assert.equal(SCENE_PIN_FLOAT_HEIGHT, 1.3);
  assert.equal(frame.group.name, 'scene-pin-ground-frame');
  assert.equal(frame.group.children.length, 4);
  const children = frame.group.children;
  assert.equal(children[0].position.z, -0.455);
  assert.equal(children[1].position.z, 0.455);
  assert.equal(children[2].position.x, -0.455);
  assert.equal(children[3].position.x, 0.455);
  assert.ok(children.every(item => item.position.y === 0.05));
  assert.ok(children.every(item => item.geometry.parameters.height === 0.01));
  assert.ok(children.every(item => item.renderOrder === 999));
  assert.equal(frame.material.depthTest, false);
  assert.equal(frame.material.color.hex, 0x2563eb);
  frame.setSelected(true);
  assert.equal(frame.material.color.hex, 0xffcc00);
  frame.setSelected(false);
  assert.equal(frame.material.color.hex, 0x2563eb);
  frame.dispose();
  assert.ok(children.every(item => item.geometry.disposed));
  assert.equal(frame.material.disposed, true);
});

test('floor frame supports SiteNav original green / personal blue colours', () => {
  for (const color of [0x00b140, 0x4F6AF5]) {
    const frame = createSceneGroundFrame(THREE, color);
    assert.equal(frame.material.color.hex, color);
    frame.dispose();
  }
});
