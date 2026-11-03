// Logika bridge (terpisah dari koneksi MQTT agar mudah diuji).
//
// Alur data: telemetry/event masuk -> ANTREAN (urut) -> database. Bila database tidak terjangkau, antrean disimpan
// ke disk (spool) dan dikirim ulang berurutan saat database kembali. Energi dihitung di database (energy_daily)
// dan ringkasannya dipublikasikan (retained) ke dashboard lewat MQTT.
const energy = require('../lib/energy');

const STATUSES = ['STOPPED', 'RUNNING', 'FAULT'];
const inRange = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

function createHandlers({
  sql, persistMs = 5000, spool = null, publishEnergy = () => {}, queueMax = 20000, prepare = async () => {},
  now = Date.now, log = console.log, warn = console.error,
}) {
  let lastSavedAt = -Infinity;
  let lastStatus = null;
  let espOnline = null;

  let queue = [];            // item belum masuk DB: {k:'t', ts, volt, amp, watt, e, st} | {k:'e', ts, type, detail}
  let state = null;          // cermin energy_state di DB: {kwh, ts}; null = belum sinkron
  let daily = null;          // cermin energy_daily 30 hari terakhir {'YYYY-MM-DD': kWh}
  let dbOk = true;
  let flushing = false;
  let lastPublishAt = 0;
  let lastSyncAt = 0;
  let dropped = 0;

  if (spool) {
    queue = spool.load().slice(-queueMax).map((it) => ({ ...it, _saved: true }));
    if (queue.length) { spool.replace(queue); log(`[bridge] ${queue.length} data antrean dari disk akan dikirim ke database`); }
  }

  // ---------- antrean ----------
  function spoolSync(rewrite = false) {
    if (!spool) return;
    try {
      if (!queue.length) spool.clear();
      else if (rewrite) { spool.replace(queue); queue.forEach((it) => { it._saved = true; }); }
      else {
        const fresh = queue.filter((it) => !it._saved);
        if (fresh.length) { spool.append(fresh); fresh.forEach((it) => { it._saved = true; }); }
      }
    } catch (e) { warn('[bridge] gagal menulis spool:', e.message); }
  }

  function enqueue(item) {
    queue.push(item);
    if (queue.length > queueMax) {
      const gone = queue.findIndex((it) => it.k === 't');          // buang telemetry terlama dulu; energi tetap
      queue.splice(gone >= 0 ? gone : 0, 1);                       // terkejar lewat selisih register berikutnya
      if (++dropped === 1) warn(`[bridge] antrean penuh (${queueMax}); data terlama dibuang`);
    }
    if (flushing) spoolSync();   // flush sedang menunggu database: amankan item baru ke disk sekarang
    return flush();
  }

  const remove = (it) => { const i = queue.indexOf(it); if (i >= 0) queue.splice(i, 1); };

  function markDb(ok, err) {
    if (ok === dbOk) return;
    dbOk = ok;
    if (ok) log('[bridge] database tersambung kembali');
    else {
      const hint = /does not exist|relation/i.test(err && err.message) ? ' -> jalankan: npm run init-db' : '';
      warn(`[bridge] gagal menulis ke database (${err && err.message})${hint}. Data diantre${spool ? ' & disimpan ke disk' : ''}, dicoba lagi otomatis.`);
    }
  }

  async function syncFromDb() {
    const [st, d] = await Promise.all([energy.loadState(sql), energy.loadDaily(sql, now())]);
    state = st; daily = d; lastSyncAt = now();
  }

  const iso = (ms) => new Date(ms).toISOString();

  // Terapkan item paling depan. Melempar error bila DB bermasalah (item tetap di antrean).
  async function applyHead() {
    const it = queue[0];
    if (it.k === 'e') {
      await sql`INSERT INTO event_log (ts, type, detail) VALUES (${iso(it.ts)}::timestamptz, ${it.type}, ${it.detail})`;
      remove(it);
      return;
    }
    // Register 0 saat patokan sudah > 0 = PZEM gagal dibaca (ESP32 mengirim voltage 0 / energy 0), bukan reset sungguhan.
    // Jangan dihitung & jangan jadikan patokan, kalau tidak register yang pulih (mis. 0,26) terhitung sebagai konsumsi baru.
    if (it.e === 0 && state && state.kwh > 0) it.e = null;
    if (it.e == null) {   // energi tidak valid: simpan telemetry saja
      await sql`INSERT INTO telemetry (ts, voltage_v, current_a, power_w, energy_kwh, status)
                VALUES (${iso(it.ts)}::timestamptz, ${it.volt}, ${it.amp}, ${it.watt}, ${null}, ${it.st})`;
      remove(it);
      return;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await energy.applySample(sql, state, it);
      if (r.status === 'applied') {
        state = r.state;
        for (const d of r.days) daily[d.day] = d.kwh;
        remove(it);                          // tanpa await antara update cermin & penghapusan: publish tidak melihat hitungan ganda
        if (r.kind === 'anomaly') {
          const s = ((it.ts - r.prevTs) / 1000).toFixed(0);
          enqueue({ k: 'e', ts: it.ts, type: 'ENERGY', detail: `Lonjakan register PZEM diabaikan: ${r.prevKwh.toFixed(3)} -> ${it.e.toFixed(3)} kWh dalam ${s} detik` });
        } else if (r.kind === 'reset') {
          enqueue({ k: 'e', ts: it.ts, type: 'ENERGY', detail: `Register PZEM turun ${r.prevKwh.toFixed(3)} -> ${it.e.toFixed(3)} kWh (reset/pembacaan salah); dihitung lanjut dari nilai baru` });
        }
        return;
      }
      if (r.status === 'duplicate') { remove(it); return; }   // sudah pernah masuk (mis. pengiriman ulang)
      await syncFromDb();                                         // 'conflict': patokan di DB berbeda -> sinkron ulang
    }
    throw new Error('patokan energi di database terus berubah (apakah ada dua bridge berjalan?)');
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    let applied = 0;
    try {
      if (!state) { await prepare(); await syncFromDb(); }
      while (queue.length) {
        await applyHead();
        applied++;
        if (applied % 50 === 0) publish();
      }
      markDb(true);
    } catch (e) {
      markDb(false, e);
    } finally {
      spoolSync(applied > 0);
      flushing = false;
    }
    publish(true);
  }

  // ---------- ringkasan energi untuk dashboard ----------
  // Normal: persis isi database. Saat ada antrean (DB putus): isi database + estimasi dari antrean.
  function snapshot(t) {
    if (!daily) return null;
    let d = daily;
    let shadow = state ? { ...state } : null;
    let estimated = false;
    for (const it of queue) {
      if (it.k !== 't' || it.e == null || !shadow || (it.e === 0 && shadow.kwh > 0)) continue;
      if (!estimated) { d = { ...daily }; estimated = true; }
      const p = energy.plan(shadow, it);
      if (p.kind === 'duplicate') continue;
      for (const x of p.days) d[x.day] = (d[x.day] || 0) + x.kwh;
      shadow = { kwh: it.e, ts: it.ts };
    }
    return {
      ...energy.summarize(d, t),
      registerKwh: shadow ? shadow.kwh : null,
      source: estimated ? 'estimate' : 'db',
      pending: queue.length,
      dbOk,
      asOf: t,
    };
  }

  function publish(force = false) {
    const t = now();
    if (!force && t - lastPublishAt < 1000) return;
    const s = snapshot(t);
    if (!s) return;
    lastPublishAt = t;
    try { publishEnergy(s); } catch (e) { warn('[bridge] gagal publish energi:', e.message); }
  }

  // ---------- handler MQTT ----------
  // Telemetry masuk tiap ~0,5-1 dtk; disimpan tiap persistMs, atau langsung saat status berubah.
  // (Energi tidak hilang karena persistMs: register PZEM kumulatif, jadi selisihnya mencakup semua yang terlewat.)
  async function onTelemetry(raw, nowMs) {
    const d = parse(raw);
    if (!d || !STATUSES.includes(d.status) || d.sensorOk === false) return;
    if (!inRange(d.voltage, 0, 300) || !inRange(d.current, 0, 100) || !inRange(d.power, 0, 30000)) return;
    const e = inRange(d.energy, 0, 1e7) ? d.energy : null;

    const changed = lastStatus !== null && d.status !== lastStatus;
    lastStatus = d.status;
    if (!changed && nowMs - lastSavedAt < persistMs) return;
    lastSavedAt = nowMs;
    await enqueue({ k: 't', ts: nowMs, volt: d.voltage, amp: d.current, watt: d.power, e, st: d.status });
  }

  const logEvent = (type, detail) => enqueue({ k: 'e', ts: now(), type, detail: String(detail).slice(0, 200) });

  async function onEvent(raw) {
    const d = parse(raw);
    if (!d || typeof d.detail !== 'string') return;
    await logEvent(d.type === 'TRIP' ? 'TRIP' : 'DEVICE', d.detail);
  }

  // Status online/offline dari ESP32 (LWT). Pesan retained saat bridge baru start tidak dicatat.
  async function onStatus(raw, retained) {
    const online = raw === 'online';
    if (retained) { espOnline = online; return; }
    if (espOnline === online) return;
    espOnline = online;
    await logEvent('CONNECTION', online ? 'ESP32 terhubung ke broker' : 'ESP32 terputus dari broker');
  }

  async function onCommand(raw) {
    const d = parse(raw);
    if (!d) return;
    if (d.cmd === 'RUN' || d.cmd === 'STOP') await logEvent('RELAY_CMD', 'Dashboard: ' + d.cmd);
    else if (d.cmd === 'RESET') await logEvent('FAULT_RESET', 'Reset FAULT dikirim dari dashboard');
  }

  // ---------- siklus hidup ----------
  const start = () => flush();
  // Dipanggil berkala (10 dtk): coba kirim antrean, publish ulang ringkasan (juga mengganti hari tepat tengah malam),
  // dan sinkron ulang dari DB tiap 5 menit agar tetap akurat bila DB diubah dari luar.
  async function tick() {
    if (!flushing && dbOk && !queue.length && state && now() - lastSyncAt > 300000) {
      try { await syncFromDb(); } catch (e) { markDb(false, e); }
    }
    if (queue.length || !state) await flush(); else publish(true);
  }
  const shutdown = () => spoolSync(true);

  return { onTelemetry, onEvent, onStatus, onCommand, start, tick, publish, shutdown, _debug: () => ({ queue, state, daily, dbOk }) };
}

module.exports = { createHandlers };
