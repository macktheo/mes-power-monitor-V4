// Membuat/menyesuaikan skema PostgreSQL (Neon) + mengisi energi dari telemetry lama. Aman diulang. Pakai: npm run init-db
const { ENV_FILE, parseEnv } = require('./_env');
const { neon } = require('@neondatabase/serverless');
const { ensureSchema } = require('../lib/schema');

(async () => {
  const url = process.env.DATABASE_URL || parseEnv(ENV_FILE).DATABASE_URL;
  if (!url) { console.error('DATABASE_URL belum diisi. Jalankan "npm run setup" dulu.'); process.exit(1); }
  await ensureSchema(neon(url));
  console.log('Skema database siap (telemetry, event_log, energy_daily, energy_state).');
})().catch((e) => { console.error('Gagal:', e.message); process.exit(1); });
