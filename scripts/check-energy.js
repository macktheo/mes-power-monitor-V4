// Cek cepat tanpa menjalankan dashboard: koneksi Neon, skema, dan angka energi hari ini / 30 hari. Pakai: npm run check
const { ENV_FILE, parseEnv } = require('./_env');
const { neon } = require('@neondatabase/serverless');
const { ensureSchema } = require('../lib/schema');
const energy = require('../lib/energy');

(async () => {
  const url = process.env.DATABASE_URL || parseEnv(ENV_FILE).DATABASE_URL;
  if (!url) { console.error('DATABASE_URL belum diisi.'); process.exit(1); }
  const sql = neon(url);
  await ensureSchema(sql);
  const t = (await sql`SELECT count(*)::int AS n, max(ts)::text AS last FROM telemetry`)[0];
  const daily = await energy.loadDaily(sql, Date.now());
  const s = energy.summarize(daily, Date.now());
  console.log(`telemetry: ${t.n} baris, terakhir ${t.last}`);
  console.log('energi per hari:', daily);
  console.log(`HARI INI: ${s.todayKwh.toFixed(3)} kWh | 30 HARI: ${s.monthKwh.toFixed(3)} kWh | biaya 30 hari: Rp ${Math.round(s.monthCost)}`);
})().catch((e) => { console.error('Gagal:', e.message); process.exit(1); });
