import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const source=read('viewer3d.js');
const style=read('style.css');

test('gesture pass-through is only enabled for touch visitors, never editors',()=>{
  assert.match(source,/isTouchMapDevice\(\)/);
  assert.match(source,/!document\.getElementById\('add-label-btn'\)/);
  assert.match(source,/!document\.getElementById\('admin-controls'\)/);
  assert.match(source,/classList\.toggle\('sn-touch-gesture-map',_touchMapMode\(\)\)/);
  assert.match(style,/#app\.sn-touch-gesture-map #labels-wrap\s*,[\s\S]*?#app\.sn-touch-gesture-map #labels-wrap \*\s*\{[^}]*pointer-events:none !important/s);
  assert.match(style,/#app\.sn-touch-gesture-map #labels-wrap[\s\S]*?touch-action:none !important/);
  assert.doesNotMatch(style,/#app\s+#labels-wrap \*\s*\{[^}]*pointer-events:none !important/s);
});

test('a tap is routed through visible CSS2D label rectangles before invisible spheres',()=>{
  const canvas=source.slice(source.indexOf("renderer.domElement.addEventListener('click', e => {\n  // A pinch/drag"),
    source.indexOf('// ── Point selection & panel ──'));
  assert.match(canvas,/\(_mobileDetails\.isCompact\(\) \|\| _touchMapMode\(\)\) && !_isMobileMapTap\(e\)/);
  assert.match(canvas,/_touchMapMode\(\) && _tapTargetOnCanvas\(e\.clientX,e\.clientY\)/);
  assert.ok(canvas.indexOf('_tapTargetOnCanvas')<canvas.indexOf('_raycaster.setFromCamera(_pointer, camera);\n\n  const meshes'));
  assert.match(source,/priority:50,elements:\[caption,svg,pin\]/);
  assert.match(source,/priority:40,elements:\[p\.labelInner,p\.svgEl\]/);
  assert.match(source,/priority:20,elements:\[label\],activate:\(\)=>label\.click\(\)/);
});

test('script does not forward pointer gestures or issue extra network calls',()=>{
  const applet=read('map-touch-input.js');
  assert.doesNotMatch(applet,/\.dispatchEvent\(|fetch\(|XMLHttpRequest|\.setPointerCapture/);
  assert.match(source,/const _isMobileMapTap = trackMapTaps\(renderer\.domElement\)/);
  assert.match(source,/const controls = new OrbitControls\(camera, renderer\.domElement\)/);
});
