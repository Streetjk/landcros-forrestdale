import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = name => readFileSync(new URL('../'+name,import.meta.url),'utf8');
const brand = read('site-brand-layout.css');
const detailCss = read('mobile-detail-sheet.css');
const detailJs = read('mobile-detail-sheet.js');
const viewerJs = read('viewer3d.js');

test('logo and address have one fixed top-left anchor in all orientations and states',()=>{
  assert.match(brand,/#app #site-brand\s*\{[^}]*position:\s*fixed !important;[^}]*top:\s*calc\(16px \+ var\(--safe-top,[^}]*left:\s*calc\(16px \+ env\(safe-area-inset-left, 0px\)\) !important;[^}]*right:\s*auto !important;/s);
  assert.match(brand,/#app #site-brand\s*\{[^}]*visibility:\s*visible !important;[^}]*opacity:\s*1 !important;/s);
  assert.match(brand,/#app #site-brand #site-address\s*\{[^}]*text-align:\s*left !important;/s);
  assert.doesNotMatch(detailCss,/#app\.sn-details-active #site-brand\s*\{\s*visibility:\s*hidden\s*!important/);
  assert.doesNotMatch(detailCss,/#app\.sn-details-full #site-brand\s*\{\s*opacity:/);
  for(const page of ['index.html','viewer3d.html']){
    const html=read(page);
    assert.ok(html.indexOf('site-brand-layout.css?v=20261015a')>html.indexOf('mobile-detail-sheet.css?v=20261015b'),page+' brand overrides must load last');
  }
});

test('landscape dismiss keeps only the right drawer tab, portrait retains bottom Locations control',()=>{
  const landscape = detailCss.slice(detailCss.indexOf('@media (max-width:1024px) and (orientation:landscape)'));
  assert.match(landscape,/#app\.sn-details-dismissed #sn-details-browse\s*\{display:none!important;\}/);
  assert.match(landscape,/#app\.sn-details-dismissed #panel-tab\s*\{display:flex!important;right:0!important;\}/);
  assert.match(detailCss,/#app\.sn-details-dismissed #sn-details-browse\s*\{[^}]*display:block;/);
  assert.match(detailJs,/function browseLocations\(\)\s*\{/);
  assert.match(detailJs,/browse\.addEventListener\('click', browseLocations\)/);
  assert.match(detailJs,/Object\.freeze\(\{open,repeat,reset,dismiss,browseLocations,/);
  assert.match(viewerJs,/window\._snShowLocationsFromSideTab = \(\) =>/);
  assert.match(viewerJs,/_mobileDetails\.browseLocations\(\)/);
  for(const page of ['index.html','viewer3d.html']){
    assert.match(read(page),/window\._snShowLocationsFromSideTab\?\.\(\)/);
  }
});
