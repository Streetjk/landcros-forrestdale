-- SiteNav Fire Operations: private staff registers, departmental planned hot
-- work, DFES notification receipts, and an append-only change history.
-- All access goes through the existing authenticated SiteNav server. No public
-- API, browser token, anonymous Supabase access, or public map export.

create table fire_hot_works (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  work_date date not null,
  start_time time not null,
  end_time time not null,
  department text not null,
  trade text not null,
  building_ref text not null,
  location_detail text not null,
  description text not null,
  equipment text not null,
  enclosure text not null check (enclosure in ('fully_enclosed','open_workshop','outdoors')),
  vegetation_within_30m boolean,
  dbca_within_3km boolean,
  controls text not null default '',
  fire_watch_employee_id uuid,
  status text not null default 'submitted'
    check (status in ('submitted','under_review','reviewed','notification_recorded','completed','cancelled')),
  not_number text,
  notified_at timestamptz,
  notified_by uuid references profiles(id) on delete set null,
  created_by uuid references profiles(id) on delete set null,
  updated_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time),
  check (status <> 'notification_recorded' or not_number is not null)
);

create table fire_staff (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  employee_number text,
  full_name text not null,
  department text not null,
  trade text not null,
  extinguisher_trained_on date,
  extinguisher_expires_on date,
  fire_watch_trained_on date,
  fire_watch_expires_on date,
  fire_vehicle_trained_on date,
  fire_vehicle_expires_on date,
  bushfire_trained_on date,
  bushfire_expires_on date,
  evidence_reference text not null default '',
  active boolean not null default true,
  notes text not null default '',
  updated_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, employee_number),
  unique (site_id, id)
);

alter table fire_hot_works
  add constraint fire_hot_works_watch_same_site
  foreign key (site_id, fire_watch_employee_id) references fire_staff(site_id,id);

create table fire_extinguishers (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  asset_code text not null,
  type text not null,
  capacity numeric(6,2) not null check (capacity > 0),
  unit text not null check (unit in ('kg','L')),
  building_ref text not null,
  location_detail text not null,
  scene_x numeric(9,3),
  scene_z numeric(9,3),
  inspected_on date,
  inspection_due_on date,
  condition text not null default 'in_service'
    check (condition in ('in_service','out_of_service','missing')),
  notes text not null default '',
  updated_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id,asset_code),
  check ((scene_x is null) = (scene_z is null))
);

create table fire_ops_audit (
  id bigint generated always as identity primary key,
  site_id uuid not null references sites(id) on delete cascade,
  entity text not null check (entity in ('hot_work','staff','extinguisher')),
  entity_id uuid not null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  actor uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index fire_hot_works_site_day_idx on fire_hot_works(site_id,work_date,department);
create index fire_staff_site_trade_idx on fire_staff(site_id,trade,department);
create index fire_extinguishers_site_building_idx on fire_extinguishers(site_id,building_ref);
create index fire_ops_audit_site_recent_idx on fire_ops_audit(site_id,created_at desc);

alter table fire_hot_works enable row level security;
alter table fire_staff enable row level security;
alter table fire_extinguishers enable row level security;
alter table fire_ops_audit enable row level security;

revoke all on fire_hot_works, fire_staff, fire_extinguishers, fire_ops_audit
  from public, anon, authenticated;
revoke all on sequence fire_ops_audit_id_seq from public, anon, authenticated;
