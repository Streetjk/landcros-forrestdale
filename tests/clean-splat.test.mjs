import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSplatBuffer } from '../scripts/clean-splat.mjs';

function record(x=0,y=0,z=0,alpha=255,s=[0.01,0.01,0.01]){
 const b=Buffer.alloc(32),view=new DataView(b.buffer,b.byteOffset,b.byteLength);
 [x,y,z,...s].forEach((v,i)=>view.setFloat32(i*4,v,true));
 b[24]=200;b[25]=150;b[26]=100;b[27]=alpha;b.set([128,128,128,255],28);
 return b;
}
test('cleaner preserves all opaque details and their exact original bytes/order',()=>{
 const a=record(0,0,0),b=record(0.1,0,0,200,[0.2,0.02,0.02]);
 const input=Buffer.concat([a,b]);
 const {buffer,report}=cleanSplatBuffer(input);
 assert.deepEqual(buffer,input);
 assert.equal(report.removed,0);
});
test('cleaner removes invisible/elongated semi-transparent splats without changing neighbours',()=>{
 const a=record(0,0,0),b=record(0.1,0,0,1),c=record(0.2,0,0,15,[0.19,0.001,0.01]);
 const input=Buffer.concat([a,b,c]);
 const {buffer,report}=cleanSplatBuffer(input,{maxRemovalRatio:0.9});
 assert.deepEqual(buffer,a);
 assert.equal(report.reasons.transparent,1);
 assert.equal(report.reasons.oversized,1);
 assert.equal(Buffer.compare(input,Buffer.concat([a,b,c])),0);
});
test('cleaner rejects invalid data and too-aggressive cleanup',()=>{
 assert.throws(()=>cleanSplatBuffer(Buffer.alloc(31)),/32-byte/);
 assert.throws(()=>cleanSplatBuffer(Buffer.from([])),/nonempty/);
 assert.throws(()=>cleanSplatBuffer(Buffer.concat([record(),record(1,1,1,0)])),/safety cap/);
});
