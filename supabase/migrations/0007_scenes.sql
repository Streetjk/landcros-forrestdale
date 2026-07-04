-- SiteNav — Scenes (named, shareable, scene-scoped object sets)
--
-- A "scene" is a named set of scene-scoped objects (pins/labels/buttons/
-- widgets) that overlay the base viewer ONLY when opened via the scene's
-- permanent share code. The default viewer stays vanilla — it renders no
-- scene objects at all (see Slice 0: the site-agnostic /api/scene-objects
-- route was removed and the viewer only fetches a scene when ?scene=<code>
-- is present).
--
-- Design (Opus-designed, Fable-reviewed):
--   * scene_objects.scene_id is NOT NULL — a scene object CANNOT exist
--     without a scene, so the vanilla path (which opens no scene) can never
--     render one. This makes the "objects leak onto the default viewer" bug
--     structurally unrepresentable, not merely filtered.
--   * points.scene_id is NULLABLE — NULL = a vanilla base pin (part of the
--     default site), non-NULL = a scene-scoped pin (invisible on vanilla /,
--     reuses the full points machinery: contacts, position3d, rendering).
--   * Both FKs are COMPOSITE (site_id, scene_id) -> scenes(site_id, id), so
--     a pin/object's scene must belong to the SAME site — the cross-tenant
--     guard the scripts FK (0006) established. MATCH SIMPLE (the default)
--     means a NULL scene_id on points skips the FK check — exactly right for
--     base pins.

create table scenes (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  name        text not null,
  share_code  text not null unique,                 -- global opaque capability token (server-generated)
  camera      jsonb,                                 -- nullable {position,lookAt}; applied ONLY on scene-open, never on vanilla /
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (site_id, id)                               -- backs the composite FKs from points + scene_objects
);
create index on scenes (site_id);
create trigger t_scenes_updated before update on scenes
  for each row execute function set_updated_at();

-- ── scene_objects.scene_id (NOT NULL) ─────────────────────────────────────
-- Archive any existing rows first (Fable amendment: free insurance), then
-- delete them — they were experimental base-site objects that the vanilla
-- requirement forbids anyway, and they'd block the NOT NULL add. The backup
-- table is a plain snapshot, no FKs, safe to drop later once confirmed.
create table scene_objects_pre_scenes_backup as select * from scene_objects;
delete from scene_objects;

alter table scene_objects add column scene_id uuid not null;
alter table scene_objects
  add constraint scene_objects_scene_id_fkey
  foreign key (site_id, scene_id) references scenes(site_id, id) on delete cascade;
create index on scene_objects (site_id, scene_id);

-- ── points.scene_id (NULLABLE) ────────────────────────────────────────────
alter table points add column scene_id uuid;
alter table points
  add constraint points_scene_id_fkey
  foreign key (site_id, scene_id) references scenes(site_id, id) on delete cascade;
create index on points (site_id, scene_id);

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Belt-and-suspenders for the inert browser-client scaffold; the server's
-- service-role pool bypasses RLS and enforces authz in application code
-- (server.js), including the public by-code scene read. Editors manage
-- scenes; the public share-code path is server-mediated, not a client policy.
alter table scenes enable row level security;
create policy scenes_read on scenes for select
  using (is_site_member(site_id, 'viewer'));
create policy scenes_write on scenes for all
  using (is_site_member(site_id, 'editor'))
  with check (is_site_member(site_id, 'editor'));
