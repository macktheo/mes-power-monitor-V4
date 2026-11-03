require('./env');
// Ambang batas dashboard (harus selaras dengan firmware ESP32)
module.exports = {
  WARN_POWER_W: 250,     // toast peringatan daya di dashboard
  WARN_CURRENT_A: 1.0,   // toast peringatan arus di dashboard
  TRIP_POWER_W: 310,     // trip overpower (di ESP32)
  TRIP_CURRENT_A: 1.5,   // trip overcurrent (di ESP32)
  ONLINE_TIMEOUT_S: 15,  // ESP32 dianggap DISCONNECTED jika tidak kirim data > 15 detik
  TARIFF_PER_KWH: parseFloat(process.env.TARIF_PER_KWH || '1444.70'),
};
