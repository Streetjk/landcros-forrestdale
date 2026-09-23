'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_SITE_FIELDS = Object.freeze([
  'name',
  'title',
  'address',
  'logo',
  'mainPhone',
  'visitorInfo',
  'buildingPhoto',
]);

function readPublicSiteMetadata(siteDir, slug) {
  const out = { slug };
  try {
    const raw = fs.readFileSync(path.join(siteDir, 'data', 'config.json'), 'utf8');
    const config = JSON.parse(raw);
    const site = config && typeof config === 'object' && !Array.isArray(config)
      ? config.site
      : null;
    if (!site || typeof site !== 'object' || Array.isArray(site)) return out;

    for (const field of PUBLIC_SITE_FIELDS) {
      const value = site[field];
      if (typeof value === 'string' && value.trim()) out[field] = value.trim();
    }
  } catch {
    // Public metadata is optional. Keep /api/site available even if the local
    // display config is missing or malformed, without exposing file details.
  }
  return out;
}

module.exports = {
  readPublicSiteMetadata,
};
