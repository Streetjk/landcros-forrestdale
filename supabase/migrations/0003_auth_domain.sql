-- SiteNav — corporate domain restriction
-- Business rule: only Hitachi Construction Machinery Australia staff may own
-- sites or be granted access. Enforced at the DB layer (defence in depth) in
-- addition to the Supabase Auth email allowlist, so a misconfigured auth
-- provider cannot let a non-corporate account in.
--
-- Auth model (current): passwordless email OTP / magic link, no password.
-- Future: Microsoft Entra ID (Azure AD) SSO for Hitachi Outlook accounts — the
-- same domain guard applies because the Entra identity's email is @hcma.com.au.

create or replace function allowed_email_domain() returns text
  language sql immutable as $$ select 'hcma.com.au'::text $$;

-- Email of the current request's identity, from the Supabase JWT claims.
create or replace function current_email() returns text
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
  );
$$;
revoke all on function current_email() from public;
grant execute on function current_email() to authenticated, anon;

-- True if a given auth user's email is on the corporate domain.
create or replace function user_email_ok(uid uuid) returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from auth.users u
    where u.id = uid
      and lower(u.email) like '%@' || allowed_email_domain()
  );
$$;
revoke all on function user_email_ok(uuid) from public;
grant execute on function user_email_ok(uuid) to authenticated, anon;

-- ── Tighten site creation: creator must be a corporate account ───────────────
drop policy sites_insert on sites;
create policy sites_insert on sites for insert to authenticated
  with check (
    created_by = auth.uid()
    and lower(coalesce(current_email(), '')) like '%@' || allowed_email_domain()
  );

-- ── Tighten membership grants: the TARGET user must be a corporate account ────
-- (Re-create the policies from 0002 with the added domain guard. This prevents
-- an admin/owner from granting site access to a non-corporate email.)
drop policy members_insert on site_members;
create policy members_insert on site_members for insert
  with check (
    is_site_member(site_id, 'admin')
    and (role <> 'owner' or is_site_member(site_id, 'owner'))
    and user_email_ok(user_id)
  );

drop policy members_update on site_members;
create policy members_update on site_members for update
  using (
    is_site_member(site_id, 'admin')
    and (role <> 'owner' or is_site_member(site_id, 'owner'))
  )
  with check (
    is_site_member(site_id, 'admin')
    and (role <> 'owner' or is_site_member(site_id, 'owner'))
    and user_email_ok(user_id)
  );
