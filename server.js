#!/usr/bin/env node
/**
 * SiteNav local dev server — HTTP/1.1, static files + Supabase-backed admin API
 * Usage: node server.js [port]   (default 50000)
 *
 * For SharePoint/cloud: flip USE_SHAREPOINT=true in db.js and retire this file.
 */
const http        = require('http');
const fs          = require('fs');
const path        = require('path');
const { execFile } = require('child_process');
const sdb         = require('./supabase-db');
const auth        = require('./auth-db');
const siteAdmin   = require('./site-admin');
const sceneDb     = require('./scene-db');

// Load .env for local dev (Render sets env vars directly and those take precedence)
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}

// Generic client error body — logs the real error server-side, never leaks
// DB/schema/config detail (e.message) to the client.
function _errBody(e) {
  console.error('[api]', (e && e.message) ? e.message : e);
  return JSON.stringify({ error: 'Internal error' });
}

const ROOT      = __dirname;
const SITE      = process.env.SITE || 'landcros';
const SITE_DIR  = path.join(ROOT, 'sites', SITE);
const DATA      = path.join(SITE_DIR, 'data');
const SHARED_ASSETS = path.join(ROOT, 'assets');
const PORT      = parseInt(process.env.PORT || process.argv[2] || '50000', 10);

// ── Auth (Stage 2b): cookie-carried session, no external dep ──────────────
// Session token format/signing lives in auth-db.js (signSession/verifySession);
// this is just the HTTP cookie plumbing.
const SESSION_COOKIE = 'sn_session';
const SESSION_MAX_AGE = 43200; // seconds (12h), matches auth-db.js SESSION_TTL_MS

function _getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function _cookieAttrs(req, maxAge) {
  const secure = (req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' ? '; Secure' : '';
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function _setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${_cookieAttrs(req, SESSION_MAX_AGE)}`);
}

function _clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${_cookieAttrs(req, 0)}`);
}

// Verified {profileId, email} for the caller's session cookie, or null.
function _session(req) {
  return auth.verifySession(_getCookie(req, SESSION_COOKIE));
}

// Session + site-role gate shared by the write endpoints below: 401 if no
// session, 403 if the session's role on SITE is below minRole, else cb(session).
function _requireRole(req, res, minRole, cb) {
  const s = _session(req);
  if (!s) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
  auth.getSiteRole(s.profileId, SITE).then(role => {
    if (!auth.roleAtLeast(role, minRole)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Forbidden' }));
    }
    cb(s);
  }).catch(e => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(_errBody(e));
  });
}

// Platform-admin gate for the grand-editor portal (/api/sites*): distinct
// from _requireRole's per-site role check. 401 if no session, 403 if the
// session's email is not in PLATFORM_ADMIN_EMAILS, else returns the session.
function _requirePlatformAdmin(req, res) {
  const s = _session(req);
  if (!s) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'auth required' })); return null; }
  if (!auth.isPlatformAdmin(s.email)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'platform admin only' })); return null; }
  return s;
}

// Per-slug editor gate for the scene-object editor (Phase 2 SLICE 2a): unlike
// _requireRole (which checks only the env-pinned SITE), this checks role on
// an arbitrary :slug, since the editor is multi-site. Platform admins bypass
// the per-site role check (they can edit any site, same as _requirePlatformAdmin).
function _requireSiteEditor(req, res, slug, cb) {
  const s = _session(req);
  if (!s) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
  if (auth.isPlatformAdmin(s.email)) { cb(s); return; }
  auth.getSiteRole(s.profileId, slug).then(role => {
    if (!auth.roleAtLeast(role, 'editor')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Forbidden' }));
    }
    cb(s);
  }).catch(e => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(_errBody(e));
  });
}

// Reads + JSON-parses the request body (shared by the auth POST routes).
function _readJsonBody(req, cb) {
  let body = '';
  let bodySize = 0;
  req.on('data', c => { bodySize += c.length; if (bodySize > POST_BODY_LIMIT) { req.destroy(); return; } body += c; });
  req.on('end', () => {
    try { cb(null, JSON.parse(body || '{}')); }
    catch (e) { cb(e); }
  });
}

