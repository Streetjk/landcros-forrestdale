#!/usr/bin/env bash
# deploy/oracle-setup.sh — first-boot setup for SiteNav on an Oracle Cloud
# "Always Free" VM (Ubuntu 22.04/24.04, Ampere A1 or AMD micro).
#
# What it does: installs Node 22 + Caddy, clones the repo to /opt/sitenav,
# writes a systemd service that restarts on failure and on reboot, and puts
# Caddy in front for automatic HTTPS (Let's Encrypt) on your domain.
#
# Run ONCE on the fresh VM (as the default `ubuntu` user):
#   curl -fsSL https://raw.githubusercontent.com/Streetjk/landcros-forrestdale/main/deploy/oracle-setup.sh \
#     | DOMAIN=sitenav.example.com REPO=https://github.com/Streetjk/landcros-forrestdale.git bash
#
# Then fill in /opt/sitenav/.env (the script creates a template and stops the
# service until SESSION_SECRET is set) and run:  sudo systemctl restart sitenav
#
# Redeploy later:  sudo /opt/sitenav/deploy/update.sh
set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN=your.host.name (must already point at this VM public IP)}"
REPO="${REPO:-https://github.com/Streetjk/landcros-forrestdale.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/sitenav
APP_PORT=50000

echo "==> System packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "==> Node 22"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi

echo "==> Caddy (automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq caddy
fi

echo "==> Firewall: Oracle images ship iptables rules that block 80/443 even when the VCN allows them"
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save >/dev/null 2>&1 || true

echo "==> App user + checkout"
id -u sitenav >/dev/null 2>&1 || sudo useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin sitenav
if [ ! -d "$APP_DIR/.git" ]; then
  sudo git clone --branch "$BRANCH" --depth 1 "$REPO" "$APP_DIR"
fi
sudo chown -R sitenav:sitenav "$APP_DIR"
sudo -u sitenav bash -c "cd $APP_DIR && npm ci --omit=dev --no-audit --no-fund"

echo "==> .env template (fill this in!)"
if [ ! -f "$APP_DIR/.env" ]; then
  sudo -u sitenav tee "$APP_DIR/.env" >/dev/null <<ENV
# Required
SITE=landcros
SESSION_SECRET=$(openssl rand -hex 32)
SUPABASE_URL=
SUPABASE_SECRET_KEY=
SUPABASE_DB_URL=
PLATFORM_ADMIN_EMAILS=
# Email for PIN setup/reset links
RESEND_API_KEY=
MAIL_FROM=SiteNav <noreply@${DOMAIN}>
PUBLIC_BASE_URL=https://${DOMAIN}
PORT=${APP_PORT}
ENV
  sudo chmod 600 "$APP_DIR/.env"
fi

echo "==> systemd service"
sudo tee /etc/systemd/system/sitenav.service >/dev/null <<UNIT
[Unit]
Description=SiteNav (node server.js)
After=network-online.target
Wants=network-online.target

[Service]
User=sitenav
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${APP_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Caddy reverse proxy"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
${DOMAIN} {
    encode zstd gzip
    reverse_proxy 127.0.0.1:${APP_PORT}
}
CADDY

echo "==> Update helper"
sudo tee "$APP_DIR/deploy/update.sh" >/dev/null <<'UPD'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/sitenav
sudo -u sitenav git pull --ff-only
sudo -u sitenav npm ci --omit=dev --no-audit --no-fund
systemctl restart sitenav
systemctl --no-pager status sitenav | head -5
UPD
sudo chmod +x "$APP_DIR/deploy/update.sh"

sudo systemctl daemon-reload
sudo systemctl enable --now sitenav caddy
sudo systemctl restart caddy

echo
echo "Done. Next:"
echo "  1. sudo nano ${APP_DIR}/.env      # paste Supabase + Resend values"
echo "  2. sudo systemctl restart sitenav"
echo "  3. journalctl -u sitenav -f       # watch logs"
echo "  Site: https://${DOMAIN}"
