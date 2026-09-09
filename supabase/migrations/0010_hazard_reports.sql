-- SiteNav — Hazard report map
--
-- The hazard map is the SAME scenes machinery as the admin map (a named,
-- shareable set of scene objects opened via a share code) with one extra
-- object kind and two side tables. Keeping it on scenes rather than a
-- parallel schema is what keeps the two maps identical by construction.
--
--   scenes.kind          'admin' (default, public share link) or 'hazard'
--                        (share link requires an @hcma.com.au session; the
--                        server enforces this in the by-code route).
--   scene_objects.kind   gains 'hazard' — a pin whose props hold
--                        { title, description, recipients[] }.
--   hazard_photos        photos attached to a hazard object. Two copies live
--                        in the private Supabase Storage bucket
--                        "hazard-photos": a browser-compressed JPEG (<=300 KB,
--                        shown in the viewer) and the untouched original
--                        (attached to the notification email). Both are
--                        deleted after 30 days by the server's hourly sweep.
--   hazard_notifications audit of every "send report" — who, to whom, when.
--
-- RLS: both new tables are enabled with NO policies, so only the server's
-- service-role pool can touch them (same model as profile_pins in 0009).

alter table scenes
  add column kind text not null default 'admin' check (kind in ('admin', 'hazard'));
create index on scenes (site_id, kind);

alter table scene_objects drop constraint scene_objects_kind_check;
alter table scene_objects
  add constraint scene_objects_kind_check
  check (kind in ('pin','label','button','widget','model','zone','hazard'));

create table hazard_photos (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references sites(id) on delete cascade,
  scene_id      uuid not null,
  object_id     uuid not null references scene_objects(id) on delete cascade,
  storage_path  text not null,          -- compressed JPEG shown in the viewer
  original_path text not null,          -- untouched upload, emailed as attachment
  original_name text,
  content_type  text not null,          -- of the original
  bytes         int  not null,          -- compressed size
  original_bytes int not null,
  width         int,
  height        int,
  created_by    uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '30 days',
  foreign key (site_id, scene_id) references scenes(site_id, id) on delete cascade
);
create index on hazard_photos (object_id);
create index on hazard_photos (expires_at);
alter table hazard_photos enable row level security;

create table hazard_notifications (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references sites(id) on delete cascade,
  scene_id    uuid not null,
  recipients  text[] not null,
  message     text,
  photo_count int not null default 0,
  sent_by     uuid references profiles(id) on delete set null,
  sent_at     timestamptz not null default now(),
  provider_id text,
  foreign key (site_id, scene_id) references scenes(site_id, id) on delete cascade
);
create index on hazard_notifications (scene_id, sent_at desc);
alter table hazard_notifications enable row level security;
