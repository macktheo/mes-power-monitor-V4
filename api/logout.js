const { setSessionCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
};
