// Deploy ke Vercel + upload environment variable dari .env.local. Pakai: npm run deploy
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, ENV_FILE, parseEnv } = require('./_env');

const env = parseEnv(ENV_FILE);
const NEED = ['DATABASE_URL', 'DASHBOARD_PASSWORD', 'SESSION_SECRET', 'TARIF_PER_KWH', 'MQTT_WS_URL', 'MQTT_DASH_USER', 'MQTT_DASH_PASS'];
const missing = NEED.filter((k) => !env[k]);
if (missing.length) {
  console.error('Belum terisi di .env.local: ' + missing.join(', ') + '\nJalankan: npm run setup');
  process.exit(1);
}

const vc = (args, opts = {}) =>
  spawnSync('npx', ['--yes', 'vercel', ...args], { cwd: ROOT, shell: true, stdio: 'inherit', encoding: 'utf8', ...opts });
const fail = (m) => { console.error('\n' + m); process.exit(1); };

console.log('==> Cek login Vercel');
if (vc(['whoami'], { stdio: 'pipe' }).status !== 0) {
  if (vc(['login']).status !== 0) fail('Login Vercel gagal.');
}

if (!fs.existsSync(path.join(ROOT, '.vercel', 'project.json'))) {
  console.log('==> Membuat/menghubungkan project Vercel');
  if (vc(['link', '--yes', '--project', 'mes-power-monitor']).status !== 0) fail('vercel link gagal.');
}

console.log('==> Mengunggah environment variable (production)');
for (const k of NEED) {
  vc(['env', 'rm', k, 'production', '--yes'], { stdio: 'pipe' }); // abaikan jika belum ada
  const r = vc(['env', 'add', k, 'production'], { stdio: ['pipe', 'inherit', 'inherit'], input: env[k] });
  if (r.status !== 0) fail(`Gagal menambah ${k}. Tambahkan manual di Vercel > Settings > Environment Variables.`);
}

console.log('==> Deploy production');
const d = vc(['deploy', '--prod', '--yes'], { stdio: ['inherit', 'pipe', 'inherit'] });
if (d.status !== 0) fail('Deploy gagal.');
console.log('\nURL deployment: ' + (d.stdout || '').trim());
console.log(`
Selesai. Penting:
 1. Dashboard di Vercel hanya bisa terhubung ke broker bila MQTT_WS_URL adalah wss://... yang bisa
    dijangkau dari internet (broker cloud, mis. HiveMQ Cloud / EMQX Cloud). ws://192.168.x.x hanya
    bekerja saat dashboard dibuka lewat "vercel dev" / http di jaringan lokal.
 2. ESP32 TIDAK memakai domain Vercel lagi: ia langsung ke broker MQTT.
 3. Bridge (npm run bridge) harus tetap berjalan di mesin yang selalu hidup agar data masuk ke database.
`);
