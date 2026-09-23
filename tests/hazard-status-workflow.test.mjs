import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  NotificationStatusPartialError,
  notifyThenPersistStatus,
  partialCompletionBody,
} = require('../hazard-status-workflow.js');

const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('notification completes before escalation status is persisted', async () => {
  const calls = [];
  const result = await notifyThenPersistStatus({
    notify: async () => { calls.push('notify'); return { id: 'audit-1', recipients: ['synthetic@example.invalid'] }; },
    persist: async () => { calls.push('persist'); return { status: 'escalated', statusChangedAt: 'now' }; },
  });
  assert.deepEqual(calls, ['notify', 'persist']);
  assert.equal(result.notification.id, 'audit-1');
  assert.equal(result.statusResult.status, 'escalated');
});

test('notification failure never attempts the status write', async () => {  let persistCalls = 0;
  const failure = new Error('synthetic notify failure');
  await assert.rejects(
    notifyThenPersistStatus({
      notify: async () => { throw failure; },
      persist: async () => { persistCalls += 1; },
    }),
    error => error === failure,
  );
  assert.equal(persistCalls, 0);
});

test('status failure after notification becomes an explicit minimal partial completion', async () => {
  let caught;
  try {
    await notifyThenPersistStatus({
      notify: async () => ({ id: 'audit-2', recipients: ['private@example.invalid'], secret: 'not-public' }),
      persist: async () => { throw new Error('synthetic persistence failure'); },
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof NotificationStatusPartialError);
  assert.equal(caught.notificationId, 'audit-2');
  assert.deepEqual(partialCompletionBody(caught), {
    error: 'Notification sent but status update failed',
    code: 'partial-completion',
    notificationId: 'audit-2',
  });
  assert.doesNotMatch(JSON.stringify(partialCompletionBody(caught)), /private@example|not-public/);
});
test('both server escalation entry points use notify-then-persist orchestration', () => {
  const statusStart = serverSource.indexOf('async function _changeStatus');
  const statusEnd = serverSource.indexOf('const _sceneCodeStatusMatch', statusStart);
  const statusBlock = serverSource.slice(statusStart, statusEnd);
  assert.match(statusBlock, /status === 'escalated'[\s\S]*notifyThenPersistStatus\(\{/);
  assert.match(statusBlock, /notify: \(\) => hazardDb\.notifyScene[\s\S]*persist: \(\) => scenesDb\.setSceneStatus/);
  assert.match(statusBlock, /else \{\n      result = await scenesDb\.setSceneStatus/);

  const notifyStart = serverSource.indexOf("const _hazardNotifyMatch");
  const notifyEnd = serverSource.indexOf('// ── Share link store', notifyStart);
  const notifyBlock = serverSource.slice(notifyStart, notifyEnd);
  assert.match(notifyBlock, /notifyThenPersistStatus\(\{[\s\S]*notify: \(\) => hazardDb\.notifyScene[\s\S]*persist: \(\) => scenesDb\.setSceneStatus\(sceneId, 'escalated'/);
  assert.match(notifyBlock, /NotificationStatusPartialError[\s\S]*_partialStatusError\(e, 'direct-notify'\)/);
});

test('partial completion HTTP body is explicit and does not claim successful escalation', () => {
  assert.match(serverSource, /_json\(res, 500, partialCompletionBody\(e\)\)/);
  const helperSource = fs.readFileSync(new URL('../hazard-status-workflow.js', import.meta.url), 'utf8');
  assert.doesNotMatch(helperSource, /escalated:\s*false|notified\s*[:,]/);
});
