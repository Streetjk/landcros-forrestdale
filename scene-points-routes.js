'use strict';

const defaultDb = require('./scene-points-db');
const { PointError, UUID_RE } = defaultDb;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const PATH_RE = /^\/api\/sites\/([^/]+)\/scenes\/([^/]+)\/points(?:\/([^/]+))?$/;

function sendJson(res, statusCode, body) {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function createScenePointHandler(options = {}) {
  const {
    requireEditor,
    managedScene,
    readJson,
    json = sendJson,
    db = defaultDb,
    onError = () => {},
  } = options;

  return function handle(req, res, url) {
    const pathname = typeof url === 'string' ? url : url?.pathname || req.url;
    const match = PATH_RE.exec(pathname);
    if (!match) return false;

    res.setHeader('Cache-Control', 'no-store');

    const rawSlug = match[1];
    const rawSceneId = match[2];
    const rawPointId = match[3];

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

    let pointId = null;
    if (rawPointId !== undefined) {
      if (!UUID_RE.test(rawPointId)) {
        json(res, 400, { error: 'INVALID_POINT_ID' });
        return true;
      }
      pointId = rawPointId.toLowerCase();
    }

    const method = (req.method || 'GET').toUpperCase();
    const isItem = pointId !== null;

    if (isItem) {
      if (method !== 'DELETE') {
        res.setHeader('Allow', 'DELETE');
        json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
      }
    } else if (method !== 'GET' && method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return true;
    }

    const fail = (err) => {
      if (res.writableEnded) return;
      if (err instanceof PointError && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599) {
        json(res, err.status, { error: err.code || 'POINT_ERROR' });
        return;
      }
      try {
        onError(err);
      } catch (_) {}
      json(res, 500, { error: 'INTERNAL_SERVER_ERROR' });
    };

    try {
      requireEditor(req, res, slug, (session) => {
        if (res.writableEnded) return;
        if (!session || typeof session !== 'object' || !session.profileId) {
          json(res, 401, { error: 'UNAUTHORIZED' });
          return;
        }

        (async () => {
          const scene = await managedScene(res, slug, sceneId, session);
          if (!scene || res.writableEnded) return;

          const actor = session.profileId;

          if (method === 'GET') {
            const points = await db.getScenePoints(slug, sceneId);
            if (res.writableEnded) return;
            json(res, 200, points);
            return;
          }

          if (method === 'POST') {
            const body = await new Promise((resolve, reject) => {
              try {
                readJson(req, (err, data) => {
                  if (err) return reject(new PointError(400, 'INVALID_JSON_BODY'));
                  resolve(data);
                });
              } catch (readErr) {
                reject(new PointError(400, 'INVALID_JSON_BODY'));
              }
            });

            if (!body || typeof body !== 'object' || Array.isArray(body)) {
              throw new PointError(400, 'INVALID_JSON_BODY');
            }

            const saved = await db.saveScenePoint(slug, sceneId, body, actor, { createOnly: req.headers?.['if-none-match'] === '*' });
            if (res.writableEnded) return;
            json(res, 200, saved);
            return;
          }

          if (method === 'DELETE') {
            await db.deleteScenePoint(slug, sceneId, pointId, actor);
            if (res.writableEnded) return;
            json(res, 200, { ok: true });
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
  createScenePointHandler,
};
