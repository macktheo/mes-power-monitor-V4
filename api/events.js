// GET /api/events  -> 30 log kejadian terakhir (dashboard, auth: login)
const { getSql } = require('../lib/db');
const { requireUser } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!requireUser(req, res)) return;
  const sql = getSql();
  const rows = await sql`SELECT ts, type, detail FROM event_log ORDER BY ts DESC LIMIT 30`;
  res.json(rows);
};
