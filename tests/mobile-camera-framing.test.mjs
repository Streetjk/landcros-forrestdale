import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileCameraFraming } from '../mobile-camera-framing.js';

test('closed, idle and invalid viewports leave the original camera projection intact', () => {
  for (const stage of ['closed','idle','unknown']) {
    assert.deepEqual(mobileCameraFraming({
      stage,viewportWidth:390,viewportHeight:850,panelHeight:240,
    }),{x:0,y:0});
  }
  assert.deepEqual(mobileCameraFraming({stage:'summary',viewportWidth:0,viewportHeight:0}),{x:0,y:0});
});

test('portrait summary centres the scene above the detail sheet and camera buttons', () => {
  assert.deepEqual(mobileCameraFraming({
    stage:'summary',viewportWidth:390,viewportHeight:900,panelHeight:240,
  }),{x:0,y:152});
});

test('full details keeps a small map view visible and caps the projection shift', () => {
  assert.deepEqual(mobileCameraFraming({
    stage:'full',viewportWidth:390,viewportHeight:900,panelHeight:774,
  }),{x:0,y:387});
});

test('a selected building near the top is not shifted under the site brand', () => {
  assert.deepEqual(mobileCameraFraming({
    stage:'summary',viewportWidth:390,viewportHeight:900,panelHeight:240,focusScreenY:150,
  }),{x:0,y:42});
});

test('a selected building below camera buttons moves just into the safe map region', () => {
  assert.deepEqual(mobileCameraFraming({
    stage:'summary',viewportWidth:390,viewportHeight:900,panelHeight:240,focusScreenY:840,
  }),{x:0,y:262});
});

test('landscape moves the map left of the drawer instead of moving it vertically', () => {
  assert.deepEqual(mobileCameraFraming({
    stage:'summary',viewportWidth:640,viewportHeight:390,panelWidth:310,landscape:true,
  }),{x:179,y:0});
  assert.deepEqual(mobileCameraFraming({
    stage:'summary',viewportWidth:640,viewportHeight:390,panelWidth:310,landscape:true,focusScreenX:60,
  }),{x:32,y:0});
});
