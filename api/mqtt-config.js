// GET /api/mqtt-config  -> kredensial broker untuk dashboard (hanya setelah login)
// User MQTT "dashboard" dibatasi ACL broker: hanya boleh membaca telemetry/status dan menulis command.
const { requireUser } = require('../lib/auth');
const cfg = require('../lib/config');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!requireUser(req, res)) return;
  if (!process.env.MQTT_WS_URL) {
    return res.status(500).json({ error: 'mqtt_not_configured', message: 'MQTT_WS_URL belum diset.' });
  }
  res.json({
    url: process.env.MQTT_WS_URL,
    username: process.env.MQTT_DASH_USER || '',
    password: process.env.MQTT_DASH_PASS || '',
    limits: { warnPowerW: cfg.WARN_POWER_W, warnCurrentA: cfg.WARN_CURRENT_A, tripPowerW: cfg.TRIP_POWER_W, tripCurrentA: cfg.TRIP_CURRENT_A },
  });
};
