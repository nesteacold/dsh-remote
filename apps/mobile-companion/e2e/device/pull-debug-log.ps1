# Pull the opt-in JS trace off the device and print its tail.
#
# The trace is the file sink of the app's redacting `DebugLog` (src/platform/debug-log-file.ts,
# file name `dsh-companion-debug.log`). It exists ONLY in a build made with
# `EXPO_PUBLIC_DSH_DEBUG_LOG=1` — that is the `diagnostic` eas.json profile:
#     npx eas-cli build --platform android --profile diagnostic
# A preview/production build writes no trace at all, and this script then reports "no trace"
# instead of inventing one.
#
# File location (Android, the app's filesDir):
#     /data/user/0/com.dshext.companion/files/dsh-companion-debug.log
# iOS (the app sandbox's Documents directory):
#     <app container>/Documents/dsh-companion-debug.log
#
# `adb shell run-as <pkg>` works only on a debuggable build, so a release APK needs the file read
# as the app's own uid: this script tries `adb root` + `adb pull` first and falls back to `run-as`.
# Note that `adb root` restarts adbd, so any `adb reverse` set up for a pairing run is gone after.
#
# Usage (PowerShell, from apps/mobile-companion):
#   .\e2e\device\pull-debug-log.ps1
#   .\e2e\device\pull-debug-log.ps1 -Tail 300
#   .\e2e\device\pull-debug-log.ps1 -Out .\debug.log

param(
  [string]$Adb = 'C:\Android\sdk\platform-tools\adb.exe',
  [string]$Package = 'com.dshext.companion',
  [string]$RemotePath = '/data/user/0/com.dshext.companion/files/dsh-companion-debug.log',
  [string]$Out = "$env:TEMP\dsh-companion-debug.log",
  [int]$Tail = 120
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Adb)) { throw "adb not found: $Adb" }

& $Adb wait-for-device | Out-Null

Write-Host '— root —'
& $Adb root 2>&1 | ForEach-Object { Write-Host "  $_" }
Start-Sleep -Seconds 2
& $Adb wait-for-device | Out-Null

if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }

Write-Host "— pull $RemotePath —"
& $Adb pull $RemotePath $Out 2>&1 | ForEach-Object { Write-Host "  $_" }
$pulled = Test-Path -LiteralPath $Out

if (-not $pulled) {
  # A debuggable build: read the same file through the app's own uid, no root needed.
  Write-Host '— pull failed; trying run-as (debuggable build only) —'
  $relative = $RemotePath -replace "^/data/(user/0|data)/$([regex]::Escape($Package))/", ''
  & $Adb shell "run-as $Package cat $relative" 2>&1 | Set-Content -LiteralPath $Out -Encoding utf8
  if ((Test-Path -LiteralPath $Out) -and (Get-Item -LiteralPath $Out).Length -gt 0) {
    $pulled = $true
  } else {
    Remove-Item -LiteralPath $Out -Force -ErrorAction SilentlyContinue
  }
}

if (-not $pulled) {
  Write-Host 'no trace found. Either this build was not made with EXPO_PUBLIC_DSH_DEBUG_LOG=1, the'
  Write-Host 'app has not logged anything yet, or the device allows neither `adb root` nor `run-as`'
  Write-Host '(a release APK on a production image): use a userdebug emulator image or a dev build.'
  exit 1
}

Write-Host "— $Out (last $Tail lines) —"
Get-Content -LiteralPath $Out -Tail $Tail
