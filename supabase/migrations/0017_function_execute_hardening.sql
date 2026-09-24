-- SiteNav — least-privilege EXECUTE grants for SECURITY DEFINER helpers.
--
-- RLS policy helpers still need EXECUTE for the roles whose policies call them.
-- Trigger/server-only functions do not belong on the browser RPC surface.

-- Membership domain guards are authenticated-only. Make policy role scope
-- explicit before removing anon access to user_email_ok().
drop policy if exists members_insert on public.site_members;
create policy members_insert on public.site_members for insert to authenticated
  with check (
    is_site_member(site_id, 'admin')
    and (role <> 'owner' or is_site_member(site_id, 'owner'))
    and user_email_ok(user_id)
  );

drop policy if exists members_update on public.site_members;
create policy members_update on public.site_members for update to authenticated
  using (
    is_site_member(site_id, 'admin')
    and (role <> 'owner' or is_site_member(site_id, 'owner'))
  )
  with check (
    is_site_member(site_id, 'admin')
    and (role <> 'owner' or is_site_member(site_id, 'owner'))
    and user_email_ok(user_id)
  );

-- Trigger-only: callers insert into sites; they never invoke the trigger
-- function directly.
revoke execute on function public.add_owner_membership() from public, anon, authenticated;

-- Authenticated site-creation policy helper only.
revoke execute on function public.current_email() from public, anon;
grant execute on function public.current_email() to authenticated;

-- Authenticated membership-write policy helper only.
revoke execute on function public.user_email_ok(uuid) from public, anon;
grant execute on function public.user_email_ok(uuid) to authenticated;

-- RLS helpers are required by both anon publication reads and authenticated
-- member policies. Remove only the broad PUBLIC grant, then state the exact
-- supported callers explicitly.
revoke execute on function public.is_site_member(uuid, public.site_role) from public;
grant execute on function public.is_site_member(uuid, public.site_role) to anon, authenticated;

revoke execute on function public.contact_is_base_visible(uuid, uuid) from public;
grant execute on function public.contact_is_base_visible(uuid, uuid) to anon, authenticated;

-- Visit increments are server/service only. Explicit revokes are required even
-- if an earlier migration revoked PUBLIC, because role-specific grants may have
-- drifted independently.
revoke execute on function public.increment_visit(uuid, uuid) from public, anon, authenticated;
grant execute on function public.increment_visit(uuid, uuid) to service_role;

-- Remove mutable-search-path linter findings from helper functions used by
-- triggers/policies. These functions do not require caller-controlled schemas.
alter function public.allowed_email_domain() set search_path = pg_catalog;
alter function public.set_updated_at() set search_path = public, pg_temp;
