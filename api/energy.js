// GET /api/energy  -> kWh hari ini & 30 hari terakhir + estimasi biaya (dashboard, auth: login)
// Dibaca dari tabel energy_daily, yang diisi bridge dari selisih register energi PZEM (lihat lib/energy.js).
// Dashboard utamanya menerima angka ini real-time lewat MQTT (mes/power/energy); endpoint ini untuk muat awal & cadangan.
const { getSql } = require('../lib/db');
const { requireUser } = require('../lib/auth');
const energy = require('../lib/energy');
const { ensureSchema } = require('../lib/schema');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!requireUser(req, res)) return;

  const now = Date.now();
  try {
    const sql = getSql();
    await ensureSchema(sql);   // tabel dibuat otomatis bila belum ada
    const daily = await energy.loadDaily(sql, now);
    res.json({ ...energy.summarize(daily, now), source: 'db', pending: 0, dbOk: true, asOf: now });
  } catch (e) {
    console.error('[api/energy]', e.message);
    res.status(503).json({ error: 'db_unavailable' });   // dashboard tetap menampilkan nilai terakhir tersimpan
  }
};
