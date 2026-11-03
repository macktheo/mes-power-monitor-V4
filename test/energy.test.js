// Tes logika energi & bridge. Database ditiru di memori (meniru semantik SQL, termasuk compare-and-swap),
// jadi yang diuji adalah logika; sintaks SQL ke Postgres asli harus diverifikasi di lingkungan Anda.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const energy = require('../lib/energy');
const { createHandlers } = require('../bridge/handlers');
const { createSpool } = require('../bridge/spool');

const T0 = Date.UTC(2026, 10, 3, 5, 0, 0);          // 3 Nov 2026 12:00 WIB
const MIN = 60000;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function fakeDb() {
  const db = { state: { kwh: null, ts: null }, daily: {}, telemetry: [], events: [], down: false, failAfterCommit: 0 };
  const sql = (strings, ...v) => {
    const q = strings.join('?');
    return (async () => {
      if (db.down) throw new Error('fetch failed');
      if (q.includes('FROM energy_state WHERE id = 1'))
        return [{ kwh: db.state.kwh, ts: db.state.ts == null ? null : new Date(db.state.ts).toISOString() }];
      if (q.includes('FROM energy_daily WHERE day >='))
        return Object.entries(db.daily).map(([day, kwh]) => ({ day, kwh }));
      let rows = [];
      if (q.includes('WITH upd AS')) {
        const [kwh, ts, prev, , volt, amp, watt, , st, days] = v;
        const cur = db.state.ts == null ? null : new Date(db.state.ts).toISOString();
        if (cur === prev) {                                   // compare-and-swap
          db.state = { kwh, ts: Date.parse(ts) };
          db.telemetry.push({ ts: Date.parse(ts), volt, amp, watt, e: kwh, st });
          rows = JSON.parse(days).map((d) => {
            db.daily[d.day] = (db.daily[d.day] || 0) + d.kwh;
            return { day: d.day, kwh: db.daily[d.day] };
          });
        }
      } else if (q.includes('INSERT INTO telemetry')) {
        db.telemetry.push({ ts: Date.parse(v[0]), e: v[4] });
      } else if (q.includes('INSERT INTO event_log')) {
        db.events.push({ ts: Date.parse(v[0]), type: v[1], detail: v[2] });
      } else throw new Error('SQL tak dikenal: ' + q);
      if (db.failAfterCommit > 0) { db.failAfterCommit--; throw new Error('timeout setelah commit'); }
      return rows;
    })();
  };
  return { db, sql };
}

