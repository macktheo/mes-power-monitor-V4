// GET /api/history?range=1h|6h|24h|7d  (dashboard, auth: login)
const { getSql } = require('../lib/db');
const { requireUser } = require('../lib/auth');

// rentang (detik) dan ukuran bucket rata-rata (detik) -> maksimal ~360 titik per grafik
const RANGES = {
  '1h':  { secs: 3600,   bucket: 15 },
  '6h':  { secs: 21600,  bucket: 60 },
  '24h': { secs: 86400,  bucket: 300 },
  '7d':  { secs: 604800, bucket: 1800 },
};

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!requireUser(req, res)) return;

  const r = RANGES[req.query.range] || RANGES['1h'];
  const sql = getSql();
  const rows = await sql`
    SELECT to_timestamp(floor(extract(epoch FROM ts) / ${r.bucket}::float8) * ${r.bucket}::float8) AS t,
           avg(current_a)::float8 AS current_a,
           avg(power_w)::float8   AS power_w
    FROM telemetry
    WHERE ts >= now() - make_interval(secs => ${r.secs}::float8)
    GROUP BY 1
    ORDER BY 1`;
  res.json(rows.map((x) => ({ t: x.t, current: Number(x.current_a), power: Number(x.power_w) })));
};
