import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { buildNotificationContent, selectNotificationAttachments } = require('../hazard-notification.js');

const base = {
  retentionDays: 30,
  allowedDomain: 'hcma.com.au',
  shareUrl: 'https://example.invalid/s/demo',
  objects: [
    { id: 'a', props: { title: 'Oil spill', description: 'Near bay 2' } },
    { id: 'b', props: {} },
  ],
  photos: [
    { id: 'p1', object_id: 'a' },
    { id: 'p2', object_id: 'a' },
    { id: 'p3', object_id: 'b' },
  ],
};

test('hazard notification content preserves subject, counts, defaults and retention wording', () => {
  const result = buildNotificationContent({
    ...base,
    scene: { kind: 'hazard', name: 'Workshop hazards' },
    message: 'Please review today.',
    skippedCount: 2,
  });
  assert.equal(result.subject, 'Hazard report: Workshop hazards');
  assert.match(result.text, /Hazard report "Workshop hazards" \(2 pins\)\./);
  assert.match(result.text, /Oil spill \(2 photos\)\n  Near bay 2/);
  assert.match(result.text, /Hazard 2 \(1 photo\)/);
  assert.match(result.text, /2 photo\(s\) exceeded the email size limit/);
  assert.match(result.text, /Photos are kept for 30 days\./);
  assert.match(result.html, /Sign-in with your @hcma\.com\.au email is required\./);
  assert.deepEqual(result.lines[1], { title: 'Hazard 2', description: '', photoCount: 1 });
});

test('admin notification content uses map-sharing wording', () => {
  const result = buildNotificationContent({
    ...base,
    scene: { kind: 'admin', name: 'Visitor route' },
    objects: [],
    photos: [],
    skippedCount: 0,
  });
  assert.equal(result.subject, 'Map shared with you: Visitor route');
  assert.match(result.text, /"Visitor route" has been escalated to you\./);
  assert.match(result.html, /Sign in with your @hcma\.com\.au email to add it to your list and update its status\./);
  assert.doesNotMatch(result.text, /exceeded the email size limit/);
});

test('HTML escapes scene, pin, description, message and share URL while text remains plain', () => {
  const marker = `<img src=x onerror="boom"> & 'quoted'`;
  const result = buildNotificationContent({
    retentionDays: 30,
    allowedDomain: 'hcma.com.au',
    scene: { kind: 'hazard', name: marker },
    objects: [{ id: 'x', props: { title: marker, description: marker } }],
    photos: [],
    message: marker,
    shareUrl: 'https://example.invalid/?a=1&b="two"',
  });
  assert.doesNotMatch(result.html, /<img src=x/);
  assert.match(result.html, /&lt;img src=x onerror=&quot;boom&quot;&gt; &amp; &#39;quoted&#39;/);
  assert.match(result.html, /href="https:\/\/example\.invalid\/\?a=1&amp;b=&quot;two&quot;"/);
  assert.match(result.text, /<img src=x onerror="boom">/);
});

test('attachment selection respects the running cap and returns skipped photos deterministically', () => {
  const photos = [
    { id: 'a', original_bytes: 4 },
    { id: 'b', original_bytes: 5 },
    { id: 'c', original_bytes: 2 },
  ];
  const result = selectNotificationAttachments(photos, { maxTotalBytes: 10, currentBytes: 1 });
  assert.deepEqual(result.selected.map((p) => p.id), ['a', 'b']);
  assert.deepEqual(result.skipped.map((p) => p.id), ['c']);
  assert.equal(result.totalBytes, 10);
});

test('attachment selection accepts camelCase fixture byte counts', () => {
  const result = selectNotificationAttachments([
    { id: 'a', originalBytes: 6 },
    { id: 'b', originalBytes: 5 },
  ], { maxTotalBytes: 10 });
  assert.deepEqual(result.selected.map((p) => p.id), ['a']);
  assert.deepEqual(result.skipped.map((p) => p.id), ['b']);
});

test('notification helper stays pure and dependency-free', async () => {
  const source = await readFile(new URL('../hazard-notification.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /\bfetch\s*\(|createClient|mailer|process\.env|\.query\s*\(/);
});
