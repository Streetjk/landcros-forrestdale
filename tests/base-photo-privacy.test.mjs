import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pointPhotosDb = require('../point-photos-db.js');
const supabaseDb = require('../supabase-db.js');
const PHOTO = '00000000-0000-4000-8000-000000000004';
const SITE = '00000000-0000-4000-8000-000000000001';

function withPool(pool, fn) {
  const oldPool = supabaseDb.pool;
  const oldSite = supabaseDb.getSiteId;
  supabaseDb.pool = () => pool;
  supabaseDb.getSiteId = async slug => { assert.equal(slug, 'landcros'); return SITE; };
  return Promise.resolve().then(fn).finally(() => {
    supabaseDb.pool = oldPool;
    supabaseDb.getSiteId = oldSite;
    pointPhotosDb._setStorageForTesting(null, false);
  });
}

function storage(recorder) {
  return { from(bucket) {
    assert.equal(bucket, 'point-photos');
    return { async download(path) {
      recorder.push(path);
      const bytes = Uint8Array.from([1,2,3]);
      return { data: { async arrayBuffer() { return bytes.buffer; } }, error: null };
    } };
  } };
}

test('public base photo requires published shared unexpired base binding and downloads compressed only', async () => {
  const queries = [], downloads = [];
  pointPhotosDb._setStorageForTesting(storage(downloads), true);
  await withPool({ async query(sql, params) {
    queries.push({ sql, params });
    return { rows: [{ id: PHOTO, storage_path: 'site/point/thumb.jpg', original_path: 'site/point/original.png', original_name: 'x.png' }] };
  } }, async () => {
    const p = await pointPhotosDb.readPublicPhoto(PHOTO);
    assert.equal(p.contentType, 'image/jpeg');
    assert.deepEqual(downloads, ['site/point/thumb.jpg']);
    assert.deepEqual(queries[0].params, [PHOTO]);
    assert.match(queries[0].sql, /join sites s on s\.id = ph\.site_id/);
    assert.match(queries[0].sql, /p\.scene_id is null/);
    assert.match(queries[0].sql, /p\.scope = 'shared'/);
    assert.match(queries[0].sql, /s\.published = true/);
    assert.match(queries[0].sql, /ph\.expires_at is null or ph\.expires_at > now\(\)/);
  });
});

test('public base photo miss never reaches storage', async () => {
  let storageUsed = false;
  pointPhotosDb._setStorageForTesting({ from() { storageUsed = true; throw new Error('must not access storage'); } }, true);
  await withPool({ async query() { return { rows: [] }; } }, async () => {
    assert.equal(await pointPhotosDb.readPublicPhoto(PHOTO), null);
    assert.equal(storageUsed, false);
  });
});

test('site-authorized base photo read binds site and is the only base path that may download original', async () => {
  const queries = [], downloads = [];
  pointPhotosDb._setStorageForTesting(storage(downloads), true);
  await withPool({ async query(sql, params) {
    queries.push({ sql, params });
    return { rows: [{ id: PHOTO, storage_path: 'site/point/thumb.jpg', original_path: 'site/point/original.png', content_type: 'image/png' }] };
  } }, async () => {
    const p = await pointPhotosDb.readPhotoForSite('landcros', PHOTO, { original: true });
    assert.equal(p.contentType, 'image/png');
    assert.deepEqual(downloads, ['site/point/original.png']);
    assert.deepEqual(queries[0].params, [PHOTO, SITE]);
    assert.match(queries[0].sql, /ph\.site_id = \$2/);
    assert.match(queries[0].sql, /p\.scene_id is null/);
  });
});

test('server and UI keep anonymous originals closed and move staff originals to site-qualified route', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const admin = fs.readFileSync('admin3d.js', 'utf8');
  const viewer = fs.readFileSync('viewer3d.js', 'utf8');
  assert.match(server, /url\.searchParams\.get\('original'\) === '1'\) return _json\(res, 404/);
  assert.match(server, /pointPhotosDb\.readPublicPhoto\(_pointPhotoReadMatch\[1\]\)/);
  assert.match(server, /pointPhotosDb\.readPhotoForSite\(slug, photoId/);
  assert.match(server, /_requireSiteRole\(req, res, slug, 'viewer'/);
  assert.doesNotMatch(admin, /`\/api\/point-photos\/\$\{encodeURIComponent\(p\.id\)\}\?original=1`/);
  assert.match(admin, /`\/api\/sites\/\$\{encodeURIComponent\(_slug\)\}\/points\/photos\/\$\{encodeURIComponent\(p\.id\)\}`/);
  assert.doesNotMatch(viewer, /a\.href = `\$\{compressedUrl\}\?original=1`/);
});
