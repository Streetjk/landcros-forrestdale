# SiteNav — Supabase backend (Phase 1)

Replaces the git-commits-as-database model with Postgres + RLS + Auth + Storage.
Tenant isolation is enforced by **Row-Level Security**, not application code.

## Layout

```
supabase/
  migrations/
    0001_schema.sql   # tables: sites, site_members, points, contacts,
                      # scene_objects, audit_log, visits, submissions,
                      # events, webhooks, webhook_deliveries
    0002_rls.sql      # is_site_member() + owner trigger + all RLS policies
    ...
    0009_login_pins.sql # profile_pins + pin_reset_tokens (service-role only)
    0010_hazard_reports.sql # scenes.kind, hazard object kind, hazard_photos, hazard_notifications
    0011_scene_status_subscriptions.sql # scenes.status, scene_subscriptions (per-user lists)
  tests/
    rls_test.sql      # standalone psql harness — proves tenant isolation
```

## What you need to provision (blocks live wiring)

1. Create a Supabase project at https://supabase.com → note:
   - Project URL            → `SUPABASE_URL`
   - `anon` public key       → `SUPABASE_ANON_KEY`   (browser/client)
   - `service_role` key      → `SUPABASE_SERVICE_ROLE_KEY` (server only — bypasses RLS, never ship to a browser)
2. Add them to `.env` (already gitignored) alongside the existing `ADMIN_TOKEN`:
   ```
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_ANON_KEY=<anon key>
   SUPABASE_SERVICE_ROLE_KEY=<service role key>   # server-only
   ```
   On Render, set the same three as environment variables (service_role as a secret).

## Login PINs (0009_login_pins.sql)

Sign-in is email **and** a 6-digit PIN. The first PIN for any account (and any
reset) is set through a single-use link emailed to that address, so the inbox
is proven once and the PIN gates every login after that. Five wrong PINs lock
the account for 15 minutes; links expire after 30 minutes.

Server env for this:

```
SESSION_SECRET=<long random string>      # signs the session cookie (already required)
RESEND_API_KEY=re_...                    # https://resend.com — free tier is plenty
MAIL_FROM="SiteNav <noreply@your-domain>" # a sender on a domain verified in Resend
PUBLIC_BASE_URL=https://your-app.example  # absolute origin used in emailed links
```

Without `RESEND_API_KEY` the server logs the link to its console instead of
sending it and the UI tells the user email isn't configured. For local dev
only, `ALLOW_INSECURE_PIN_LINKS=1` also returns the link in the API response
so you can click through without a mail account — never set that in prod.

Routes: `POST /api/auth/login {email[, pin]}` → `pin-required` |
`pin-setup-sent` | `active` | `pin-invalid` | `locked` | `pending` | `none` |
`denied`; `POST /api/auth/pin/request-reset {email}`; `POST /api/auth/pin/reset
{token, pin}` (the emailed link lands on `/reset-pin.html`);
`POST /api/auth/pin/change {currentPin, newPin}` (signed in).

## Hazard report map (0010_hazard_reports.sql)

`start.html` lets a signed-in user choose the **Admin map** or the **Hazard
report map**. Both are `editor.html` (`?mode=hazard` for the latter) on the
same scenes machinery: a scene has `kind = 'admin' | 'hazard'`.

- Admin scenes: share link `/s/<code>` is public (unchanged).
- Hazard scenes: `/s/<code>` requires an @hcma.com.au session; the viewer
  shows a sign-in gate and reloads once signed in. Only the report's author
  or a site admin can delete it.
- Hazard pins are `scene_objects` of kind `hazard` with
  `props = { title, description }`. Photos are compressed in the browser to
  <=300 KB (longest edge 1600 px) and uploaded together with the untouched
  original in one binary request; both land in the private Supabase Storage
  bucket `hazard-photos` (created automatically on first upload) and are
  deleted after **30 days** by the server's hourly sweep. Max 6 photos per pin.
- "Send report" emails every pin's title/description plus the **original**
  photos as attachments (up to 30 MB per email; larger sets note the
  overflow and rely on the map link) to 1-20 `@hcma.com.au` recipients via
  Resend, and records it in `hazard_notifications`.

