// Membuat .env.local (rahasia backend + MQTT) dan firmware/.../secrets.h dari jawaban Anda.
// Aman dijalankan ulang: nilai lama dipakai sebagai default (tekan Enter untuk mempertahankan).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { ROOT, ENV_FILE, parseEnv } = require('./_env');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
// Antrian baris: aman untuk input interaktif maupun input yang di-pipe/paste sekaligus
const queue = [];
let waiting = null;
let closed = false;
rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else queue.push(l); });
rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(''); } });
const ask = (q, def = '') => {
  process.stdout.write(def ? `${q} [${def}]: ` : `${q}: `);
  return new Promise((res) => {
    const fin = (a) => res(a.trim() || def);
    if (queue.length) fin(queue.shift());
    else if (closed) fin('');
    else waiting = fin;
  });
};
const rnd = (n = 32) => crypto.randomBytes(n).toString('hex');
const cStr = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

(async () => {
  const cur = parseEnv(ENV_FILE);
  console.log('Tekan Enter untuk memakai nilai di dalam [ ].\n');

  const e = {};
  e.DATABASE_URL = await ask('DATABASE_URL (connection string Neon; boleh kosong dulu)', cur.DATABASE_URL || '');
  e.DASHBOARD_PASSWORD = await ask('Password login dashboard', cur.DASHBOARD_PASSWORD || '');
  while (!e.DASHBOARD_PASSWORD) {
    if (closed && !queue.length) { console.error('\nInput berakhir sebelum password dashboard diisi.'); process.exit(1); }
    e.DASHBOARD_PASSWORD = await ask('Password dashboard wajib diisi');
  }
  e.TARIF_PER_KWH = await ask('Tarif listrik Rp/kWh (cek tarif PLN golongan Anda!)', cur.TARIF_PER_KWH || '1444.70');
  e.SESSION_SECRET = cur.SESSION_SECRET || rnd();

  console.log('\n-- MQTT --');
  const host = (await ask('IP/host broker yang dijangkau ESP32 (IP laptop/Raspberry Pi)', cur.MQTT_ESP_HOST || '192.168.0.106'))
    .replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '');
  e.MQTT_ESP_HOST = host;
  e.MQTT_ESP_PORT = await ask('Port MQTT untuk ESP32 (1883 = lokal, 8883 = TLS cloud)', cur.MQTT_ESP_PORT || '1883');
  e.MQTT_USE_TLS = await ask('ESP32 pakai TLS ke broker? (0 = tidak, 1 = ya)', cur.MQTT_USE_TLS || '0');
  e.MQTT_WS_URL = await ask('URL WebSocket broker untuk dashboard (ws://... lokal, wss://... cloud)', cur.MQTT_WS_URL || `ws://${host}:9001`);
  e.MQTT_URL = await ask('URL broker untuk bridge (dijalankan di mesin yang sama dengan broker)', cur.MQTT_URL || `mqtt://localhost:${e.MQTT_ESP_PORT}`);
  e.MQTT_ESP_USER = cur.MQTT_ESP_USER || 'esp32';
  e.MQTT_ESP_PASS = cur.MQTT_ESP_PASS || rnd(12);
  e.MQTT_DASH_USER = cur.MQTT_DASH_USER || 'dashboard';
  e.MQTT_DASH_PASS = cur.MQTT_DASH_PASS || rnd(12);
  e.MQTT_BRIDGE_USER = cur.MQTT_BRIDGE_USER || 'bridge';
  e.MQTT_BRIDGE_PASS = cur.MQTT_BRIDGE_PASS || rnd(12);

  console.log('\n-- WiFi ESP32 --');
  e.ESP_WIFI_SSID = await ask('Nama WiFi untuk ESP32', cur.ESP_WIFI_SSID || '');
  e.ESP_WIFI_PASSWORD = await ask('Password WiFi', cur.ESP_WIFI_PASSWORD || '');
  rl.close();

  const lines = [
    '# Dibuat oleh scripts/configure.js - JANGAN commit file ini',
    ...Object.entries(e).map(([k, v]) => `${k}=${v}`),
  ];
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });

  const dir = path.join(ROOT, 'firmware', 'esp32_mes_monitor');
  let t = fs.readFileSync(path.join(dir, 'secrets.h.example'), 'utf8');
  t = t.replace(/#define WIFI_SSID .*/, () => `#define WIFI_SSID      "${cStr(e.ESP_WIFI_SSID || 'NAMA_WIFI')}"`)
       .replace(/#define WIFI_PASSWORD .*/, () => `#define WIFI_PASSWORD  "${cStr(e.ESP_WIFI_PASSWORD || 'PASSWORD_WIFI')}"`)
       .replace(/#define MQTT_HOST .*/, () => `#define MQTT_HOST      "${cStr(host)}"`)
       .replace(/#define MQTT_PORT .*/, () => `#define MQTT_PORT      ${parseInt(e.MQTT_ESP_PORT, 10) || 1883}`)
       .replace(/#define MQTT_USER .*/, () => `#define MQTT_USER      "${cStr(e.MQTT_ESP_USER)}"`)
       .replace(/#define MQTT_PASS .*/, () => `#define MQTT_PASS      "${cStr(e.MQTT_ESP_PASS)}"`)
       .replace(/#define MQTT_USE_TLS .*/, () => `#define MQTT_USE_TLS   ${e.MQTT_USE_TLS === '1' ? 1 : 0}`);
  fs.writeFileSync(path.join(dir, 'secrets.h'), t);

  console.log('\nTersimpan: .env.local dan firmware/esp32_mes_monitor/secrets.h (keduanya sudah di .gitignore).');
  console.log('Berikutnya: npm run mqtt:broker  (di terminal 1),  npm run bridge  (terminal 2),  npm run flash.');
  if (!e.DATABASE_URL) console.log('- DATABASE_URL masih kosong: isi lewat "npm run setup" setelah membuat database di neon.tech.');
})();
