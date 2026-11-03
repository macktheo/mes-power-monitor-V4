# MES Power Monitor - versi MQTT (ESP32 + PZEM-004T)

```
                      MQTT (TCP persisten, latensi perintah < 100 ms)
 PZEM → ESP32  ◀══════════════════════════▶  Broker MQTT (Mosquitto)  ◀═══ WebSocket ═══▶  Dashboard (browser)
                                                    │
                                                    ▼ (subscribe)
                                             Bridge (Node.js) ──▶ PostgreSQL (Neon) ◀── API (Vercel) ◀── Dashboard
                                             simpan tiap 5 dtk                      riwayat grafik, kWh, log
```

**Pembagian tugas**
* **ESP32**: baca sensor, **proteksi lokal** (trip > 290 W / > 1.2 A / sensor mati, tetap jalan tanpa internet), kontrol relay, publish telemetry 1x/detik, menerima perintah instan.
* **Broker Mosquitto**: perantara pesan, dengan login per user dan **ACL** (ESP32 hanya boleh kirim data & baca perintah; dashboard hanya baca data & kirim perintah).
* **Bridge** (`bridge/`): berlangganan MQTT lalu menyimpan ke PostgreSQL. Data tetap tersimpan walau dashboard tidak dibuka.
* **API Vercel** (`api/`): login, riwayat grafik, kWh + biaya, log kejadian, dan kredensial broker untuk dashboard (hanya setelah login).
* **Dashboard** (`public/index.html`): nilai real-time dan tombol kontrol lewat MQTT; grafik, kWh, dan log dari database.

## Topik MQTT

| Topik | Arah | Isi |
|---|---|---|
| `mes/power/telemetry` | ESP32 → broker | `{"status","sensorOk","voltage","current","power","energy"}` tiap 1 detik |
| `mes/power/status` | ESP32 → broker | `online` / `offline` (retained; `offline` = Last Will saat koneksi putus) |
| `mes/power/event` | ESP32 → broker | `{"type":"TRIP"\|"DEVICE","detail"}` |
| `mes/power/command` | dashboard → ESP32 | `{"cmd":"RUN"\|"STOP"\|"RESET"}` (**tidak retained**) |
| `mes/power/energy` | bridge → dashboard | ringkasan kWh hari ini & 30 hari + biaya, **retained**, tiap ~5 dtk (hanya bridge yang boleh menulis) |

## Mulai cepat (lokal, Windows/Linux/macOS)

