// webhook-delivery.js — outbound HMAC-signed webhook delivery worker (Phase 3).
//
// Polls webhook_deliveries on an interval (see server.js), attempts pending
// or retry-due rows, signs with HMAC-SHA256, and marks success/failed/dead.
// At-least-once delivery: a process restart between "receiver returned 2xx"
// and "UPDATE status='success'" re-delivers next tick — receivers should
// dedupe by the event id in the signed body.
//
// SSRF note: webhook URLs are admin-configured (a higher trust level than
// visitor input, but this app's auth is email-only/unverified, so still
// worth guarding). _isSafeWebhookUrl blocks non-https and literal
// private/loopback/link-local targets; delivery uses redirect:'manual' so a
// URL that passes validation can't hop to an internal target via a 3xx. This
// is a literal-IP + scheme check, not DNS-rebinding-proof — accepted at this
// app's scale (internal small-business tool, admin-trust webhook config).

const crypto = require('crypto');
const net = require('net');
const { pool: sharedPool } = require('./supabase-db');

function _getPool() {
  return sharedPool();
}

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000];
const DELIVERY_BATCH_LIMIT = 50; // bounds one tick's work regardless of backlog size
const RESPONSE_READ_LIMIT = 10_000; // best-effort cap on response bytes buffered per delivery
const REQUEST_TIMEOUT_MS = 5000;

// Deliberately NOT built on net.BlockList with a mixed ipv4/ipv6 rule set —
// adding an IPv4-mapped ::ffff:0:0/96 ipv6 subnet was found (via direct
// testing) to make BlockList#check('<public ipv4>', 'ipv4') return true,
// i.e. it silently blocked ALL ipv4 addresses once that rule existed. Kept
// the ipv6 BlockList to loopback/link-local/ULA only, and handle IPv4-mapped
// IPv6 literals by extracting the embedded IPv4 and checking that separately.
const _ipv6BlockList = new net.BlockList();
_ipv6BlockList.addSubnet('::1', 128, 'ipv6');
_ipv6BlockList.addSubnet('fc00::', 7, 'ipv6');  // unique local
_ipv6BlockList.addSubnet('fe80::', 10, 'ipv6'); // link-local

function _isBlockedIpv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = m.slice(1, 3).map(Number);
  if (a === 127 || a === 10 || a === 0) return true;     // loopback / private / "this network"
  if (a === 172 && b >= 16 && b <= 31) return true;       // private
  if (a === 192 && b === 168) return true;                // private
  if (a === 169 && b === 254) return true;                // link-local
  if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT (100.64.0.0/10)
  return false;
}

// Node's URL parser normalizes IPv4-mapped IPv6 literals to compressed hex
// (e.g. ::ffff:127.0.0.1 → ::ffff:7f00:1), so a dotted-decimal regex alone
// misses most inputs — handle both the hex and (defensively) dotted forms.
function _ipv4MappedToDotted(host) {
  let m = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
  }
  m = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  return m ? m[1] : null;
}

function _isSafeWebhookUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  let host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // URL.hostname keeps IPv6 brackets

  if (net.isIPv4(host)) return !_isBlockedIpv4(host);
  if (net.isIPv6(host)) {
    const mapped = _ipv4MappedToDotted(host);
    if (mapped) return !_isBlockedIpv4(mapped);
    return !_ipv6BlockList.check(host, 'ipv6');
  }
  return true; // a hostname, not a literal IP — DNS-rebinding is an accepted residual risk (see file header)
}

let _running = false;

async function runDeliveryTick() {
  if (_running) return; // one tick's slow deliveries must not overlap the next tick — no dup-select on the same rows
  _running = true;
  try {
    const { rows } = await _getPool().query(
      `select d.id as delivery_id, d.attempts, w.url, w.secret,
              e.id as event_id, e.type, e.payload, e.created_at
       from webhook_deliveries d
       join webhooks w on w.id = d.webhook_id
       join events e on e.id = d.event_id
       where d.status = 'pending' or (d.status = 'failed' and d.next_retry_at <= now())
       order by d.created_at
       limit $1`,
      [DELIVERY_BATCH_LIMIT]
    );
    for (const row of rows) {
      await _attemptDelivery(row);
    }
  } catch (e) {
    console.error('[webhook-delivery] tick error:', e.message);
  } finally {
    _running = false;
  }
}

async function _attemptDelivery(row) {
  const attemptNum = row.attempts + 1;

  if (!_isSafeWebhookUrl(row.url)) {
    await _markDead(row.delivery_id, attemptNum, 'blocked: unsafe webhook URL');
    return;
  }

  // Sign the exact bytes sent, once — never re-stringify before verifying.
  const body = JSON.stringify({ id: row.event_id, type: row.type, payload: row.payload, createdAt: row.created_at });
  const ts = Math.floor(Date.now() / 1000);
  const sig = row.secret
    ? crypto.createHmac('sha256', row.secret).update(`${ts}.${body}`).digest('hex')
    : null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sig ? { 'X-SiteNav-Signature': `t=${ts},v1=${sig}` } : {}),
      },
      body,
      redirect: 'manual', // a 3xx here is a failed delivery, not something we follow
      signal: controller.signal,
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`HTTP ${resp.status}`);
    }
    await _drainCapped(resp);
    await _markSuccess(row.delivery_id, attemptNum);
  } catch (err) {
    await _markFailed(row.delivery_id, attemptNum, err.message || String(err));
  } finally {
    clearTimeout(timeout);
  }
}

// Best-effort cap on response bytes read — a chunk already in flight when the
// cap is hit is still consumed whole, so this bounds most but not all cases.
async function _drainCapped(resp) {
  const reader = resp.body?.getReader?.();
  if (!reader) return;
  try {
    let readBytes = 0;
    while (readBytes < RESPONSE_READ_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      readBytes += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function _markSuccess(deliveryId, attemptNum) {
  await _getPool().query(
    `update webhook_deliveries
     set status = 'success', attempts = $2, last_error = null, next_retry_at = null
     where id = $1`,
    [deliveryId, attemptNum]
  );
}

async function _markFailed(deliveryId, attemptNum, errMsg) {
  if (attemptNum >= MAX_ATTEMPTS) {
    await _getPool().query(
      `update webhook_deliveries set status = 'dead', attempts = $2, last_error = $3 where id = $1`,
      [deliveryId, attemptNum, errMsg]
    );
    return;
  }
  const backoffMs = BACKOFF_MS[Math.min(attemptNum - 1, BACKOFF_MS.length - 1)];
  await _getPool().query(
    `update webhook_deliveries
     set status = 'failed', attempts = $2, last_error = $3, next_retry_at = now() + ($4 || ' milliseconds')::interval
     where id = $1`,
    [deliveryId, attemptNum, errMsg, String(backoffMs)]
  );
}

async function _markDead(deliveryId, attemptNum, errMsg) {
  await _getPool().query(
    `update webhook_deliveries set status = 'dead', attempts = $2, last_error = $3 where id = $1`,
    [deliveryId, attemptNum, errMsg]
  );
}

module.exports = { runDeliveryTick, _isSafeWebhookUrl };