Needs `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (Storage) and `RESEND_API_KEY`
(sending) on top of the PIN-login env above.

Routes: `GET/POST /api/sites/:slug/scenes?kind=`; `GET|POST
/api/sites/:slug/hazard/objects/:objectId/photos`; `DELETE
/api/sites/:slug/hazard/photos/:id`; `GET /api/hazard-photos/:id[?original=1]`
(session); `POST /api/sites/:slug/scenes/:id/notify {recipients, message}`;
`GET /api/sites/:slug/scenes/:id/notifications`; `GET /api/site`.

## Per-user lists, status and archive (0011_scene_status_subscriptions.sql)

Both maps. Each scene has `status` open → escalated → resolved (and back).
Any signed-in user who holds the link can change it, from the editor's
status row or the status bar the viewer shows at the top of an opened scene;
anonymous viewers of an admin link see the status read-only. "Escalate" =
email the link (hazard: pins + original photos) to @hcma.com.au recipients and
set the status; sending a hazard report also marks it escalated.

Opening a share link while signed in adds the scene to that person's list
(`scene_subscriptions`). The editor lists the scenes you created plus those
you opened; resolved ones sit under a folded **Archived** section. Deleting
from the list removes only your subscription unless you are the creator (or a
platform admin), in which case the scene itself is deleted.

Routes: `POST /api/scenes/by-code/:code/status {status[, recipients, message]}`
(session); `POST /api/sites/:slug/scenes/:id/status`; `GET
/api/sites/:slug/scenes?kind=` is now per-user; `DELETE
/api/sites/:slug/scenes/:id` returns `{removed:'subscription'}` for
non-creators.

## Apply the migrations

Either the Supabase CLI:
```
supabase link --project-ref <ref>
supabase db push          # applies migrations/*.sql in order
```
…or paste `0001_schema.sql` then `0002_rls.sql` into the Supabase SQL editor.

> Supabase creates the `auth` schema, `auth.uid()`, and the `anon` /
> `authenticated` / `service_role` roles and their default table grants
> automatically — the migrations assume they exist.

## Verify RLS locally before trusting it (recommended)

The test harness stubs the Supabase runtime (`auth` schema, roles) so it runs on
a vanilla Postgres, applies both migrations, and asserts tenant isolation. A
clean exit = all checks passed; any FAIL raises and aborts.

```
createdb sitenav_rls_test
psql -v ON_ERROR_STOP=1 -d sitenav_rls_test -f supabase/tests/rls_test.sql
dropdb sitenav_rls_test
```

Covers: owner-membership trigger; per-tenant read/write isolation; anon limited
to published + shared data; public submission insert only on published sites;
webhooks/secret unreadable by any client.

## Auth model

- **Now:** passwordless email login (Supabase "magic link" / email OTP — no
  password). Access is restricted to the corporate domain **`@hcma.com.au`**.
  The restriction is enforced in two places:
  1. Supabase Auth — set the email domain allowlist to `hcma.com.au`
     (Auth → Providers → Email, or an access-control auth hook).
  2. The database — `0003_auth_domain.sql` blocks site creation and membership
     grants for any non-`@hcma.com.au` identity, so a misconfigured provider
     cannot let an outside account in. (Verified by checks c9a/c9b in the test.)
- **Later (supported, not yet enabled):** Microsoft Entra ID (Azure AD) SSO so
  staff sign in with their Hitachi Outlook accounts. Supabase has a built-in
  Azure provider; enabling it needs an app registration in Hitachi's Entra
  tenant (client id/secret + redirect URL). The same `@hcma.com.au` domain guard
  applies unchanged, because the Entra identity's email is on that domain.

To change the allowed domain, edit `allowed_email_domain()` in
`0003_auth_domain.sql` (single source of truth).

## Isolation model (summary)

| Table | anon (public) | authenticated member | server (service_role) |
|---|---|---|---|
| sites | read if `published` | read/write by role | full |
| points | read `shared` on published | read/write (editor+) | full |
| contacts | read `active` on published | read/write (editor+) | full |
| scene_objects | read on published | read/write (editor+) | full |
| submissions | **insert only** (published) | staff read/triage (editor+) | full |
| audit_log | none | read (admin+), insert (editor+) | full |
| visits | none | read (viewer+) | write (increments) |
| events / webhooks / webhook_deliveries | none | none | full (secrets stay here) |

Roles are ordered `viewer < editor < admin < owner`; a member's row in
`site_members` sets their role per site.
