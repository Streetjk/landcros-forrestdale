-- SiteNav — 6-digit login PINs for internal (@hcma.com.au) accounts
--
-- Until now login was email-only with no verification (see 0005_profiles.sql
-- and the SECURITY NOTE in auth-db.js): anyone who knew a colleague's address
-- could sign in as them. A profile now also needs a 6-digit PIN, which the
-- user sets via a link emailed to that address — so possession of the inbox
-- is proven once, and the PIN gates every login after that.
--
-- Hashes live in their own table rather than on profiles: profiles has a
-- self-read RLS policy (profiles_self_read) which would otherwise expose
-- pin_hash to the browser-side client. Neither table below has any policy —
-- with RLS enabled that means only the service-role pool in auth-db.js can
-- touch them, same model as webhooks.secret in 0002_rls.sql.

create table profile_pins (
  profile_id      uuid primary key references profiles(id) on delete cascade,
  -- scrypt, encoded as "<salt-b64url>$<hash-b64url>" (see auth-db.js hashPin)
  pin_hash        text not null,
  set_at          timestamptz not null default now(),
  -- brute-force guard: 10^6 possible PINs is small, so the hash cost alone
  -- is not a defence — lock after a handful of consecutive failures.
  failed_attempts int  not null default 0,
  locked_until    timestamptz
);

alter table profile_pins enable row level security;

-- Single-use, short-lived tokens for both first-time PIN setup and resets.
-- Only the sha256 of the emailed token is stored, so a DB read leak cannot
-- be replayed as a link.
create table pin_reset_tokens (
  token_hash  text primary key,
  profile_id  uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create index pin_reset_tokens_profile_idx on pin_reset_tokens (profile_id);

alter table pin_reset_tokens enable row level security;
