-- SiteNav platform schema — Phase 1 foundation
-- Multi-tenant: every domain row is scoped by site_id. Isolation is enforced
-- by RLS in 0002_rls.sql, NOT by application code. Do not rely on WHERE site_id
-- in the app for security — it is defence-in-depth only.

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ── Roles ──────────────────────────────────────────────────────────────────
-- Ordered least→most privilege. Membership checks use rank comparison
-- (see is_site_member() in 0002_rls.sql).
create type site_role as enum ('viewer', 'editor', 'admin', 'owner');

-- ── Sites ────────────────────────────────────────────────────────────────
-- One row per navigable site. `config` holds the render-time settings that
-- today live in sites/<slug>/data/config.json (plane, splat, camera, scene,
-- comparison, models). Kept as jsonb so the viewer engine can consume it
-- unchanged during migration.
create table sites (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text not null,
  title       text,
  address     text,
  logo        text,
  config      jsonb not null default '{}'::jsonb,
  published   boolean not null default false, -- gates public/anon read access
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Membership ─────────────────────────────────────────────────────────────
-- Which auth user may act on which site, and at what role. A user with no
-- row here has no admin/editor access to that site (public read still applies
-- to published sites via anon policies).
create table site_members (
  site_id     uuid not null references sites(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        site_role not null default 'viewer',
  created_at  timestamptz not null default now(),
  primary key (site_id, user_id)
);
create index on site_members (user_id);

-- ── Contacts ────────────────────────────────────────────────────────────────
-- Personnel shown on pins. NOTE: contains PII (name/phone/email). Public read
-- is intentional (drivers must call the contact) but scoped to published sites
-- and only the fields the viewer needs — see the public view in 0002_rls.sql.
create table contacts (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  name        text not null,
  role        text,
  phone       text,
  email       text,
  active      boolean not null default true,
  created_by  text,                               -- legacy free-text ("import"/"browser")
  created_at  timestamptz not null default now()
);
create index on contacts (site_id);

-- ── Points (pins) ────────────────────────────────────────────────────────────
-- Interactive map/scene points. Geometry kept as jsonb to match the existing
-- viewer3d.js payload shape exactly (latlng array, position3d {x,y,z}, etc.).
create table points (
  id                uuid primary key default gen_random_uuid(),
  site_id           uuid not null references sites(id) on delete cascade,
  label             text not null,
  type              text not null default 'drop-off',   -- drop-off|collection|both|meet-point
  scope             text not null default 'shared',      -- shared|personal
  latlng            jsonb,                               -- [lat, lng]
  position3d        jsonb,                               -- {x,y,z}
  notes             text,
  contact_ids       uuid[] not null default '{}',
  route_waypoints   jsonb not null default '[]'::jsonb,
  route_waypoints3d jsonb not null default '[]'::jsonb,
  camera_preset3d   jsonb,
  building_ref      text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index on points (site_id);

-- ── Scene objects (forward-looking, editor portal / Phase 2) ─────────────────
-- Generic draggable objects: pin | label | button | widget | model | zone.
-- Unifies today's split-brain (points.json + localStorage labels/routes) into
-- one authoritative, persisted list. `props` is kind-specific; `script_id`
-- links a widget to a sandboxed script (Phase 2). Present now so the schema
-- and RLS are stable before the editor is built.
create table scene_objects (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  kind        text not null check (kind in ('pin','label','button','widget','model','zone')),
  transform   jsonb not null default '{}'::jsonb,  -- position/rotation/scale
  style       jsonb not null default '{}'::jsonb,
  props       jsonb not null default '{}'::jsonb,  -- kind-specific (e.g. stl asset path, action)
  script_id   uuid,                                 -- FK added in a later migration when scripts table exists
  z_index     int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on scene_objects (site_id);

-- ── Audit log (was changelog.json) ───────────────────────────────────────────
create table audit_log (
  id            bigint generated always as identity primary key,
  site_id       uuid not null references sites(id) on delete cascade,
  ts            timestamptz not null default now(),
  changed_by    uuid references auth.users(id) on delete set null,
  action        text not null,                     -- save|delete|publish|...
  entity_type   text not null,                     -- point|contact|scene_object|site
  entity_id     text,
  entity_label  text
);
create index on audit_log (site_id, ts desc);

-- ── Visit analytics (was visits.json) ────────────────────────────────────────
create table visits (
  id          bigint generated always as identity primary key,
  site_id     uuid not null references sites(id) on delete cascade,
  point_id    uuid,                                -- null row = site total
  count       bigint not null default 0,
  first_visit timestamptz,
  last_visit  timestamptz
);
-- point_id may be NULL (the site-total row), so it cannot sit in a PK/unique
-- key directly. Enforce one row per (site, point) — and one total row per site —
-- with a coalesce sentinel unique index.
create unique index visits_site_point_uniq
  on visits (site_id, coalesce(point_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ── Public submissions (forward-looking, automation / Phase 3) ───────────────
-- End-user dropped pin + photo. Anon may INSERT (the public "drop a pin"
-- feature) but never read others' submissions. A submission insert is the
-- event source that Phase 3 webhooks fan out to external APIs.
create table submissions (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  point_label text,
  latlng      jsonb,
  position3d  jsonb,
  photo_path  text,                                -- object-storage key (Supabase Storage)
  meta        jsonb not null default '{}'::jsonb,
  status      text not null default 'new',         -- new|processing|done|rejected
  created_at  timestamptz not null default now()
);
create index on submissions (site_id, created_at desc);

-- ── Events + webhooks (forward-looking, automation / Phase 3) ────────────────
create table events (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  type        text not null,                       -- pin.created|submission.created|...
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index on events (site_id, created_at desc);

create table webhooks (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  url         text not null,
  events      text[] not null default '{}',        -- event type filter
  secret      text,                                -- HMAC signing secret (server-only)
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index on webhooks (site_id);

create table webhook_deliveries (
  id            uuid primary key default gen_random_uuid(),
  webhook_id    uuid not null references webhooks(id) on delete cascade,
  event_id      uuid not null references events(id) on delete cascade,
  status        text not null default 'pending',   -- pending|success|failed|dead
  attempts      int not null default 0,
  last_error    text,
  next_retry_at timestamptz,
  created_at    timestamptz not null default now()
);
create index on webhook_deliveries (status, next_retry_at);

-- ── updated_at maintenance ───────────────────────────────────────────────────
create or replace function set_updated_at() returns trigger
  language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger t_sites_updated   before update on sites         for each row execute function set_updated_at();
create trigger t_points_updated  before update on points        for each row execute function set_updated_at();
create trigger t_scene_updated   before update on scene_objects for each row execute function set_updated_at();
