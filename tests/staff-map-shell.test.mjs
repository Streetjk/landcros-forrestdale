import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shell = require('../staff-map-shell.js');
const staffNav = require('../staff-nav.js');

function response(status, data, { jsonThrows = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (jsonThrows) throw new SyntaxError('bad json');
      return data;
    },
  };
}

function harness(sequence) {
  const calls = [];
  const mounts = [];
  const unmounts = [];
  const doc = { body: { dataset: {} } };
  const nav = {
    normalizeSiteSlug: staffNav.normalizeSiteSlug,
    mount(opts) { mounts.push(opts); return {}; },
    unmount(opts) { unmounts.push(opts); return true; },
  };
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, mounts, unmounts, doc, document: doc, nav, fetchFn };
}

test('anonymous, failed, malformed, or non-staff sessions never mount staff Map navigation', async () => {
  const cases = [
    [response(401, { error: 'Unauthorized' })],
    [response(403, { error: 'Forbidden' })],
    [response(500, { error: 'Internal error' })],
    [response(200, null, { jsonThrows: true })],
    [response(200, { email: 'not-an-email', role: 'editor' })],
    [response(200, { email: 'user@hcma.com.au', role: 'viewer' })],
    [new Error('offline')],
  ];
  for (const sequence of cases) {
    const h = harness([...sequence]);
    assert.equal(await shell.mountAuthenticatedMapNav(h), false);
    assert.equal(h.mounts.length, 0);
    assert.equal(h.calls.length, 1);
    assert.equal(h.doc.body.dataset.staffNavMounted, undefined);
  }
});

test('editor/admin/owner sessions mount Map first, then add Reports only from a validated site slug', async () => {
  for (const role of ['editor', 'admin', 'owner']) {
    const h = harness([
      response(200, { email: 'staff@hcma.com.au', role }),
      response(200, { slug: ' LANDCROS ' }),
    ]);
    assert.equal(await shell.mountAuthenticatedMapNav(h), true);
    assert.deepEqual(h.calls.map(c => c.url), ['/api/auth/me', '/api/site']);
    for (const call of h.calls) {
      assert.equal(call.opts.method, 'GET');
      assert.equal(call.opts.credentials, 'same-origin');
      assert.equal(call.opts.cache, 'no-store');
    }
    assert.equal(h.mounts.length, 2);
    assert.equal(h.mounts[0].currentPage, 'map');
    assert.equal('siteSlug' in h.mounts[0], false);
    assert.equal(h.mounts[1].currentPage, 'map');
    assert.equal(h.mounts[1].siteSlug, 'landcros');
    assert.equal(h.doc.body.dataset.staffNavMounted, 'true');
  }
});

test('site metadata failure or hostile slug keeps authenticated Map on the safe three-item shell', async () => {
  for (const siteReply of [
    response(500, { error: 'unavailable' }),
    response(200, { slug: 'https://evil.invalid' }),
    response(200, { slug: '../landcros' }),
    response(200, null, { jsonThrows: true }),
    new Error('site offline'),
  ]) {
    const h = harness([
      response(200, { email: 'staff@hcma.com.au', role: 'editor' }),
      siteReply,
    ]);
    assert.equal(await shell.mountAuthenticatedMapNav(h), true);
    assert.equal(h.mounts.length, 1);
    assert.equal(h.mounts[0].currentPage, 'map');
    assert.equal(h.doc.body.dataset.staffNavMounted, 'true');
  }
});

test('staff identity validation is narrow and side-effect free', () => {
  assert.equal(shell.isStaffIdentity({ email: 'a@hcma.com.au', role: 'editor' }), true);
  assert.equal(shell.isStaffIdentity({ email: 'a@hcma.com.au', role: 'admin' }), true);
  assert.equal(shell.isStaffIdentity({ email: 'a@hcma.com.au', role: 'owner' }), true);
  for (const value of [null, [], {}, { email: '', role: 'editor' }, { email: 'x', role: 'editor' }, { email: 'a@hcma.com.au', role: 'viewer' }]) {
    assert.equal(shell.isStaffIdentity(value), false);
  }
});


test('failed revalidation clears a previously mounted Map staff shell', async () => {
  const h = harness([
    response(200, { email: 'staff@hcma.com.au', role: 'editor' }),
    response(200, { slug: 'landcros' }),
    response(401, { error: 'Unauthorized' }),
  ]);
  assert.equal(await shell.mountAuthenticatedMapNav(h), true);
  assert.equal(h.doc.body.dataset.staffNavMounted, 'true');
  assert.equal(await shell.mountAuthenticatedMapNav(h), false);
  assert.equal(h.doc.body.dataset.staffNavMounted, undefined);
  assert.equal(h.unmounts.length, 1);
  assert.equal(h.mounts.length, 2);
});

test('explicit clear invalidates a pending site upgrade so Reports cannot remount stale state', async () => {
  let resolveSite;
  const siteReply = new Promise(resolve => { resolveSite = resolve; });
  const h = harness([response(200, { email: 'staff@hcma.com.au', role: 'editor' }), siteReply]);
  const pending = shell.mountAuthenticatedMapNav(h);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.mounts.length, 1);
  shell.clearAuthenticatedMapNav(h);
  resolveSite(response(200, { slug: 'landcros' }));
  assert.equal(await pending, false);
  assert.equal(h.mounts.length, 1);
  assert.equal(h.unmounts.length, 1);
  assert.equal(h.doc.body.dataset.staffNavMounted, undefined);
});