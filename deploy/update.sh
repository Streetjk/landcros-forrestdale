#!/usr/bin/env bash
# Redeploy SiteNav on the Oracle VM after pushing to the deployed branch.
# Pulls whatever branch /opt/sitenav was cloned from, refreshes production
# deps, and restarts the service. Run with sudo:
#   sudo /opt/sitenav/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/sitenav
cd "$APP_DIR"
echo "==> pulling $(sudo -u sitenav git rev-parse --abbrev-ref HEAD)"
sudo -u sitenav git pull --ff-only
echo "==> npm ci --omit=dev"
sudo -u sitenav npm ci --omit=dev --no-audit --no-fund
echo "==> restarting sitenav"
systemctl restart sitenav
systemctl --no-pager --lines=8 status sitenav
