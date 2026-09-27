import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PUBLIC_BUILDING_DETAIL_FIELDS,
  assessBuildingDetailReadiness,
} from '../location-details.js';
import {
  buildPublicContentReadinessReport,
  runReadiness,
} from '../scripts/public-content-readiness.mjs';
import { shouldProbeStaffSession } from '../public-transport.js';

const productionPath = path.resolve('sites/landcros/data/buildings.geojson');
const fixturePath = path.resolve('tests/fixtures/public-building-details.geojson');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('LANDCROS readiness reports every exact missing details field without mutating labels or positions', () => {
  const source = readJson(productionPath);
  const labelAndPositionBefore = source.features.map(feature => ({
    id: feature.properties.id,
    name: feature.properties.name,
    labelText: feature.properties.labelText,
    pos3d: feature.properties.pos3d,
  }));

  const report = buildPublicContentReadinessReport(source, 'sites/landcros/data/buildings.geojson');
  assert.equal(report.featureCount, 12);
  assert.equal(report.readyCount, 0);
  assert.equal(report.incompleteCount, 12);
  assert.deepEqual(report.contract, PUBLIC_BUILDING_DETAIL_FIELDS);
  for (const building of report.buildings) {
    assert.equal(building.detailsPresent, false);
    assert.deepEqual(building.missingFields, [...PUBLIC_BUILDING_DETAIL_FIELDS]);
    assert.deepEqual(building.invalidFields, []);
    assert.equal(building.ready, false);
  }

  assert.deepEqual(source.features.map(feature => ({
    id: feature.properties.id,
    name: feature.properties.name,
    labelText: feature.properties.labelText,
    pos3d: feature.properties.pos3d,
  })), labelAndPositionBefore);
  assert.doesNotMatch(fs.readFileSync(productionPath, 'utf8'), /Synthetic|fixture-/);
});

test('test-only synthetic fixture exercises complete, missing, and invalid public details', () => {
  const fixture = readJson(fixturePath);
  const report = buildPublicContentReadinessReport(fixture, 'tests/fixtures/public-building-details.geojson');

  assert.deepEqual(report.buildings.map(building => building.id), [
    'fixture-complete', 'fixture-missing', 'fixture-invalid',
  ]);
  assert.equal(report.readyCount, 1);
  assert.equal(report.incompleteCount, 2);
  assert.deepEqual(report.buildings[0].missingFields, []);
  assert.deepEqual(report.buildings[0].invalidFields, []);
  assert.deepEqual(report.buildings[1].missingFields, [...PUBLIC_BUILDING_DETAIL_FIELDS]);
  assert.deepEqual(report.buildings[2].missingFields, []);
  assert.deepEqual(report.buildings[2].invalidFields, ['phone', 'image']);

  const invalidFeature = fixture.features[2];
  const before = JSON.stringify(invalidFeature);
  assessBuildingDetailReadiness(invalidFeature);
  assert.equal(JSON.stringify(invalidFeature), before, 'readiness must not rewrite fixture data');
});

test('readiness CLI can preview a separate fixture and fail checks without writing it', () => {
  const output = [];
  const status = runReadiness(['--input', fixturePath, '--json', '--check'], { log: value => output.push(value) });
  assert.equal(status, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.source, 'tests/fixtures/public-building-details.geojson');
  assert.equal(report.incompleteCount, 2);
  assert.equal(fs.existsSync(fixturePath), true);
});

test('static visitor media boundary prevents private/staff point-media fetches', () => {
  const viewer = fs.readFileSync('viewer3d.js', 'utf8');
  const mediaStart = viewer.indexOf('async function _renderPointPhotos');
  const mediaEnd = viewer.indexOf('async function selectPoint', mediaStart);
  assert.ok(mediaStart >= 0 && mediaEnd > mediaStart, 'point media renderer boundary must remain discoverable');
  const mediaBlock = viewer.slice(mediaStart, mediaEnd);
  const guard = mediaBlock.indexOf('if (!shouldProbeStaffSession(_publicRuntime, window.location)) return;');
  const staffListFetch = mediaBlock.indexOf('list = await fetch(_apiUrl(`/api/sites/');
  assert.ok(guard >= 0, 'static visitor guard is required');
  assert.ok(staffListFetch > guard, 'staff photo metadata must remain behind the static visitor guard');
  assert.doesNotMatch(mediaBlock.slice(0, guard), /fetch\(/, 'static visitor path must return before private-media fetches');

  const runtime = {
    siteSlug: 'landcros',
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz123456',
    apiOrigin: 'https://api.example.test',
  };
  assert.equal(shouldProbeStaffSession(runtime, { href: 'https://static.example.test/' }), false);
  assert.equal(shouldProbeStaffSession(runtime, { href: 'https://api.example.test/' }), true);
});

test('readiness rejects malformed collections and empty check never passes', () => {
  for (const invalid of [null, {}, [], { type: 'FeatureCollection', features: {} }]) {
    assert.throws(() => buildPublicContentReadinessReport(invalid), /PUBLIC_CONTENT_INVALID_FEATURE_COLLECTION/);
  }

  const completeFeature = readJson(fixturePath).features[0];
  for (const invalidFeature of [
    completeFeature.properties,
    { ...completeFeature, type: 'Point' },
    { ...completeFeature, properties: null },
    { ...completeFeature, geometry: null },
    { ...completeFeature, geometry: {} },
    { ...completeFeature, geometry: { type: 'Point', coordinates: [115.95] } },
    { ...completeFeature, geometry: { type: 'Unknown', coordinates: [115.95, -32.14] } },
  ]) {
    assert.throws(
      () => buildPublicContentReadinessReport({ type: 'FeatureCollection', features: [invalidFeature] }),
      /PUBLIC_CONTENT_INVALID_FEATURE/,
    );
  }

  const emptyPath = path.resolve('tests/fixtures/public-building-details-empty.tmp.geojson');
  fs.writeFileSync(emptyPath, JSON.stringify({ type: 'FeatureCollection', features: [] }));
  try {
    const output = [];
    const status = runReadiness(['--input', emptyPath, '--json', '--check'], { log: value => output.push(value) });
    assert.equal(status, 1);
    const report = JSON.parse(output[0]);
    assert.equal(report.featureCount, 0);
    assert.equal(report.readyCount, 0);
  } finally {
    fs.rmSync(emptyPath, { force: true });
  }
});
