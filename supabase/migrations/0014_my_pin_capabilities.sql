-- Per-pin bearer capabilities for account-owned My Pins.
-- Plaintext tokens are never persisted; the server stores SHA-256(token).

create table my_pin_capabilities (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references sites(id) on delete cascade,
  scene_id      uuid not null,
  point_id      uuid not null references points(id) on delete cascade,
  purpose       text not null default 'my-pins-v1' check (purpose = 'my-pins-v1'),
  token_hash    text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  issued_by     uuid not null references profiles(id) on delete restrict,
  issued_at     timestamptz not null default now(),
  revoked_at    timestamptz,
  revoked_by    uuid references profiles(id) on delete set null,
  rotated_from  uuid references my_pin_capabilities(id) on delete set null,
  foreign key (site_id, scene_id)
    references scenes(site_id, id) on delete cascade
);

create unique index my_pin_capabilities_one_active_per_point
  on my_pin_capabilities(point_id)
  where revoked_at is null;

create index my_pin_capabilities_scene_point_idx
  on my_pin_capabilities(site_id, scene_id, point_id);

alter table my_pin_capabilities enable row level security;
-- No browser policy is intentional. Server-side ownership/capability checks
-- mediate all access.
