// Menjalankan SEMUA layanan sekaligus: broker MQTT + bridge ke database + dashboard web.
// Layanan yang mati dihidupkan ulang otomatis. Log disimpan di logs/system.log.
//   npm start        (Ctrl+C untuk menghentikan semuanya)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, ENV_FILE } = require('./_env');

if (!fs.existsSync(ENV_FILE)) {
  console.error('.env.local belum ada. Jalankan dulu: npm run setup');
  process.exit(1);
}

const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'system.log');
try { if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.truncateSync(LOG_FILE, 0); } catch { /* belum ada */ }
const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });

const stamp = () => new Date().toLocaleString('id-ID', { hour12: false, timeZone: 'Asia/Jakarta' });
function log(tag, line) {
  const msg = `${stamp()} [${tag}] ${line}`;
  console.log(msg);
  out.write(msg + '\n');
}

const services = [
  { name: 'broker', args: ['scripts/mqtt-users.js', '--run', '--quiet'], startDelay: 0 },
  { name: 'bridge', args: ['bridge/bridge.js'], startDelay: 3000 },   // tunggu broker siap
  { name: 'web', args: ['scripts/local-server.js'], startDelay: 0 },
];
let stopping = false;

function launch(svc) {
  // process.execPath = node yang sama dengan yang menjalankan skrip ini (tidak bergantung PATH)
  const child = spawn(process.execPath, svc.args, { cwd: ROOT, env: process.env, windowsHide: true });
  svc.child = child;
  log('sistem', `${svc.name} dimulai (pid ${child.pid})`);
  const pipe = (s) => s.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => log(svc.name, l)));
  pipe(child.stdout); pipe(child.stderr);
  child.on('error', (e) => log('sistem', `${svc.name} gagal dijalankan: ${e.message}`));
  child.on('exit', (code) => {
    if (stopping) return;
    log('sistem', `${svc.name} berhenti (kode ${code}). Dimulai ulang dalam 5 detik...`);
    setTimeout(() => launch(svc), 5000);
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}
function shutdown() {
  if (stopping) return;
  stopping = true;
  log('sistem', 'menghentikan semua layanan...');
  services.forEach((s) => killTree(s.child));
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('sistem', 'MES Power Monitor dimulai (broker + bridge + web)');
services.forEach((s) => setTimeout(() => launch(s), s.startDelay));
