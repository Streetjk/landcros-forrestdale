// Structural acceptance for the Opus 5.5 EX2000-7 cab operator (v6).
// Inspects the shipped GLB, not just the browser's loader stub.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const glb = readFileSync(new URL('../assets/excavator/EX2000_7_SiteNav_v6.glb', import.meta.url));
assert.equal(glb.toString('ascii', 0, 4), 'glTF');
assert.equal(glb.readUInt32LE(8), glb.length);
const jsonLength = glb.readUInt32LE(12);
const gl = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
const nodesByName = new Map(gl.nodes.map((node, index) => [node.name, index]));
const materialNames = gl.materials.map(mat => mat.name);
const material = name => gl.materials.find(mat => mat.name === name);
const parentOf = new Map();
for (const [index, node] of gl.nodes.entries()) {
  for (const child of node.children ?? []) parentOf.set(child, index);
}
function ancestors(name) {
  const result = [];
  for (let index = nodesByName.get(name); index !== undefined; index = parentOf.get(index)) {
    result.unshift(gl.nodes[index].name);
  }
  return result;
}
function usedMaterials(name) {
  const node = gl.nodes[nodesByName.get(name)];
  assert.notEqual(node?.mesh, undefined, name + ' must contain a mesh');
  return new Set(gl.meshes[node.mesh].primitives.map(primitive => materialNames[primitive.material]));
}
function triangleCount(name) {
  const node = gl.nodes[nodesByName.get(name)];
  return gl.meshes[node.mesh].primitives.reduce((sum, primitive) => sum + gl.accessors[primitive.indices].count / 3, 0);
}

test('seated operator and joysticks are attached to rotating house, not tracks', () => {
  assert.deepEqual(ancestors('CAB_OPERATOR'), ['ROOT', 'SLEW', 'CAB_OPERATOR']);
  assert.deepEqual(ancestors('CAB_CONTROLS'), ['ROOT', 'SLEW', 'CAB_CONTROLS']);
  assert.ok(triangleCount('CAB_OPERATOR') > 1_000);
  assert.ok(triangleCount('CAB_OPERATOR') < 4_000);
  assert.ok(triangleCount('CAB_CONTROLS') < 1_000);
  assert.ok(glb.length < 3 * 1024 * 1024);
});

test('operator wears hi-vis and protective equipment', () => {
  const used = usedMaterials('CAB_OPERATOR');
  for (const name of ['HIVIS_YELLOW', 'REFLECTIVE_SILVER', 'WORKWEAR_BLACK',
                      'OPERATOR_SKIN', 'HARDHAT_WHITE', 'SAFETY_LENS']) {
    assert.ok(used.has(name), 'operator material missing: ' + name);
  }
  assert.ok(usedMaterials('CAB_CONTROLS').has('TRACK_BLACK'));
});

test('existing machine colours and 85% transparent glazing remain', () => {
  const glass = material('CAB_GLASS');
  assert.equal(glass.alphaMode, 'BLEND');
  assert.ok(Math.abs(glass.pbrMetallicRoughness.baseColorFactor[3] - 0.15) < 0.002);
  const orange = material('HITACHI_ORANGE').pbrMetallicRoughness.baseColorFactor;
  assert.ok(Math.abs(orange[0] - 0.855) < 0.03);
  assert.ok(Math.abs(orange[1] - 0.147) < 0.03);
  assert.ok(Math.abs(orange[2] - 0.0137) < 0.02);
});

test('motion rig, 92 shoes and animation clips are preserved', () => {
  const trackNodes = gl.nodes.filter(node => /^TRACK_[LR]_Shoe_\d{2}$/.test(node.name));
  assert.equal(trackNodes.length, 92);
  assert.deepEqual(gl.animations.map(animation => animation.name).sort(), ['Dig', 'Slew', 'TrackDrive_OnePitch']);
  for (const name of ['BOOM', 'STICK', 'BUCKET', 'UNDERCARRIAGE', 'SLEW']) {
    assert.ok(nodesByName.has(name), 'missing joint: ' + name);
  }
  const source = readFileSync(new URL('../excavator-route.js', import.meta.url), 'utf8');
  assert.match(source, /EX2000_7_SiteNav_v7\.glb/);
  assert.doesNotMatch(source, /EX2000_7_SiteNav_v6\.glb/);
});
