import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const fn = fs.readFileSync('supabase/migrations/0017_function_execute_hardening.sql', 'utf8');
const backup = fs.readFileSync('supabase/migrations/0018_backup_table_lockdown.sql', 'utf8');

test('function hardening keeps required RLS helpers while removing browser RPCs', () => {
  assert.match(fn, /members_insert[\s\S]*for insert to authenticated/);
  assert.match(fn, /members_update[\s\S]*for update to authenticated/);
  assert.match(fn, /revoke execute on function public\.add_owner_membership\(\) from public, anon, authenticated/);
  assert.match(fn, /revoke execute on function public\.current_email\(\) from public, anon/);
  assert.match(fn, /grant execute on function public\.current_email\(\) to authenticated/);
  assert.match(fn, /revoke execute on function public\.user_email_ok\(uuid\) from public, anon/);
  assert.match(fn, /grant execute on function public\.user_email_ok\(uuid\) to authenticated/);
  assert.match(fn, /revoke execute on function public\.increment_visit\(uuid, uuid\) from public, anon, authenticated/);
  assert.match(fn, /grant execute on function public\.increment_visit\(uuid, uuid\) to service_role/);
  for (const helper of ['is_site_member', 'contact_is_base_visible']) {
    assert.match(fn, new RegExp(`revoke execute on function public\\.${helper}`));
    assert.match(fn, new RegExp(`grant execute on function public\\.${helper}[\\s\\S]*to anon, authenticated`));
  }
});

test('backup snapshot is RLS-enabled and has no browser table grants', () => {
  assert.match(backup, /alter table public\.scene_objects_pre_scenes_backup enable row level security/);
  assert.match(backup, /revoke all on table public\.scene_objects_pre_scenes_backup from public, anon, authenticated/);
  assert.doesNotMatch(backup, /create policy/i);
});
