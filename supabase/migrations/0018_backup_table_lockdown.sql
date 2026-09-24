-- SiteNav — quarantine the pre-scenes backup snapshot from browser roles.
-- The table is retained temporarily for rollback/forensics but is not a product
-- surface. No RLS policies are intentional: browser roles should see nothing.

alter table public.scene_objects_pre_scenes_backup enable row level security;
revoke all on table public.scene_objects_pre_scenes_backup from public, anon, authenticated;
