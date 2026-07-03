// webhooks-db.js — server-side CRUD for per-site webhook registrations (Phase 3).
//
// webhooks.secret is an HMAC signing key and must never reach a browser —
// listWebhooks() never selects it; createWebhook() always generates it
// server-side (never accepts a client-supplied value) and is the only path
// that ever returns it, once, at creation.

const { pool: sharedPool, getSiteId, appendAudit } = require('./supabase-db');
const { _isSafeWebhookUrl } = require('./webhook-delivery');
const crypto = require('crypto');

function _getPool() {
  return sharedPool();
}

function webhookToJson(r) {
  return {
    id: r.id,
    url: r.url,
    events: r.events,
    active: r.active,
    createdAt: r.created_at,
  };
}

async function listWebhooks(slug) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    'select id, url, events, active, created_at from webhooks where site_id = $1 order by created_at',
    [siteId]
  );
  return rows.map(webhookToJson);
}

const MAX_EVENTS_LEN = 20;

// events===undefined means "not provided" -> [] (documented "subscribe to
// all event types" default). Anything else that isn't a clean string array
// is rejected outright — silently coercing a malformed value to [] would
// silently broaden the subscription to everything instead of erroring.
function _validateEvents(events) {
  if (events === undefined) return [];
  if (!Array.isArray(events) || events.length > MAX_EVENTS_LEN
      || !events.every(e => typeof e === 'string' && e.length <= 100)) {
    throw new Error('events must be an array of at most 20 strings');
  }
  return events;
}

async function createWebhook(slug, { url, events } = {}, changedBy = null) {
  if (!_isSafeWebhookUrl(url)) throw new Error('url must be https and not a private/loopback/link-local address');
  const eventList = _validateEvents(events);
  const siteId = await getSiteId(slug);
  const secret = crypto.randomBytes(32).toString('hex');
  const { rows } = await _getPool().query(
    `insert into webhooks (site_id, url, events, secret) values ($1, $2, $3, $4)
     returning id, url, events, active, created_at`,
    [siteId, url, eventList, secret]
  );
  await appendAudit(siteId, changedBy, 'create', 'webhook', rows[0].id, url);
  return { ...webhookToJson(rows[0]), secret }; // only place secret is ever returned
}

async function updateWebhook(slug, id, { url, events, active } = {}, changedBy = null) {
  const siteId = await getSiteId(slug);
  if (url !== undefined && !_isSafeWebhookUrl(url)) {
    throw new Error('url must be https and not a private/loopback/link-local address');
  }
  const eventList = events !== undefined ? _validateEvents(events) : undefined;
  const { rows } = await _getPool().query(
    `update webhooks set
       url = coalesce($3, url),
       events = coalesce($4, events),
       active = coalesce($5, active)
     where id = $1 and site_id = $2
     returning id, url, events, active, created_at`,
    [id, siteId, url ?? null, eventList ?? null, active ?? null]
  );
  if (!rows.length) throw new Error(`Webhook ${id} belongs to a different site`);
  await appendAudit(siteId, changedBy, 'update', 'webhook', id, rows[0].url);
  return webhookToJson(rows[0]);
}

async function deleteWebhook(slug, id, changedBy = null) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    'delete from webhooks where id = $1 and site_id = $2 returning url',
    [id, siteId]
  );
  if (rows.length) await appendAudit(siteId, changedBy, 'delete', 'webhook', id, rows[0].url);
}

module.exports = {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
};