// ── Auto-commit data changes to GitHub ────────────────────────────────────
// Requires GITHUB_PAT env var. Runs async — write response is not delayed.
// Commits tagged [skip render] so Render ignores them (data-only, no rebuild).
let _gitPushPending = false;
function _gitCommitPush(relPath) {
  const pat = process.env.GITHUB_PAT;
  if (!pat) return;
  if (_gitPushPending) return;
  _gitPushPending = true;
  setTimeout(() => {
    _gitPushPending = false;
    const remote  = `https://x-access-token:${pat}@github.com/Streetjk/landcros-forrestdale.git`;
    const msg     = `auto: update ${SITE}/${relPath} [skip render]`;
    const dataDir = path.join('sites', SITE, 'data');
    const git = (args) => new Promise((resolve, reject) => {
      execFile('git', args, (err, _stdout, stderr) => {
        if (err) { err.stderr = stderr; return reject(err); }
        resolve();
      });
    });
    (async () => {
      try {
        await git(['-C', ROOT, 'config', 'user.email', 'sitenav-bot@render.com']);
        await git(['-C', ROOT, 'config', 'user.name', 'SiteNav Bot']);
        await git(['-C', ROOT, 'remote', 'set-url', 'origin', remote]);
        await git(['-C', ROOT, 'add', '-A', '--', dataDir]);
        try {
          await git(['-C', ROOT, 'diff', '--cached', '--quiet']);
          return; // exit 0 → nothing staged, nothing to commit
        } catch {
          // non-zero exit → there are staged changes, proceed to commit
        }
        await git(['-C', ROOT, 'commit', '-m', msg]);
        await git(['-C', ROOT, 'pull', '--rebase', 'origin', 'HEAD']);
        await git(['-C', ROOT, 'push', 'origin', 'HEAD']);
        console.log('[git-push] pushed:', msg);
      } catch (err) {
        console.error('[git-push] failed:', err.stderr?.trim() || err.message);
      }
    })();
  }, 2000);
}

