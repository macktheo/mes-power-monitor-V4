// Perhitungan energi (kWh) di backend.
// Sumber: register energi PZEM (kumulatif) yang dikirim ESP32. Energi = selisih register antar sampel, jadi
// konsumsi selama koneksi putus tetap terhitung begitu sampel berikutnya masuk (register tetap bertambah di PZEM).
// Hasil disimpan per hari di tabel energy_daily (zona Asia/Jakarta, UTC+7 tanpa DST).
require('./env');
const cfg = require('./config');

const WIB_MS = 7 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const WINDOW_DAYS = 30;            // "30 hari terakhir" = hari ini + 29 hari sebelumnya (hari kalender WIB)
const NOISE_KWH = 0.0005;          // resolusi PZEM 0,001 kWh: penurunan < setengahnya hanyalah pembulatan float
const maxW = () => Number(process.env.ENERGY_MAX_W || 2000);

const dayStart = (ms) => Math.floor((ms + WIB_MS) / DAY_MS) * DAY_MS - WIB_MS;
const dayKey = (ms) => new Date(ms + WIB_MS).toISOString().slice(0, 10);

// Pecah energi selisih (fromMs..toMs) per hari, proporsional terhadap waktu. Untuk jeda yang melewati tengah malam.
function splitByDay(fromMs, toMs, kwh) {
  if (!(toMs > fromMs) || !(kwh > 0)) return [{ day: dayKey(toMs), kwh: 0 }];
  const out = [];
  let t = fromMs;
  while (t < toMs) {
    const end = Math.min(dayStart(t) + DAY_MS, toMs);
    out.push({ day: dayKey(t), kwh: (kwh * (end - t)) / (toMs - fromMs) });
    t = end;
  }
  return out;
}

// prev/cur: {kwh, ts(ms)}. Mengembalikan energi yang dipakai di antara keduanya dan jenis kejadiannya.
function computeDelta(prev, cur) {
  if (!prev || prev.kwh == null || prev.ts == null) return { kwh: 0, kind: 'init' };
  const hours = (cur.ts - prev.ts) / 3.6e6;
  if (!(hours > 0)) return { kwh: 0, kind: 'duplicate' };
  const plausible = (maxW() / 1000) * hours + 0.002;   // batas fisik: daya maksimum x lama selang (+2 Wh toleransi)
  const diff = cur.kwh - prev.kwh;
  if (diff >= -NOISE_KWH) return diff <= plausible ? { kwh: Math.max(diff, 0), kind: 'ok' } : { kwh: 0, kind: 'anomaly' };
  // Register turun: PZEM direset atau pembacaan sesaat salah. Nilai baru = energi sejak reset.
  return { kwh: cur.kwh <= plausible ? cur.kwh : 0, kind: 'reset' };
}

function plan(prev, s) {
  const has = prev && prev.ts != null && prev.kwh != null;
  const d = computeDelta(has ? prev : null, { kwh: s.e, ts: s.ts });
  if (d.kind === 'duplicate') return { kind: 'duplicate', kwh: 0, days: [] };
  return { kind: d.kind, kwh: d.kwh, days: splitByDay(has ? prev.ts : s.ts, s.ts, d.kwh) };
}

// daily: {'YYYY-MM-DD': kWh}
function summarize(daily, nowMs) {
  const today = dayKey(nowMs);
  const from = dayKey(nowMs - (WINDOW_DAYS - 1) * DAY_MS);
  let month = 0;
  for (const [d, k] of Object.entries(daily)) if (d >= from && d <= today) month += k;
  const todayKwh = daily[today] || 0;
  const tariff = cfg.TARIFF_PER_KWH;
  return { day: today, todayKwh, monthKwh: month, tariffPerKwh: tariff, todayCost: todayKwh * tariff, monthCost: month * tariff };
}

async function loadState(sql) {
  const rows = await sql`
    SELECT last_kwh::float8 AS kwh,
           to_char(last_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts
    FROM energy_state WHERE id = 1`;
  if (!rows.length) throw new Error('baris energy_state tidak ada (jalankan: npm run init-db)');
  const r = rows[0];
  return { kwh: r.kwh == null ? null : Number(r.kwh), ts: r.ts ? Date.parse(r.ts) : null };
}

async function loadDaily(sql, nowMs) {
  const from = dayKey(nowMs - (WINDOW_DAYS - 1) * DAY_MS);
  const rows = await sql`SELECT day::text AS day, kwh::float8 AS kwh FROM energy_daily WHERE day >= ${from}::date`;
  return Object.fromEntries(rows.map((r) => [r.day, Number(r.kwh)]));
}

// Satu sampel telemetry -> (1) baris telemetry, (2) tambah energi harian, (3) majukan patokan register.
// Semuanya DALAM SATU pernyataan SQL (atomik) dan hanya berlaku jika patokan di DB masih sama dengan yang kita kira
// (compare-and-swap). Jadi pengiriman ulang sampel yang sama tidak akan menghitung energi dua kali.
async function applySample(sql, state, s) {
  const p = plan(state, s);
  if (p.kind === 'duplicate') return { status: 'duplicate' };
  const prevIso = state && state.ts != null ? new Date(state.ts).toISOString() : null;
  const tsIso = new Date(s.ts).toISOString();
  const rows = await sql`
    WITH upd AS (
      UPDATE energy_state
         SET last_kwh = ${s.e}::float8, last_ts = ${tsIso}::timestamptz
       WHERE id = 1 AND date_trunc('milliseconds', last_ts) IS NOT DISTINCT FROM ${prevIso}::timestamptz
      RETURNING 1 AS ok
    ), tel AS (
      INSERT INTO telemetry (ts, voltage_v, current_a, power_w, energy_kwh, status)
      SELECT ${tsIso}::timestamptz, ${s.volt}::float8, ${s.amp}::float8, ${s.watt}::float8, ${s.e}::float8, ${s.st}::text
      FROM upd
      RETURNING 1 AS ok
    )
    INSERT INTO energy_daily AS ed (day, kwh)
    SELECT x.day, x.kwh
    FROM jsonb_to_recordset(${JSON.stringify(p.days)}::jsonb) AS x(day date, kwh float8), upd
    WHERE true
    ON CONFLICT (day) DO UPDATE SET kwh = ed.kwh + EXCLUDED.kwh, updated_at = now()
    RETURNING ed.day::text AS day, ed.kwh::float8 AS kwh`;
  if (!rows.length) return { status: 'conflict' };
  return {
    status: 'applied', kind: p.kind, delta: p.kwh,
    prevKwh: state && state.kwh, prevTs: state && state.ts,
    state: { kwh: s.e, ts: s.ts },
    days: rows.map((r) => ({ day: r.day, kwh: Number(r.kwh) })),   // total harian SESUDAH update
  };
}

module.exports = { dayKey, dayStart, splitByDay, computeDelta, plan, summarize, loadState, loadDaily, applySample, DAY_MS, WINDOW_DAYS };
