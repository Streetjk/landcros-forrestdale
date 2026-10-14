import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GPS_MIN_UPDATE_MS, shouldRenderGpsFix, gpsSceneAccuracyRadius,
  gpsWithinSite,
} from '../gps-tracking.js';

const calibration = JSON.parse(
  readFileSync(new URL('../sites/landcros/assets/gps-calibration.json', import.meta.url), 'utf8')
);

test('watchPosition redraw throttles to at most one normal update every three seconds', () => {
  assert.equal(GPS_MIN_UPDATE_MS, 3000);
  assert.equal(shouldRenderGpsFix(1000, -1, 25, Infinity), true);
  assert.equal(shouldRenderGpsFix(2000, 1000, 25, 25), false);
  assert.equal(shouldRenderGpsFix(3999, 1000, 25, 25), false);
  assert.equal(shouldRenderGpsFix(4000, 1000, 25, 25), true);
  assert.equal(shouldRenderGpsFix(2000, 1000, 9, 25), true);
  assert.equal(shouldRenderGpsFix(2000, 1000, 18, 25), false);
  assert.equal(shouldRenderGpsFix(NaN, 1000, 25, 25), false);
});

test('GPS accuracy circle scales to calibrated scene units without huge meshes', () => {
  const scale = calibration.fit.approxMetresPerSceneUnit;
  assert.ok(Math.abs(gpsSceneAccuracyRadius(25, calibration) - 25 / scale) < 0.001);
  assert.equal(gpsSceneAccuracyRadius(0, calibration), gpsSceneAccuracyRadius(30, calibration));
  assert.equal(gpsSceneAccuracyRadius(10000, calibration), 6);
  assert.equal(gpsSceneAccuracyRadius(0.1, calibration), 0.16);
});

test('GPS respects a buffered site boundary; disallow impossible positions', () => {
  const x = calibration.references[0];
  assert.equal(gpsWithinSite({x:x.sceneX,z:x.sceneZ}, calibration), true);
  assert.equal(gpsWithinSite({x:1000,z:1000}, calibration), false);
  assert.equal(gpsWithinSite(null, calibration), false);
});
