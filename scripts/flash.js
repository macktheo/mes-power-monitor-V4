// Compile + upload firmware ke ESP32. Pakai:
//   npm run flash                    (auto-deteksi port)
//   npm run flash -- --port=COM3     (atau /dev/ttyUSB0)
//   npm run flash:monitor            (upload lalu buka Serial Monitor)
//   npm run monitor                  (hanya Serial Monitor)
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT } = require('./_env');

const SKETCH = path.join(ROOT, 'firmware', 'esp32_mes_monitor');
const FQBN = 'esp32:esp32:esp32';
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

// arduino-cli mungkin baru dipasang dan belum ada di PATH sesi ini
const extra = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), 'bin'), path.join(os.homedir(), 'arduino-cli')];
process.env.PATH = extra.join(path.delimiter) + path.delimiter + process.env.PATH;

const cli = (a, o = {}) => spawnSync('arduino-cli', a, { stdio: 'inherit', ...o });
const die = (m) => { console.error('\n' + m); process.exit(1); };

if (cli(['version'], { stdio: 'ignore' }).status !== 0) {
  die('arduino-cli tidak ditemukan. Jalankan scripts/install.sh (Linux/macOS) atau scripts/install.ps1 (Windows) dulu.');
}

function detectPort() {
  const r = spawnSync('arduino-cli', ['board', 'list', '--format', 'json'], { encoding: 'utf8' });
  try {
    const j = JSON.parse(r.stdout);
    const list = Array.isArray(j) ? j : (j.detected_ports || []);
    const ports = list.map((x) => x.port || {}).filter((p) =>
      p.protocol === 'serial' && p.address &&
      !/^\/dev\/ttyS\d+$/.test(p.address) && !/bluetooth|debug-console/i.test(p.address));
    return ports.length ? ports[0].address : null;
  } catch { return null; }
}

const portArg = (args.find((a) => a.startsWith('--port=')) || '').split('=')[1];
const port = portArg || detectPort();
if (!port) die('Port ESP32 tidak terdeteksi. Colok USB (pakai kabel data, bukan kabel charger) dan/atau pasang driver CH340/CP210x.\nAtau tentukan manual: npm run flash -- --port=COM3');

if (!has('--monitor-only')) {
  if (!fs.existsSync(path.join(SKETCH, 'secrets.h'))) die('secrets.h belum ada. Jalankan: npm run setup');
  console.log('==> Compile firmware');
  if (cli(['compile', '--fqbn', FQBN, SKETCH]).status !== 0) die('Compile gagal. Kirim pesan error di atas untuk diperbaiki.');
  console.log(`==> Upload ke ${port}`);
  if (cli(['upload', '-p', port, '--fqbn', FQBN, SKETCH]).status !== 0) {
    die('Upload gagal. Coba: tahan tombol BOOT di ESP32 saat tulisan "Connecting..." muncul, lalu ulangi.');
  }
  console.log('Upload berhasil.');
}

if (has('--monitor') || has('--monitor-only')) {
  console.log(`==> Serial Monitor ${port} (Ctrl+C untuk keluar)`);
  cli(['monitor', '-p', port, '-c', 'baudrate=115200']);
}
