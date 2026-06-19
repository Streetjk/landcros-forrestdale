#!/usr/bin/env node
/**
 * SiteNav local dev server — HTTP/1.1, static files + POST /api/write
 * Usage: node server.js [port]   (default 50000)
 *
 * For SharePoint/cloud: flip USE_SHAREPOINT=true in db.js and retire this file.
 */
const http        = require('http');
const fs          = require('fs');
const path        = require('path');
const { exec }    = require('child_process');

// Load .env for local dev (Render sets env vars directly and those take precedence)
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const ROOT      = __dirname;
const SITE      = process.env.SITE || 'landcros';
const SITE_DIR  = path.join(ROOT, 'sites', SITE);
const DATA      = path.join(SITE_DIR, 'data');
const SHARED_ASSETS = path.join(ROOT, 'assets');
const PORT      = parseInt(process.env.PORT || process.argv[2] || '50000', 10);

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
    const remote = `https://x-access-token:${pat}@github.com/Streetjk/landcros-forrestdale.git`;
    const msg = `auto: update ${SITE}/${relPath} [skip render]`;
    const cmd = [
      `git -C "${ROOT}" config user.email "sitenav-bot@render.com"`,
      `git -C "${ROOT}" config user.name "SiteNav Bot"`,
      `git -C "${ROOT}" remote set-url origin "${remote}"`,
      `git -C "${ROOT}" add -A -- "${path.join('sites', SITE, 'data')}"`,
      `git -C "${ROOT}" diff --cached --quiet || git -C "${ROOT}" commit -m "${msg}"`,
      `git -C "${ROOT}" pull --rebase origin HEAD`,
      `git -C "${ROOT}" push origin HEAD`,
    ].join(' && ');
    exec(cmd, (err, _, stderr) => {
      if (err) console.error('[git-push] failed:', stderr?.trim());
      else console.log('[git-push] pushed:', msg);
    });
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
const POST_BODY_LIMIT = 1_000_000; // 1 MB max for /api/write and /api/visit

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
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
      'Access-Control-Allow-Methods': 'POST, GET, HEAD, OPTIONS',
    });
    return res.end();
  }

  // ── Share link store ──────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/share') {
    let body = '';
    let bodySize = 0;
    req.on('data', c => { bodySize += c.length; if (bodySize > POST_BODY_LIMIT) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      try {
        const pinData = JSON.parse(body);
        const links = _readSharedLinks();
        const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
        let code;
        do { code = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
        while (links[code]);
        links[code] = { pinData, created: new Date().toISOString() };
        _writeSharedLinks(links);
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const shareUrl = `${proto}://${req.headers['host']}/${code}`;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ code, url: shareUrl }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
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
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(entry.pinData));
  }

  if (req.method === 'GET' && pathname === '/api/visits') {
    const v = _readVisits();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(v));
  }

  if (req.method === 'POST' && pathname === '/api/visit') {
    let body = '';
    let bodySize = 0;
    req.on('data', c => { bodySize += c.length; if (bodySize > POST_BODY_LIMIT) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      try {
        const { pointId } = JSON.parse(body || '{}');
        const v = _readVisits();
        v.total = (v.total || 0) + 1;
        if (!v.firstVisit) v.firstVisit = new Date().toISOString();
        v.lastVisit = new Date().toISOString();
        if (pointId) v.points[pointId] = (v.points[pointId] || 0) + 1;
        _writeVisits(v);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, total: v.total }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/write') {
    if (!ADMIN_TOKEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Write API disabled: set ADMIN_TOKEN env var' }));
    }
    const token = req.headers['x-admin-token'] || '';
    if (!token || token !== ADMIN_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    let body = '';
    let bodySize = 0;
    req.on('data', chunk => { bodySize += chunk.length; if (bodySize > POST_BODY_LIMIT) { req.destroy(); return; } body += chunk; });
    req.on('end', () => {
      try {
        const { path: relPath, data } = JSON.parse(body);
        // Client sends "./data/foo.json" — remap to site data dir, reject anything else
        const stripped = relPath.replace(/^\.?\//, '');
        if (!stripped.startsWith('data/') && stripped !== 'data') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Write outside ./data/ forbidden' }));
        }
        const filename = stripped.slice('data/'.length);
        const target = path.join(DATA, filename);
        // Double-check no traversal
        if (!target.startsWith(DATA + path.sep) && target !== DATA) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Write outside ./data/ forbidden' }));
        }
        fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
        console.log(`[write] ${SITE}/${stripped}`);
        _gitCommitPush(stripped);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/auth-check') {
    if (!ADMIN_TOKEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false }));
    }
    const token = req.headers['x-admin-token'] || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: token === ADMIN_TOKEN }));
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
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

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
