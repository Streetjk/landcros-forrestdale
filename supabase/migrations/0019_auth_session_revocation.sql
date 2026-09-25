-- SiteNav staff auth — revocable sessions.
-- A signed cookie carries this monotonically increasing version. Any PIN
-- reset/change increments it; protected requests also require status=active.
alter table public.profiles
  add column if not exists session_version bigint not null default 0
  check (session_version >= 0);

-- profiles has a self-read RLS policy. Keep the revocation counter server-only
-- even when authenticated clients use PostgREST directly.
revoke select on table public.profiles from anon, authenticated;
grant select (id, email, display_name, status, created_at) on table public.profiles to authenticated;
