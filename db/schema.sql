-- Jalankan sekali di SQL Editor Neon / Supabase (PostgreSQL)

CREATE TABLE IF NOT EXISTS telemetry (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  voltage_v  REAL NOT NULL,
  current_a  REAL NOT NULL,
  power_w    REAL NOT NULL,
  energy_kwh REAL,
  status     TEXT NOT NULL CHECK (status IN ('STOPPED','RUNNING','FAULT'))
);
CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry (ts DESC);

-- Tepat satu baris (id = 1): status perangkat + perintah untuk ESP32
CREATE TABLE IF NOT EXISTS device_state (
  id                 INT PRIMARY KEY CHECK (id = 1),
  last_seen          TIMESTAMPTZ,
  device_status      TEXT NOT NULL DEFAULT 'UNKNOWN',
  desired_relay      TEXT NOT NULL DEFAULT 'OFF' CHECK (desired_relay IN ('ON','OFF')),
  cmd_seq            INT  NOT NULL DEFAULT 0,
  reset_requested_at TIMESTAMPTZ
);
INSERT INTO device_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS event_log (
  id     BIGSERIAL PRIMARY KEY,
  ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  type   TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log (ts DESC);

-- (Opsional) hapus data telemetry lebih dari 90 hari agar free tier tidak penuh:
-- DELETE FROM telemetry WHERE ts < now() - interval '90 days';

-- ===== Energi (kWh) : dihitung backend, disimpan per hari (zona Asia/Jakarta) =====
-- Total harian; "hari ini" = 1 baris, "30 hari terakhir" = jumlah 30 baris. Ringan walau telemetry sudah jutaan baris.
CREATE TABLE IF NOT EXISTS energy_daily (
  day        DATE PRIMARY KEY,
  kwh        DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tepat satu baris (id = 1): nilai register PZEM terakhir yang sudah dihitung. Dipakai sebagai patokan selisih
-- berikutnya, jadi restart bridge / putus koneksi tidak membuat energi hilang atau terhitung dua kali.
CREATE TABLE IF NOT EXISTS energy_state (
  id       INT PRIMARY KEY CHECK (id = 1),
  last_kwh DOUBLE PRECISION,
  last_ts  TIMESTAMPTZ
);
INSERT INTO energy_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