Prasyarat: **Mosquitto** terpasang (https://mosquitto.org/download/ | `sudo apt install mosquitto` | `brew install mosquitto`).

```bash
npm install                 # pasang dependensi baru (mqtt)
npm run setup               # jawab pertanyaan: DB, password dashboard, IP laptop, WiFi, dst.
npm run init-db             # buat tabel (jika belum; aman diulang)
npm run mqtt:broker         # TERMINAL 1: buat user + jalankan broker (port 1883 & 9001)
npm run bridge              # TERMINAL 2: simpan data MQTT ke database
npm run flash               # TERMINAL 3: compile + upload ke ESP32
npx vercel dev --listen 0.0.0.0:3000    # TERMINAL 4: dashboard + API  (buka http://localhost:3000)
```

Library Arduino baru: **PubSubClient** (Nick O'Leary). Jalankan ulang `scripts/install.*`, atau:
`arduino-cli lib install PubSubClient`.

**Windows: matikan service Mosquitto bawaan** (jika terpasang), karena memakai port 1883 yang sama (PowerShell Administrator):
```powershell
net stop mosquitto
```
Cek IP laptop dengan `ipconfig` (IPv4 WiFi). Jika bukan `192.168.0.106`, jalankan `npm run setup` dan isi IP yang benar.

**Firewall Windows** (PowerShell sebagai Administrator), agar ESP32 & HP bisa menjangkau broker:
```powershell
netsh advfirewall firewall add rule name="MQTT 1883" dir=in action=allow protocol=TCP localport=1883
netsh advfirewall firewall add rule name="MQTT WS 9001" dir=in action=allow protocol=TCP localport=9001
```

## Jalan otomatis (tanpa membuka terminal)

Satu perintah menjalankan broker + bridge + dashboard sekaligus (dan menghidupkan ulang yang mati):

```bash
npm start            # dashboard: http://localhost:3000 ; log: logs/system.log
```

**Windows: otomatis setiap login** (PowerShell, "Run as administrator" bila ingin sekaligus membuka firewall):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\autostart-windows.ps1 -StartNow
# hapus: ... -Remove
```
Syarat: laptop tetap menyala dan tidak tidur (atur Power Options), service Mosquitto bawaan Windows dimatikan,
dan IP laptop tetap (buat DHCP reservation di router), karena ESP32 mengarah ke IP itu.

**Linux / Raspberry Pi (disarankan untuk 24 jam):** lihat `deploy/mes-monitor.service`.

Catatan: mode ini memakai `scripts/local-server.js` (bukan `vercel dev`), jadi tidak perlu login Vercel.
Saat internet/Neon putus, bridge mengantre data ke `data/spool.jsonl` dan mengirimnya berurutan setelah tersambung (lihat "Energi" di bawah); dashboard real-time tetap jalan.

## Tes tanpa ESP32

```bash
# lihat semua pesan (ganti PASS dengan MQTT_BRIDGE_PASS di .env.local)
mosquitto_sub -h localhost -u bridge -P PASS -t "mes/power/#" -v

# simulasi ESP32 (ganti PASS dengan MQTT_ESP_PASS)
mosquitto_pub -h localhost -u esp32 -P PASS -t mes/power/status -r -m online
mosquitto_pub -h localhost -u esp32 -P PASS -t mes/power/telemetry \
  -m '{"status":"STOPPED","sensorOk":true,"voltage":220.1,"current":0.0,"power":0.0,"energy":1.2}'
```
Dashboard harus menampilkan `ESP32: CONNECTED` dalam hitungan detik. Perintah dari dashboard tampil di `mosquitto_sub`.

## Energi (kWh hari ini & 30 hari terakhir)

* **Sumber**: register energi PZEM (kumulatif) yang dikirim ESP32. Energi = selisih register antar sampel yang disimpan.
* **Dihitung backend**: bridge menambahkan selisih ke tabel `energy_daily` (per hari, WIB) dalam satu pernyataan SQL atomik bersama baris `telemetry`, lalu mem-publish ringkasannya (retained) ke `mes/power/energy`. Dashboard hanya menampilkan; `/api/energy` membaca tabel yang sama (muat awal & cadangan bila MQTT mati).
* **"30 hari terakhir"** = hari ini + 29 hari sebelumnya (hari kalender WIB).
* **Tahan putus**: konsumsi saat ESP32/bridge mati terpulihkan dari selisih register berikutnya (dibagi per hari bila melewati tengah malam). Saat Neon/internet putus, data diantre di disk (`data/spool.jsonl`) dan dikirim ulang berurutan tanpa hitungan ganda (compare-and-swap pada `energy_state`). Dashboard menyimpan nilai terakhir di browser.
* **Pengaman**: lonjakan register yang mustahil secara fisik (> `ENERGY_MAX_W` x lama selang) dan penurunan register (reset PZEM / glitch) tidak dihitung dan dicatat di Log Kejadian (tipe `ENERGY`).
* **Resolusi**: PZEM hanya menaikkan register per 0,001 kWh (1 Wh). Pada beban kecil angka bergerak per beberapa puluh detik; itu batas sensor, bukan keterlambatan.
* **Tabel dibuat otomatis**: bridge dan `/api/energy` menjalankan `lib/schema.js` (idempoten) sehingga error `relation "energy_daily" does not exist` tidak muncul lagi; energi dari telemetry lama diisi sekali (backfill) saat tabel pertama kali dibuat.
* **Register 0 diabaikan**: saat PZEM gagal dibaca ESP32 mengirim `voltage 0 / energy 0`. Sampel itu tidak dihitung dan tidak dijadikan patokan, jadi pulihnya register (mis. 0 -> 0,26 kWh) tidak terhitung sebagai konsumsi baru.
* Cek tanpa dashboard: `npm run check` (menampilkan energi per hari, hari ini, dan 30 hari dari Neon). `npm test` menjalankan tes logika.
* Setelah memperbarui kode: cukup `npm install` lalu `npm start` (atau `npm run init-db` untuk membuat tabel manual).

## Keamanan perintah

* Broker `allow_anonymous false` + ACL per user. Kredensial dashboard hanya diberikan lewat `/api/mqtt-config` setelah login.
* Perintah **tidak retained** dan ESP32 memakai sesi bersih: perintah yang dikirim saat ESP32 offline **dibuang**, tidak dieksekusi nanti saat ia menyala lagi. Dashboard juga menonaktifkan tombol saat ESP32 DISCONNECTED.
* Setelah reboot, relay selalu OFF (tidak auto-start).
* **FAULT latch di ESP32**: `RUN` ditolak saat FAULT; `RESET` hanya berlaku saat FAULT dan hasilnya STOPPED (bukan RUNNING); `RUN` yang menyusul < 1,5 detik setelah `RESET` diabaikan.
* Keterbatasan: konfirmasi reset FAULT berupa dialog di dashboard. Siapa pun yang sudah login (punya kredensial MQTT dashboard) secara teknis dapat mengirim `RESET`. Proteksi sebenarnya: login dashboard + ESP32 tetap memutus beban jika masih overload.

## Deploy ke Vercel (opsional)

Dashboard di Vercel (HTTPS) hanya bisa memakai broker lewat **`wss://`** yang dapat dijangkau internet. `ws://192.168.x.x` diblokir browser (mixed content) dan tidak terjangkau dari luar.

1. Pakai broker cloud (HiveMQ Cloud / EMQX Cloud, ada free tier) atau Mosquitto di VPS dengan TLS. Buat 3 user (esp32, dashboard, bridge) dan atur ACL seperti `mosquitto/acl`.
2. `npm run setup`: isi `MQTT_WS_URL` (`wss://...`), port ESP32 `8883`, TLS `1`, `MQTT_URL` (mis. `mqtts://host:8883`).
3. `npm run deploy` (mengunggah variabel DB, login, dan MQTT dashboard ke Vercel).
4. **Bridge harus berjalan terus** di mesin yang selalu hidup (Raspberry Pi, VPS, Render, dll.). Jalankan hanya **satu** instance agar data tidak ganda.
5. Untuk produksi, set `USE_INSECURE_TLS 0` dan isi `ROOT_CA` di `secrets.h`.

## Struktur

```
firmware/esp32_mes_monitor/   kode ESP32 (MQTT) + secrets.h.example
bridge/                       bridge MQTT -> PostgreSQL (bridge.js, handlers.js)
mosquitto/acl                 hak akses per user MQTT
api/                          login, logout, mqtt-config, history, energy, events (Vercel Functions)
lib/                          env loader, db, auth, config
db/schema.sql                 skema PostgreSQL (tabel device_state tidak dipakai lagi, boleh dibiarkan)
public/index.html             dashboard
scripts/                      install, configure, init-db, mqtt-users (+broker), deploy, flash
docs/                         checklist pengujian & template kalibrasi
```

Perubahan dari versi HTTP: endpoint `telemetry`, `command`, `latest`, `relay`, `fault/reset` dihapus (digantikan MQTT); DEVICE_KEY tidak dipakai lagi.

## Catatan

* Tarif listrik default Rp 1.444,70/kWh hanya nilai awal; cek tarif PLN golongan Anda.
* Pengerjaan sisi AC 220 V berbahaya: pakai enclosure isolatif, strain relief, dan MCB/fuse. Proteksi software tidak menggantikan proteksi hardware.
* Kode sudah diuji logikanya dengan stub (backend, bridge, tampilan dashboard), tetapi **belum diuji dengan broker Mosquitto dan ESP32 sungguhan**. Ikuti `docs/checklist_pengujian.md`.
