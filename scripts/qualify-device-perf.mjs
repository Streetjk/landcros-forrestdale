#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEVICE_CLASSES = new Set(['lower-end-android','mid-range-android','older-iphone','high-end-reference']);
const CACHE_STATES = new Set(['cold', 'warm']);
const CLARITY = new Set(['acceptable', 'unacceptable']);
const SHA256_RE = /^[0-9a-f]{64}$/i;
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(message) { throw new Error(message); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}
function string(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string`);
  return value.trim();
}
function finite(value, name, min = -Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(`${name} must be a finite number >= ${min}`);
  return value;
}
function integer(value, name, min = 0) {
  if (!Number.isInteger(value) || value < min) fail(`${name} must be an integer >= ${min}`);
  return value;
}
function event(snapshot, name) { return snapshot.events.find(entry => entry && entry.name === name); }
function readiness(snapshot) {
  const result = {};
  for (const name of ['baseGuideReady', 'visualReady', 'splatReady']) {
    const entry = event(snapshot, name);
    if (!entry) fail(`snapshot.events is missing ${name}`);
    result[name] = finite(entry.t, `${name}.t`, 0);
  }
  if (result.baseGuideReady > result.visualReady || result.visualReady > result.splatReady) {
    fail('readiness marks must satisfy baseGuideReady <= visualReady <= splatReady');
  }
  return result;
}
function visibilityEvidence(snapshot) {
  let hiddenIndex = -1;
  let resumedIndex = -1;
  for (let i = 0; i < snapshot.events.length; i++) {
    const entry = snapshot.events[i];
    if (!entry || entry.name !== 'visibility' || !entry.extra) continue;
    if (entry.extra.hidden === true && hiddenIndex < 0) hiddenIndex = i;
    if (entry.extra.hidden === false && hiddenIndex >= 0 && i > hiddenIndex) { resumedIndex = i; break; }
  }
  if (hiddenIndex < 0 || resumedIndex < 0) fail('snapshot.events must show hidden:true followed by hidden:false');
  return { hiddenIndex, resumedIndex };
}
function validateMemory(snapshot) {
  const memory = object(snapshot.memory, 'snapshot.memory');
  const samples = integer(memory.samples, 'snapshot.memory.samples');
  if (samples === 0) {
    if (memory.lastBytes !== null || memory.maxBytes !== null || memory.source !== null) {
      fail('unavailable memory must use samples=0 with lastBytes/maxBytes/source null');
    }
    return { samples: 0, lastBytes: null, maxBytes: null, source: null };
  }
  return {
    samples,
    lastBytes: finite(memory.lastBytes, 'snapshot.memory.lastBytes', 0),
    maxBytes: finite(memory.maxBytes, 'snapshot.memory.maxBytes', 0),
    source: string(memory.source, 'snapshot.memory.source'),
  };
}

export function validatePhysicalRecord(input) {
  const record = object(input, 'record');
  if (record.synthetic === true) fail('synthetic evidence cannot qualify as physical-device evidence');
  if (record.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (record.evidenceKind !== 'physical-device') fail('evidenceKind must be physical-device');
  const capturedAt = string(record.capturedAt, 'capturedAt');
  if (!ISO_RE.test(capturedAt) || !Number.isFinite(Date.parse(capturedAt))) fail('capturedAt must be an ISO-8601 timestamp with timezone');
  const buildCommit = string(record.buildCommit, 'buildCommit');
  if (!COMMIT_RE.test(buildCommit)) fail('buildCommit must be a 7-40 character hex commit id');
  const deviceClass = string(record.deviceClass, 'deviceClass');
  if (!DEVICE_CLASSES.has(deviceClass)) fail('deviceClass is not recognized');
  const deviceModel = string(record.deviceModel, 'deviceModel');
  const os = string(record.os, 'os');
  const browser = string(record.browser, 'browser');
  const browserVersion = string(record.browserVersion, 'browserVersion');
  const networkProfile = string(record.networkProfile, 'networkProfile');
  if (!CACHE_STATES.has(record.cacheState)) fail('cacheState must be cold or warm');
  const route = string(record.route, 'route');
  const viewport = object(record.viewport, 'viewport');
  const width = finite(viewport.width, 'viewport.width', 1);
  const height = finite(viewport.height, 'viewport.height', 1);
  const gestureProtocol = string(record.gestureProtocol, 'gestureProtocol');
  const movingDpr = record.movingDpr;
  if (movingDpr !== 'default' && !(typeof movingDpr === 'number' && Number.isFinite(movingDpr) && movingDpr >= 0.5 && movingDpr <= 1)) {
    fail('movingDpr must be default or a finite number from 0.5 to 1');
  }
  if (!CLARITY.has(record.motionClarity)) fail('motionClarity must be acceptable or unacceptable');
  const assetSha256 = string(record.assetSha256, 'assetSha256');
  if (!SHA256_RE.test(assetSha256)) fail('assetSha256 must be a SHA-256 hex digest');

  const snapshot = object(record.snapshot, 'snapshot');
  if (snapshot.version !== 1 || snapshot.enabled !== true) fail('snapshot must be enabled viewer-perf version 1');
  if (!Array.isArray(snapshot.events)) fail('snapshot.events must be an array');
  const quality = object(snapshot.quality, 'snapshot.quality');
  const qualityTier = string(quality.tier, 'snapshot.quality.tier');
  const device = object(snapshot.device, 'snapshot.device');
  finite(device.devicePixelRatio, 'snapshot.device.devicePixelRatio', Number.MIN_VALUE);
  const asset = object(snapshot.asset, 'snapshot.asset');
  const assetSelected = string(asset.selected, 'snapshot.asset.selected');
  const assetBytes = finite(asset.bytes, 'snapshot.asset.bytes', 1);
  const ready = readiness(snapshot);

  const frames = object(snapshot.frames, 'snapshot.frames');
  integer(frames.movingFrames, 'snapshot.frames.movingFrames', 20);
  const movingRenderedFps = finite(frames.movingRenderedFps, 'snapshot.frames.movingRenderedFps', Number.MIN_VALUE);
  const movingP50Ms = finite(frames.movingP50Ms, 'snapshot.frames.movingP50Ms', Number.MIN_VALUE);
  const movingP95Ms = finite(frames.movingP95Ms, 'snapshot.frames.movingP95Ms', movingP50Ms);

  const longTasks = object(snapshot.longTasks, 'snapshot.longTasks');
  integer(longTasks.count, 'snapshot.longTasks.count');
  finite(longTasks.totalMs, 'snapshot.longTasks.totalMs', 0);
  finite(longTasks.maxMs, 'snapshot.longTasks.maxMs', 0);
  const splatUpdate = object(snapshot.splatUpdate, 'snapshot.splatUpdate');
  integer(splatUpdate.count, 'snapshot.splatUpdate.count');
  finite(splatUpdate.avgMs, 'snapshot.splatUpdate.avgMs', 0);
  finite(splatUpdate.maxMs, 'snapshot.splatUpdate.maxMs', 0);
  const resolutionSwitches = integer(snapshot.resolutionSwitches, 'snapshot.resolutionSwitches');
  const renderer = object(snapshot.renderer, 'snapshot.renderer');
  finite(renderer.width, 'snapshot.renderer.width', 1);
  finite(renderer.height, 'snapshot.renderer.height', 1);
  const memory = validateMemory(snapshot);
  visibilityEvidence(snapshot);

  return {
    schemaVersion: 1,
    provenance: 'physical-device-operator-supplied',
    provenanceWarning: 'Device identity and physical provenance are operator-supplied and are not cryptographically proven by this tool.',
    capturedAt, buildCommit, deviceClass, deviceModel, os, browser, browserVersion,
    networkProfile, cacheState: record.cacheState, route, viewport: { width, height },
    gestureProtocol, movingDpr, motionClarity: record.motionClarity,
    asset: { selected: assetSelected, bytes: assetBytes, sha256: assetSha256 },
    qualityTier, readinessMs: ready,
    frames: { movingRenderedFps, movingP50Ms, movingP95Ms },
    longTasks: { count: longTasks.count, totalMs: longTasks.totalMs, maxMs: longTasks.maxMs },
    splatUpdate: { count: splatUpdate.count, avgMs: splatUpdate.avgMs, maxMs: splatUpdate.maxMs },
    resolutionSwitches, memory,
  };
}

function same(a, b, label, pick = value => value) {
  if (JSON.stringify(pick(a)) !== JSON.stringify(pick(b))) fail(`A/B comparison is confounded: ${label} differs`);
}
function delta(candidate, baseline) { return Number((candidate - baseline).toFixed(3)); }

export function comparePhysicalRecords(baselineInput, candidateInput) {
  const baseline = validatePhysicalRecord(baselineInput);
  const candidate = validatePhysicalRecord(candidateInput);
  if (baseline.movingDpr !== 'default' || candidate.movingDpr !== 0.75) {
    fail('DPR A/B requires baseline movingDpr=default and candidate movingDpr=0.75');
  }
  for (const field of ['buildCommit','deviceClass','deviceModel','os','browser','browserVersion','networkProfile','cacheState','route','gestureProtocol','qualityTier']) {
    same(baseline, candidate, field, value => value[field]);
  }
  same(baseline, candidate, 'viewport', value => value.viewport);
  same(baseline, candidate, 'asset identity', value => value.asset);

  return {
    comparisonKind: 'physical-device-moving-dpr-ab',
    provenance: 'physical-device-operator-supplied',
    candidateMotionClarity: candidate.motionClarity,
    eligibleForHumanPromotionReview: candidate.motionClarity === 'acceptable',
    note: 'This comparison does not recommend or apply a default DPR change; human visual/performance review remains required.',
    deltas: {
      movingRenderedFps: delta(candidate.frames.movingRenderedFps, baseline.frames.movingRenderedFps),
      movingP50Ms: delta(candidate.frames.movingP50Ms, baseline.frames.movingP50Ms),
      movingP95Ms: delta(candidate.frames.movingP95Ms, baseline.frames.movingP95Ms),
      longTaskTotalMs: delta(candidate.longTasks.totalMs, baseline.longTasks.totalMs),
      longTaskMaxMs: delta(candidate.longTasks.maxMs, baseline.longTasks.maxMs),
      splatUpdateAvgMs: delta(candidate.splatUpdate.avgMs, baseline.splatUpdate.avgMs),
      splatUpdateMaxMs: delta(candidate.splatUpdate.maxMs, baseline.splatUpdate.maxMs),
      resolutionSwitches: candidate.resolutionSwitches - baseline.resolutionSwitches,
      baseGuideReadyMs: delta(candidate.readinessMs.baseGuideReady, baseline.readinessMs.baseGuideReady),
      visualReadyMs: delta(candidate.readinessMs.visualReady, baseline.readinessMs.visualReady),
      splatReadyMs: delta(candidate.readinessMs.splatReady, baseline.readinessMs.splatReady),
    }, baseline, candidate,
  };
}

function loadJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function main(argv = process.argv.slice(2)) {
  const [command, first, second] = argv;
  if (command === 'validate' && first && !second) return validatePhysicalRecord(loadJson(first));
  if (command === 'compare' && first && second) return comparePhysicalRecords(loadJson(first), loadJson(second));
  fail('usage: qualify-device-perf.mjs validate <record.json> | compare <baseline.json> <candidate.json>');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { console.log(JSON.stringify(main(), null, 2)); }
  catch (error) { console.error(`qualification failed: ${error.message}`); process.exitCode = 1; }
}
