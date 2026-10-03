-- SiteNav — Photos on admin-map pins
--
-- The admin map (admin3d.html) and the hazard map are separate pin systems:
-- hazard photos hang off scene_objects, admin pins live in the older `points`
-- table. hazard_photos.object_id has a FK to scene_objects, so it cannot hold
-- a point id — hence a parallel table rather than generalising that one. The
-- alternative (dropping that FK and adding a discriminator) would have
-- weakened referential integrity on the hazard side, which already works.
--
--   point_photos   photos attached to a shared admin pin. Two copies live in
--                  the private Supabase Storage bucket "point-photos": a
--                  browser-compressed JPEG (<=300 KB, shown in the panel) and
--                  the untouched original.
--
-- Only SHARED pins can carry photos. Personal pins live solely in the
-- browser's localStorage and have no row here to reference.
--
-- Retention differs from hazard_photos on purpose. Hazard photos are incident
-- evidence and always expire after 30 days; admin pins are permanent site
-- wayfinding, so expires_at is NULLABLE — 30 days by default, NULL meaning
-- "keep indefinitely", chosen per photo. The server's sweep skips NULLs.
--
-- RLS: enabled with NO policies, so only the server's service-role pool can
-- touch it (same model as hazard_photos in 0010 and profile_pins in 0009).

create table point_photos (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references sites(id) on delete cascade,
  point_id       uuid not null references points(id) on delete cascade,
  storage_path   text not null,          -- compressed JPEG shown in the panel
  original_path  text not null,          -- untouched upload
  original_name  text,
  content_type   text not null,          -- of the original
  bytes          int  not null,          -- compressed size
  original_bytes int  not null,
  width          int,
  height         int,
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  -- NULL = keep indefinitely. Nullable is the whole point of this column
  -- differing from hazard_photos.expires_at, which is NOT NULL.
  expires_at     timestamptz default now() + interval '30 days'
);
create index on point_photos (point_id);
create index on point_photos (expires_at);
alter table point_photos enable row level security;
