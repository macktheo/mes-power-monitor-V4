# Checklist Pengujian & Kalibrasi

## A. Uji perangkat lunak (tanpa beban AC dulu)
- [ ] `curl` ke `/api/telemetry` berhasil, baris muncul di tabel `telemetry`
- [ ] ESP32 terhubung WiFi, badge dashboard `ESP32: CONNECTED`
- [ ] Cabut daya ESP32 → badge menjadi `DISCONNECTED` ≤ 15 detik, tombol kontrol nonaktif
- [ ] Restart ESP32 → grafik histori tetap ada (data di PostgreSQL)
- [ ] Tombol NYALAKAN / MATIKAN menggerakkan relay (tunda ±2 detik)
- [ ] Reboot ESP32 saat relay ON → relay tetap OFF setelah boot (tidak auto-start)
- [ ] Matikan WiFi router → proteksi lokal tetap bekerja (uji dengan beban uji di bawah)

## B. Uji proteksi (pakai beban terukur, hati-hati tegangan AC)
- [ ] Beban ≥ 250 W → toast peringatan muncul di kanan bawah
- [ ] Beban > 290 W → trip ke FAULT, relay OFF, event `TRIP` tercatat
- [ ] Arus ≥ 1.0 A → toast peringatan arus muncul di kanan bawah (baris "Arus saat ini")
- [ ] Arus > 1.5 A (mis. beban induktif/inrush) → trip Overcurrent
- [ ] Saat FAULT: tombol NYALAKAN nonaktif/ditolak; banner "Pulihkan dari FAULT" muncul
- [ ] Reset FAULT tanpa centang konfirmasi → tombol Pulihkan tidak aktif
- [ ] Setelah reset → status STOPPED (bukan RUNNING)
- [ ] Cabut kabel PZEM saat RUNNING → trip "Sensor PZEM tidak terbaca" setelah ±5 detik

## C. Uji variasi beban & kalibrasi
Gunakan alat pembanding (power meter / multimeter true-RMS) yang terkalibrasi.
Catat di `kalibrasi_template.csv`. Hitung galat: `(PZEM − Referensi) / Referensi × 100%`.
- [ ] Beban resistif: lampu pijar, heater
- [ ] Beban induktif: kipas, motor kecil
- [ ] Beban elektronik: charger, adaptor
- [ ] Minimal 5 titik beban berbeda per jenis; ulangi 3 kali tiap titik
- [ ] Jika galat konsisten, terapkan faktor koreksi (mis. di dashboard/backend), jangan di firmware proteksi tanpa uji ulang

## D. Enclosure & keselamatan
- [ ] Seluruh rangkaian AC di dalam casing isolatif, tidak ada logam/terminal terbuka
- [ ] Kabel masuk/keluar memakai cable gland / strain relief
- [ ] Jalur AC dan jalur sinyal (ESP32/PZEM) terpisah rapi, jarak aman
- [ ] Ada MCB/fuse di jalur masuk
- [ ] Ventilasi cukup; tidak ada komponen panas menempel casing plastik tipis
- [ ] Label peringatan "Tegangan Tinggi" terpasang

## E. Uji khusus MQTT
- [ ] `mosquitto_sub` menampilkan telemetry 1x/detik dari ESP32
- [ ] Klik NYALAKAN di dashboard → relay bunyi < 0,5 detik
- [ ] Cabut daya ESP32 → badge DISCONNECTED ≤ 5 detik; `mes/power/status` berisi `offline`
- [ ] Kirim RUN saat ESP32 mati, nyalakan ESP32 → relay TETAP OFF (perintah lama tidak dieksekusi)
- [ ] Matikan broker → badge `BROKER: DISCONNECTED`; proteksi trip lokal ESP32 tetap bekerja
- [ ] Tutup semua tab dashboard → data tetap masuk ke database (cek tabel `telemetry` bertambah tiap ±5 detik)
- [ ] Login ke broker dengan user `dashboard` lalu publish ke `mes/power/telemetry` → ditolak ACL
- [ ] Koneksi tanpa user/password → ditolak
