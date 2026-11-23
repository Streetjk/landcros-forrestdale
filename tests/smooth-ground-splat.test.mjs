import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { smoothGroundSplat } from '../scripts/smooth-ground-splat.mjs';

const base = new URL('../sites/landcros/assets/', import.meta.url);
const cfg = JSON.parse(fs.readFileSync(new URL('../sites/landcros/data/config.json', import.meta.url), 'utf8'));

test('smoothing configuration selects ground-smoothed models without a visible quality switch', () => {
  assert.equal(cfg.assets.splatModels.full, './assets/site-ground-smooth.splat');
  assert.equal(cfg.assets.splatModels.lite, './assets/site-lite-ground-smooth.splat');
  assert.equal(cfg.assets.splatModels.original, './assets/site.splat');
  const viewer = fs.readFileSync(new URL('../viewer3d.js', import.meta.url),'utf8');
  assert.doesNotMatch(viewer,/btn-splat-quality|qualityBtn/);
});
test('refuses invalid geometry input and configuration', () => {
  assert.throws(() => smoothGroundSplat(Buffer.alloc(31), cfg),/32-byte-aligned/);
  assert.throws(() => smoothGroundSplat(Buffer.alloc(32), {}),/rotation.*normalization/);
});
for (const [inputName, outputName, expectedMoved, expectedClamped] of [
  ['site-clean.splat','site-ground-smooth.splat',74080,1603],
  ['site-lite.splat','site-lite-ground-smooth.splat',56021,1462],
]) {
  test(`${outputName}: deterministic smoothing, unchanged raised geometry and metadata`, () => {
    const original=fs.readFileSync(new URL(inputName,base));
    const expected=fs.readFileSync(new URL(outputName,base));
    const {buffer,report}=smoothGroundSplat(original,cfg);
    assert.deepEqual(buffer,expected);
    assert.equal(report.outputBytes,report.inputBytes);
    assert.equal(report.moved,expectedMoved);
    assert.equal(report.clamped,expectedClamped);
    assert.ok(report.moved < report.inputRecords*.30);
    assert.ok(buffer.length < 15e6);

    const [a,b,c]=cfg.splat.rotation,[,oy]=cfg.splat.centerOffset;
    const [cx,,cz]=cfg.splat.normalization.center,S=cfg.splat.normalization.scale;
    const sa=Math.sin(a),ca=Math.cos(a),sb=Math.sin(b),cb=Math.cos(b),sc=Math.sin(c),cc=Math.cos(c);
    const rY=[ca*sc+sa*sb*cc,ca*cc-sa*sb*sc,-sa*cb];
    let changed=0;
    for(let o=0;o<original.length;o+=32){
      const x=original.readFloatLE(o),y=original.readFloatLE(o+4),z=original.readFloatLE(o+8);
      const originalHeight=S*(rY[0]*x+rY[1]*y+rY[2]*z)+oy;
      const updatedHeight=S*(rY[0]*x+rY[1]*buffer.readFloatLE(o+4)+rY[2]*z)+oy;
      // No point on an actual elevated building/roof was altered.
      if(originalHeight>=.42||originalHeight<.12) assert.deepEqual(buffer.subarray(o,o+32),original.subarray(o,o+32));
      assert.ok(updatedHeight <= originalHeight + 0.000005);
      assert.deepEqual(buffer.subarray(o,o+4),original.subarray(o,o+4));
      assert.deepEqual(buffer.subarray(o+8,o+12),original.subarray(o+8,o+12));
      assert.deepEqual(buffer.subarray(o+24,o+32),original.subarray(o+24,o+32));
      if(!buffer.subarray(o,o+32).equals(original.subarray(o,o+32)))changed++;
    }
    assert.ok(changed>=expectedMoved);
  });
}