const VISITS_FILE = path.join(DATA, 'visits.json');
function _readVisits() {
  try { return JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8')); }
  catch { return { total: 0, firstVisit: null, lastVisit: null, points: {} }; }
}
function _writeVisits(v) { fs.writeFileSync(VISITS_FILE, JSON.stringify(v, null, 2), 'utf8'); }

const SHARED_LINKS_FILE = path.join(DATA, 'shared-links.json');
function _readSharedLinks() {
  try { return JSON.parse(fs.readFileSync(SHARED_LINKS_FILE, 'utf8')); }
  catch { return {}; }
}
function _writeSharedLinks(l) { fs.writeFileSync(SHARED_LINKS_FILE, JSON.stringify(l, null, 2), 'utf8'); }
const _shareHits = new Map(); // ip → array of creation timestamps (rolling-hour rate limit)

// Generic per-IP rolling-window rate limit. Returns true (and sends 429) when
// the caller is over budget. Used to blunt auth enumeration / mass profile
// creation on the email-only (no-verification) login endpoints.
const _rlBuckets = new Map();
function _rateLimited(req, res, bucket, max, windowMs) {
  const ip  = req.socket.remoteAddress || 'unknown';
  const key = bucket + ':' + ip;
  const now = Date.now();
  const hits = (_rlBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate limit' }));
    return true;
  }
  hits.push(now);
  _rlBuckets.set(key, hits);
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.ply':  'application/octet-stream',
  '.splat':'application/octet-stream',
  '.stl':  'application/octet-stream',
  '.geojson': 'application/json; charset=utf-8',
};

// Binary/image assets are content-addressed (their content rarely changes after deploy)
const IMMUTABLE_EXTS = new Set(['.splat', '.ply', '.stl', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
const POST_BODY_LIMIT = 1_000_000; // 1 MB max for JSON POST bodies (auth, points, contacts, visit)

function addHeaders(res, extra = {}) {
  // COOP/COEP only on viewer3d so SharedArrayBuffer works; skip for admin
  Object.entries(extra).forEach(([k, v]) => res.setHeader(k, v));
}

const server = http.createServer((req, res) => {
  const url  = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // ── Write API ─────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, GET, HEAD, OPTIONS',
    });
    return res.end();
  }

  // ── Auth (Stage 2b): per-user email login, gates the admin surface only ──
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (_rateLimited(req, res, 'auth-login', 30, 3600000)) return;
    _readJsonBody(req, (err, { email } = {}) => {
      if (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
      if (!auth.emailAllowed(email)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'denied' }));
      }
      auth.checkProfile(email).then(st => {
        if (st.status === 'active') {
          _setSessionCookie(req, res, auth.signSession({ profileId: st.profileId, email }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: st.status, email }));
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      });
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/create') {
    if (_rateLimited(req, res, 'auth-create', 10, 3600000)) return;
    _readJsonBody(req, (err, { email } = {}) => {
      if (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
      if (!auth.emailAllowed(email)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'denied' }));
      }
      auth.createProfile(email).then(({ status, profileId }) => {
        if (status === 'active') {
          _setSessionCookie(req, res, auth.signSession({ profileId, email }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status }));
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      });
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const s = _session(req);
    if (!s) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    auth.getSiteRole(s.profileId, SITE).then(role => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email: s.email, role }));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(_errBody(e));
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    _clearSessionCookie(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── Admin: pending profile approval (admin/owner of SITE only) ──────────
  if (req.method === 'GET' && pathname === '/api/admin/pending') {
    _requireRole(req, res, 'admin', () => {
      auth.listPendingProfiles().then(pending => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pending));
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      });
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/approve') {
    _requireRole(req, res, 'admin', () => {
      _readJsonBody(req, (err, { profileId } = {}) => {
        if (err || !profileId) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'profileId is required' })); }
        auth.approveProfile(profileId).then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }).catch(e => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(_errBody(e));
        });
      });
    });
    return;
  }

  // ── Platform admin: grand-editor site management (Phase 2 SLICE 1) ─────
  // Gated by _requirePlatformAdmin (PLATFORM_ADMIN_EMAILS), NOT _requireRole —
  // this is a platform-level surface, distinct from any single site's login.
  if (req.method === 'GET' && pathname === '/api/sites') {
    const s = _requirePlatformAdmin(req, res);
    if (!s) return;
    siteAdmin.listAllSites().then(sites => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sites));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(_errBody(e));
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/sites') {
    const s = _requirePlatformAdmin(req, res);
    if (!s) return;
    _readJsonBody(req, (err, { slug, name, title, address, logo } = {}) => {
      if (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
      siteAdmin.createSite({ slug, name, title, address, logo, createdByProfileId: s.profileId }).then(site => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(site));
      }).catch(e => {
        const message = (e && e.message) || '';
        if (message === 'slug already exists') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: message }));
        }
        if (message === 'invalid slug' || message === 'name is required') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: message }));
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      });
    });
    return;
  }

  const _publishMatch = /^\/api\/sites\/([a-z0-9][a-z0-9-]{1,62})\/publish$/.exec(pathname);
  if (_publishMatch && req.method === 'POST') {
    const s = _requirePlatformAdmin(req, res);
    if (!s) return;
    _readJsonBody(req, (err, { published } = {}) => {
      if (err || typeof published !== 'boolean') { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'published (boolean) is required' })); }
      siteAdmin.setPublished(_publishMatch[1], published).then(site => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(site));
      }).catch(e => {
        if (e && e.message === 'site not found') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'site not found' }));
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      });
    });
    return;
  }

  // ── Scene objects — drag-drop editor persistence (Phase 2 SLICE 2a) ────
  // Reads are public ONLY for published sites (the viewer renders scene
  // objects for any published site); unpublished sites require viewer+
  // membership. Writes require an editor+ role on :slug (multi-site — see
  // _requireSiteEditor, distinct from _requireRole's single env-SITE check).
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
  const _objectsMatch = /^\/api\/sites\/([^/]+)\/objects$/.exec(pathname);
  if (_objectsMatch && (req.method === 'GET' || req.method === 'POST')) {
    const slug = _objectsMatch[1];
    if (!SLUG_RE.test(slug)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    if (req.method === 'GET') {
      const sendObjects = () => sceneDb.listSceneObjects(slug).then(objects => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(objects));
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      });
      const deny = () => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); };
      sceneDb.isSitePublished(slug).then(published => {
        if (published) return sendObjects();
        const s = _session(req);
        if (!s) return deny();
        if (auth.isPlatformAdmin(s.email)) return sendObjects();
        return auth.getSiteRole(s.profileId, slug).then(role => {
          if (!auth.roleAtLeast(role, 'viewer')) return deny();
          return sendObjects();
        });
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      });
      return;
    }
    _requireSiteEditor(req, res, slug, (s) => {
      _readJsonBody(req, (err, obj) => {
        if (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
        sceneDb.saveSceneObject(slug, obj, s.profileId).then(saved => {
          console.log(`[objects] ${slug}/${saved.id} saved by ${s.profileId}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(saved));
        }).catch(e => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(_errBody(e));
        });
      });
    });
    return;
  }

  const _objectDeleteMatch = /^\/api\/sites\/([^/]+)\/objects\/([0-9a-fA-F-]{36})$/.exec(pathname);
  if (_objectDeleteMatch && req.method === 'DELETE') {
    const slug = _objectDeleteMatch[1];
    const id = _objectDeleteMatch[2];
    if (!SLUG_RE.test(slug)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    _requireSiteEditor(req, res, slug, (s) => {
      sceneDb.deleteSceneObject(slug, id, s.profileId).then(() => {
        console.log(`[objects] ${slug}/${id} deleted by ${s.profileId}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      });
    });
    return;
  }

  // ── Share link store ──────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/share') {
    let body = '';
    let bodySize = 0;
    req.on('data', c => { bodySize += c.length; if (bodySize > POST_BODY_LIMIT) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      try {
        const pinData = JSON.parse(body);
        if (JSON.stringify(pinData).length > 100_000) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'pinData too large' }));
        }
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        const hits = (_shareHits.get(ip) || []).filter(t => now - t < 3_600_000);
        if (hits.length >= 20) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'rate limit' }));
        }
        hits.push(now);
        _shareHits.set(ip, hits);
        const links = _readSharedLinks();
        const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
        let code;
        do { code = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
        while (links[code]);
        links[code] = { pinData, created: new Date().toISOString() };
        _writeSharedLinks(links);
        _gitCommitPush('data/shared-links.json');
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const shareUrl = `${proto}://${req.headers['host']}/${code}`;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ code, url: shareUrl }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/share/')) {
    const code = pathname.slice('/api/share/'.length).replace(/[^a-z0-9]/g, '');
    if (!code) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'missing code' })); }
    const links = _readSharedLinks();
    const entry = links[code];
    if (!entry) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    if (Date.now() - new Date(entry.created).getTime() > 90 * 24 * 60 * 60 * 1000) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'expired' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(entry.pinData));
  }

  if (req.method === 'GET' && pathname === '/api/visits') {
    if (sdb.isConfigured()) {
      sdb.getVisits(SITE).then(v => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(v));
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      });
      return;
    }
    const v = _readVisits();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(v));
  }

  if (req.method === 'POST' && pathname === '/api/visit') {
    let body = '';
    let bodySize = 0;
    req.on('data', c => { bodySize += c.length; if (bodySize > POST_BODY_LIMIT) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      (async () => {
        try {
          const { pointId } = JSON.parse(body || '{}');
          let total;
          if (sdb.isConfigured()) {
            await sdb.recordVisit(SITE, pointId || null);
            total = (await sdb.getVisits(SITE)).total;
          } else {
            const v = _readVisits();
            v.total = (v.total || 0) + 1;
            if (!v.firstVisit) v.firstVisit = new Date().toISOString();
            v.lastVisit = new Date().toISOString();
            if (pointId) v.points[pointId] = (v.points[pointId] || 0) + 1;
            _writeVisits(v);
            total = v.total;
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, total }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(_errBody(e));
        }
      })();
    });
    return;
  }

  // ── Points/contacts — Supabase-backed admin data path (see supabase-db.js) ─
  // Reads are public (parity with the old static data/points.json &
  // data/contacts.json files); writes require an editor+ session on SITE
  // (see _requireRole) — replaces the old shared-secret write gate.
  if (pathname === '/api/points' && (req.method === 'GET' || req.method === 'POST')) {
    if (!sdb.isConfigured()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Supabase not configured: set SUPABASE_DB_URL' }));
    }
    if (req.method === 'GET') {
      sdb.getPoints(SITE).then(points => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(points));
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      });
      return;
    }
    _requireRole(req, res, 'editor', (s) => {
      let body = '';
      let bodySize = 0;
      req.on('data', c => { bodySize += c.length; if (bodySize > POST_BODY_LIMIT) { req.destroy(); return; } body += c; });
      req.on('end', () => {
        (async () => {
          try {
            const point = JSON.parse(body);
            const saved = await sdb.savePoint(SITE, point, s.profileId);
            console.log(`[points] ${SITE}/${saved.id} saved by ${s.profileId}`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(saved));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(_errBody(e));
          }
        })();
      });
    });
    return;
  }

  const _pointDeleteMatch = /^\/api\/points\/([0-9a-fA-F-]{36})$/.exec(pathname);
  if (_pointDeleteMatch && req.method === 'DELETE') {
    if (!sdb.isConfigured()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Supabase not configured: set SUPABASE_DB_URL' }));
    }
    _requireRole(req, res, 'editor', (s) => {
      sdb.deletePoint(SITE, _pointDeleteMatch[1], s.profileId).then(() => {
        console.log(`[points] ${SITE}/${_pointDeleteMatch[1]} deleted by ${s.profileId}`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      });
    });
    return;
  }

  if (pathname === '/api/contacts' && (req.method === 'GET' || req.method === 'POST')) {
    if (!sdb.isConfigured()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Supabase not configured: set SUPABASE_DB_URL' }));
    }
    if (req.method === 'GET') {
      sdb.getContacts(SITE).then(contacts => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(contacts));
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(_errBody(e));
      });
      return;
    }
    _requireRole(req, res, 'editor', (s) => {
      let body = '';
      let bodySize = 0;
      req.on('data', c => { bodySize += c.length; if (bodySize > POST_BODY_LIMIT) { req.destroy(); return; } body += c; });
      req.on('end', () => {
        (async () => {
          try {
            const contact = JSON.parse(body);
            const saved = await sdb.saveContact(SITE, contact, s.profileId);
            console.log(`[contacts] ${SITE}/${saved.id} saved by ${s.profileId}`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(saved));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(_errBody(e));
          }
        })();
      });
    });
    return;
  }

  // ── Short-code redirect: /<8-char-code> → viewer3d.html?s=<code> ──────
  const _shortMatch = /^\/([a-z2-9]{8})$/.exec(pathname);
  if (_shortMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    const code = _shortMatch[1];
    const links = _readSharedLinks();
    if (links[code]) {
      res.writeHead(302, { 'Location': `/viewer3d.html?s=${code}` });
      return res.end();
    }
  }

  // ── Static files ──────────────────────────────────────────────────────
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }

  // Resolve file path — site-specific data/assets take priority over engine root
  let filePath;
  if (pathname.startsWith('/data/')) {
    filePath = path.join(SITE_DIR, pathname);
  } else if (pathname.startsWith('/assets/')) {
    const siteAsset = path.join(SITE_DIR, pathname);
    filePath = fs.existsSync(siteAsset) ? siteAsset : path.join(ROOT, pathname);
  } else {
    // Engine files (HTML, JS, CSS) — also check site root for branding files (logo.png, etc.)
    const enginePath = path.join(ROOT, pathname === '/' ? '/index.html' : pathname);
    const sitePath   = path.join(SITE_DIR, pathname.replace(/^\//, ''));
    filePath = fs.existsSync(enginePath) ? enginePath : sitePath;
  }

  // Prevent path traversal
  const resolved = path.resolve(filePath);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  filePath = resolved;

  // Directory → index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    // Try .html extension fallback (e.g. /viewer3d → viewer3d.html)
    const htmlFallback = filePath + '.html';
    if (fs.existsSync(htmlFallback)) {
      filePath = htmlFallback;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found: ' + pathname);
    }
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);

  // Conditional GET (ETag via mtime)
  const etag  = `"${stat.mtimeMs.toString(16)}"`;
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch === etag) {
    res.writeHead(304); return res.end();
  }

  // All HTML pages get COOP/COEP so viewer3d can be embedded as an iframe
  // (credentialless COEP allows CDN resources like Leaflet, Google Fonts)
  const coopHeaders = (ext === '.html' || pathname === '/') ? {
    'Cross-Origin-Opener-Policy':   'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
  } : {};

  const cacheControl = IMMUTABLE_EXTS.has(ext)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  // HTTP Range support — required by the Gaussian splat loader for .splat/.ply files
  const rangeHeader = req.headers['range'];
  if (rangeHeader) {
    const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (m) {
      const start = parseInt(m[1], 10);
      const end   = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Type':   mime,
        'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control':  cacheControl,
        ...coopHeaders,
      });
      if (req.method === 'HEAD') return res.end();
      const rs = fs.createReadStream(filePath, { start, end });
      rs.pipe(res);
      rs.on('error', () => res.destroy());
      return;
    }
  }

  const headers = {
    'Content-Type':   mime,
    'Content-Length': stat.size,
    'Accept-Ranges':  'bytes',
    'ETag':           etag,
    'Cache-Control':  cacheControl,
    ...coopHeaders,
  };

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', () => res.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SiteNav dev server → http://0.0.0.0:${PORT}`);
  console.log(`  Admin 2D: http://192.168.50.95:${PORT}/`);
  console.log(`  Admin 3D: http://192.168.50.95:${PORT}/admin3d.html`);
  console.log(`  Viewer:   http://192.168.50.95:${PORT}/viewer3d.html`);
});
