#!/usr/bin/env bash
# build.sh — build a privacy-safe static site distribution for Render deployment
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
mkdir -p "${OUT}/assets" "${OUT}/data"

# One source of truth with server.js: raw contacts/changelog/share files and
# server-only modules are never copied simply because they exist in the repo.
while IFS= read -r f; do
  [ -f "$f" ] && cp "$f" "${OUT}/"
done < <(node -e "for (const f of require('./static-public-files').PUBLIC_ROOT_FILES) console.log(f)")

while IFS= read -r f; do
  [ -f "sites/${SITE}/data/${f}" ] && cp "sites/${SITE}/data/${f}" "${OUT}/data/"
done < <(node -e "for (const f of require('./static-public-files').PUBLIC_DATA_FILES) console.log(f)")

while IFS= read -r f; do
  [ -f "sites/${SITE}/${f}" ] && cp "sites/${SITE}/${f}" "${OUT}/"
done < <(node -e "for (const f of require('./static-public-files').PUBLIC_SITE_ROOT_FILES) console.log(f)")

# Asset authorization uses the exact same classifier as the Node server.
# Copy one manifest entry at a time so dot paths, encoded-equivalent unsafe
# names and case-normalized extensions cannot diverge between runtimes.
copy_public_assets() {
  local source="$1"
  local overwrite="$2"
  [ -d "$source" ] || return 0
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    mkdir -p "${OUT}/assets/$(dirname "$rel")"
    if [ "$overwrite" = yes ] || [ ! -e "${OUT}/assets/${rel}" ]; then
      cp "$source/$rel" "${OUT}/assets/$rel"
    fi
  done < <(node scripts/list-public-assets.cjs "$source")
}
copy_public_assets "sites/${SITE}/assets" yes
copy_public_assets assets no

# Static-host helpers contain no site/staff data.
for f in _headers serve.json staticwebapp.config.json; do
  [ -f "$f" ] && cp "$f" "${OUT}/"
done

echo "Done: ${OUT}/"
find "${OUT}" -type f | sort
