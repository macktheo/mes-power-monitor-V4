// Membuat file password + konfigurasi Mosquitto dari .env.local, lalu (opsional) menjalankan broker.
//   npm run mqtt:users    -> hanya generate
//   npm run mqtt:broker   -> generate + jalankan mosquitto (Ctrl+C untuk berhenti)
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, ENV_FILE, parseEnv } = require('./_env');

const env = parseEnv(ENV_FILE);
const users = [
  [env.MQTT_ESP_USER, env.MQTT_ESP_PASS],
  [env.MQTT_DASH_USER, env.MQTT_DASH_PASS],
  [env.MQTT_BRIDGE_USER, env.MQTT_BRIDGE_PASS],
];
if (users.some(([u, p]) => !u || !p)) {
  console.error('Kredensial MQTT belum ada di .env.local. Jalankan: npm run setup');
  process.exit(1);
}

const dirs = ['', 'C:/Program Files/mosquitto/', '/usr/sbin/', '/usr/bin/', '/usr/local/sbin/', '/opt/homebrew/sbin/', '/opt/homebrew/bin/'];
function find(name) {
  for (const d of dirs) {
    for (const n of [name, name + '.exe']) {
      const r = spawnSync(d + n, ['--help'], { stdio: 'ignore' });
      if (!r.error) return d + n;
    }
  }
  return null;
}
const passwdTool = find('mosquitto_passwd');
if (!passwdTool) {
  console.error('mosquitto_passwd tidak ditemukan. Pasang Mosquitto dulu:\n' +
    '  Windows: https://mosquitto.org/download/  |  Ubuntu: sudo apt install mosquitto  |  macOS: brew install mosquitto');
  process.exit(1);
}

const dir = path.join(ROOT, 'mosquitto');
const passwd = path.join(dir, 'passwd');
fs.rmSync(passwd, { force: true });
users.forEach(([u, p], i) => {
  const r = spawnSync(passwdTool, [...(i === 0 ? ['-c'] : []), '-b', passwd, u, p], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('Gagal membuat user ' + u); process.exit(1); }
});

const f = (p) => p.replace(/\\/g, '/');
const conf = path.join(dir, 'mosquitto.generated.conf');
fs.writeFileSync(conf, [
  '# Dibuat otomatis oleh scripts/mqtt-users.js',
  'allow_anonymous false',
  `password_file ${f(passwd)}`,
  `acl_file ${f(path.join(dir, 'acl'))}`,
  '',
  'listener 1883',
  '',
  'listener 9001',
  'protocol websockets',
  '',
].join('\n'));
console.log(`User MQTT dibuat: ${users.map((u) => u[0]).join(', ')}\nKonfigurasi: ${conf}`);

if (process.argv.includes('--run')) {
  const broker = find('mosquitto');
  if (!broker) { console.error('Program mosquitto tidak ditemukan.'); process.exit(1); }
  console.log('\nMenjalankan broker (port 1883 untuk ESP32/bridge, 9001 WebSocket untuk dashboard). Ctrl+C untuk berhenti.\n');
  const verbose = !process.argv.includes('--quiet');
  const p = spawn(broker, ['-c', conf, ...(verbose ? ['-v'] : [])], { stdio: 'inherit' });
  p.on('exit', (code) => process.exit(code || 0));
} else {
  console.log(`\nJalankan broker:  npm run mqtt:broker`);
}
