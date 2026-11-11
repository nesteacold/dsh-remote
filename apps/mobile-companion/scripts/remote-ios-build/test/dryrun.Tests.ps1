#Requires -Version 5.1
<#
.SYNOPSIS
    Contract test for the remote iOS build scripts: PowerShell parse + dry-run behaviour.

.DESCRIPTION
    No Pester dependency and no network: this file runs as-is on Windows PowerShell 5.1.

        powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\dryrun.Tests.ps1

    It asserts the P0 gates from specs/009-remote-ios-build/plan.md:
      - the driver and this file parse with zero errors under the 5.1 parser
      - -Help exits 0 and documents the exit-code table
      - -DryRun exits 0, prints the plan (worktree source line, dirty count, host key policy),
        makes no ssh call (a black-holed host would need ConnectTimeout=10, so a fast run
        proves it never dialled), and creates nothing
      - -AcceptHostKey is the only way to accept-new; the default stays StrictHostKeyChecking=yes
      - -SelfTest against a refusing host exits 2 in seconds and leaves no artifacts directory
      - bad -Profile / -QuotaGb exit 2 with a message
      - the example config is accepted
      - the shell scripts carry the mandated contract lines and no `set -x`
      - FR-016/017/018 static contract: no `bash -s` command, staged absolute script path,
        fd-3 payload guard, stage-before-upload, retrieval on exit 0 and 5, driver-owned power
      - no issuer-UUID-shaped string anywhere in the scripts or the runbook

    The package itself (worktree bytes, hard excludes, untracked files, -FromHead) is covered
    by the sibling test\package.Tests.ps1.

    -IncludeBash additionally runs `bash -n` on both shell scripts. It is opt-in because Git
    Bash cannot start in some sandboxes (MSYS signal-pipe creation is blocked); when it is not
    requested, or bash fails to run, the check is reported as SKIP, never as green.

    Exit: 0 all checks pass (skips allowed) | 1 at least one check failed.
#>
[CmdletBinding()]
param(
    [switch]$IncludeBash
)

$ErrorActionPreference = 'Continue'

$script:Passed = 0
$script:Failed = 0
$script:Skipped = 0

function Ok {
    param([string]$Message)
    $script:Passed = $script:Passed + 1
    Write-Host ('PASS  ' + $Message)
}

function No {
    param([string]$Message, [string]$Detail)
    $script:Failed = $script:Failed + 1
    Write-Host ('FAIL  ' + $Message)
    if (-not [string]::IsNullOrEmpty($Detail)) {
        Write-Host ('      ' + $Detail)
    }
}

function Skip {
    param([string]$Message, [string]$Reason)
    $script:Skipped = $script:Skipped + 1
    Write-Host ('SKIP  ' + $Message + ' (' + $Reason + ')')
}

function Assert-True {
    param([bool]$Condition, [string]$Message, [string]$Detail)
    if ($Condition) { Ok $Message } else { No $Message $Detail }
}

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ScriptRoot = Split-Path -Parent $Here
$AppRoot = Split-Path -Parent (Split-Path -Parent $ScriptRoot)
$Driver = Join-Path $ScriptRoot 'Invoke-RemoteIosBuild.ps1'
$ConfExample = Join-Path $ScriptRoot 'ios-build.conf.example'
$MacScript = Join-Path $ScriptRoot 'mac\ios-build.sh'
$BootstrapScript = Join-Path $ScriptRoot 'mac\bootstrap-mac.sh'
$Runbook = Join-Path (Join-Path $AppRoot 'docs') 'remote-ios-build.md'
$AppGitIgnore = Join-Path $AppRoot '.gitignore'
$SelfPath = $MyInvocation.MyCommand.Path

$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $PsExe)) { $PsExe = 'powershell.exe' }

