# Device E2E: install a built APK, pair through the loopback fixture, and capture the
# PinnedWs native diagnostics from logcat.
#
# Usage (PowerShell, from apps/mobile-companion):
#   .\e2e\device\run-device-pairing.ps1 -Apk C:\path\to\app.apk
#
# What it does, in order:
#   1. starts the fixture gateway on loopback (port 3443) and reads its pairing QR
#   2. ensures the emulator is booted and unlocked (PIN 1234)
#   3. installs the APK, clears app data, launches it, passes the biometric gate
#   4. types the 435-char pairing string in 40-char chunks and verifies it byte-exactly
#      through `uiautomator dump` (short/长 injections corrupt the token)
#   5. taps Pair, waits, then prints the fixture evidence and the `PinnedWs` logcat lines
#
# The pairing code lives 5 minutes: every step above must stay inside that window.

param(
  [Parameter(Mandatory = $true)][string]$Apk,
  [string]$Adb = 'C:\Android\sdk\platform-tools\adb.exe',
  [int]$Port = 3443,
  [int]$ControlPort = 3444,
  [string]$Pin = '1234'
)

$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path $Apk)) { throw "APK not found: $Apk" }
if (-not (Test-Path $Adb)) { throw "adb not found: $Adb" }

function FieldText {
  & $Adb shell uiautomator dump /sdcard/ui.xml 2>&1 | Out-Null
  & $Adb pull /sdcard/ui.xml "$env:TEMP\ui.xml" 2>&1 | Out-Null
  $xml = Get-Content "$env:TEMP\ui.xml" -Raw
  $m = [regex]::Match($xml, 'text="(eyJ[A-Za-z0-9_\-=]*)"')
  if ($m.Success) { return $m.Groups[1].Value } else { return '' }
}

Write-Host '— starting fixture —'
$fixtureOut = "$env:TEMP\fixture.out.log"
$fixtureErr = "$env:TEMP\fixture.err.log"
$fixture = Start-Process -FilePath 'node' `
  -ArgumentList 'e2e\harness\gateway.mjs', '--port', $Port, '--control-port', $ControlPort,
                '--bind', '127.0.0.1', '--lan-host', '127.0.0.1', '--print-json' `
  -WorkingDirectory $appDir -RedirectStandardOutput $fixtureOut -RedirectStandardError $fixtureErr `
  -NoNewWindow -PassThru
Start-Sleep -Seconds 4
$offer = (Get-Content $fixtureOut | Where-Object { $_ -match '^\{"mode"' } | Select-Object -First 1) | ConvertFrom-Json
$qr = $offer.pairing.qr
Write-Host "  endpoint=$($offer.endpoint) qrLength=$($qr.Length)"

Write-Host '— device —'
& $Adb wait-for-device | Out-Null
& $Adb reverse "tcp:$Port" "tcp:$Port" | Out-Null
& $Adb shell input keyevent KEYCODE_WAKEUP | Out-Null
& $Adb shell input swipe 540 1800 540 700 200 | Out-Null
& $Adb shell input text $Pin | Out-Null
& $Adb shell input keyevent KEYCODE_ENTER | Out-Null
& $Adb shell pm clear com.dshext.companion | Out-Null
& $Adb logcat -c
& $Adb shell monkey -p com.dshext.companion -c android.intent.category.LAUNCHER 1 2>&1 | Out-Null
Start-Sleep -Seconds 9
& $Adb shell input text $Pin | Out-Null
& $Adb shell input keyevent KEYCODE_ENTER | Out-Null
Start-Sleep -Seconds 5

Write-Host '— install —'
& $Adb install -r $Apk | Out-Null

Write-Host '— navigate to pairing —'
& $Adb shell monkey -p com.dshext.companion -c android.intent.category.LAUNCHER 1 2>&1 | Out-Null
Start-Sleep -Seconds 9
& $Adb shell input text $Pin | Out-Null
& $Adb shell input keyevent KEYCODE_ENTER | Out-Null
Start-Sleep -Seconds 5
& $Adb shell input tap 540 1393    # "Pair a computer"
Start-Sleep -Seconds 3
& $Adb shell input tap 540 912     # paste field

Write-Host '— typing the pairing string in 40-char chunks —'
for ($i = 0; $i -lt $qr.Length; $i += 40) {
  $chunk = $qr.Substring($i, [Math]::Min(40, $qr.Length - $i))
  & $Adb shell input text $chunk | Out-Null
  Start-Sleep -Milliseconds 350
}
$got = FieldText
Write-Host "  field exact=$($got -eq $qr) length=$($got.Length)/$($qr.Length)"
if ($got -ne $qr) { throw 'the injected pairing string does not match the QR; aborting before submitting' }

& $Adb shell input keyevent KEYCODE_BACK | Out-Null
Start-Sleep -Seconds 1
& $Adb shell input tap 540 1118    # "Pair"
Start-Sleep -Seconds 12

Write-Host '— fixture diagnostics —'
Get-Content $fixtureErr | Select-String 'fixture-conn' | ForEach-Object { $_.Line }

Write-Host '— fixture evidence —'
$state = (Invoke-WebRequest -Uri "http://127.0.0.1:$ControlPort/state" `
  -Headers @{ 'x-fixture-token' = $offer.controlToken } -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
$e = $state.evidence
Write-Host ("  tcp={0} tls={1} attempts={2} refusals={3} hellos={4} frames={5} open={6}" -f `
  $e.tcpConnections, $e.tlsHandshakesCompleted, $e.upgradeAttempts, $e.upgradeRefusals.Count, `
  $e.clientHellos.Count, $e.frames.Count, $e.openConnections)

Write-Host '— PinnedWs native diagnostics (logcat) —'
& $Adb logcat -d -s PinnedWs:D | ForEach-Object { $_ }

Write-Host '— screenshot —'
& $Adb shell screencap -p /sdcard/pairing-result.png | Out-Null
& $Adb pull /sdcard/pairing-result.png "$env:TEMP\pairing-result.png" | Out-Null
Write-Host "  $env:TEMP\pairing-result.png"

Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue
& $Adb reverse --remove-all | Out-Null
