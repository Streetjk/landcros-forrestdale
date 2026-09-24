-- SiteNav — restrict direct anonymous reads to the public column contract.
-- RLS limits rows, not columns. The anon role must not retain a table-level
-- SELECT that would make every column on an otherwise-visible row readable.
-- Authenticated privileges are deliberately unchanged.

revoke select on table sites, points, contacts from anon;

-- Also clear any legacy column grants for known staff/audit fields before the
-- explicit public allowlist is applied. These REVOKEs are idempotent.
revoke select (config, created_by, created_at, updated_at) on table sites from anon;
revoke select (scene_id, phone_override, created_by, created_at, updated_at) on table points from anon;
revoke select (email, created_by, created_at) on table contacts from anon;

grant select (
  id, slug, name, title, address, logo, published
) on table sites to anon;

grant select (
  id, site_id, label, type, scope, latlng, position3d, notes,
  contact_ids, route_waypoints, route_waypoints3d, camera_preset3d, building_ref
) on table points to anon;

grant select (
  id, site_id, name, role, phone, active
) on table contacts to anon;
