# Instalasi semua kebutuhan (Windows 10/11, PowerShell)
#   Node.js LTS, dependensi proyek, arduino-cli, core ESP32, library PZEM004Tv30 + ArduinoJson
# Jalankan:  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Info($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
function Run([string]$exe, [string[]]$a) {
  & $exe @a
  if ($LASTEXITCODE -ne 0) { throw "Perintah gagal: $exe $($a -join ' ')" }
}

# ---------- 1. Node.js >= 18 ----------
$needNode = $true
if (Get-Command node -ErrorAction SilentlyContinue) {
  $major = [int](node -p "process.versions.node.split('.')[0]")
  if ($major -ge 18) { $needNode = $false }
}
if ($needNode) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget tidak ditemukan. Pasang Node.js LTS manual dari https://nodejs.org lalu jalankan skrip ini lagi."
  }
  Info "Memasang Node.js LTS (winget)"
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  Refresh-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js terpasang tetapi belum terbaca. Tutup terminal, buka lagi, lalu jalankan skrip ini ulang."
  }
}
Info "Node $(node -v)"

# ---------- 2. Dependensi proyek ----------
Info "npm install (dependensi backend)"
Run 'npm.cmd' @('install','--no-audit','--no-fund')

# ---------- 3. arduino-cli ----------
$cliDir = Join-Path $env:USERPROFILE 'arduino-cli'
if (-not (Get-Command arduino-cli -ErrorAction SilentlyContinue)) {
  Info "Mengunduh arduino-cli ke $cliDir"
  New-Item -ItemType Directory -Force $cliDir | Out-Null
  $zip = Join-Path $env:TEMP 'arduino-cli.zip'
  Invoke-WebRequest 'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Windows_64bit.zip' -OutFile $zip
  Expand-Archive $zip -DestinationPath $cliDir -Force
  $userPath = [Environment]::GetEnvironmentVariable('Path','User')
  if ($userPath -notlike "*$cliDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$cliDir", 'User')
  }
  $env:Path += ";$cliDir"
}
Run 'arduino-cli' @('version')

# ---------- 4. Core ESP32 + library ----------
$espUrl = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json'
& arduino-cli config init 2>$null | Out-Null
$urls = (& arduino-cli config get board_manager.additional_urls 2>$null) -join ' '
if ($urls -notmatch 'espressif') { Run 'arduino-cli' @('config','add','board_manager.additional_urls',$espUrl) }

Info "Memasang core ESP32 (unduhan besar, tunggu beberapa menit)"
Run 'arduino-cli' @('core','update-index')
Run 'arduino-cli' @('core','install','esp32:esp32')

Info "Memasang library: PZEM004Tv30, PubSubClient, ArduinoJson 7.x"
Run 'arduino-cli' @('lib','install','PZEM004Tv30','PubSubClient','ArduinoJson@7.0.4')

Write-Host "`nCatatan: jika port ESP32 tidak muncul di Device Manager, pasang driver CH340 atau CP210x sesuai chip board Anda." -ForegroundColor Yellow

# ---------- 5. Konfigurasi ----------
Info "Konfigurasi proyek"
Run 'node' @('scripts/configure.js')

Write-Host @"

Selesai. Langkah berikutnya:
  npm run init-db       # buat tabel di PostgreSQL (butuh DATABASE_URL dari Neon)
  npm run mqtt:broker   # jalankan broker Mosquitto (terminal 1; Mosquitto harus terpasang)
  npm run bridge        # simpan data MQTT ke database (terminal 2)
  npm run flash         # compile + upload firmware ke ESP32 (colok USB dulu)
  npm run monitor       # lihat Serial Monitor
  npm run deploy        # (opsional) deploy dashboard ke Vercel
"@
