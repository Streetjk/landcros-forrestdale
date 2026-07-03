// events-db.js — server-side event emission + eager webhook fan-out (Phase 3).
//
// emitEvent() writes to `events` then creates one `webhook_deliveries` row per
// active webhook subscribed to that event type, all in one transaction so a
// mid-fanout failure can't strand an event with partial deliveries. Eager
// fan-out (not a lazy cursor worker) is the right call at this scale — sites
// realistically have 0-2 webhooks each.
//
// events/webhooks/webhook_deliveries have RLS enabled with zero client
// policies (see 0002_rls.sql) — service-role only, by design, since
// webhooks.secret is an HMAC key that must never reach a browser.

const { pool: sharedPool, j } = require('./supabase-db');

function _getPool() {
  return sharedPool();
}

// A webhook's events[] defaults to '{}' (see 0001_schema.sql). This module
// treats an empty filter as "subscribed to all event types" — a documented
// choice, not an accident of the schema default (see webhook CRUD validation
// in server.js, which surfaces this to the admin creating the webhook).
async function emitEvent(siteId, type, payload) {
  const client = await _getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: eventRows } = await client.query(
      `insert into events (site_id, type, payload) values ($1, $2, $3::jsonb) returning id`,
      [siteId, type, j(payload ?? {})]
    );
    const eventId = eventRows[0].id;
    const { rows: webhooks } = await client.query(
      `select id from webhooks where site_id = $1 and active = true and (events = '{}' or $2 = any(events))`,
      [siteId, type]
    );
    for (const wh of webhooks) {
      await client.query(
        `insert into webhook_deliveries (webhook_id, event_id, status) values ($1, $2, 'pending')`,
        [wh.id, eventId]
      );
    }
    await client.query('COMMIT');
    return eventId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { emitEvent };
