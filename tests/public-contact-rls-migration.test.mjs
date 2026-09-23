import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/0015_public_contact_shared_base_scope.sql', 'utf8');
const normalized = migration.replace(/\s+/g, ' ');

test('contact RLS helper requires an explicitly shared base point reference', () => {
  assert.match(normalized, /create or replace function public\.contact_is_base_visible\(cid uuid, sid uuid\)/i);
  assert.match(normalized, /where p\.site_id = sid and p\.scene_id is null and p\.scope = 'shared' and cid = any\(p\.contact_ids\)/i);
  assert.doesNotMatch(normalized, /or not exists/i);
});

test('contact RLS helper retains hardened SECURITY DEFINER execution grants', () => {
  assert.match(normalized, /security definer set search_path = public, pg_temp/i);
  assert.match(normalized, /revoke all on function public\.contact_is_base_visible\(uuid, uuid\) from public/i);
  assert.match(normalized, /grant execute on function public\.contact_is_base_visible\(uuid, uuid\) to authenticated, anon/i);
  assert.doesNotMatch(normalized, /alter table|drop table|delete from|truncate/i);
});
