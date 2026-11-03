// Bridge: berlangganan MQTT, menyimpan data ke PostgreSQL (Neon), menghitung energi, dan mempublikasikannya.
// Jalankan SATU instance saja di mesin yang selalu hidup:  npm run bridge
require('../lib/env');
const path = require('path');
const mqtt = require('mqtt');
const { getSql } = require('../lib/db');
const { createHandlers } = require('./handlers');
const { createSpool } = require('./spool');
const { ensureSchema } = require('../lib/schema');

const T = {
  telemetry: 'mes/power/telemetry',
  status: 'mes/power/status',
  event: 'mes/power/event',
  command: 'mes/power/command',
  energy: 'mes/power/energy',     // ringkasan kWh (retained), hanya bridge yang menulis
};

const spool = createSpool(process.env.BRIDGE_SPOOL_FILE || path.join(__dirname, '..', 'data', 'spool.jsonl'));
let client;   // diisi di bawah; dipakai handler saat publish

const h = createHandlers({
  sql: getSql(),
  persistMs: Number(process.env.BRIDGE_PERSIST_MS || 5000),
  spool,
  prepare: () => ensureSchema(getSql()),   // buat tabel otomatis bila belum ada
  publishEnergy: (payload) => {
    if (client && client.connected) client.publish(T.energy, JSON.stringify(payload), { qos: 1, retain: true });
  },
});

const url = process.env.MQTT_URL || 'mqtt://localhost:1883';
client = mqtt.connect(url, {
  username: process.env.MQTT_BRIDGE_USER,
  password: process.env.MQTT_BRIDGE_PASS,
  clientId: 'mes-bridge',
  reconnectPeriod: 3000,
  clean: true,
});

client.on('connect', () => {
  console.log(`[bridge] terhubung ke ${url}`);
  client.subscribe('mes/power/#', { qos: 1 });
  h.publish(true);   // segarkan pesan retained segera
});
client.on('reconnect', () => console.log('[bridge] mencoba menyambung ulang...'));
client.on('error', (e) => console.error('[bridge] error MQTT:', e.message));

// Diagnostik: tampilkan di log apakah ESP32 benar-benar mengirim data ke broker ini.
let rxTelemetry = 0, rxLast = 0, rxLastReported = 0;
client.on('message', (topic, payload, packet) => {
  const raw = payload.toString();
  if (topic === T.telemetry) { if (!rxTelemetry) console.log('[bridge] telemetry PERTAMA dari ESP32 diterima'); rxTelemetry++; rxLast = Date.now(); }
  if (topic === T.status) console.log(`[bridge] status ESP32: ${raw}${packet.retain ? ' (retained)' : ''}`);
  let job = null;
  if (topic === T.telemetry) job = h.onTelemetry(raw, Date.now());
  else if (topic === T.event) job = h.onEvent(raw);
  else if (topic === T.status) job = h.onStatus(raw, packet.retain);
  else if (topic === T.command) job = h.onCommand(raw);
  if (job) job.catch((e) => console.error(`[bridge] gagal memproses (${topic}):`, e.message));
});

setInterval(() => {
  if (!client.connected) return;
  if (!rxTelemetry) console.log('[bridge] BELUM ada telemetry dari ESP32. Cek: Serial Monitor ESP32 (harus "[MQTT] terhubung"), IP broker di firmware, firewall port 1883.');
  else if (Date.now() - rxLast > 30000) console.log(`[bridge] telemetry berhenti ${Math.round((Date.now() - rxLast) / 1000)} detik lalu (ESP32 mati / putus WiFi / broker).`);
  else if (Date.now() - rxLastReported > 300000) { rxLastReported = Date.now(); console.log(`[bridge] sehat: ${rxTelemetry} telemetry diterima sejak start.`); }
}, 30000);

h.start().catch((e) => console.error('[bridge] start:', e.message));
setInterval(() => h.tick().catch((e) => console.error('[bridge] tick:', e.message)), 10000);

const stop = () => { h.shutdown(); client.end(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
