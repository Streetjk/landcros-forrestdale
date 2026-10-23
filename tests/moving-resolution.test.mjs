import assert from 'node:assert/strict';
import test from 'node:test';
import { createMovingResolutionPolicy } from '../moving-resolution.js';

function runMotion(policy, intervalMs, frames, startAt = 1000) {
  let decision = null;
  for (let i = 0; i < frames; i++) {
    const result = policy.observeFrame(startAt + intervalMs * i, true, true);
    if (result) decision = result;
  }
  return decision;
}

test('high-tier sustained slow movement learns 0.65, without reducing the still-image DPR', () => {
  const policy = createMovingResolutionPolicy({ tier: 'high', pixelRatio: 1.28125 });
  assert.equal(policy.adaptive, true);
  assert.equal(policy.movingDpr, 1);
  assert.equal(runMotion(policy, 38, 18), null);
  const result = policy.observeFrame(1000 + 38 * 18, true, true);
  assert.equal(result.previousDpr, 1);
  assert.equal(result.movingDpr, 0.65);
  assert.equal(result.samples, 18);
  assert.equal(policy.movingDpr, 0.65);
  // The viewer restores 1.28125 on idle; the policy only sets moving DPR.
  assert.equal(runMotion(policy, 45, 30), null);
  assert.equal(policy.movingDpr, 0.65);
});

test('fast 60 Hz motion stays sharp, a later slow gesture triggers once', () => {
  const policy = createMovingResolutionPolicy({ tier: 'high', pixelRatio: 1.5 });
  assert.equal(runMotion(policy, 16.67, 100), null);
  assert.equal(policy.movingDpr, 1);
  policy.observeFrame(2700, false);
  assert.equal(runMotion(policy, 33.34, 19, 2800).movingDpr, 0.65);
});

test('no degradation during initial model load, short bursts or hidden/resumed frames', () => {
  const policy = createMovingResolutionPolicy({ tier: 'high', pixelRatio: 1.28125 });
  for (let i = 0; i < 50; i++) policy.observeFrame(i * 40, true, false);
  assert.equal(policy.movingDpr, 1);
  assert.equal(runMotion(policy, 44, 10, 2500), null);
  policy.observeFrame(3000, false, true);
  assert.equal(runMotion(policy, 44, 9, 3500), null);
  policy.resetSamples();
  assert.equal(runMotion(policy, 44, 9, 10000), null);
  assert.equal(policy.movingDpr, 1);
});

test('one unrelated long-task pause does not trigger motion downgrading', () => {
  const policy = createMovingResolutionPolicy({ tier: 'high', pixelRatio: 1.5 });
  assert.equal(runMotion(policy, 16.67, 50), null);
  policy.observeFrame(3000, true, true); // gap over 110ms resets window
  assert.equal(runMotion(policy, 16.67, 50, 3016.67), null);
  assert.equal(policy.movingDpr, 1);
});

test('perf-only overrides remain fixed and prevent automatic selection', () => {
  for (const overrideDpr of [1, 0.75, 0.65, 0.5]) {
    const policy = createMovingResolutionPolicy({ tier: 'high', pixelRatio: 1.28125, overrideDpr });
    assert.equal(policy.adaptive, false);
    assert.equal(runMotion(policy, 45, 50), null);
    assert.equal(policy.movingDpr, overrideDpr);
  }
});

test('mid/low tiers and existing <=0.75 DPR do not adapt', () => {
  for (const [tier, pixelRatio] of [['medium', 1.2], ['low', 1], ['high', 0.7]]) {
    const policy = createMovingResolutionPolicy({ tier, pixelRatio });
    assert.equal(policy.adaptive, false);
    assert.equal(runMotion(policy, 45, 50), null);
    assert.equal(policy.movingDpr, Math.min(pixelRatio, 1));
  }
});
