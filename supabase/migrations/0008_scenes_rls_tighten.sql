-- SiteNav — tighten RLS so scene-scoped data is never anon-readable
-- (Scenes feature, Slice 3 — Codex defense-in-depth finding).
--
-- The server uses a service-role pool (bypasses RLS) and enforces authz in
-- application code; the public scene read is the by-code route
-- (getSceneBundleByCode), which is scene+site scoped. The anon/publishable
-- Supabase client is NOT used anywhere live (supabase/db.mjs is inert; the
-- key is never sent to a browser). But these RLS policies still granted anon
-- SELECT on published sites — and since scene_objects.scene_id is now NOT
-- NULL (every object belongs to a scene), that policy would expose EVERY
-- scene's objects (and widget script sources) if the anon key ever leaked,
-- bypassing the "a code authorizes exactly one scene" perimeter via
-- Supabase's own REST API. Same for scripts, and for scene-scoped pins in
-- the points table.
--
-- Fix: remove the published-public read from scene_objects and scripts
-- (member-only now); and exclude scene-scoped pins (scene_id IS NOT NULL)
-- from the points anon-read policy so a scene's shared pins can't be read
-- anonymously via RLS. Base pins (scene_id IS NULL) keep their original
-- anon-read-when-shared-and-published behavior.

-- scene_objects: member-only read (was: published-public OR member).
drop policy scene_read_public on scene_objects;
create policy scene_read_member on scene_objects for select
  using (is_site_member(site_id, 'viewer'));

-- scripts: member-only read (was: published-public OR member).
drop policy scripts_read_public on scripts;
create policy scripts_read_member on scripts for select
  using (is_site_member(site_id, 'viewer'));

-- points: keep base-pin public read, but never anon-expose scene pins.
drop policy points_read_public on points;
create policy points_read_public on points for select
  using (
    (scene_id is null and scope = 'shared'
      and exists (select 1 from sites s where s.id = site_id and s.published))
    or is_site_member(site_id, 'viewer')
  );

-- contacts: keep the intended public read of active contacts on published
-- sites (drivers need phone/email), but exclude "scene-only" contacts —
-- those referenced ONLY by scene-scoped pins and by no base pin — so a
-- scene's contacts can't be read anonymously via RLS. Mirrors the app-layer
-- getContacts({baseOnly}) filter (Codex round-3 defense-in-depth).
--
-- The base-vs-scene test MUST run in a SECURITY DEFINER function (same
-- pattern as is_site_member) so its subquery over `points` bypasses the
-- points RLS above — otherwise, evaluated as anon, the scene pin is hidden
-- by points RLS and "not referenced by any scene pin" wrongly reads true,
-- leaking the scene-only contact. SECURITY DEFINER sees all pins truthfully.
create or replace function public.contact_is_base_visible(cid uuid, sid uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp   -- pin search_path (SECURITY DEFINER injection guard), same as is_site_member
as $$
  select exists (select 1 from public.points p
                   where p.site_id = sid and p.scene_id is null and cid = any(p.contact_ids))
      or not exists (select 1 from public.points p
                   where p.site_id = sid and p.scene_id is not null and cid = any(p.contact_ids));
$$;
revoke all on function public.contact_is_base_visible(uuid, uuid) from public;
grant execute on function public.contact_is_base_visible(uuid, uuid) to authenticated, anon;

drop policy contacts_read_public on contacts;
create policy contacts_read_public on contacts for select
  using (
    (active and exists (select 1 from sites s where s.id = site_id and s.published)
      and public.contact_is_base_visible(id, site_id))
    or is_site_member(site_id, 'viewer')
  );
