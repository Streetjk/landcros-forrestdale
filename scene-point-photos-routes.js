'use strict';

const defaultDb = require('./point-photos-db');
const { PointPhotoError } = defaultDb;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_RE = /^\/api\/sites\/([^/]+)\/scenes\/([^/]+)\/points\/([^/]+)\/photos(?:\/([^/]+))?$/;

function sendJson(res, statusCode, body) {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(JSON.stringify(body));
}

function createScenePointPhotoHandler(options = {}) {
  const {
    requireEditor,
    managedScene,
    readRawBody,
    readJson,
    json = sendJson,
    db = defaultDb,
    onError = () => {},
  } = options;

  return function handle(req, res, url) {
    const pathname = typeof url === 'string' ? url : url?.pathname || req.url;
    const match = PATH_RE.exec(pathname);
    if (!match) return false;

    // Cache-Control must always be private, no-store for scene-owned media
    res.setHeader('Cache-Control', 'private, no-store');

    const rawSlug = match[1];
    const rawSceneId = match[2];
    const rawPointId = match[3];
    const rawPhotoId = match[4];

    // 1. Syntax validation: slug, UUIDs, allowed methods
    if (!SLUG_RE.test(rawSlug)) {
      json(res, 404, { error: 'SITE_NOT_FOUND' });
      return true;
    }
    const slug = rawSlug.toLowerCase();

    if (!UUID_RE.test(rawSceneId)) {
      json(res, 400, { error: 'INVALID_SCENE_ID' });
      return true;
    }
    const sceneId = rawSceneId.toLowerCase();

    if (!UUID_RE.test(rawPointId)) {
      json(res, 400, { error: 'INVALID_POINT_ID' });
      return true;
    }
    const pointId = rawPointId.toLowerCase();

    let photoId = null;
    if (rawPhotoId !== undefined) {
      if (!UUID_RE.test(rawPhotoId)) {
        json(res, 400, { error: 'INVALID_PHOTO_ID' });
        return true;
      }
      photoId = rawPhotoId.toLowerCase();
    }

    const method = (req.method || 'GET').toUpperCase();
    const isItem = photoId !== null;

    if (isItem) {
      if (method !== 'GET' && method !== 'HEAD' && method !== 'PATCH' && method !== 'DELETE') {
        res.setHeader('Allow', 'GET, HEAD, PATCH, DELETE');
        json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
      }
    } else {
      if (method !== 'GET' && method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
      }
    }

    const fail = (err) => {
      if (res.writableEnded) return;
      if (err instanceof PointPhotoError || err?.name === 'PointPhotoError' || err?.code) {
        if (err.code === 'point-not-found') {
          json(res, 404, { error: 'POINT_NOT_FOUND' });
          return;
        }
        if (err.code === 'not-found' || err.code === 'photo-not-found') {
          json(res, 404, { error: 'PHOTO_NOT_FOUND' });
          return;
        }
        if (err.code === 'limit') {
          json(res, 409, { error: 'PHOTO_LIMIT' });
          return;
        }
        if (err.code === 'too-large') {
          json(res, 413, { error: 'PHOTO_TOO_LARGE' });
          return;
        }
        if (err.code === 'bad-type') {
          json(res, 400, { error: 'PHOTO_BAD_TYPE' });
          return;
        }
        if (err.code === 'bad-request') {
          json(res, 400, { error: 'PHOTO_BAD_REQUEST' });
          return;
        }
      }
      if (err && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 && err.code) {
        json(res, err.status, { error: err.code });
        return;
      }
      try {
        onError(err);
      } catch (_) {}
      json(res, 500, { error: 'INTERNAL_SERVER_ERROR' });
    };

    try {
      // 2. Require signed-in site editor
      requireEditor(req, res, slug, (session) => {
        if (res.writableEnded) return;
        if (!session || typeof session !== 'object' || !session.profileId) {
          json(res, 401, { error: 'UNAUTHORIZED' });
          return;
        }

        // 3. managedScene object ownership
        (async () => {
          const scene = await managedScene(res, slug, sceneId, session);
          if (!scene || res.writableEnded) return;

          const kind = String(scene.kind || 'admin').trim().toLowerCase();
          if (kind !== 'admin') {
            json(res, 400, { error: 'INVALID_SCENE_KIND' });
            return;
          }

          const actor = session.profileId;

          // 4. DAL operations
          if (!isItem) {
            // Collection GET: list photos for this scene point
            if (method === 'GET') {
              const list = await db.listScenePointPhotos(slug, sceneId, pointId);
              if (res.writableEnded) return;
              json(res, 200, list);
              return;
            }

            // Collection POST: upload binary envelope
            if (method === 'POST') {
              const maxCompressed = db.MAX_COMPRESSED_BYTES || 400 * 1024;
              const maxOriginal = db.MAX_ORIGINAL_BYTES || 15 * 1024 * 1024;
              const maxLimit = maxOriginal + maxCompressed + 4096;

              const buf = await new Promise((resolve, reject) => {
                try {
                  readRawBody(req, maxLimit, (err, data) => {
                    if (err) {
                      const isTooLarge = err.code === 'too-large' || /too large|payload too large|max payload/i.test(err.message || '');
                      const status = isTooLarge ? 413 : 400;
                      const code = isTooLarge ? 'PHOTO_TOO_LARGE' : 'INVALID_UPLOAD_BODY';
                      const e = new Error(code);
                      e.status = status;
                      e.code = code;
                      return reject(e);
                    }
                    resolve(data);
                  });
                } catch (readErr) {
                  reject(readErr);
                }
              });

              if (!Buffer.isBuffer(buf) || buf.length < 4) {
                const e = new Error('INVALID_UPLOAD_ENVELOPE');
                e.status = 400; e.code = 'INVALID_UPLOAD_ENVELOPE';
                throw e;
              }

              const hlen = buf.readUInt32BE(0);
              if (hlen <= 0 || hlen > 4000 || 4 + hlen > buf.length) {
                const e = new Error('INVALID_UPLOAD_HEADER');
                e.status = 400; e.code = 'INVALID_UPLOAD_HEADER';
                throw e;
              }

              let header;
              try {
                header = JSON.parse(buf.subarray(4, 4 + hlen).toString('utf8'));
              } catch {
                const e = new Error('INVALID_UPLOAD_HEADER');
                e.status = 400; e.code = 'INVALID_UPLOAD_HEADER';
                throw e;
              }

              if (!header || typeof header !== 'object' || Array.isArray(header)) {
                const e = new Error('INVALID_UPLOAD_HEADER');
                e.status = 400; e.code = 'INVALID_UPLOAD_HEADER';
                throw e;
              }

              const cLen = header.compressedBytes | 0;
              if (cLen <= 0 || 4 + hlen + cLen > buf.length) {
                const e = new Error('INVALID_UPLOAD_PAYLOAD');
                e.status = 400; e.code = 'INVALID_UPLOAD_PAYLOAD';
                throw e;
              }

              const compressed = buf.subarray(4 + hlen, 4 + hlen + cLen);
              const original = buf.subarray(4 + hlen + cLen);
              if (!original.length) {
                const e = new Error('INVALID_UPLOAD_PAYLOAD');
                e.status = 400; e.code = 'INVALID_UPLOAD_PAYLOAD';
                throw e;
              }

              if (compressed.length > maxCompressed || original.length > maxOriginal) {
                const e = new Error('PHOTO_TOO_LARGE');
                e.status = 413; e.code = 'PHOTO_TOO_LARGE';
                throw e;
              }

              const contentType = String(header.contentType || '').trim().toLowerCase();
              const allowedTypes = db.IMAGE_TYPES || new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
              if (!allowedTypes.has(contentType)) {
                const e = new Error('PHOTO_BAD_TYPE');
                e.status = 400; e.code = 'PHOTO_BAD_TYPE';
                throw e;
              }

              const photo = await db.addScenePointPhoto(slug, sceneId, pointId, {
                compressed,
                original,
                contentType,
                originalName: typeof header.originalName === 'string' ? header.originalName.slice(0, 120) : null,
                width: header.width | 0 || null,
                height: header.height | 0 || null,
                keepIndefinitely: header.keepIndefinitely === true,
              }, actor);

              if (res.writableEnded) return;
              json(res, 200, photo);
              return;
            }
          } else {
            // Item GET / HEAD
            if (method === 'GET' || method === 'HEAD') {
              const parsedUrl = typeof url === 'object' && url !== null ? url : new URL(req.url, 'http://localhost');
              const isOriginal = parsedUrl.searchParams?.get('original') === '1' || (typeof req.url === 'string' && /[?&]original=1\b/.test(req.url));

              const p = await db.readScenePointPhoto(slug, sceneId, pointId, photoId, { original: isOriginal });
              if (!p) {
                json(res, 404, { error: 'PHOTO_NOT_FOUND' });
                return;
              }

              if (res.writableEnded) return;
              res.statusCode = 200;
              const safeName = (p.row?.original_name || 'photo').replace(/[^\w.-]/g, '_');
              const headers = {
                'Content-Type': p.contentType,
                'Content-Length': p.buffer.length,
                'Cache-Control': 'private, no-store',
                'Content-Disposition': `inline; filename="${safeName}"`,
              };
              for (const [k, v] of Object.entries(headers)) {
                res.setHeader(k, v);
              }
              if (typeof res.writeHead === 'function') {
                res.writeHead(200, headers);
              }
              res.end(method === 'HEAD' ? undefined : p.buffer);
              return;
            }

            // Item PATCH: update retention
            if (method === 'PATCH') {
              const body = await new Promise((resolve, reject) => {
                try {
                  readJson(req, (err, data) => {
                    if (err) {
                      const e = new Error('INVALID_JSON_BODY');
                      e.status = 400; e.code = 'INVALID_JSON_BODY';
                      return reject(e);
                    }
                    resolve(data);
                  });
                } catch (readErr) {
                  reject(readErr);
                }
              });

              if (!body || typeof body !== 'object' || Array.isArray(body)) {
                const e = new Error('INVALID_JSON_BODY');
                e.status = 400; e.code = 'INVALID_JSON_BODY';
                throw e;
              }

              const hasKeep = typeof body.keep === 'boolean';
              const hasKeepIndefinitely = typeof body.keepIndefinitely === 'boolean';
              if (!hasKeep && !hasKeepIndefinitely) {
                const e = new Error('INVALID_BODY');
                e.status = 400; e.code = 'INVALID_BODY';
                throw e;
              }

              const keepIndefinitely = hasKeepIndefinitely ? body.keepIndefinitely : body.keep;
              const updated = await db.setScenePointPhotoRetention(slug, sceneId, pointId, photoId, keepIndefinitely);
              if (res.writableEnded) return;
              json(res, 200, updated);
              return;
            }

            // Item DELETE: delete photo
            if (method === 'DELETE') {
              await db.deleteScenePointPhoto(slug, sceneId, pointId, photoId);
              if (res.writableEnded) return;
              json(res, 200, { ok: true });
              return;
            }
          }
        })().catch(fail);
      });
    } catch (err) {
      fail(err);
    }

    return true;
  };
}

module.exports = {
  createScenePointPhotoHandler,
};
