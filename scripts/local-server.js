// Server lokal untuk dashboard + API (pengganti "vercel dev"): tanpa Vercel CLI, tanpa login, ringan.
// Memakai file yang sama persis dengan Vercel: public/ (statis) dan api/*.js (handler).
require('../lib/env');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const API = path.join(ROOT, 'api');
const PORT = Number(process.env.PORT || 3000);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

function loadHandler(pathname) {
  const rel = pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9\-/]+$/i.test(rel) || rel.includes('..')) return null;
  const file = path.join(API, rel + '.js');
  if (!file.startsWith(API + path.sep) || !fs.existsSync(file)) return null;
  return require(file);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= 1e6) chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      if (String(req.headers['content-type'] || '').includes('application/json')) {
        try { return resolve(JSON.parse(raw)); } catch { return resolve(undefined); }
      }
      resolve(raw);
    });
    req.on('error', () => resolve(undefined));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    const handler = loadHandler(url.pathname);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(o)); return res; };
    if (!handler) return res.status(404).json({ error: 'not_found' });
    req.query = Object.fromEntries(url.searchParams);
    req.body = await readBody(req);
    try { await handler(req, res); }
    catch (e) { console.error('[api] error:', e.message); if (!res.headersSent) res.status(500).json({ error: 'server_error' }); }
    return;
  }

  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.statusCode = 400; return res.end('Bad request'); }
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404; return res.end('Not found');
  }
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard berjalan di http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  dari perangkat lain di WiFi yang sama: http://${i.address}:${PORT}`);
});
