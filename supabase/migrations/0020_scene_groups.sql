-- Scene organisation is personal: deleting a group never deletes scenes.
-- No changes to existing scene rows, share codes, objects or media.
create table if not exists public.scene_groups (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('admin','hazard')),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now(),
  unique(site_id,profile_id,id)
);
create unique index if not exists scene_groups_unique_name
  on public.scene_groups (site_id,profile_id,kind,lower(btrim(name)));

create table if not exists public.scene_group_assignments (
  site_id uuid not null,
  profile_id uuid not null,
  scene_id uuid not null,
  group_id uuid not null,
  primary key (site_id,profile_id,scene_id),
  foreign key (site_id,profile_id,group_id)
    references public.scene_groups(site_id,profile_id,id) on delete cascade,
  foreign key (site_id,scene_id)
    references public.scenes(site_id,id) on delete cascade
);
create index if not exists scene_group_assignments_group_idx
  on public.scene_group_assignments(group_id);
alter table public.scene_groups enable row level security;
alter table public.scene_group_assignments enable row level security;
-- The Node server authenticates and scopes all reads/writes. Supabase anon
-- and authenticated browser users must not access these tables directly.
revoke all on public.scene_groups, public.scene_group_assignments
  from PUBLIC, anon, authenticated;
-- Node's server-side Supabase service role is the sole permitted reader/writer.
grant select,insert,update,delete on
  public.scene_groups, public.scene_group_assignments to service_role;
