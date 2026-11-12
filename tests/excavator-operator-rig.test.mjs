// Contract and Blender GLB integration: no browser or three.js dependency.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { makeOperatorRig } from '../excavator-operator-rig.mjs';

const asset = new URL('../assets/excavator/', import.meta.url);
const contract = JSON.parse(readFileSync(new URL('operator_rig_contract_v7.json', asset),'utf8'));
const glb = readFileSync(new URL('EX2000_7_SiteNav_v7.glb', asset));
assert.ok(glb.length < 4_000_000, 'mobile model must remain under 4 MB');
assert.equal(glb.toString('utf8',0,4),'glTF');
const gl = JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)).toString('utf8'));
const names = new Set(gl.nodes.map(n=>n.name).filter(Boolean));
const required = [...Object.keys(contract.operator.bones),...Object.keys(contract.controls)];
for(const name of required) assert.ok(names.has(name),'GLB missing operator node '+name);
for(const name of ['SLEW','CAB_OPERATOR','CAB_OPERATOR_Mesh','CAB_CONTROLS']) {
  assert.ok(names.has(name),'GLB missing '+name);
}
for(const name of ['OperatorDrive','OperatorSteer','OperatorSlew']) {
  assert.ok(gl.animations.some(a=>a.name===name),'GLB missing '+name+' clip');
}
const materials = new Map(gl.materials.map(m=>[m.name,m]));
for(const name of ['HIVIS_YELLOW','REFLECTIVE_SILVER','SAFETY_LENS','HITACHI_ORANGE','CAB_GLASS']) {
  assert.ok(materials.has(name),'missing material '+name);
}
const glass=materials.get('CAB_GLASS');
assert.equal(glass.alphaMode,'BLEND','cab glazing must remain transparent');
assert.ok(Math.abs(glass.pbrMetallicRoughness.baseColorFactor[3]-0.15)<0.001,
  'cab glazing must retain 85% transparency');
const mock = new Map(required.map(name=>[name,{
  name, quaternion:{value:null,set(x,y,z,w){this.value=[x,y,z,w];}},
}]));
const operator=makeOperatorRig({getObjectByName:n=>mock.get(n)},contract);
const neutral=name=>(contract.operator.bones[name]||contract.controls[name]).rotation_xyzw;
const changed=name=>mock.get(name).quaternion.value.some((v,i)=>Math.abs(v-neutral(name)[i])>1e-4);
const driven=['CAB_JOY_L','CAB_JOY_R','CAB_TRAVEL_L','CAB_TRAVEL_R',
  'OP_UpperArm_L','OP_LowerArm_L','OP_Hand_L',
  'OP_UpperArm_R','OP_LowerArm_R','OP_Hand_R','OP_Foot_L','OP_Foot_R'];
operator.reset();
for(const name of driven) {
  assert.deepEqual(mock.get(name).quaternion.value,neutral(name),'rest pose: '+name);
}
operator.apply({joyL:{fb:0.18,lr:-0.78},joyR:{fb:0.12,lr:0.25},travelL:0.72,travelR:0.52});
for(const name of driven) {
  assert.ok(changed(name),'control movement must animate '+name);
}
for(const name of driven) {
  const q=mock.get(name).quaternion.value;
  assert.ok(q.every(Number.isFinite),'invalid quaternion: '+name);
  assert.ok(Math.abs(Math.hypot(...q)-1)<1e-4,'non-unit quaternion: '+name);
}
operator.reset();
for(const name of driven) assert.deepEqual(mock.get(name).quaternion.value,neutral(name),'reset: '+name);
console.log('PASS: v7 GLB/contract, 85% cab glazing, skinned operator, independently animated hands/joysticks/feet and reset.');
