#!/usr/bin/env node
// supabase/import.mjs
//
// Loads the existing per-site JSON files (sites/<slug>/data/{config,contacts,
// points,changelog}.json) into the Postgres schema defined by
// supabase/migrations/0001_schema.sql (+ 0002_rls.sql, 0003_auth_domain.sql).
//
// PORTABLE by design: plain node-postgres against a connection string, so it
// runs unchanged against local Postgres, Supabase, or Azure Postgres.
//
// Usage:
//   DATABASE_URL=postgres://user:pass@host:5432/dbname node supabase/import.mjs [--fresh]
//
// --fresh   TRUNCATEs points, contacts, audit_log, sites (RESTART IDENTITY
//           CASCADE) before importing — use for a clean re-seed.
// (default) Without --fresh, re-running is idempotent:
//             - sites upsert by slug (unique)
//             - contacts/points upsert by JSON id when present
//             - points without a JSON id, and changelog rows (audit_log has
//               no natural id at all), are de-duplicated by exact content
//               match before insert.
//
// The whole import runs inside a single transaction; any error rolls back.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SITES_DIR = path.join(REPO_ROOT, 'sites');

const FRESH = process.argv.includes('--fresh');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    'ERROR: DATABASE_URL is not set.\n' +
    'Example: DATABASE_URL=postgres://user:pass@host:5432/dbname node supabase/import.mjs'
  );
  process.exit(1);
}

