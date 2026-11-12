#!/usr/bin/env bash
# build.sh — build a static site distribution for Render deployment
# Usage: bash build.sh <site>   (e.g. bash build.sh landcros)
set -euo pipefail

SITE="${1:-landcros}"
OUT="dist-${SITE}"

if [ ! -d "sites/${SITE}" ]; then
  echo "ERROR: sites/${SITE}/ not found" >&2
  exit 1
fi

echo "Building ${SITE} → ${OUT}/"
rm -rf "${OUT}"
mkdir -p "${OUT}/assets"

# Engine files (JS, HTML, CSS, worker, helpers)
for f in *.js *.mjs *.html *.css coi-serviceworker.js qr.js; do
  [ -f "$f" ] && cp "$f" "${OUT}/" || true
done

# The excavator route is an opt-in copy of the public viewer. It keeps the
# current homepage unchanged and has its own stable, bookmarkable URL.
if [ "$SITE" = "landcros" ]; then
  cp "${OUT}/index.html" "${OUT}/excavator-route.html"
  # Give the opt-in page its own viewer module cache key. The main page keeps
  # its original script URL, while this page fetches the gated route changes.
  sed -i -E 's#viewer3d\.js\?v=[^" ]+#viewer3d.js?v=ex2000-route-20261112#' "${OUT}/excavator-route.html"
fi

# Config and static-host helpers
for f in _headers serve.json staticwebapp.config.json; do
  [ -f "$f" ] && cp "$f" "${OUT}/" || true
done

# Site-specific data
cp -r "sites/${SITE}/data" "${OUT}/"

# Site-specific assets (splats, satellite, thumbnails, etc.)
if command -v rsync >/dev/null 2>&1; then
  rsync -a "sites/${SITE}/assets/" "${OUT}/assets/"
else
  cp -a "sites/${SITE}/assets/." "${OUT}/assets/"
fi

# Site branding files at root (logo, etc.)
[ -f "sites/${SITE}/logo.png" ]       && cp "sites/${SITE}/logo.png" "${OUT}/"
[ -f "sites/${SITE}/speedlimit2.png" ] && cp "sites/${SITE}/speedlimit2.png" "${OUT}/"

# Shared engine assets (don't overwrite site-specific files)
if [ -d assets/dirtwithrocks ]; then
  mkdir -p "${OUT}/assets/dirtwithrocks"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --ignore-existing assets/dirtwithrocks/ "${OUT}/assets/dirtwithrocks/"
  else
    cp -an assets/dirtwithrocks/. "${OUT}/assets/dirtwithrocks/"
  fi
fi
[ -f assets/Trex.stl ]     && cp assets/Trex.stl "${OUT}/assets/" 2>/dev/null || true

# Optional Opus-generated excavator GLB and calibrated rig parameters. Keep
# them additive and entirely outside the ordinary home-page asset load path.
if [ "$SITE" = "landcros" ] && [ -d assets/excavator ]; then
  mkdir -p "${OUT}/assets/excavator"
  cp -a assets/excavator/. "${OUT}/assets/excavator/"
fi

echo "Done: ${OUT}/"
find "${OUT}" -type f | sort
