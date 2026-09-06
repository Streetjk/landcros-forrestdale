# Deploying SiteNav

`server.js` is a plain Node HTTP server that reads its config from environment
variables and binds `0.0.0.0:$PORT`, so it runs unchanged on any host that can
run Node 18+. The database and auth live in **Supabase** (free tier) on every
option below — the host only runs the Node process.

## Env vars (every host)

| Var | Purpose |
|---|---|
| `SITE` | site slug to serve, e.g. `landcros` |
| `SESSION_SECRET` | long random string; signs the login cookie (`openssl rand -hex 32`) |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | project URL + service-role key (Auth admin API) |
| `SUPABASE_DB_URL` | Postgres connection string (pooler URL) |
| `PLATFORM_ADMIN_EMAILS` | comma-separated owner emails |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` **or** `RESEND_API_KEY` | PIN setup/reset and hazard-report emails — SMTP through an ordinary mailbox (no DNS access needed), or Resend (needs a verified domain). See `.env.example`. |
| `PUBLIC_BASE_URL` | `https://your-host` — used in emailed links |

`SUPABASE_URL` + `SUPABASE_SECRET_KEY` also drive Supabase Storage for hazard
report photos (bucket `hazard-photos`, created on first upload). The entry
page for staff is `/start.html`; the public map stays at `/`.

Apply `supabase/migrations/*.sql` in order (Supabase SQL editor or `supabase db push`)
**before** the first deploy that includes `0009_login_pins.sql`.

## Option A — Oracle Cloud Always Free (your own VM, genuinely free)

The strongest free option now that Koyeb's free tier is gone (see Option C).
Always Free includes Arm (Ampere A1) capacity, 200 GB block storage and
10 TB/month egress, with no time limit. Oracle **halved** the A1 allowance on
15 June 2026, from 4 OCPU / 24 GB to 2 OCPU / 12 GB, without announcing it —
still far more than this app needs, but a reminder to treat the limits as
subject to change. Sign-up needs a card for identity verification (Always Free
shapes are not charged), and A1 capacity is sometimes unavailable in busy
regions; your home region is permanent, so choose carefully.

### Not getting charged

Signing up gives you two separate things: a 30-day trial with US$300 of
credit, and the open-ended **Always Free** allowance. They expire differently.

- **Your card is not charged unless you upgrade the account.** When the 30
  days (or the $300) run out you get a 30-day grace period; anything built
  beyond the Always Free limits is then reclaimed, while resources tagged
  *Always Free* keep running indefinitely.
- So the rule is simply: **only ever create resources marked "Always
  Free-eligible"**, and the trial ending is a non-event.
- Current Always Free limits: 2 OCPU / 12 GB Ampere A1 (halved from 4/24 on
  15 June 2026), 200 GB total block storage across at most 2 volumes — the
  VM's boot volume counts toward this — and 10 TB/month egress.

**The catch that matters for this app:** Oracle reclaims *idle* Always Free
compute. An instance is idle if, over a 7-day window, 95th-percentile CPU
stays under 20% (alongside low network and memory use). A low-traffic
internal viewer will sit well under that, so the VM can be stopped and
reclaimed even though you did nothing wrong.

The documented way out is counter-intuitive: **upgrade to Pay As You Go.**
PAYG accounts are exempt from idle reclamation, and Oracle states you are not
charged while usage stays within the Always Free limits. The trade-off is
that a card is now attached to an account that *can* bill you, so if you take
this route set a budget alert (Billing → Budgets) at a dollar or two, and
keep every resource Always Free-eligible. Otherwise stay on the free account
and accept that an idle VM may need recreating.

### Steps

1. Create an account at https://cloud.oracle.com → choose a home region near
   Perth (Sydney or Melbourne).
2. **Compute → Instances → Create**. Image: **Ubuntu 24.04**. Shape:
   *Ampere → VM.Standard.A1.Flex*, 2 OCPU / 12 GB. Confirm the shape shows
   the **"Always Free-eligible"** badge before creating — this is the single
   check that keeps the account free. Add your SSH public key, note the
   public IP.
3. **Networking → VCN → Security List (default)** → add ingress rules for
   TCP `80` and `443` from `0.0.0.0/0`.
4. Optional: point a DNS **A record** at the public IP. If you have no
   domain, skip this — the script derives one from the IP via `nip.io`.