$TempRoot = Join-Path $env:TEMP ('dsh-ios-build-tests-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Force -Path $TempRoot)

function Remove-TempRoot {
    if (Test-Path -LiteralPath $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Driver {
    param([string[]]$ArgList)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $out = & $PsExe -NoProfile -ExecutionPolicy Bypass -File $Driver @ArgList 2>&1
    $code = $LASTEXITCODE
    $sw.Stop()
    return @{
        ExitCode = $code
        Output   = ($out | Out-String)
        Seconds  = $sw.Elapsed.TotalSeconds
    }
}

function Test-Parses {
    param([string]$Path, [string]$Label)
    $errs = $null
    $toks = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$toks, [ref]$errs)
    $detail = ''
    if ($errs.Count -gt 0) {
        $detail = ($errs | ForEach-Object { 'L{0}: {1}' -f $_.Extent.StartLineNumber, $_.Message }) -join '; '
    }
    Assert-True ($errs.Count -eq 0) ('parse: ' + $Label + ' has 0 errors') $detail
}

# --------------------------------------------------------------------------- 1. parse

Write-Host '--- parse (Windows PowerShell 5.1 parser) ---'
Test-Parses -Path $Driver -Label 'Invoke-RemoteIosBuild.ps1'
Test-Parses -Path $SelfPath -Label 'dryrun.Tests.ps1'

# --------------------------------------------------------------------------- 2. help

Write-Host '--- -Help ---'
$help = Invoke-Driver @('-Help')
Assert-True ($help.ExitCode -eq 0) '-Help exits 0' ('exit ' + $help.ExitCode)
Assert-True ($help.Output -match 'Exit codes:') '-Help prints the exit-code table'
foreach ($code in @('0 ok', '2 preflight', '3 lock', '4 build', '5 upload', '6 cleanup')) {
    Assert-True ($help.Output.Contains($code)) ('-Help documents exit code token "' + $code + '"')
}
Assert-True ($help.Output.Contains('-SelfTest')) '-Help documents -SelfTest'
Assert-True ($help.Output.Contains('-FromHead')) '-Help documents -FromHead'
Assert-True ($help.Output.Contains('-AcceptHostKey')) '-Help documents -AcceptHostKey'
Assert-True ($help.Output.Contains('current working tree')) '-Help states that the working tree is packaged'

# --------------------------------------------------------------------------- 3. dry run

Write-Host '--- -DryRun (black-holed host: any ssh attempt would block for ConnectTimeout=10) ---'
$blackholeConf = Join-Path $TempRoot 'blackhole.conf'
$confLines = @(
    'DSH_IOS_HOST=203.0.113.1',
    'DSH_IOS_USER=nobody',
    'DSH_IOS_SSH_PORT=22',
    'DSH_IOS_TEAM_ID=ABCDE12345',
    'DSH_IOS_QUOTA_GB=30',
    'DSH_IOS_FLOOR_GB=15'
)
Set-Content -LiteralPath $blackholeConf -Value $confLines -Encoding ASCII

$dry = Invoke-Driver @('-DryRun', '-ConfigFile', $blackholeConf, '-Upload')
Assert-True ($dry.ExitCode -eq 0) '-DryRun exits 0' ('exit ' + $dry.ExitCode + ' output: ' + $dry.Output)
Assert-True ($dry.Output.Contains('PLAN: remote iOS build')) '-DryRun prints the plan header'
Assert-True ($dry.Output.Contains('zero ssh calls')) '-DryRun states that it made zero ssh calls'
Assert-True ($dry.Seconds -lt 5) '-DryRun returns in < 5 s (no ssh dial: ConnectTimeout is 10 s)' ('took ' + $dry.Seconds + ' s')
Assert-True ($dry.Output.Contains('DSHIosBuild')) '-DryRun names the build volume'
Assert-True ($dry.Output.Contains('-quota')) '-DryRun shows the APFS quota step'
Assert-True ($dry.Output.Contains('deleteVolume')) '-DryRun shows the volume deletion step'
Assert-True ($dry.Output.Contains('--apiIssuer <redacted')) '-DryRun redacts the upload issuer'
Assert-True (-not $dry.Output.Contains('BEGIN PRIVATE KEY')) '-DryRun prints no key material'
Assert-True ($dry.Output.Contains('source           : worktree (HEAD ')) '-DryRun names the worktree source and the HEAD sha'
Assert-True ($dry.Output.Contains('dirty files)')) '-DryRun reports the dirty-file count'
Assert-True ($dry.Output.Contains('StrictHostKeyChecking=yes')) '-DryRun defaults to StrictHostKeyChecking=yes'
Assert-True (-not $dry.Output.Contains('accept-new')) '-DryRun does not accept an unknown host key by default'
Assert-True ($dry.Output.Contains('self-test')) '-DryRun lists the remote self-test as the first step'

$dryAccept = Invoke-Driver @('-DryRun', '-ConfigFile', $blackholeConf, '-AcceptHostKey')
Assert-True ($dryAccept.Output.Contains('StrictHostKeyChecking=accept-new')) '-AcceptHostKey switches the plan to accept-new once'

$dryHead = Invoke-Driver @('-DryRun', '-ConfigFile', $blackholeConf, '-FromHead')
Assert-True ($dryHead.Output.Contains('source           : HEAD ')) '-FromHead prints the HEAD source line'
Assert-True (-not $dryHead.Output.Contains('git ls-files tracked+untracked')) '-FromHead does not claim the working tree'

$artifactsDir = ''
foreach ($line in ($dry.Output -split "`r?`n")) {
    if ($line -match 'artifacts dir\s+:\s+(.+)$') { $artifactsDir = $Matches[1].Trim() }
}
Assert-True ($artifactsDir.Length -gt 0) '-DryRun prints the artifacts directory' 'not found in output'
if ($artifactsDir.Length -gt 0) {
    Assert-True (-not (Test-Path -LiteralPath $artifactsDir)) '-DryRun created no artifacts directory'
}

# --------------------------------------------------------------------------- 4. bad params

Write-Host '--- bad parameters (must be exit 2, not a PowerShell binding error) ---'
$badProfile = Invoke-Driver @('-DryRun', '-Profile', 'staging')
Assert-True ($badProfile.ExitCode -eq 2) 'bad -Profile exits 2' ('exit ' + $badProfile.ExitCode)
Assert-True ($badProfile.Output -match "bad -Profile 'staging'") 'bad -Profile names the value'

$badQuota = Invoke-Driver @('-DryRun', '-QuotaGb', '0')
Assert-True ($badQuota.ExitCode -eq 2) 'bad -QuotaGb exits 2' ('exit ' + $badQuota.ExitCode)

$badTeam = Invoke-Driver @('-DryRun', '-TeamId', 'short')
Assert-True ($badTeam.ExitCode -eq 2) 'bad -TeamId exits 2' ('exit ' + $badTeam.ExitCode)

$noSignUpload = Invoke-Driver @('-DryRun', '-NoSign', '-Upload')
Assert-True ($noSignUpload.ExitCode -eq 2) '-NoSign with -Upload exits 2' ('exit ' + $noSignUpload.ExitCode)

$missingConf = Invoke-Driver @('-DryRun', '-ConfigFile', (Join-Path $TempRoot 'does-not-exist.conf'))
Assert-True ($missingConf.ExitCode -eq 2) 'missing -ConfigFile exits 2' ('exit ' + $missingConf.ExitCode)

# --------------------------------------------------------------------------- 4b. self-test

Write-Host '--- -SelfTest (localhost port 1 refuses immediately: no Mac, no build) ---'
$refusedConf = Join-Path $TempRoot 'refused.conf'
Set-Content -LiteralPath $refusedConf -Encoding ASCII -Value @(
    'DSH_IOS_HOST=127.0.0.1',
    'DSH_IOS_USER=nobody',
    'DSH_IOS_SSH_PORT=1'
)
$selfTestArtifactsBefore = @(Get-ChildItem -LiteralPath (Join-Path $AppRoot 'artifacts\ios') -ErrorAction SilentlyContinue).Count
$selfTest = Invoke-Driver @('-SelfTest', '-ConfigFile', $refusedConf)
Assert-True ($selfTest.ExitCode -eq 2) '-SelfTest against an unreachable host exits 2' ('exit ' + $selfTest.ExitCode + ' output: ' + $selfTest.Output)
Assert-True ($selfTest.Seconds -lt 12) '-SelfTest fails fast (< 12 s)' ('took ' + $selfTest.Seconds + ' s')
Assert-True ($selfTest.Output.Contains('SELF-TEST FAILED')) '-SelfTest says what failed'
Assert-True ($selfTest.Output.Contains('bash -n')) '-SelfTest parses the remote script with the Mac bash before anything else'
Assert-True (-not $selfTest.Output.Contains('remote iOS build ')) '-SelfTest never starts a build'
$selfTestArtifactsAfter = @(Get-ChildItem -LiteralPath (Join-Path $AppRoot 'artifacts\ios') -ErrorAction SilentlyContinue).Count
Assert-True ($selfTestArtifactsAfter -eq $selfTestArtifactsBefore) '-SelfTest left no artifacts directory behind'

# --------------------------------------------------------------------------- 5. example config

Write-Host '--- ios-build.conf.example ---'
Assert-True (Test-Path -LiteralPath $ConfExample) 'ios-build.conf.example exists'
$example = Invoke-Driver @('-DryRun', '-ConfigFile', $ConfExample)
Assert-True ($example.ExitCode -eq 0) 'the example config is accepted' ('exit ' + $example.ExitCode + ' output: ' + $example.Output)
Assert-True ($example.Output.Contains('mac-mini.tailnet-example.ts.net')) 'the plan uses the example host'
$exampleText = Get-Content -LiteralPath $ConfExample -Raw
Assert-True (-not ($exampleText -match '(?m)^\s*DSH_IOS_ASC_ISSUER_ID\s*=\s*\S+')) 'the example config carries no issuer value'
Assert-True (-not ($exampleText -match '(?m)^\s*DSH_IOS_ASC_KEY_ID\s*=\s*\S+')) 'the example config carries no key id value'

# --------------------------------------------------------------------------- 6. shell contract

Write-Host '--- shell scripts (static contract) ---'
foreach ($pair in @(@('ios-build.sh', $MacScript), @('bootstrap-mac.sh', $BootstrapScript))) {
    $label = $pair[0]
    $path = $pair[1]
    Assert-True (Test-Path -LiteralPath $path) ($label + ' exists')
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $text = Get-Content -LiteralPath $path -Raw
    Assert-True ($text.StartsWith('#!/bin/bash')) ($label + ' has a bash shebang')
    Assert-True ($text.Contains('set -Eeuo pipefail')) ($label + ' sets -Eeuo pipefail')
    Assert-True (-not ($text -match '(?m)^\s*set\s+-[a-z]*x')) ($label + ' never enables set -x')
    Assert-True (-not $text.Contains("`r")) ($label + ' uses LF line endings')
}

$macText = Get-Content -LiteralPath $MacScript -Raw
foreach ($needle in @(
        'trap cleanup EXIT INT TERM HUP',
        'diskutil apfs addVolume',
        '-quota',
        'diskutil apfs deleteVolume',
        'diskutil info -plist /')) {
    Assert-True ($macText.Contains($needle)) ('ios-build.sh contains "' + $needle + '"')
}
Assert-True ($macText -match 'RESULT \{') 'ios-build.sh emits a RESULT JSON line'
Assert-True ($macText.Contains('CODE_SIGNING_ALLOWED=NO')) 'ios-build.sh has the --no-sign path'
Assert-True ($macText.Contains('xcodebuild archive')) 'ios-build.sh archives with xcodebuild'
Assert-True ($macText.Contains("'generic/platform=iOS'")) 'ios-build.sh targets generic/platform=iOS'
Assert-True (-not ($macText -match 'xcrun\s+simctl')) 'ios-build.sh installs no simulator runtime'
Assert-True (-not ($macText -match 'eas\s+(build|submit|login)')) 'ios-build.sh never calls EAS'
Assert-True (-not ($macText -match 'npm_config_cache=\$HOME')) 'ios-build.sh keeps the npm cache in the volume'
Assert-True ($macText.Contains('--self-test)')) 'ios-build.sh accepts --self-test'
Assert-True ($macText.Contains('self_test()')) 'ios-build.sh has a self_test function'
Assert-True ($macText.Contains('--source=')) 'ios-build.sh accepts --source (worktree vs head)'
Assert-True ($macText.Contains("--from-head) SOURCE='head'")) 'ios-build.sh accepts --from-head'
Assert-True ($macText.Contains('"source":"%s"')) 'ios-build.sh reports the package source in RESULT'
Assert-True ($macText.Contains('dirty files)')) 'ios-build.sh logs the dirty-file count with the source'
Assert-True ($macText.Contains('stage_artifacts must run before cleanup')) 'ios-build.sh documents why staging outlives the volume'
Assert-True ($macText.Contains('3-day prune')) 'ios-build.sh keeps the prune as the safety net'
Assert-True (-not ($macText -match '(?m)^\s*set\s+-[a-z]*x')) 'ios-build.sh still never enables set -x'

$bootText = Get-Content -LiteralPath $BootstrapScript -Raw
Assert-True ($bootText.Contains('--apply-guards')) 'bootstrap-mac.sh has --apply-guards'
Assert-True ($bootText.Contains('chmod 600')) 'bootstrap-mac.sh enforces mode 600 on the Mac config'
Assert-True ($bootText.Contains('systemsetup -getremotelogin')) 'bootstrap-mac.sh checks Remote Login'
Assert-True ($bootText.Contains('xcrun altool --help')) 'bootstrap-mac.sh checks altool'
Assert-True ($bootText.Contains('pod --version')) 'bootstrap-mac.sh checks CocoaPods'
Assert-True ($bootText.Contains('xcode-select -p')) 'bootstrap-mac.sh checks xcode-select'
Assert-True (-not ($bootText -match 'sudo\s+shutdown')) 'bootstrap-mac.sh never shuts the Mac down'
$sudoCount = ([regex]::Matches($bootText, 'sudo -n')).Count
Assert-True ($sudoCount -eq 1) 'bootstrap-mac.sh runs exactly one sudo command (the read-only state check)' ('found ' + $sudoCount)
Assert-True (-not ($bootText -match 'sudo\s+-n\s+(cp|sh|ln|install|systemsetup\s+-setremotelogin)')) 'bootstrap-mac.sh runs no privileged change'
Assert-True ($bootText.Contains('printed, NOT executed')) 'bootstrap-mac.sh marks the sshd block as printed only'
Assert-True ($bootText.Contains('sudo launchctl kickstart')) 'bootstrap-mac.sh prints the sshd restart command instead of running it'
Assert-True ($bootText.Contains('ssh-keygen -lf')) 'bootstrap-mac.sh prints the ssh host key fingerprints'
Assert-True ($bootText -match 'ssh_host_(ed25519|rsa)_key\.pub') 'bootstrap-mac.sh reads the real host public keys'

# --------------------------------------------------------------------------- 7. no secrets

Write-Host '--- secret scan (issuer-shaped UUIDs, key material, committed artifacts) ---'
$scanFiles = @(
    @('Invoke-RemoteIosBuild.ps1', $Driver),
    @('mac/ios-build.sh', $MacScript),
    @('mac/bootstrap-mac.sh', $BootstrapScript),
    @('ios-build.conf.example', $ConfExample),
    @('docs/remote-ios-build.md', $Runbook)
)
$uuidPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
foreach ($pair in $scanFiles) {
    $label = $pair[0]
    $path = $pair[1]
    if (-not (Test-Path -LiteralPath $path)) {
        No ('secret scan: ' + $label + ' exists') 'file missing'
        continue
    }
    $text = Get-Content -LiteralPath $path -Raw
    Assert-True (-not ($text -match $uuidPattern)) ('no issuer-shaped UUID in ' + $label)
    Assert-True (-not ($text -match 'BEGIN [A-Z ]*PRIVATE KEY')) ('no PEM private key block in ' + $label)
    Assert-True (-not ($text -match 'LS0tLS1CRUdJTi')) ('no base64 key body in ' + $label)
}

$driverText = Get-Content -LiteralPath $Driver -Raw
Assert-True ($driverText.Contains('ConnectTimeout=10')) 'the driver sets ConnectTimeout=10'
Assert-True ($driverText.Contains('BatchMode=yes')) 'the driver sets BatchMode=yes'
Assert-True (-not ($driverText -match '(?m)^\s*Set-StrictMode')) 'the driver does not set StrictMode (5.1 safe)'
Assert-True ($driverText.Contains('ls-files -z -co --exclude-standard')) 'the driver packages the working tree file list from git ls-files'
Assert-True ($driverText.Contains('--null --no-recursion')) 'the driver feeds tar NUL-separated names (paths survive byte-for-byte)'
Assert-True ($driverText.Contains('.dsh-wiki/*')) 'the driver hard-excludes .dsh-wiki even though it is tracked'
Assert-True ($driverText.Contains('archive --format=tar HEAD')) 'the driver keeps git archive HEAD for -FromHead'
Assert-True ($driverText.Contains("'StrictHostKeyChecking=' + `$HostKeyPolicy")) 'both option lists use the host key policy'
Assert-True ($driverText.Contains("`$HostKeyPolicy = 'yes'")) 'the default host key policy is yes'
Assert-True ($driverText.Contains("`$HostKeyPolicy = 'accept-new'")) 'only -AcceptHostKey relaxes it, to accept-new'
Assert-True ($driverText.Contains('rm -rf -- ')) 'the driver removes this run''s staging directory after the transfer'
Assert-True ($driverText.Contains('selftest.log')) 'the self-test report is kept in the run directory'
Assert-True ($driverText.Contains('RESULT (\{')) 'the driver parses the remote RESULT line'
Assert-True ($driverText.Contains('Invoke-Expression') -eq $false) 'the driver never uses Invoke-Expression'
Assert-True ($driverText.Contains('ConvertFrom-Json')) 'the driver parses RESULT as JSON'
Assert-True ($driverText.Contains("'-P', `$Settings.Port")) 'the driver passes the scp port as -P (-p means preserve times)'
Assert-True ($driverText.Contains('Test-NonEmptyZip')) 'the driver verifies the .ipa size and ZIP magic'
Assert-True ($driverText.Contains("'.partial'")) 'the driver retrieves into a .partial file first'

# --------------------------------------------------------------------------- 8. artifacts ignored

Write-Host '--- artifacts are git-ignored ---'
if (Test-Path -LiteralPath $AppGitIgnore) {
    $ignoreText = Get-Content -LiteralPath $AppGitIgnore -Raw
    Assert-True ($ignoreText -match '(?m)^artifacts/\s*$') 'apps/mobile-companion/.gitignore ignores artifacts/'
}

# --------------------------------------------------------------------------- 9. optional bash -n

Write-Host '--- shell syntax (optional) ---'
if (-not $IncludeBash) {
    Skip 'bash -n on both shell scripts' 'not requested; pass -IncludeBash where a bash binary can start'
} else {
    $bash = ''
    foreach ($candidate in @(
            'C:\Program Files\Git\bin\bash.exe',
            'C:\Program Files\Git\usr\bin\bash.exe',
            (Join-Path $env:SystemRoot 'System32\bash.exe'))) {
        if (Test-Path -LiteralPath $candidate) { $bash = $candidate; break }
    }
    if ([string]::IsNullOrEmpty($bash)) {
        Skip 'bash -n on both shell scripts' 'no bash binary found'
    } else {
        foreach ($pair in @(@('ios-build.sh', $MacScript), @('bootstrap-mac.sh', $BootstrapScript))) {
            $outFile = Join-Path $TempRoot ('bash-out-' + $pair[0] + '.txt')
            $errFile = Join-Path $TempRoot ('bash-err-' + $pair[0] + '.txt')
            $bashPath = $pair[1].Replace('\', '/')
            $proc = Start-Process -FilePath $bash -ArgumentList @('-n', $bashPath) -NoNewWindow -Wait -PassThru `
                -RedirectStandardOutput $outFile -RedirectStandardError $errFile -ErrorAction SilentlyContinue
            if ($null -eq $proc) {
                Skip ('bash -n ' + $pair[0]) 'bash could not be started in this environment'
            } else {
                Assert-True ($proc.ExitCode -eq 0) ('bash -n ' + $pair[0]) ('exit ' + $proc.ExitCode)
            }
        }
    }
}

# --------------------------------------- 10. FR-016 / FR-017 / FR-018 static contract

Write-Host '--- FR-018: orchestrator staged on the Mac, payload fd guarded ---'
Assert-True (-not $driverText.Contains("'bash', '-s'")) 'the driver builds no `bash -s` remote command'
Assert-True (-not $driverText.Contains('bash -s --')) 'the driver never streams arguments to `bash -s --`'
Assert-True ($driverText.Contains('Get-FileHash -Algorithm SHA256')) 'the driver hashes the orchestrator with Get-FileHash -Algorithm SHA256'
Assert-True ($driverText.Contains('shasum -a 256')) 'the driver compares that hash with shasum -a 256 on the Mac'
Assert-True ($driverText.Contains('/.dsh-ios-build')) 'the orchestrator is staged at the stable ~/.dsh-ios-build path'
Assert-True ($driverText.Contains('/ios-build.sh')) 'the staged file is ios-build.sh'
Assert-True ($driverText -match "/bin/bash '\s*\+\s*") 'the remote command runs <bash> <staged absolute script path>'
Assert-True ($driverText.Contains('$StagedPath')) 'the staged absolute path is embedded in the remote command'
Assert-True ($driverText.Contains('sha256 mismatch')) 'a hash mismatch aborts the run'
Assert-True ($driverText.Contains('Invoke-RemoteStream -CommandLine $cmdLine')) 'the build streams the tar to the staged script'
Assert-True ($driverText.Contains('Resolve-RemoteHome')) 'the remote $HOME is resolved once and embedded as an absolute path'
Assert-True ($macText.Contains('exec 3<&0')) 'ios-build.sh reserves fd 3 for the payload'
Assert-True ($macText.Contains('exec </dev/null')) 'ios-build.sh points its own stdin at /dev/null'
Assert-True ($macText.Contains('/dev/fd/3')) 'extract_source reads the payload from fd 3'
Assert-True (-not ($macText -match 'tar -x -f - ')) 'extract_source never reads stdin'
Assert-True ($macText -match '"power":"%s"') 'RESULT carries the requested power action'

Write-Host '--- FR-016: stage before upload, retrieve on exit 0 and 5, driver-owned power-down ---'
$mainMatch = [regex]::Match($macText, '(?s)main\(\) \{.*?\n\}')
Assert-True $mainMatch.Success 'ios-build.sh has a main() body to order-check'
if ($mainMatch.Success) {
    $stageAt = $mainMatch.Value.IndexOf('stage_artifacts')
    $uploadAt = $mainMatch.Value.IndexOf('upload_ipa')
    Assert-True ($stageAt -ge 0) 'main() calls stage_artifacts'
    Assert-True ($uploadAt -ge 0) 'main() calls upload_ipa'
    Assert-True ($stageAt -lt $uploadAt) 'main() stages the artifact BEFORE the upload attempt'
}
Assert-True ($driverText.Contains('$exitCode -eq $ExitUpload')) 'the driver retrieves the artifact on exit 5 too'
Assert-True ($driverText -match 'UPLOAD FAILED \(the \.ipa is kept locally\)') 'the driver still says the .ipa is kept locally'
Assert-True ($driverText.Contains('Invoke-PowerDown')) 'the driver owns the power action'
Assert-True ($driverText.Contains('-Shutdown ([bool]$ShutdownAfterBuild)')) 'the driver derives the power action from -ShutdownAfterBuild'
Assert-True ($driverText.Contains('pmset sleepnow')) 'the driver issues the sleep on the Mac'
Assert-True (-not $macText.Contains('request_sleep')) 'the remote script has no request_sleep exit path'
Assert-True (-not ($macText -match 'pmset|osascript')) 'the remote script never sleeps or shuts the Mac down itself'
Assert-True (-not ($macText -match 'shutdown -h')) 'the remote script never issues a shutdown command'

Write-Host '--- FR-017: identity warning only when an ASC key is configured ---'
Assert-True ($macText.Contains('automatic signing will try to create one')) 'a missing identity is a warning with an ASC key'
Assert-True ($macText -match 'identity count: 0') 'a missing identity still fails without an ASC key'

# --------------------------------------- 11. FR-019 env normalisation, power default, dirty count

Write-Host '--- FR-019: the remote session fixes its own PATH and locale ---'
Assert-True ($macText.Contains('normalise_path')) 'ios-build.sh normalises PATH itself'
Assert-True ($macText.Contains('/opt/homebrew/bin')) 'PATH includes the Homebrew bin dir (node/npm/pod live there)'
Assert-True ($macText.Contains('/usr/local/bin')) 'PATH includes /usr/local/bin'
Assert-True ($macText.Contains('.gem/ruby/*/bin')) 'PATH includes user-installed gem bins'
Assert-True ($macText.Contains('normalise_locale')) 'ios-build.sh normalises the locale itself'
Assert-True ($macText -match 'UTF-8') 'the locale normaliser targets UTF-8'
Assert-True ($macText.Contains('Unicode Normalization')) 'the code documents the CocoaPods ASCII-8BIT failure it prevents'
$mainCall = [regex]::Match($macText, '(?s)main\(\) \{.{0,200}')
Assert-True ($mainCall.Success -and $mainCall.Value.Contains('normalise_path') -and $mainCall.Value.Contains('normalise_locale')) 'main() normalises PATH and locale before anything else'
Assert-True ($macText -match "st_item ok 'locale'") 'self-test reports the effective locale'

Write-Host '--- default power action is stay-awake, not sleep ---'
Assert-True ($macText.Contains("local power='stay-awake'")) 'RESULT defaults to power=stay-awake'
Assert-True ($macText.Contains('--sleep')) 'the remote accepts --sleep'
Assert-True ($macText -match "(?m)^SLEEP=0") 'SLEEP defaults to 0'
Assert-True ($driverText.Contains('$SleepAfterBuild')) 'the driver exposes -SleepAfterBuild'
Assert-True ($driverText.Contains('POWER:stay-awake')) 'the driver reports stay-awake as a first-class outcome'
Assert-True ($driverText.Contains("if (`$SleepAfterBuild) { `$remoteArgs += '--sleep' }")) 'the driver passes --sleep to the remote'
$powerFn = [regex]::Match($driverText, '(?s)function Invoke-PowerDown \{.*?\n\}')
Assert-True $powerFn.Success 'Invoke-PowerDown exists'
if ($powerFn.Success) {
    Assert-True ($powerFn.Value.Contains('elseif ($Sleep)')) 'sleep happens only when -SleepAfterBuild was passed'
    Assert-True ($powerFn.Value.Contains("'POWER:stay-awake'")) 'the default branch leaves the Mac awake'
}

Write-Host '--- the uncommitted-file count actually reaches the Mac ---'
Assert-True ($driverText.Contains("('--dirty-files=' + `$DirtyCount)")) 'the driver passes --dirty-files to the remote'
Assert-True ($macText.Contains('--dirty-files')) 'the remote parses --dirty-files'

# --------------------------------------- 12. the shell script actually executes (not just parses)

Write-Host '--- ios-build.sh runs: help, bad argument, non-macOS guard ---'
$bashExe = $null
foreach ($cand in @('C:\Program Files\Git\bin\bash.exe', 'C:\Program Files\Git\usr\bin\bash.exe', 'bash')) {
    if ($cand -eq 'bash') { $bashExe = 'bash'; break }
    if (Test-Path $cand) { $bashExe = $cand; break }
}
$macScriptPath = Join-Path (Join-Path $ScriptRoot 'mac') 'ios-build.sh'
if ($null -eq $bashExe) {
    Skip 'ios-build.sh --help' 'no bash binary on this machine'
    Skip 'ios-build.sh bad argument' 'no bash binary on this machine'
    Skip 'ios-build.sh non-macOS guard' 'no bash binary on this machine'
} else {
    $helpRun = & $bashExe $macScriptPath --help 2>&1
    $helpCode = $LASTEXITCODE
    $helpText = ($helpRun -join "`n")
    Assert-True ($helpText -match 'Usage:') 'ios-build.sh --help prints a usage block' $helpText
    Assert-True ($helpText -match '--run-id') 'ios-build.sh --help documents --run-id' $helpText
    Assert-True ($helpText -match '--self-test') 'ios-build.sh --help documents --self-test' $helpText
    Assert-True ($helpText -match '--dirty-files') 'ios-build.sh --help documents --dirty-files' $helpText

    $badRun = & $bashExe $macScriptPath --definitely-not-a-flag 2>&1
    $badCode = $LASTEXITCODE
    Assert-True ($badCode -eq 2) 'an unknown argument exits 2' ('exit ' + $badCode)
    Assert-True ((($badRun -join "`n") -match 'unknown argument')) 'an unknown argument is named in the error' ($badRun -join ' ')

    # On Windows the script must refuse before touching disk: it is a macOS-only orchestrator.
    $nonMacRun = & $bashExe $macScriptPath --self-test 2>&1
    $nonMacText = ($nonMacRun -join "`n")
    if ($nonMacText -match 'Darwin') {
        Assert-True ((($nonMacText -match 'self-test: PASS')) -or ($nonMacText -match '\[fail\] macOS')) 'the non-macOS guard reports clearly' $nonMacText
    } else {
        Assert-True ((($nonMacText -match 'not macOS')) -or ($nonMacText -match 'macOS only')) 'a non-macOS host is refused with a clear message' $nonMacText
    }
}

# --------------------------------------- 13. expo-modules-jsi Swift pin patch

Write-Host '--- expo-modules-jsi nested build is pinned to Swift 5 ---'
Assert-True ($macText.Contains('patch_expo_modules_jsi')) 'ios-build.sh has a patch step for expo-modules-jsi'
Assert-True ($macText.Contains('SWIFT_VERSION=5')) 'the patch pins the nested xcodebuild to Swift 5'
$mainPatch = [regex]::Match($macText, '(?s)main\(\) \{.*?\n\}')
if ($mainPatch.Success) {
    $depsAt = $mainPatch.Value.IndexOf('install_deps')
    $patchAt = $mainPatch.Value.IndexOf('patch_expo_modules_jsi')
    $prebuildAt = $mainPatch.Value.IndexOf('prebuild_ios')
    Assert-True ($depsAt -ge 0 -and $patchAt -gt $depsAt) 'the patch runs after npm ci (node_modules must exist)'
    Assert-True ($patchAt -lt $prebuildAt) 'the patch runs before prebuild'
}
Assert-True ($macText.Contains('env -i')) 'the code records why a flag cannot reach the nested build'
Assert-True ($driverText.Contains('--swift-version=')) 'the driver can also pass a Swift language mode'

# --------------------------------------- 14. FR-021 volume cleanup cannot leak

Write-Host '--- FR-021: the build volume is deleted by name and verified, never by mount path alone ---'
Assert-True ($macText.Contains('reclaim_all_volumes_by_name')) 'cleanup reclaims volumes by name'
Assert-True ($macText -match 'deleteVolume "\\?\$VOL_NAME') 'cleanup calls deleteVolume with the volume NAME'
Assert-True ($macText.Contains('VOLUME_LEFTOVER')) 'a leftover volume is tracked as a failure'
Assert-True ($macText.Contains('still registered')) 'the failure names the registered-but-unmounted volume'
Assert-True ($macText.Contains('orphan volumes')) 'the self-test reports orphan volumes'
Assert-True ($macText -match 'grep -c "Name: \*\$VOL_NAME" \|\| true') 'grep -c is guarded so set -e cannot abort on a zero count'
$destroyAt = [regex]::Match($macText, '(?s)destroy_volume\(\) \{.*?\n\}')
Assert-True $destroyAt.Success 'destroy_volume exists'
if ($destroyAt.Success) {
    Assert-True ($destroyAt.Value.Contains('reclaim_all_volumes_by_name')) 'destroy_volume verifies the container afterwards'
}
$createAt = [regex]::Match($macText, '(?s)create_volume\(\) \{.*?\n\}')
Assert-True $createAt.Success 'create_volume exists'
if ($createAt.Success) {
    Assert-True ($createAt.Value.Contains('reclaim_all_volumes_by_name')) 'create_volume reclaims orphans from earlier runs before adding a new volume'
}
Assert-True ($macText -match '(?m)^PATCH_EXPO_JSI=0') 'the expo-modules-jsi patch is opt-in (default off)'
Assert-True ($macText.Contains('--patch-expo-jsi')) 'the opt-in flag exists and is documented'

# --------------------------------------- 15. the working Swift 6.2 workaround (opt-in)

Write-Host '--- --jsi-sendable-patch: the two edits that make expo-modules-jsi compile ---'
Assert-True ($macText.Contains('patch_jsi_slot_sendable')) 'the pipeline has the Slot Sendable patch step'
Assert-True ($macText.Contains('~Copyable, @unchecked Sendable')) 'it adds @unchecked Sendable to Slot'
Assert-True ($macText.Contains('let slotValue = JavaScriptValue.Slot(slot)')) 'it builds the Slot outside the closure'
Assert-True ($macText.Contains('try encode(slotValue, runtime)')) 'the closure captures the Slot, not the raw pointer'
Assert-True ($macText.Contains('--jsi-sendable-patch')) 'the workaround is opt-in and documented'
Assert-True ($macText -match '(?m)^JSI_SENDABLE_PATCH=0') 'it defaults to off'
Assert-True ($driverText.Contains('$JsiSendablePatch')) 'the driver exposes the switch'

# --------------------------------------------------------------------------- summary

Remove-TempRoot

Write-Host ''
Write-Host ('=== ' + $script:Passed + ' passed, ' + $script:Failed + ' failed, ' + $script:Skipped + ' skipped ===')
if ($script:Failed -gt 0) { exit 1 }
exit 0
