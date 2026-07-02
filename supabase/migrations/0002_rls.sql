-- SiteNav platform — Row-Level Security
-- Isolation model: every site-scoped table is readable/writable only by members
-- of that site at a sufficient role, EXCEPT deliberate public (anon) read of
-- PUBLISHED sites' viewer data, and deliberate public INSERT of submissions.
-- The Supabase service_role key bypasses RLS — all server-mediated writes
-- (visit counters, event emission, webhook delivery) use it and enforce
-- authorization in application code.

-- ── Membership helper ────────────────────────────────────────────────────────
-- SECURITY DEFINER so the function body bypasses RLS on site_members; this is
-- what prevents infinite recursion when site_members' own policies call it.
-- Enum comparison uses declaration order: viewer < editor < admin < owner.
create or replace function is_site_member(sid uuid, min_role site_role)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.site_members m
    where m.site_id = sid
      and m.user_id = auth.uid()
      and m.role >= min_role
  );
$$;

revoke all on function is_site_member(uuid, site_role) from public;
grant execute on function is_site_member(uuid, site_role) to authenticated, anon;

-- Auto-grant owner membership to a site's creator (bypasses RLS via definer).
create or replace function add_owner_membership()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if new.created_by is not null then
    insert into public.site_members (site_id, user_id, role)
    values (new.id, new.created_by, 'owner')
    on conflict (site_id, user_id) do nothing;
  end if;
  return new;
end $$;

create trigger t_sites_owner after insert on sites
  for each row execute function add_owner_membership();

-- ── Enable RLS everywhere ────────────────────────────────────────────────────
alter table sites               enable row level security;
alter table site_members        enable row level security;
alter table contacts            enable row level security;
alter table points              enable row level security;
alter table scene_objects       enable row level security;
alter table audit_log           enable row level security;
alter table visits              enable row level security;
alter table submissions         enable row level security;
alter table events              enable row level security;
alter table webhooks            enable row level security;
alter table webhook_deliveries  enable row level security;

-- ── sites ────────────────────────────────────────────────────────────────────
create policy sites_read_public on sites for select
  using (published or is_site_member(id, 'viewer'));
-- Any signed-in user may create a site; created_by must be themselves so the
-- owner-membership trigger grants them ownership (they cannot forge authorship).
create policy sites_insert on sites for insert to authenticated
  with check (created_by = auth.uid());
create policy sites_update on sites for update
  using (is_site_member(id, 'admin')) with check (is_site_member(id, 'admin'));
create policy sites_delete on sites for delete
  using (is_site_member(id, 'owner'));

-- ── site_members ─────────────────────────────────────────────────────────────
-- Members can see the roster of sites they belong to; admins manage it.
create policy members_read on site_members for select
  using (is_site_member(site_id, 'viewer'));
-- Admins manage viewer/editor/admin rows, but ONLY owners may create, modify,
-- or delete an `owner` row (or promote anyone — including themselves — to owner).
-- This keeps the admin/owner boundary intact: an admin cannot self-escalate to
-- owner and then delete the site.
create policy members_insert on site_members for insert
  with check (
    is_site_member(site_id, 'admin')
    and (role <> 'owner' or is_site_member(site_id, 'owner'))
  );
create policy members_update on site_members for update
  using (
    is_site_member(site_id, 'admin')
    and (role <> 'owner' or is_site_member(site_id, 'owner'))
  )
  with check (
    is_site_member(site_id, 'admin')
    and (role <> 'owner' or is_site_member(site_id, 'owner'))
  );
create policy members_delete on site_members for delete
  using (
    is_site_member(site_id, 'admin')
    and (role <> 'owner' or is_site_member(site_id, 'owner'))
  );

-- ── contacts ───────────────────────────────────────────────────────────────
-- PUBLIC read of active contacts on published sites is intentional: the viewer
-- shows a contact's phone/email so drivers can call. Scoped to published+active.
create policy contacts_read_public on contacts for select
  using (
    (active and exists (select 1 from sites s where s.id = site_id and s.published))
    or is_site_member(site_id, 'viewer')
  );
create policy contacts_write on contacts for all
  using (is_site_member(site_id, 'editor'))
  with check (is_site_member(site_id, 'editor'));

-- ── points ───────────────────────────────────────────────────────────────────
-- Public sees only SHARED points on published sites; personal-scope pins and
-- unpublished sites stay member-only.
create policy points_read_public on points for select
  using (
    (scope = 'shared' and exists (select 1 from sites s where s.id = site_id and s.published))
    or is_site_member(site_id, 'viewer')
  );
create policy points_write on points for all
  using (is_site_member(site_id, 'editor'))
  with check (is_site_member(site_id, 'editor'));

-- ── scene_objects ─────────────────────────────────────────────────────────────
create policy scene_read_public on scene_objects for select
  using (
    exists (select 1 from sites s where s.id = site_id and s.published)
    or is_site_member(site_id, 'viewer')
  );
create policy scene_write on scene_objects for all
  using (is_site_member(site_id, 'editor'))
  with check (is_site_member(site_id, 'editor'));

-- ── audit_log ─────────────────────────────────────────────────────────────────
-- Append-only: admins read, editors may insert their own actions, no update/delete.
create policy audit_read on audit_log for select
  using (is_site_member(site_id, 'admin'));
create policy audit_insert on audit_log for insert
  with check (is_site_member(site_id, 'editor'));

-- ── visits ────────────────────────────────────────────────────────────────────
-- Analytics: members read only. All increments go through the server
-- (service_role), which bypasses RLS — so no anon/authenticated write policy.
-- This closes the old "public POST can write arbitrary visit counts" hole.
create policy visits_read on visits for select
  using (is_site_member(site_id, 'viewer'));

-- ── submissions ──────────────────────────────────────────────────────────────
-- The public "drop a pin + photo" feature: anon may INSERT against a PUBLISHED
-- site, but may never read submissions. Staff (editor+) read and triage.
create policy submissions_public_insert on submissions for insert to anon, authenticated
  with check (
    status = 'new'
    and exists (select 1 from sites s where s.id = site_id and s.published)
  );
create policy submissions_staff_read on submissions for select
  using (is_site_member(site_id, 'editor'));
create policy submissions_staff_update on submissions for update
  using (is_site_member(site_id, 'editor')) with check (is_site_member(site_id, 'editor'));

-- ── events / webhooks / webhook_deliveries ───────────────────────────────────
-- SERVER-ONLY. RLS is enabled with NO client policies, so anon/authenticated
-- get zero rows and cannot write. Only the service_role (server) touches these.
-- Rationale: webhooks.secret is an HMAC signing key and must never reach a
-- browser; keeping the whole table service-role-only avoids column-masking.
-- The admin dashboard reads/writes webhooks via a server endpoint that checks
-- is_site_member(admin) in application code before using the service key.
