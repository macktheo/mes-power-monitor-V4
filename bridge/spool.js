// Antrean di disk (JSON per baris) untuk data yang belum berhasil masuk database (internet / Neon putus).
// Bridge menulis ke sini hanya saat database bermasalah; saat normal file ini kosong/tidak ada.
const fs = require('fs');
const path = require('path');

const line = (it) => JSON.stringify(it, (k, v) => (k === '_saved' ? undefined : v));

function createSpool(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return {
    file,
    load() {
      let txt;
      try { txt = fs.readFileSync(file, 'utf8'); } catch { return []; }
      const out = [];
      for (const l of txt.split('\n')) {
        if (!l.trim()) continue;
        try { const o = JSON.parse(l); if (o && (o.k === 't' || o.k === 'e') && Number.isFinite(o.ts)) out.push(o); }
        catch { /* baris terpotong akibat proses mati mendadak: abaikan */ }
      }
      return out;
    },
    append(items) { if (items.length) fs.appendFileSync(file, items.map(line).join('\n') + '\n'); },
    replace(items) {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, items.map(line).join('\n') + (items.length ? '\n' : ''));
      fs.renameSync(tmp, file);
    },
    clear() { try { fs.rmSync(file, { force: true }); } catch { /* sudah tidak ada */ } },
  };
}

module.exports = { createSpool };