const tel = (e, p = 100) => JSON.stringify({ status: 'RUNNING', sensorOk: true, voltage: 220, current: 0.5, power: p, energy: e });
function setup(extra = {}) {
  const f = fakeDb();
  const published = [];
  let clock = T0;
  const h = createHandlers({
    sql: f.sql, persistMs: 0, publishEnergy: (p) => published.push(p), now: () => clock,
    log: () => {}, warn: () => {}, ...extra,
  });
  return { ...f, h, published, last: () => published[published.length - 1], setClock: (t) => { clock = t; } };
}
const tmpSpool = () => createSpool(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-')), 'spool.jsonl'));

test('dayKey / splitByDay memakai hari WIB dan membagi proporsional melewati tengah malam', () => {
  assert.equal(energy.dayKey(Date.UTC(2026, 10, 3, 16, 59, 59)), '2026-11-03');
  assert.equal(energy.dayKey(Date.UTC(2026, 10, 3, 17, 0, 0)), '2026-11-04');   // 00:00 WIB
  const mid = Date.UTC(2026, 10, 3, 17, 0, 0);
  const parts = energy.splitByDay(mid - 3 * 3600e3, mid + 1 * 3600e3, 0.4);      // 3 jam kemarin + 1 jam hari ini
  assert.deepEqual(parts.map((p) => p.day), ['2026-11-03', '2026-11-04']);
  near(parts[0].kwh, 0.3); near(parts[1].kwh, 0.1);
});

test('computeDelta: normal, noise float, reset, lonjakan tak masuk akal, jeda panjang sah', () => {
  const prev = { kwh: 1.0, ts: T0 };
  assert.equal(energy.computeDelta(null, { kwh: 1, ts: T0 }).kind, 'init');
  near(energy.computeDelta(prev, { kwh: 1.003, ts: T0 + 5000 }).kwh, 0.003);
  assert.equal(energy.computeDelta({ kwh: 0.32100000977, ts: T0 }, { kwh: 0.321, ts: T0 + 5000 }).kind, 'ok');  // float32 vs float64
  const rst = energy.computeDelta(prev, { kwh: 0.0, ts: T0 + 5000 });
  assert.deepEqual([rst.kind, rst.kwh], ['reset', 0]);
  assert.equal(energy.computeDelta({ kwh: 0, ts: T0 }, { kwh: 0.321, ts: T0 + 5000 }).kind, 'anomaly');          // 0 -> 0.321 dalam 5 dtk
  const gap = energy.computeDelta(prev, { kwh: 1.5, ts: T0 + 3 * 3600e3 });                                       // 0,5 kWh dalam 3 jam: sah
  assert.deepEqual([gap.kind, gap.kwh], ['ok', 0.5]);
});

test('normal: total harian & 30 hari dari DB, dipublikasikan real-time', async () => {
  const { db, h, last } = setup();
  await h.onTelemetry(tel(10.000), T0);                 // patokan awal
  await h.onTelemetry(tel(10.004), T0 + MIN);
  await h.onTelemetry(tel(10.010), T0 + 2 * MIN);
  near(db.daily['2026-11-03'], 0.010);
  near(last().todayKwh, 0.010); near(last().monthKwh, 0.010);
  assert.equal(last().source, 'db'); assert.equal(last().pending, 0);
  near(last().todayCost, 0.010 * last().tariffPerKwh);
  assert.equal(db.telemetry.length, 3);
});

test('jendela 30 hari: hari ke-31 tidak ikut, hari ini = 1 baris', async () => {
  const { db, h, last } = setup();
  db.daily['2026-11-03'] = 1; db.daily['2026-10-05'] = 2; db.daily['2026-10-04'] = 4;   // 10-05 = hari ke-30, 10-04 = ke-31
  await h.start();
  await h.onTelemetry(tel(5), T0);
  near(last().todayKwh, 1); near(last().monthKwh, 3);
});

test('DB putus: data diantre ke disk, angka tetap berjalan (estimasi), setelah pulih total persis sama & tidak ganda', async () => {
  const spool = tmpSpool();
  const { db, h, last, setClock } = setup({ spool });
  await h.onTelemetry(tel(10.000), T0);
  db.down = true;
  await h.onTelemetry(tel(10.020), T0 + 1 * MIN);
  await h.onTelemetry(tel(10.050), T0 + 2 * MIN);
  assert.equal(h._debug().queue.length, 2);
  assert.equal(spool.load().length, 2);                  // aman di disk
  setClock(T0 + 2 * MIN); h.publish(true);
  assert.equal(last().source, 'estimate'); assert.equal(last().dbOk, false); assert.equal(last().pending, 2);
  near(last().todayKwh, 0.050);                          // dashboard tetap melihat energi bertambah
  near(db.daily['2026-11-03'] || 0, 0);                  // DB memang belum menerima apa-apa
  db.down = false;
  await h.tick();
  near(db.daily['2026-11-03'], 0.050);
  near(last().todayKwh, 0.050); assert.equal(last().source, 'db'); assert.equal(last().pending, 0);
  assert.equal(db.telemetry.length, 3);                  // riwayat grafik pun lengkap, urut waktu
  assert.deepEqual(db.telemetry.map((t) => t.ts), [T0, T0 + MIN, T0 + 2 * MIN]);
  assert.equal(spool.load().length, 0);
});

test('bridge restart saat DB putus: antrean dibaca dari disk dan dikirim, tanpa duplikat', async () => {
  const spool = tmpSpool();
  const a = setup({ spool });
  await a.h.onTelemetry(tel(1.000), T0);
  a.db.down = true;
  await a.h.onTelemetry(tel(1.010), T0 + MIN);
  await a.h.onTelemetry(tel(1.030), T0 + 2 * MIN);
  // proses mati; bridge baru memakai DB yang sama dan spool yang sama
  a.db.down = false;
  const published = [];
  const h2 = createHandlers({ sql: a.sql, persistMs: 0, spool, publishEnergy: (p) => published.push(p), now: () => T0 + 3 * MIN, log: () => {}, warn: () => {} });
  await h2.start();
  near(a.db.daily['2026-11-03'], 0.030);
  assert.equal(a.db.telemetry.length, 3);
  near(published[published.length - 1].todayKwh, 0.030);
});

test('respons DB hilang setelah commit: pengiriman ulang tidak menghitung dua kali', async () => {
  const { db, h } = setup();
  await h.onTelemetry(tel(2.000), T0);
  db.failAfterCommit = 1;                                // commit sukses, tapi klien melihat error
  await h.onTelemetry(tel(2.040), T0 + 5 * MIN);
  assert.equal(h._debug().queue.length, 1);              // dianggap gagal, tetap di antrean
  await h.tick();                                        // kirim ulang -> CAS gagal -> sinkron -> duplikat dibuang
  near(db.daily['2026-11-03'], 0.040);
  assert.equal(h._debug().queue.length, 0);
  assert.equal(db.telemetry.length, 2);
});

test('jeda panjang (ESP32/bridge mati) melewati tengah malam: energi terpulihkan & dibagi per hari', async () => {
  const { db, h } = setup();
  const before = Date.UTC(2026, 10, 3, 15, 0, 0);        // 22:00 WIB
  await h.onTelemetry(tel(3.000), before);
  await h.onTelemetry(tel(3.100), before + 5 * 3600e3);  // 03:00 WIB besoknya: 0,1 kWh selama 5 jam (2 jam kemarin, 3 jam hari ini)
  near(db.daily['2026-11-03'], 0.04); near(db.daily['2026-11-04'], 0.06);
});

test('glitch register 0 (PZEM gagal baca) diabaikan: tidak ada energi fiktif saat register pulih', async () => {
  const { db, h } = setup();
  await h.onTelemetry(tel(0.321), T0);
  await h.onTelemetry(tel(0.0), T0 + 5000);              // pembacaan PZEM gagal -> energy 0
  await h.onTelemetry(tel(0.321), T0 + 10000);           // kembali normal
  near(db.daily['2026-11-03'] || 0, 0);
  assert.equal(db.events.length, 0);
});

test('data nyata Neon: register 0 berjam-jam lalu pulih 0,26 tidak dihitung sebagai konsumsi baru', async () => {
  const { db, h } = setup();
  await h.onTelemetry(tel(0.256), T0);
  await h.onTelemetry(tel(0), T0 + 2 * 3600e3);          // PZEM mati 2 jam (voltage 0, energy 0)
  await h.onTelemetry(tel(0.26), T0 + 3 * 3600e3);       // pulih: selisih sebenarnya hanya 0,004 kWh
  near(db.daily['2026-11-03'], 0.004);
});

test('register turun ke nilai kecil positif = reset PZEM sungguhan: dihitung lanjut dari nilai baru', async () => {
  const { db, h } = setup();
  await h.onTelemetry(tel(5.000), T0);
  await h.onTelemetry(tel(0.002), T0 + MIN);
  near(db.daily['2026-11-03'], 0.002);
  assert.equal(db.events.filter((e) => e.type === 'ENERGY').length, 1);
});

test('patokan DB berubah dari luar (konflik): sinkron ulang lalu tetap benar', async () => {
  const { db, h } = setup();
  await h.onTelemetry(tel(1.000), T0);
  db.state = { kwh: 1.5, ts: T0 + MIN };                 // seolah proses lain memajukan patokan
  await h.onTelemetry(tel(1.505), T0 + 5 * MIN);
  near(db.daily['2026-11-03'], 0.005);
  assert.equal(h._debug().queue.length, 0);
});

test('event (TRIP dll.) ikut diantre saat DB putus dan masuk berurutan setelah pulih', async () => {
  const { db, h } = setup();
  await h.onTelemetry(tel(1.0), T0);
  db.down = true;
  await h.onEvent(JSON.stringify({ type: 'TRIP', detail: 'Overpower' }));
  db.down = false;
  await h.tick();
  assert.deepEqual(db.events.map((e) => e.detail), ['Overpower']);
});

test('tengah malam: "hari ini" jadi 0 tanpa menunggu data baru', async () => {
  const { db, h, last, setClock } = setup();
  await h.onTelemetry(tel(1.000), T0);
  await h.onTelemetry(tel(1.020), T0 + 5 * MIN);
  near(last().todayKwh, 0.02);
  setClock(Date.UTC(2026, 10, 3, 17, 0, 5));             // 00:00:05 WIB
  await h.tick();
  near(last().todayKwh, 0); near(last().monthKwh, 0.02); assert.equal(last().day, '2026-11-04');
});

test('lonjakan mustahil (0,04 kWh dalam 5 detik) ditolak sebagai anomali', async () => {
  const { db, h } = setup();
  await h.onTelemetry(tel(2.000), T0);
  await h.onTelemetry(tel(2.040), T0 + 5000);
  near(db.daily['2026-11-03'], 0);
  assert.equal(db.events[0].type, 'ENERGY');
  await h.onTelemetry(tel(2.042), T0 + 65000);           // setelah itu penghitungan lanjut normal dari patokan baru
  near(db.daily['2026-11-03'], 0.002);
});
