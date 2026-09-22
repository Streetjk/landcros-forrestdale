import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { comparePhysicalRecords, validatePhysicalRecord } from '../scripts/qualify-device-perf.mjs';

function record(overrides = {}) {
  const base = {
    schemaVersion: 1,
    evidenceKind: 'physical-device',
    capturedAt: '2026-09-22T23:10:00+08:00',
    buildCommit: 'fed155f17b258fce1d68b5866c6960252ac8a7e7',
    deviceClass: 'lower-end-android',
    deviceModel: 'Test Phone A',
    os: 'Android 14',
    browser: 'Chrome',
    browserVersion: '140.0',
    networkProfile: 'Wi-Fi same access point',
    cacheState: 'cold',
    route: '/?perf=1&perfHud=0',
    viewport: { width: 390, height: 844 },
    gestureProtocol: 'orbit 15s; pinch 15s; hide 30s; resume',
    movingDpr: 'default',
    motionClarity: 'acceptable',
    assetSha256: '7'.repeat(64),
    snapshot: {
      version: 1,
      enabled: true,
      quality: { tier: 'low' },
      device: { devicePixelRatio: 2, deviceMemory: 4, hardwareConcurrency: 8, effectiveType: '4g', saveData: false },
      frames: { movingFrames: 90, movingRenderedFps: 28, movingP50Ms: 30, movingP95Ms: 46 },
      splatUpdate: { count: 40, totalMs: 120, avgMs: 3, maxMs: 8 },
      longTasks: { count: 2, totalMs: 88, maxMs: 50 },
      memory: { samples: 0, lastBytes: null, maxBytes: null, source: null },
      renderer: { pixelRatio: 1, width: 780, height: 1688, drawCalls: 5, triangles: 10, textures: 2, geometries: 3 },
      asset: { selected: 'site-lite.splat', bytes: 8743168 },
      resolutionSwitches: 2,
      events: [
        { name: 'baseGuideReady', t: 700 },
        { name: 'visualReady', t: 2100 },
        { name: 'splatReady', t: 12000 },
        { name: 'visibility', t: 18000, extra: { hidden: true } },
        { name: 'visibility', t: 48000, extra: { hidden: false } },
      ],
    },
  };
  return { ...base, ...overrides };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('valid physical record returns normalized operator-supplied provenance', () => {
  const result = validatePhysicalRecord(record());
  assert.equal(result.provenance, 'physical-device-operator-supplied');
  assert.equal(result.readinessMs.splatReady, 12000);
  assert.equal(result.memory.samples, 0);
  assert.match(result.provenanceWarning, /operator-supplied/);
});

test('synthetic or headless provenance cannot qualify as physical evidence', () => {
  assert.throws(() => validatePhysicalRecord(record({ synthetic: true })), /synthetic evidence/);
  assert.throws(() => validatePhysicalRecord(record({ evidenceKind: 'synthetic-headless-regression' })), /physical-device/);
});

test('full-model qualification requires splatReady and ordered readiness marks', () => {
  const missing = record();
  missing.snapshot.events = missing.snapshot.events.filter(e => e.name !== 'splatReady');
  assert.throws(() => validatePhysicalRecord(missing), /missing splatReady/);
  const outOfOrder = record();
  outOfOrder.snapshot.events.find(e => e.name === 'visualReady').t = 13000;
  assert.throws(() => validatePhysicalRecord(outOfOrder), /baseGuideReady <= visualReady <= splatReady/);
});

test('motion evidence must be sufficiently sampled and internally sane', () => {
  const short = record();
  short.snapshot.frames.movingFrames = 19;
  assert.throws(() => validatePhysicalRecord(short), /movingFrames/);
  const percentile = record();
  percentile.snapshot.frames.movingP95Ms = 20;
  assert.throws(() => validatePhysicalRecord(percentile), /movingP95Ms/);
});

test('browser memory may be explicitly unavailable but not partially fabricated', () => {
  assert.doesNotThrow(() => validatePhysicalRecord(record()));
  const bad = record();
  bad.snapshot.memory.lastBytes = 1234;
  assert.throws(() => validatePhysicalRecord(bad), /unavailable memory/);
});

test('hidden-tab evidence must show hidden then resumed', () => {
  const bad = record();
  bad.snapshot.events = bad.snapshot.events.filter(e => e.name !== 'visibility' || e.extra.hidden !== false);
  assert.throws(() => validatePhysicalRecord(bad), /hidden:true followed by hidden:false/);
});

test('matched default versus 0.75 DPR pair returns paired deltas without automatic promotion', () => {
  const baseline = record();
  const candidate = record({ movingDpr: 0.75 });
  candidate.snapshot = clone(baseline.snapshot);
  candidate.snapshot.frames.movingRenderedFps = 35;
  candidate.snapshot.frames.movingP50Ms = 24;
  candidate.snapshot.frames.movingP95Ms = 38;
  candidate.snapshot.longTasks.totalMs = 70;
  candidate.snapshot.longTasks.maxMs = 45;
  candidate.snapshot.splatUpdate.avgMs = 2.5;
  candidate.snapshot.splatUpdate.maxMs = 7;
  candidate.snapshot.resolutionSwitches = 4;
  candidate.snapshot.events.find(e => e.name === 'splatReady').t = 11900;
  const result = comparePhysicalRecords(baseline, candidate);
  assert.equal(result.deltas.movingRenderedFps, 7);
  assert.equal(result.deltas.movingP95Ms, -8);
  assert.equal(result.deltas.splatReadyMs, -100);
  assert.equal(result.eligibleForHumanPromotionReview, true);
  assert.match(result.note, /does not recommend/);
});

test('A/B comparison rejects changed device, cache, asset/hash or build', () => {
  const baseline = record();
  const candidate = record({ movingDpr: 0.75 });
  for (const mutate of [
    r => { r.deviceModel = 'Different phone'; },
    r => { r.cacheState = 'warm'; },
    r => { r.snapshot.asset.bytes = 5008928; },
    r => { r.assetSha256 = '8'.repeat(64); },
    r => { r.buildCommit = 'abcdef1'; },
  ]) {
    const changed = clone(candidate);
    mutate(changed);
    assert.throws(() => comparePhysicalRecords(baseline, changed), /confounded/);
  }
});

test('A/B comparison rejects wrong DPR pairing', () => {
  assert.throws(() => comparePhysicalRecords(record({ movingDpr: 0.75 }), record({ movingDpr: 0.75 })), /baseline movingDpr=default/);
  assert.throws(() => comparePhysicalRecords(record(), record({ movingDpr: 0.8 })), /candidate movingDpr=0.75/);
});

test('unacceptable moving clarity cannot pass the human-promotion review gate', () => {
  const result = comparePhysicalRecords(record(), record({ movingDpr: 0.75, motionClarity: 'unacceptable' }));
  assert.equal(result.eligibleForHumanPromotionReview, false);
});

test('qualification implementation has no network or browser storage API dependency', () => {
  const source = fs.readFileSync(new URL('../scripts/qualify-device-perf.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /sendBeacon|XMLHttpRequest|WebSocket|localStorage|sessionStorage/);
  assert.doesNotMatch(source, /from ['"](?:https?:|node:http|node:https|node:net|node:dgram)/);
});
