const { safeEqual, requireJsonPost, createSessionValue, setSessionCookie, SESSION_MS } = require('../lib/auth');

module.exports = async (req, res) => {
  if (!requireJsonPost(req, res)) return;
  const pw = String((req.body && req.body.password) || '');
  if (!process.env.DASHBOARD_PASSWORD || !pw || !safeEqual(pw, process.env.DASHBOARD_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 700)); // perlambat brute force
    return res.status(401).json({ error: 'wrong_password' });
  }
  setSessionCookie(res, createSessionValue(), SESSION_MS / 1000);
  res.json({ ok: true });
};
