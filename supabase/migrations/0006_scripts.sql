-- SiteNav — sandboxed widget scripts (Phase 2 Slice 4 remainder)
--
-- Backs the 'widget' scene_objects kind: an admin-authored JS source string
-- that runs, sandboxed (opaque-origin iframe, whitelisted postMessage API —
-- see viewer3d.js), when a visitor interacts with the attached widget.
--
-- Unlike webhooks.secret (server-only, never reaches a browser), a script's
-- source MUST reach the visitor's browser to execute at all — there is no
-- secret to protect here. RLS mirrors scene_objects: public read on
-- published sites (or viewer+ membership), admin+ write (scripts are
-- admin-authored, security-sensitive behavior — same trust tier as
-- webhooks, not the general editor+ tier scene objects otherwise use).

create table scripts (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  name        text not null,
  source      text not null,
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (site_id, id) -- lets scene_objects' FK below require same-site, not just any script id
);
create index on scripts (site_id);

create trigger t_scripts_updated before update on scripts
  for each row execute function set_updated_at();

-- Deferred FK from 0001_schema.sql now that scripts exists. Composite on
-- (site_id, script_id) — not just script_id — so a scene_object can only
-- reference a script belonging to ITS OWN site; a plain script_id-only FK
-- would let an editor on site A point a widget at a script UUID borrowed
-- from site B, and listSceneObjects' join would then leak site B's script
-- source into site A's response. ON DELETE SET NULL (script_id) only nulls
-- the script reference, never scene_objects.site_id (which is NOT NULL and
-- must never be touched by this cascade) — needs Postgres 15+ for the
-- column-scoped SET NULL syntax; this project runs Postgres 17.
alter table scene_objects
  add constraint scene_objects_script_id_fkey
  foreign key (site_id, script_id) references scripts(site_id, id)
  on delete set null (script_id);

alter table scripts enable row level security;

create policy scripts_read_public on scripts for select
  using (
    exists (select 1 from sites s where s.id = site_id and s.published)
    or is_site_member(site_id, 'viewer')
  );
create policy scripts_write on scripts for all
  using (is_site_member(site_id, 'admin'))
  with check (is_site_member(site_id, 'admin'));
