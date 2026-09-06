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

## Option A — Koyeb (managed, git-push deploys, no server admin)

Free tier: one web service, 512 MB RAM / 0.1 vCPU, custom domain + HTTPS
included, no card required. Closest equivalent to Render.

1. Sign up at https://app.koyeb.com with GitHub.
2. **Create Web Service → GitHub** → pick `Streetjk/landcros-forrestdale`, branch `main`.
3. Builder: **Dockerfile** (auto-detected from the repo root).
4. Instance: **Free**. Region: Frankfurt or Washington (only regions on the free tier).
5. Port: `8000` (the Dockerfile's `EXPOSE`/`ENV PORT`). Health check path: `/`.
6. Environment variables: add every row from the table above. Mark the keys as **Secret**.
7. Deploy. First build ~2 min. Your URL is `https://<app>-<org>.koyeb.app`; set that as
   `PUBLIC_BASE_URL`, or add a custom domain under *Domains* and use that.
8. Every push to `main` redeploys automatically.

Limits to know: the free instance may be paused after inactivity and takes a
few seconds to wake; 512 MB is enough for this server (it streams files and
holds no scene data in memory). Serve the large `.splat` files from Supabase
Storage / Cloudflare R2 if bandwidth becomes an issue.

## Option B — Oracle Cloud Always Free (your own VM, permanent)

Free forever: up to 4 Ampere A1 cores / 24 GB RAM (or 2 AMD micro VMs),
200 GB block storage, 10 TB/month egress. Far more than Koyeb, but you manage
the box (updates, disk, restarts). Sign-up requires a card for identity
verification (not charged on Always Free shapes); A1 capacity can be
"out of capacity" in busy regions — pick a home region carefully, you can't
change it later.

1. Create an account at https://cloud.oracle.com → choose a home region near
   Perth (Sydney or Melbourne).
2. **Compute → Instances → Create**. Image: **Ubuntu 24.04**. Shape:
   *Ampere → VM.Standard.A1.Flex*, 2 OCPU / 12 GB (or all 4/24). Add your SSH
   public key. Note the public IP.
3. **Networking → VCN → Security List (default)** → add ingress rules for
   TCP `80` and `443` from `0.0.0.0/0`.
4. Point a DNS **A record** (e.g. `sitenav.yourdomain.com`) at the public IP.
5. SSH in (`ssh ubuntu@<ip>`) and run the one-shot setup:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Streetjk/landcros-forrestdale/main/deploy/oracle-setup.sh \
     | DOMAIN=sitenav.yourdomain.com bash
   ```

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

## Which one?

- **Koyeb** if you want Render-like "push and forget" and nobody wants to
  administer a Linux box. Good enough for this app's traffic.
- **Oracle** if you want a permanent, much larger machine (room to also host
  the splat assets, or later a self-hosted Postgres), and someone is happy to
  run `apt upgrade` occasionally.

Either way the Supabase project stays where it is; only `PUBLIC_BASE_URL`
changes.

## Existing configs

- `render.yaml` — Render (native Node runtime), still valid.
- `.github/workflows/deploy.yml` — pushes the repo root to **Azure Static Web
  Apps**, which cannot run `server.js` (all `/api/*` calls 404 there). Delete
  it unless the static build is intended.
