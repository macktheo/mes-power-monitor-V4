// Memastikan skema database ada (idempoten) dan mengisi energi dari telemetry lama sekali saja.
// Dipanggil otomatis oleh bridge, API /api/energy, dan `npm run init-db`, jadi tidak ada lagi error
// "relation energy_daily does not exist" walau init-db belum pernah dijalankan.
const fs = require('fs');
const path = require('path');
require('./env');

// neon 0.10.x: sql(string) langsung; versi lebih baru: sql.query(string)
async function run(sql, text) {
  try { return await sql(text); }
  catch (e) {
    if (typeof sql.query === 'function' && /not a function|deprecated|tagged/i.test(e.message)) return sql.query(text);
    throw e;
  }
}

function statements() {
  const text = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  return text.split(';').map((s) => s.trim()).filter(Boolean);
}

// Isi energy_daily dari telemetry (aturan sama dengan lib/energy.js). Sampel dengan register 0 diabaikan:
// itu pembacaan PZEM gagal (voltage 0 / energy 0), bukan konsumsi, sehingga tidak menimbulkan hitungan ganda.
async function backfill(sql, maxW) {
  const added = await sql`
    INSERT INTO energy_daily (day, kwh)
    SELECT (q.ts AT TIME ZONE 'Asia/Jakarta')::date AS day,
           SUM(CASE WHEN q.diff >= -0.0005 AND q.diff <= ${maxW}::float8 / 1000.0 * q.hours + 0.002
                    THEN GREATEST(q.diff, 0) ELSE 0 END)::float8 AS kwh
    FROM (
      SELECT ts,
             energy_kwh::float8 - LAG(energy_kwh::float8) OVER w AS diff,
             EXTRACT(EPOCH FROM ts - LAG(ts) OVER w) / 3600.0 AS hours
      FROM telemetry
      WHERE energy_kwh IS NOT NULL AND energy_kwh > 0 AND ts >= now() - interval '40 days'
      WINDOW w AS (ORDER BY ts)
    ) q
    WHERE q.diff IS NOT NULL
    GROUP BY 1
    ON CONFLICT (day) DO NOTHING
    RETURNING day::text AS day, kwh`;
  await sql`
    UPDATE energy_state SET last_kwh = t.energy_kwh::float8, last_ts = date_trunc('milliseconds', t.ts)
    FROM (SELECT ts, energy_kwh FROM telemetry WHERE energy_kwh IS NOT NULL AND energy_kwh > 0 ORDER BY ts DESC LIMIT 1) t
    WHERE energy_state.id = 1 AND energy_state.last_ts IS NULL`;
  return added.length;
}

let ready = null;
// Aman dipanggil berkali-kali; hasil di-cache per proses. Bila gagal (mis. internet putus) akan dicoba lagi pada panggilan berikutnya.
function ensureSchema(sql, { log = console.log } = {}) {
  if (!ready) {
    ready = (async () => {
      for (const s of statements()) await run(sql, s);
      const st = await sql`SELECT last_ts IS NULL AS empty FROM energy_state WHERE id = 1`;
      if (st.length && st[0].empty) {
        const n = await backfill(sql, Number(process.env.ENERGY_MAX_W || 2000));
        log(`[db] skema siap; backfill energi dari telemetry lama: ${n} hari`);
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

module.exports = { ensureSchema, backfill, statements, run };
