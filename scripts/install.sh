#!/usr/bin/env bash
# Instalasi semua kebutuhan (Linux / macOS / WSL):
#   Node.js >= 18, dependensi proyek, arduino-cli, core ESP32, library PZEM004Tv30 + ArduinoJson
# Jalankan dari mana saja:  bash scripts/install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*"; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl belum terpasang. Linux: sudo apt install curl  |  macOS: sudah bawaan."

OS="$(uname -s)"

# ---------- 1. Node.js >= 18 ----------
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  info "Memasang Node.js LTS lewat nvm"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  set +u; . "$NVM_DIR/nvm.sh"; nvm install --lts; set -u
fi
info "Node $(node -v) / npm $(npm -v)"

# ---------- 2. Dependensi proyek ----------
info "npm install (dependensi backend)"
npm install --no-audit --no-fund

# ---------- 3. arduino-cli ----------
if ! command -v arduino-cli >/dev/null 2>&1; then
  info "Memasang arduino-cli ke \$HOME/.local/bin"
  mkdir -p "$HOME/.local/bin"
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR="$HOME/.local/bin" sh
  export PATH="$HOME/.local/bin:$PATH"
  case "${SHELL:-}" in *zsh) RC="$HOME/.zshrc" ;; *) RC="$HOME/.bashrc" ;; esac
  if ! grep -qs '.local/bin' "$RC"; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$RC"
    warn "PATH ditambahkan ke $RC (buka terminal baru agar berlaku)."
  fi
fi
info "$(arduino-cli version)"

# ---------- 4. Core ESP32 + library ----------
ESP_URL="https://espressif.github.io/arduino-esp32/package_esp32_index.json"
arduino-cli config init >/dev/null 2>&1 || true
if ! arduino-cli config get board_manager.additional_urls 2>/dev/null | grep -q espressif; then
  arduino-cli config add board_manager.additional_urls "$ESP_URL"
fi
info "Memasang core ESP32 (unduhan besar, tunggu beberapa menit)"
arduino-cli core update-index
arduino-cli core install esp32:esp32

info "Memasang library: PZEM004Tv30, PubSubClient, ArduinoJson 7.x"
arduino-cli lib install "PZEM004Tv30" "PubSubClient" "ArduinoJson@7.0.4"

# ---------- 5. Izin port serial (Linux) ----------
if [ "$OS" = "Linux" ] && getent group dialout >/dev/null 2>&1 && ! id -nG | grep -qw dialout; then
  info "Menambahkan $USER ke grup dialout (agar bisa upload ke ESP32)"
  sudo usermod -aG dialout "$USER" || warn "Gagal. Jalankan manual: sudo usermod -aG dialout $USER"
  warn "Logout lalu login ulang agar izin serial berlaku."
fi
[ "$OS" = "Darwin" ] && warn "macOS: jika port ESP32 tidak muncul, pasang driver CH340 atau CP210x sesuai chip board Anda."

# ---------- 6. Konfigurasi (kunci acak, .env.local, secrets.h) ----------
info "Konfigurasi proyek"
node scripts/configure.js

cat <<'MSG'

Selesai. Langkah berikutnya:
  npm run init-db       # buat tabel di PostgreSQL (butuh DATABASE_URL dari Neon)
  npm run mqtt:broker   # jalankan broker Mosquitto (terminal 1; Mosquitto harus terpasang)
  npm run bridge        # simpan data MQTT ke database (terminal 2)
  npm run flash         # compile + upload firmware ke ESP32 (colok USB dulu)
  npm run monitor       # lihat Serial Monitor
  npm run deploy        # (opsional) deploy dashboard ke Vercel
MSG