5. SSH in (`ssh ubuntu@<ip>`) and run the one-shot setup:

   ```bash
   # with your own domain:
   curl -fsSL https://raw.githubusercontent.com/Streetjk/landcros-forrestdale/main/deploy/oracle-setup.sh \
     | DOMAIN=sitenav.yourdomain.com bash

   # with no domain — uses https://<public-ip>.nip.io:
   curl -fsSL https://raw.githubusercontent.com/Streetjk/landcros-forrestdale/main/deploy/oracle-setup.sh | bash
   ```

   HTTPS is required either way: the splat viewer needs a secure context
   (service worker + `SharedArrayBuffer`) and session cookies only get the
   `Secure` flag behind TLS. `nip.io` resolves `<ip>.nip.io` to that IP, so
   Let's Encrypt issues a real certificate for it.

   It installs Node 22 and Caddy, clones the repo to `/opt/sitenav`, creates a
   `systemd` service (auto-restart, starts on reboot), opens the VM firewall
   (Oracle images block 80/443 locally even when the VCN allows them), and
   configures Caddy for automatic HTTPS on your domain.
6. Fill in the generated env file and restart:

   ```bash
   sudo nano /opt/sitenav/.env
   sudo systemctl restart sitenav
   journalctl -u sitenav -f
   ```
7. Redeploy after pushing to `main`: `sudo /opt/sitenav/deploy/update.sh`.

## Option B — Render (managed, free, already configured here)

`render.yaml` in this repo already describes the service. Render's free web
services need no card, but they spin down after ~15 minutes of inactivity and
take roughly a minute to wake on the next request, and a workspace gets 750
free instance-hours per month. Cold starts are the trade-off; nothing else
about the app changes.

Set the environment variables from the table above in the Render dashboard
(mark keys as secret), and set `PUBLIC_BASE_URL` to the `onrender.com` URL.

Note: a sleeping instance also pauses the hourly hazard-photo cleanup sweep,
so photos are removed on the next wake rather than exactly at 30 days.

## Option C — Koyeb (now paid)

**Koyeb's free tier no longer exists for new accounts.** Mistral AI acquired
Koyeb in February 2026 and removed the free Starter plan; new signups must
take Pro (about $29/month plus compute) or above. Organisations that already
had a plan keep it. The `Dockerfile` in this repo still works there, and on
any other Docker host (Google Cloud Run, Northflank, Railway, Hugging Face
Spaces), so switching is a matter of pointing a new host at the repo.

If you do use Koyeb on a paid plan:

1. Sign up at https://app.koyeb.com with GitHub.
2. **Create Web Service → GitHub** → pick `Streetjk/landcros-forrestdale`, branch `main`.
3. Builder: **Dockerfile** (auto-detected from the repo root).
4. Instance: the smallest Pro instance is ample. Region: any.
5. Port: `8000` (the Dockerfile's `EXPOSE`/`ENV PORT`). Health check path: `/`.
6. Environment variables: add every row from the table above. Mark the keys as **Secret**.
7. Deploy. First build ~2 min. Your URL is `https://<app>-<org>.koyeb.app`; set that as
   `PUBLIC_BASE_URL`, or add a custom domain under *Domains* and use that.
8. Every push to `main` redeploys automatically.

## Which one?

- **Oracle** for a permanent, genuinely free machine with no cold starts and
  room to also serve the splat assets — provided someone is willing to run
  `apt upgrade` occasionally and A1 capacity exists in your region.
- **Render** to get running today with zero server administration, accepting a
  ~1 minute cold start after idle periods.
- **Koyeb or another paid host** when cold starts and VM upkeep are both
  unacceptable.

Either way the Supabase project stays where it is; only `PUBLIC_BASE_URL`
changes. Free tiers move: Koyeb's disappeared in February 2026 and Oracle
halved its Arm allowance in June 2026, so keep the deployment portable —
which is what the `Dockerfile` and `deploy/oracle-setup.sh` are for.

## Existing configs

- `render.yaml` — Render (native Node runtime), still valid.
- `.github/workflows/deploy.yml` — pushes the repo root to **Azure Static Web
  Apps**, which cannot run `server.js` (all `/api/*` calls 404 there). Delete
  it unless the static build is intended.
