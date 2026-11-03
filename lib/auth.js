require('./env');
const crypto = require('crypto');

const SESSION_MS = 7 * 24 * 3600 * 1000;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- Autentikasi perangkat (ESP32) ----------
function requireDevice(req, res) {
  const key = req.headers['x-device-key'];
  if (!process.env.DEVICE_KEY || !key || !safeEqual(key, process.env.DEVICE_KEY)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// ---------- Sesi login dashboard (cookie bertanda tangan HMAC) ----------
function sign(payload) {
  if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET belum diset');
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
}

function createSessionValue() {
  const exp = String(Date.now() + SESSION_MS);
  return `${exp}.${sign(exp)}`;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function isLoggedIn(req) {
  const c = parseCookies(req).session;
  if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig) return false;
  if (!safeEqual(sign(exp), sig)) return false;
  return Number(exp) > Date.now();
}

function requireUser(req, res) {
  if (!isLoggedIn(req)) {
    res.status(401).json({ error: 'login_required' });
    return false;
  }
  return true;
}

function setSessionCookie(res, value, maxAgeSec) {
  // Secure hanya di Vercel (production/preview). Lokal (vercel dev / node) memakai http.
  const secure = ['production', 'preview'].includes(process.env.VERCEL_ENV) ? ' Secure;' : '';
  res.setHeader('Set-Cookie',
    `session=${value}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`);
}

// Untuk endpoint yang mengubah state: harus POST + JSON (mitigasi CSRF, ditambah SameSite=Strict)
function requireJsonPost(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return false;
  }
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    res.status(415).json({ error: 'json_required' });
    return false;
  }
  return true;
}

module.exports = {
  safeEqual, requireDevice, requireUser, requireJsonPost,
  createSessionValue, setSessionCookie, SESSION_MS,
};