// jsonb columns: JSON.stringify explicitly. pg's default value preparation
// turns a bare JS array/object into a Postgres ARRAY-literal or relies on
// implicit toString, which is wrong for jsonb — always send real JSON text
// and let Postgres cast it.
function j(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

// contacts.json (and potentially points.json) are cloned per-site templates:
// verified all 98 landcros contact ids are byte-identical to greenfields' 98
// ids. contacts.id is a single GLOBAL primary key (no site_id in the key), so
// reusing the raw JSON id as-is would collide across sites and silently merge
// two different sites' rows into one via ON CONFLICT. Derive a per-site
// deterministic uuid from (slug, json id) instead: stable across re-runs of
// the SAME site (still idempotent), but distinct across sites even when the
// source JSON id collides.
function siteScopedUuid(slug, jsonId) {
  const hash = crypto.createHash('sha256').update(`${slug}:${jsonId}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function readJson(p, fallback = null) {
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function discoverSites() {
  return fs
    .readdirSync(SITES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((slug) => fs.existsSync(path.join(SITES_DIR, slug, 'data', 'config.json')))
    .sort();
}

async function importSite(client, slug) {
  const dataDir = path.join(SITES_DIR, slug, 'data');
  const config = readJson(path.join(dataDir, 'config.json'), {});
  const contacts = readJson(path.join(dataDir, 'contacts.json'), []);
  const points = readJson(path.join(dataDir, 'points.json'), []);
  const changelog = readJson(path.join(dataDir, 'changelog.json'), []);

  const counts = { sites: 0, contacts: 0, points: 0, audit: 0 };

  // `config` jsonb column = the FULL config.json minus only the `_doc`
  // authoring note. The `site` sub-object is KEPT inside config (viewer3d.js
  // reads e.g. _cfg.site?.speedLimitSign), while name/title/address/logo are
  // ALSO extracted into dedicated `sites` columns below. Net: nothing from
  // config.json is lost except `_doc`.
  const { site = {}, _doc, ...restConfig } = config;
  const fullConfig = { ...restConfig };
  if (Object.keys(site).length > 0) fullConfig.site = site;

  // created_by is intentionally NULL: the import runs with no authenticated
  // user, so the add_owner_membership trigger (0002_rls.sql) will NOT fire
  // and no owner is granted automatically. A human must run a separate
  // bootstrap grant (INSERT INTO site_members ...) after import to give a
  // real account ownership of the site.
  const siteRes = await client.query(
    `insert into sites (slug, name, title, address, logo, config, created_by)
     values ($1, $2, $3, $4, $5, $6::jsonb, null)
     on conflict (slug) do update set
       name = excluded.name,
       title = excluded.title,
       address = excluded.address,
       logo = excluded.logo,
       config = excluded.config,
       updated_at = now()
     returning id, (xmax = 0) as inserted`,
    [slug, site.name ?? slug, site.title ?? null, site.address ?? null, site.logo ?? null, j(fullConfig)]
  );
  const siteId = siteRes.rows[0].id;
  counts.sites += 1; // one row processed for this site either way

  // ── Contacts ──────────────────────────────────────────────────────────
  for (const c of contacts) {
    const contactId = c.id ? siteScopedUuid(slug, c.id) : null;
    const res = contactId
      ? await client.query(
          `insert into contacts (id, site_id, name, role, phone, email, active, created_by, created_at)
           values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()))
           on conflict (id) do update set
             site_id = excluded.site_id,
             name = excluded.name,
             role = excluded.role,
             phone = excluded.phone,
             email = excluded.email,
             active = excluded.active,
             created_by = excluded.created_by
           returning id, (xmax = 0) as inserted`,
          [contactId, siteId, c.name, c.role ?? null, c.phone ?? null, c.email ?? null, c.active ?? true, c.createdBy ?? null, c.createdAt ?? null]
        )
      : await client.query(
          `insert into contacts (site_id, name, role, phone, email, active, created_by, created_at)
           values ($1::uuid, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
           returning id`,
          [siteId, c.name, c.role ?? null, c.phone ?? null, c.email ?? null, c.active ?? true, c.createdBy ?? null, c.createdAt ?? null]
        );
    if (res.rows[0] && res.rows[0].inserted !== false) counts.contacts += 1;
  }

  // ── Points ────────────────────────────────────────────────────────────
  // JSON is camelCase (routeWaypoints, position3d, contactIds, buildingRef,
  // cameraPreset3d); DB columns are snake_case.
  for (const p of points) {
    // Same collision risk as contacts (see siteScopedUuid comment above):
    // scope both the point's own id and its contactIds references.
    const pointId = p.id ? siteScopedUuid(slug, p.id) : null;
    const contactIds = (p.contactIds ?? []).map((cid) => siteScopedUuid(slug, cid));
    const res = pointId
      ? await client.query(
          `insert into points (id, site_id, label, type, scope, latlng, position3d, notes,
             contact_ids, route_waypoints, route_waypoints3d, camera_preset3d, building_ref,
             created_by, created_at, updated_at)
           values ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8,
             $9::uuid[], $10::jsonb, $11::jsonb, $12::jsonb, $13,
             $14, coalesce($15::timestamptz, now()), coalesce($16::timestamptz, now()))
           on conflict (id) do update set
             site_id = excluded.site_id, label = excluded.label, type = excluded.type,
             scope = excluded.scope, latlng = excluded.latlng, position3d = excluded.position3d,
             notes = excluded.notes, contact_ids = excluded.contact_ids,
             route_waypoints = excluded.route_waypoints, route_waypoints3d = excluded.route_waypoints3d,
             camera_preset3d = excluded.camera_preset3d, building_ref = excluded.building_ref,
             created_by = excluded.created_by, updated_at = now()
           returning id, (xmax = 0) as inserted`,
          [
            pointId, siteId, p.label, p.type ?? 'drop-off', p.scope ?? 'shared',
            j(p.latlng), j(p.position3d), p.notes ?? null,
            contactIds, j(p.routeWaypoints ?? []), j(p.routeWaypoints3d ?? []), j(p.cameraPreset3d), p.buildingRef ?? null,
            p.createdBy ?? null, p.createdAt ?? null, p.updatedAt ?? null,
          ]
        )
      : // No JSON id to upsert on: dedup on the FULL normalized mapped-row
        // content (every mapped field, not just label+latlng), so an identical
        // re-run is skipped while two genuinely different no-id points that
        // merely share label+latlng are both kept. created_at/updated_at are
        // excluded from the key: they default to now() when the JSON omits
        // them, so they are not stable content. NOTE: points.json is empty in
        // all current sites, so this branch is currently unexercised.
        await client.query(
          `insert into points (site_id, label, type, scope, latlng, position3d, notes,
             contact_ids, route_waypoints, route_waypoints3d, camera_preset3d, building_ref,
             created_by, created_at, updated_at)
           select $1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7,
             $8::uuid[], $9::jsonb, $10::jsonb, $11::jsonb, $12,
             $13, coalesce($14::timestamptz, now()), coalesce($15::timestamptz, now())
           where not exists (
             select 1 from points
             where site_id = $1::uuid
               and label is not distinct from $2
               and type is not distinct from $3
               and scope is not distinct from $4
               and latlng is not distinct from $5::jsonb
               and position3d is not distinct from $6::jsonb
               and notes is not distinct from $7
               and contact_ids is not distinct from $8::uuid[]
               and route_waypoints is not distinct from $9::jsonb
               and route_waypoints3d is not distinct from $10::jsonb
               and camera_preset3d is not distinct from $11::jsonb
               and building_ref is not distinct from $12
               and created_by is not distinct from $13
           )
           returning id`,
          [
            siteId, p.label, p.type ?? 'drop-off', p.scope ?? 'shared',
            j(p.latlng), j(p.position3d), p.notes ?? null,
            contactIds, j(p.routeWaypoints ?? []), j(p.routeWaypoints3d ?? []), j(p.cameraPreset3d), p.buildingRef ?? null,
            p.createdBy ?? null, p.createdAt ?? null, p.updatedAt ?? null,
          ]
        );
    if (res.rows[0] && res.rows[0].inserted !== false) counts.points += 1;
  }

  // ── Changelog → audit_log ─────────────────────────────────────────────
  // changed_by is NULL: the legacy value ("browser"/"import") is free text,
  // not a uuid, and audit_log.changed_by references auth.users(id).
  for (const entry of changelog) {
    const res = await client.query(
      `insert into audit_log (site_id, ts, changed_by, action, entity_type, entity_id, entity_label)
       select $1::uuid, $2::timestamptz, null, $3, $4, $5, $6
       where not exists (
         select 1 from audit_log
         where site_id = $1::uuid and ts = $2::timestamptz and action = $3 and entity_type = $4
           and entity_id is not distinct from $5 and entity_label is not distinct from $6
       )
       returning id`,
      [siteId, entry.timestamp, entry.action, entry.entityType, entry.entityId ?? null, entry.entityLabel ?? null]
    );
    if (res.rows.length) counts.audit += 1;
  }

  return counts;
}

async function main() {
  const slugs = discoverSites();
  if (slugs.length === 0) {
    console.error(`No sites found under ${SITES_DIR}/*/data/config.json`);
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const summary = {};

  try {
    await client.query('begin');

    if (FRESH) {
      await client.query('truncate table points, contacts, audit_log, sites restart identity cascade');
    }

    for (const slug of slugs) {
      summary[slug] = await importSite(client, slug);
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    console.error('Import failed, transaction rolled back:', err.message);
    await client.end();
    process.exit(1);
  }

  await client.end();

  console.log(`Import complete${FRESH ? ' (--fresh)' : ''}:`);
  for (const [slug, c] of Object.entries(summary)) {
    console.log(`  ${slug}: sites=${c.sites} contacts=${c.contacts} points=${c.points} audit_log=${c.audit}`);
  }
}

main();
