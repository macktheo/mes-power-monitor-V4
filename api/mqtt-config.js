// GET /api/mqtt-config  -> kredensial broker untuk dashboard (hanya setelah login)
// User MQTT "dashboard" dibatasi ACL broker: hanya boleh membaca telemetry/status dan menulis command.
const { requireUser } = require('../lib/auth');
const cfg = require('../lib/config');

module.exports = async (req, res) => {
  // 1. Pastikan method adalah GET
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // 2. Autentikasi user (pastikan sudah login)
  if (!requireUser(req, res)) return;

  // 3. Pastikan Environment Variable WebSocket MQTT sudah diset di Vercel
  if (!process.env.MQTT_WS_URL) {
    return res.status(500).json({ 
      error: 'mqtt_not_configured', 
      message: 'MQTT_WS_URL belum diset di Environment Variables Vercel.' 
    });
  }

  // 4. Kirim respons konfigurasi MQTT ke dashboard
  try {
    return res.status(200).json({
      url: process.env.MQTT_WS_URL,
      username: process.env.MQTT_DASH_USER || '',
      password: process.env.MQTT_DASH_PASS || '',
      limits: { 
        warnPowerW: cfg.WARN_POWER_W, 
        warnCurrentA: cfg.WARN_CURRENT_A, 
        tripPowerW: cfg.TRIP_POWER_W, 
        tripCurrentA: cfg.TRIP_CURRENT_A 
      },
    });
  } catch (error) {
    console.error("Error generating MQTT config:", error);
    return res.status(500).json({ error: 'internal_server_error', message: 'Gagal memuat konfigurasi MQTT.' });
  }
};