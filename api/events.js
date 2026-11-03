const { getSql } = require('../lib/db');
const { requireUser } = require('../lib/auth');

module.exports = async (req, res) => {
  const sql = getSql();

  // =========================================================================
  // 1. METHOD GET: Mengambil data log untuk ditampilkan di Dashboard Web
  // =========================================================================
  if (req.method === 'GET') {
    // Autentikasi hanya berlaku untuk user yang membuka dashboard
    if (!requireUser(req, res)) return;
    
    try {
      const rows = await sql`SELECT ts, type, detail FROM event_log ORDER BY ts DESC LIMIT 30`;
      return res.status(200).json(rows);
    } catch (error) {
      console.error("Database GET Error:", error);
      return res.status(500).json({ error: "Gagal mengambil data event" });
    }
  }

  // =========================================================================
  // 2. METHOD POST: Menerima pengiriman data dari EMQX Cloud
  // =========================================================================
  if (req.method === 'POST') {
    try {
      // Tangkap payload JSON dari ESP32 via EMQX
      const payload = req.body;
      
      // Log ke terminal Vercel untuk pengecekan (bisa dilihat di tab Logs)
      console.log("Data masuk dari EMQX:", payload);

      // (Opsional) Jika Anda ingin menyimpan log event trip ke tabel event_log:
      // if (payload.topic === 'mes/power/event') {
      //   await sql`INSERT INTO event_log (type, detail) VALUES ('TRIP_EVENT', ${JSON.stringify(payload)})`;
      // }

      // WAJIB: Kirim respon HTTP 200 OK agar EMQX menganggap pengiriman "Success"
      return res.status(200).json({ success: true, message: "Data berhasil diterima Vercel" });
    } catch (error) {
      console.error("Error processing POST event:", error);
      return res.status(500).json({ error: "Internal Server Error saat memproses data" });
    }
  }

  // =========================================================================
  // 3. TOLAK METHOD LAIN
  // =========================================================================
  return res.status(405).json({ error: 'method_not_allowed' });
};