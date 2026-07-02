-- SiteNav — internal auth profiles
-- Stage 2a: email-only internal login (no password/magic-link). The server
-- authenticates a user by email (see auth-db.js) and creates/looks up a
-- profile row keyed on the auth.users identity. `status` gates access:
--   'pending' — @hcma.com.au email not (yet) found in any site's contacts;
--               no site_members row; awaits admin approval.
--   'active'  — email matched a contacts row (any site); granted editor
--               site_members on each matching site at creation time.
-- RLS: profiles are self-readable only. All writes (insert/approve) go
-- through the server's service-role client (auth-db.js), so there is no
-- client-facing write policy — same pattern as events/webhooks in 0002_rls.sql.

create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null unique,
  display_name text,
  status       text not null default 'pending' check (status in ('pending', 'active')),
  created_at   timestamptz not null default now()
);

alter table profiles enable row level security;

create policy profiles_self_read on profiles for select
  using (id = auth.uid());
