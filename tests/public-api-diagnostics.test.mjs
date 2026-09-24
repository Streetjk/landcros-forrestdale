import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRequestId, writePublicDataUnavailable, writeStaffDataUnavailable } = require('../public-api-diagnostics.js');

function captureResponse() {
  const state = { status: null, headers: null, body: null };
  return {
    state,
    response: {
      writeHead(status, headers) { state.status = status; state.headers = headers; },
      end(body) { state.body = body ?? ''; },
    },
  };
}

function exercise(route, error) {
  const requestId = createRequestId();
  const { state, response } = captureResponse();
  const logs = [];
  writePublicDataUnavailable(response, {
    requestId,
    route,
    site: 'landcros',
    error,
    logger: { error: (...args) => logs.push(args.join(' ')) },
  });
  return { requestId, state, logs };
}

function exerciseStaff(route, error) {
  const requestId = createRequestId();
  const { state, response } = captureResponse();
  const logs = [];
  writeStaffDataUnavailable(response, {
    requestId,
    route,
    site: 'landcros',
    error,
    logger: { error: (...args) => logs.push(args.join(' ')) },
  });
  return { requestId, state, logs };
}

test('public data failure helper returns correlated generic 500 responses and strict safe log fields', () => {
  const secret = 'SENSITIVE_MARKER';
  const pointsError = Object.assign(new Error(`relation failure ${secret}`), {
    name: `DatabaseError-${secret}`,
    code: `42P01-${secret}`,
  });
  const contactsError = Object.assign(new Error(`connection failure ${secret}`), {
    name: `NetworkError-${secret}`,
    code: `ECONNREFUSED-${secret}`,
  });

  const points = exercise('GET-api-points', pointsError);
  const contacts = exercise('GET-api-contacts', contactsError);

  for (const result of [points, contacts]) {
    assert.equal(result.state.status, 500);
    assert.equal(result.state.headers['Content-Type'], 'application/json');
    assert.equal(result.state.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(result.state.headers['X-Request-Id'], result.requestId);
    const body = JSON.parse(result.state.body);
    assert.deepEqual(body, { error: 'PUBLIC_DATA_UNAVAILABLE', requestId: result.requestId });
    assert.equal(JSON.stringify({ headers: result.state.headers, body }).includes(secret), false);
    assert.equal(result.logs.join('\n').includes(secret), false);
    const loggedJson = result.logs[0].slice(result.logs[0].indexOf('{'));
    assert.deepEqual(Object.keys(JSON.parse(loggedJson)).sort(), ['errorKind', 'requestId', 'route', 'site']);
  }

  assert.notEqual(points.requestId, contacts.requestId);
  assert.match(points.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(contacts.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('staff data failure helper returns a private correlated 500 without leaking raw errors', () => {
  const secret = 'STAFF_DB_SECRET_MARKER';
  const result = exerciseStaff('GET-api-sites-contacts', Object.assign(
    new Error(`password=hidden ${secret}`),
    { name: `DatabaseError-${secret}`, code: '28P01' },
  ));

  assert.equal(result.state.status, 500);
  assert.equal(result.state.headers['Content-Type'], 'application/json');
  assert.equal(result.state.headers['X-Request-Id'], result.requestId);
  assert.equal(Object.hasOwn(result.state.headers, 'Access-Control-Allow-Origin'), false);
  const body = JSON.parse(result.state.body);
  assert.deepEqual(body, { error: 'STAFF_DATA_UNAVAILABLE', requestId: result.requestId });
  assert.equal(JSON.stringify({ headers: result.state.headers, body }).includes(secret), false);
  assert.equal(result.logs.join('\n').includes(secret), false);
  assert.match(result.logs[0], /^\[staff-data\] /);
  const loggedJson = result.logs[0].slice(result.logs[0].indexOf('{'));
  assert.deepEqual(JSON.parse(loggedJson), {
    route: 'GET-api-sites-contacts',
    site: 'landcros',
    requestId: result.requestId,
    errorKind: 'database-authentication',
  });
});

test('server wires only public GET point/contact failures to the correlation helper', () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /const requestId = createRequestId\(\);/);
  assert.match(source, /getPoints\(SITE, \{ baseOnly: true \}\)[\s\S]*?writePublicDataUnavailable\(res, \{ requestId, route: 'GET-api-points', site: SITE, error: e \}\)/);
  assert.match(source, /getContacts\(SITE, \{ baseOnly: true \}\)[\s\S]*?writePublicDataUnavailable\(res, \{ requestId, route: 'GET-api-contacts', site: SITE, error: e \}\)/);
  const staffStart = source.indexOf('const staffContactsMatch');
  const staffEnd = source.indexOf('if (handleScenePoints(req, res, url))', staffStart);
  const staffBlock = source.slice(staffStart, staffEnd);
  assert.match(staffBlock, /req\.method === 'GET'[\s\S]*?const requestId = createRequestId\(\);[\s\S]*?sdb\.getContacts\(slug, \{ baseOnly: false \}\)[\s\S]*?writeStaffDataUnavailable\(res, \{[\s\S]*?route: 'GET-api-sites-contacts'[\s\S]*?site: slug[\s\S]*?error: e/);
  assert.match(source, /savePoint\(SITE, point, s\.profileId\)[\s\S]*?_errBody\(e\)/);
  assert.match(source, /sdb\.saveContact\(slug, contact, session\.profileId\)[\s\S]*?_errBody\(e\)/);
  assert.match(source, /pathname === '\/api\/contacts' && req\.method === 'POST'[\s\S]*?req\.resume\(\);[\s\S]*?setHeader\('Allow', 'GET'\)[\s\S]*?405/);
});

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntilReady(origin, child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${origin}/viewer3d.js`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

test('actual HTTP point/contact GET failures expose matching correlation IDs and no local DB marker', async (t) => {
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const marker = 'LOCAL_TEST_DB_MARKER';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      SITE: 'landcros',
      SUPABASE_DB_URL: `postgresql://tester:${marker}@127.0.0.1:1/testdb?connect_timeout=1`,
      PUBLIC_BASE_URL: origin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });

  await waitUntilReady(origin, child);
  const ids = [];
  for (const path of ['/api/points', '/api/contacts']) {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(3000) });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('x-request-id'), body.requestId);
    assert.equal(body.error, 'PUBLIC_DATA_UNAVAILABLE');
    assert.equal(JSON.stringify(body).includes(marker), false);
    ids.push(body.requestId);
  }
  assert.notEqual(ids[0], ids[1]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(output.includes(marker), false);
  assert.match(output, /\[public-data\].*"route":"GET-api-points"/);
  assert.match(output, /\[public-data\].*"route":"GET-api-contacts"/);
});


test('unconfigured public point/contact GETs use the same generic correlated failure contract', async (t) => {
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    SITE: 'landcros',
    PUBLIC_BASE_URL: origin,
  };
  delete env.SUPABASE_DB_URL;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });

  await waitUntilReady(origin, child);
  const ids = [];
  for (const path of ['/api/points', '/api/contacts']) {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(3000) });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('x-request-id'), body.requestId);
    assert.equal(body.error, 'PUBLIC_DATA_UNAVAILABLE');
    assert.equal(JSON.stringify(body).includes('SUPABASE_DB_URL'), false);
    ids.push(body.requestId);
  }
  assert.notEqual(ids[0], ids[1]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(output.includes('SUPABASE_DB_URL'), false);
  assert.match(output, /\[public-data\].*"route":"GET-api-points".*"errorKind":"database-configuration"/);
  assert.match(output, /\[public-data\].*"route":"GET-api-contacts".*"errorKind":"database-configuration"/);
});
