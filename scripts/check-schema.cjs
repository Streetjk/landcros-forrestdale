// Optional read-only schema preflight. Takes an already-authorized DB URL from
// the environment, never reads .env files, prints no credentials or row data.
const { Client } = require('pg');
const { classifyDbError } = require('./deployment-diagnostics.cjs');
const required = {
  sites: ['id', 'slug', 'published'], profiles: ['id'], site_members: ['site_id'],
  points: ['id', 'site_id', 'scene_id', 'phone_override'], contacts: ['id', 'site_id'],
  scenes: ['id', 'site_id', 'created_by', 'share_code', 'kind', 'status'],
  scene_objects: ['id', 'site_id', 'scene_id'],
  profile_pins: ['profile_id'], pin_reset_tokens: ['profile_id'],
  point_photos: ['point_id'], hazard_photos: ['scene_id'],
  hazard_notifications: ['scene_id'], scene_subscriptions: ['scene_id', 'profile_id'],
  my_pin_capabilities: ['id', 'site_id', 'scene_id', 'point_id', 'token_hash', 'revoked_at'],
};
const requiredFunctions = [{ name: 'contact_is_base_visible', args: 'cid uuid, sid uuid', result: 'boolean' }];
async function main() {
  if (!process.env.SUPABASE_DB_URL) throw new Error('DB_URL_REQUIRED');
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    await client.query('begin read only');
    await client.query("set local statement_timeout = '5s'");
    const { rows } = await client.query("select table_name,column_name from information_schema.columns where table_schema='public' and table_name=any($1::text[])", [Object.keys(required)]);
    const missing = [];
    for (const [table, columns] of Object.entries(required)) {
      for (const column of columns) if (!rows.some(row => row.table_name === table && row.column_name === column)) missing.push(`${table}.${column}`);
    }
    const fnRes = await client.query("select p.proname, pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])", [requiredFunctions.map(fn => fn.name)]);
    for (const fn of requiredFunctions) {
      if (!fnRes.rows.some(row => row.proname === fn.name && row.args === fn.args && row.result === fn.result)) {
        missing.push(`function:${fn.name}(${fn.args})->${fn.result}`);
      }
    }
    await client.query('rollback');
    console.log(JSON.stringify({ ok: missing.length === 0, missing, note: 'Column presence only; does not certify RLS, constraints, storage or email delivery.' }, null, 2));
    process.exitCode = missing.length ? 1 : 0;
  } finally {
    await client.end();
  }
}
main().catch(error => {
  const diagnosis = classifyDbError(error);
  console.error(JSON.stringify({ ok: false, ...diagnosis }));
  process.exitCode = 1;
});
