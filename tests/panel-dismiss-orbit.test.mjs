import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const viewer=readFileSync(new URL('../viewer3d.js',import.meta.url),'utf8');
const mobile=readFileSync(new URL('../mobile-detail-sheet.js',import.meta.url),'utf8');

test('close and blank-map tap preserve a running pin-focused camera, with no scene mutations',()=>{
  assert.match(viewer,/onDismiss: \(\) => window\.showPointList\?\.\(\{historyMode:'none',preserveCamera:true\}\)/);
  assert.match(mobile,/function dismiss\(\)[\s\S]*?onDismiss\(\)/);
  const list=viewer.slice(viewer.indexOf('window.showPointList = function('),
    viewer.indexOf('function _activeMyPinHistoryUrlMatches')>0
      ? viewer.indexOf('function _activeMyPinHistoryUrlMatches')
      : viewer.indexOf('window.startNav = function('));
  assert.match(list,/const preserveCamera = options\?\.preserveCamera === true/);
  assert.match(list,/if \(!preserveCamera\) _cancelPinFocusFlight\(\)/);
  assert.match(list,/if \(!preserveCamera\) \{[\s\S]*?stopAutoOrbit\(\)/);
  assert.match(list,/if \(!preserveCamera\) \{[\s\S]*?controls\.enabled = true/);
  assert.doesNotMatch(list,/\bfetch\s*\(/);
});

test('short canvas taps do not stop rotation; a meaningful drag and pinch still interrupt',()=>{
  assert.match(viewer,/const _cameraTouchPointers = new Map\(\)/);
  assert.match(viewer,/_cameraTapPending = _cameraTouchPointers\.size === 1/);
  assert.match(viewer,/if \(_cameraTouchPointers\.size > 1\) \{\s*_cameraTapPending = false;\s*_stopOrbitForManualGesture\(\)/);
  assert.match(viewer,/Math\.hypot\(event\.clientX-p\.x,event\.clientY-p\.y\) <= 8/);
  assert.match(viewer,/controls\.addEventListener\('start', \(\) => \{\s*if \(_touchMapMode\(\) && _cameraTapPending\) return/);
  assert.match(viewer,/renderer\.domElement\.addEventListener\('wheel', \(\) => \{\s*if \(_touchMapMode\(\)\) _stopOrbitForManualGesture\(\)/);
});

test('explicit navigation and new pin choices still cancel old camera ownership',()=>{
  assert.match(viewer,/function _focusPinCamera\(pinWorld,[\s\S]*?_cancelPinFocusFlight\(\);\s*stopAutoOrbit\(\)/);
  assert.match(viewer,/window\.startNav = function\(pt\) \{\s*_cancelPinFocusFlight\(\)/);
});
