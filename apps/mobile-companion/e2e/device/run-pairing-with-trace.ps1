# Pair against the loopback fixture and print the JS trace of the attempt.
#
# This is the diagnostic companion of `run-device-pairing.ps1`: same flow, but it ends by pulling
# the app's opt-in JS trace (`pull-debug-log.ps1`) so a failure inside JS — where a native log can
# only say "the frame was handed to the listener" — can be read directly.
#
# Requires a build made with `EXPO_PUBLIC_DSH_DEBUG_LOG=1`; use the `diagnostic` profile:
#   npx eas-cli build --platform android --profile diagnostic
# A normal (preview/production) build writes no trace and the pull step will report "no trace".
#
# Usage (PowerShell, from apps/mobile-companion):
#   .\e2e\device\run-pairing-with-trace.ps1 -Apk C:\path\to\app.apk

param(
  [Parameter(Mandatory = $true)][string]$Apk,
  [string]$Adb = 'C:\Android\sdk\platform-tools\adb.exe',
  [int]$Port = 3443,
  [int]$ControlPort = 3444,
  [string]$Pin = '1234',
  [int]$TraceTail = 200
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

Write-Host '— fixture —'
$fixtureOut = "$env:TEMP\trace-fixture.out.log"
$fixtureErr = "$env:TEMP\trace-fixture.err.log"
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

Write-Host '— install + clean slate (clearing data also removes the previous trace) —'
& $Adb shell pm clear com.dshext.companion | Out-Null
& $Adb install -r $Apk | Out-Null
& $Adb shell setprop log.tag.PinnedWs DEBUG | Out-Null
& $Adb logcat -c

Write-Host '— launch + unlock —'
& $Adb shell monkey -p com.dshext.companion -c android.intent.category.LAUNCHER 1 2>&1 | Out-Null
Start-Sleep -Seconds 10
& $Adb shell input text $Pin | Out-Null
& $Adb shell input keyevent KEYCODE_ENTER | Out-Null
Start-Sleep -Seconds 5

Write-Host '— pairing screen —'
& $Adb shell input tap 540 1393 | Out-Null   # "Pair a computer"
Start-Sleep -Seconds 3
& $Adb shell input tap 540 912 | Out-Null    # paste field

for ($i = 0; $i -lt $qr.Length; $i += 40) {
  $chunk = $qr.Substring($i, [Math]::Min(40, $qr.Length - $i))
  & $Adb shell input text $chunk | Out-Null
  Start-Sleep -Milliseconds 320
}
$got = FieldText
Write-Host "  field exact=$($got -eq $qr) length=$($got.Length)/$($qr.Length)"
if ($got -ne $qr) { throw 'the injected pairing string does not match the QR; aborting before submitting' }

& $Adb shell input keyevent KEYCODE_BACK | Out-Null
Start-Sleep -Seconds 1
& $Adb shell input tap 540 1118 | Out-Null   # "Pair"
Start-Sleep -Seconds 16

Write-Host '— fixture diagnostics —'
Get-Content $fixtureErr | Select-String 'fixture-conn' | ForEach-Object { $_.Line }

Write-Host '— fixture evidence —'
$state = (Invoke-WebRequest -Uri "http://127.0.0.1:$ControlPort/state" `
  -Headers @{ 'x-fixture-token' = $offer.controlToken } -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
$e = $state.evidence
Write-Host ("  tcp={0} tls={1} attempts={2} refusals={3} hellos={4} frames={5} open={6}" -f `
  $e.tcpConnections, $e.tlsHandshakesCompleted, $e.upgradeAttempts, $e.upgradeRefusals.Count, `
  $e.clientHellos.Count, $e.frames.Count, $e.openConnections)

Write-Host '— native PinnedWs —'
& $Adb logcat -d -s PinnedWs:D 2>&1 | Select-Object -Last 30

Write-Host '— JS trace —'
& (Join-Path $PSScriptRoot 'pull-debug-log.ps1') -Adb $Adb -Tail $TraceTail

Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue
& $Adb reverse --remove-all | Out-Null
