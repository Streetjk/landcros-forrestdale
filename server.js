#!/usr/bin/env node
/**
 * SiteNav local dev server — HTTP/1.1, static files + POST /api/write
 * Usage: node server.js [port]   (default 50000)
 *
 * For SharePoint/cloud: flip USE_SHAREPOINT=true in db.js and retire this file.
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT    = __dirname;
const DATA    = path.join(ROOT, 'data');
const PORT    = parseInt(process.env.PORT || process.argv[2] || '50000', 10);

const VISITS_FILE = path.join(DATA, 'visits.json');
function _readVisits() {
  try { return JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8')); }
  catch { return { total: 0, firstVisit: null, lastVisit: null, points: {} }; }
}
function _writeVisits(v) { fs.writeFileSync(VISITS_FILE, JSON.stringify(v, null, 2), 'utf8'); }

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

  if (req.method === 'GET' && pathname === '/api/visits') {
    const v = _readVisits();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(v));
  }

  if (req.method === 'POST' && pathname === '/api/visit') {
    let body = '';
    req.on('data', c => body += c);
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
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { path: relPath, data } = JSON.parse(body);
        const target = path.resolve(ROOT, relPath);
        if (!target.startsWith(DATA + path.sep) && target !== DATA) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Write outside ./data/ forbidden' }));
        }
        fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
        console.log(`[write] ${relPath}`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }

  let filePath = path.join(ROOT, pathname === '/' ? '/index.html' : pathname);
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
        'Cache-Control':  'no-cache',
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
    'Cache-Control':  'no-cache',
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
