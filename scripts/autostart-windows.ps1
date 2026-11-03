# Mendaftarkan auto-start Windows: broker + bridge + dashboard berjalan otomatis setiap Anda login.
#   Pasang :  powershell -ExecutionPolicy Bypass -File scripts\autostart-windows.ps1
#   Pasang + langsung jalankan:  ... -StartNow
#   Hapus  :  ... -Remove
# Jalankan sebagai Administrator jika ingin sekaligus membuka firewall (port 1883, 9001, 3000).
param([switch]$Remove, [switch]$StartNow)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TaskName = 'MES Power Monitor'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Auto-start dihapus." -ForegroundColor Yellow
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path (Join-Path $Root '.env.local'))) { throw ".env.local belum ada. Jalankan dulu: npm run setup" }

# Jalankan tersembunyi, di folder proyek, memakai node yang sama
$cmd = "Set-Location -LiteralPath '$Root'; & '$node' scripts\start-all.js"
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = 'PT30S'          # tunggu 30 detik agar WiFi sempat tersambung
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Auto-start terpasang: '$TaskName' (jalan otomatis 30 detik setelah login)." -ForegroundColor Green

# Firewall (butuh Administrator)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  foreach ($r in @(@('MQTT 1883',1883), @('MQTT WS 9001',9001), @('MES Web 3000',3000))) {
    if (-not (Get-NetFirewallRule -DisplayName $r[0] -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $r[0] -Direction Inbound -Action Allow -Protocol TCP -LocalPort $r[1] | Out-Null
      Write-Host "Firewall dibuka: port $($r[1])"
    }
  }
} else {
  Write-Host "Bukan Administrator: firewall tidak diubah (lihat README bila ESP32 tidak bisa tersambung)." -ForegroundColor Yellow
}

Write-Host @"

Catatan agar benar-benar berjalan terus:
 - Tutup terminal manual (mqtt:broker, bridge, vercel dev) sebelum memulai, supaya port tidak bentrok.
 - Matikan service Mosquitto bawaan Windows (Administrator):  sc config mosquitto start= disabled  lalu  net stop mosquitto
 - Cegah laptop tidur saat dicolok listrik: Settings > System > Power > Screen and sleep > Sleep = Never,
   dan Control Panel > Power Options > "Choose what closing the lid does" > Do nothing.
 - Log: $Root\logs\system.log
"@

if ($StartNow) { Start-ScheduledTask -TaskName $TaskName; Write-Host "Dimulai sekarang. Buka http://localhost:3000" -ForegroundColor Green }
