-- SiteNav browser boundary hardening.
-- Requires 0019 first; production application remains a separate release gate.
-- Architecture boundary: static public reads use anon directly; staff/scoped/My Pins,
-- photos, submissions and hazards are Node/service-role mediated.

-- Remove the broad browser surface inherited from Supabase default grants.
revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- Reassert the exact anonymous static read contract from 0016.
grant select (id, slug, name, title, address, logo, published)
  on table public.sites to anon;
grant select (
  id, site_id, label, type, scope, latlng, position3d, notes,
  contact_ids, route_waypoints, route_waypoints3d, camera_preset3d, building_ref
) on table public.points to anon;
grant select (id, site_id, name, role, phone, active)
  on table public.contacts to anon;

-- Preserve the 0019 self-profile display projection only.
grant select (id, email, display_name, status, created_at)
  on table public.profiles to authenticated;
-- Current public RLS policies can call these helpers while evaluating anon reads.
-- Authenticated browsers have no direct staff table surface, so they do not need them.
grant execute on function public.is_site_member(uuid, public.site_role) to anon;
grant execute on function public.contact_is_base_visible(uuid, uuid) to anon;

-- Keep the server-only RPC explicit after the broad browser EXECUTE revoke.
grant execute on function public.increment_visit(uuid, uuid) to service_role;

-- Future application objects created by the migration role must also default closed.
-- This changes defaults for the role executing 0020 (production migrations currently
-- create public objects as postgres); it intentionally does not attempt to assume
-- supabase_admin, which production postgres cannot do.
alter default privileges in schema public
  revoke all privileges on tables from anon, authenticated;
alter default privileges in schema public
  revoke all privileges on sequences from anon, authenticated;
-- PostgreSQL's built-in PUBLIC EXECUTE default is global. A schema-local
-- REVOKE cannot mask that global default, so close the migration role's global
-- function default first, then also remove any schema-specific browser grants.
alter default privileges
  revoke execute on functions from public;
alter default privileges in schema public
  revoke execute on functions from anon, authenticated;
