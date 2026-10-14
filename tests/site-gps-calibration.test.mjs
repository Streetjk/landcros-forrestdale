import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gpsToScene, sceneToGps, validGpsCalibration, loadSiteGpsCalibration }
  from '../site-gps-calibration.js';

const c = JSON.parse(readFileSync(new URL('../sites/landcros/assets/gps-calibration.json', import.meta.url)));
test('eight supplied GPS pins fit one orientation-aware calibration', () => {
  assert.ok(validGpsCalibration(c));
  assert.equal(c.fit.referenceCount, 8);
  assert.equal(c.references.length, 8);
  const diffs = c.references.map(ref => {
    const p = gpsToScene(ref.latitude, ref.longitude, c);
    assert.ok(p && Number.isFinite(p.x) && Number.isFinite(p.z));
    assert.deepEqual(p.y, 0);
    return Math.hypot(p.x-ref.sceneX, p.z-ref.sceneZ);
  });
  const rms = Math.hypot(...diffs) / Math.sqrt(diffs.length);
  assert.ok(rms < 0.12, 'Expected fit residual less than 0.12 scene units');
  assert.ok(Math.max(...diffs) < 0.17);
});

test('GPS → scene → GPS round trip preserves coordinates', () => {
  for (const ref of c.references) {
    const point = gpsToScene(ref.latitude, ref.longitude, c);
    const actual = sceneToGps(point.x, point.z, c);
    assert.ok(Math.abs(actual[0]-ref.latitude) < 1e-9);
    assert.ok(Math.abs(actual[1]-ref.longitude) < 1e-9);
  }
});

test('invalid calibration and missing site calibration fail safely', async () => {
  assert.equal(gpsToScene(-32.14,115.95,null),null);
  assert.equal(sceneToGps(0,0,{}),null);
  assert.equal(validGpsCalibration({...c,sceneFromMetres:{x:[1,0,0],z:[1,0,0]}}),false);
  assert.equal(await loadSiteGpsCalibration(async()=>({ok:false})),null);
  assert.equal(await loadSiteGpsCalibration(async()=>{throw Error('offline')}),null);
});
