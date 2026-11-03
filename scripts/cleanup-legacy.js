// Membersihkan sisa endpoint HTTP lama (sudah digantikan MQTT, dashboard tidak memakainya lagi).
//   npm run cleanup           -> hanya menampilkan apa yang akan dihapus (aman)
//   npm run cleanup -- --yes  -> benar-benar menghapus
// File di public/ (gambar/video) TIDAK dihapus; hanya diberi peringatan.
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./_env');

const legacy = ['api/command.js', 'api/latest.js', 'api/relay.js', 'api/telemetry.js', 'api/fault/reset.js'];
const doIt = process.argv.includes('--yes');

let found = 0;
for (const rel of legacy) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) continue;
  found++;
  if (doIt) { fs.rmSync(f); console.log('dihapus :', rel); } else console.log('akan dihapus:', rel);
}
const faultDir = path.join(ROOT, 'api', 'fault');
if (doIt && fs.existsSync(faultDir) && fs.readdirSync(faultDir).length === 0) fs.rmdirSync(faultDir);
if (!found) console.log('Tidak ada file endpoint lama. Sudah bersih.');
else if (!doIt) console.log('\nJalankan "npm run cleanup -- --yes" untuk menghapus.');

// Peringatan: semua isi public/ dilayani TANPA login (lokal) dan publik jika di-deploy ke Vercel
const known = new Set(['index.html']);
const extra = fs.readdirSync(path.join(ROOT, 'public')).filter((n) => !known.has(n));
if (extra.length) {
  console.log('\n[!] File lain di folder public/ (dapat dibuka siapa pun tanpa login, dan tidak dipakai dashboard):');
  extra.forEach((n) => console.log('    -', n));
  console.log('    Pindahkan ke luar folder proyek bila tidak diperlukan.');
}
