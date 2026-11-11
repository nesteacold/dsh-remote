#Requires -Version 5.1
<#
.SYNOPSIS
    Drive a remote iOS build on the Tailscale Mac from Windows PowerShell 5.1.

.DESCRIPTION
    One command: streams the CURRENT WORKING TREE (tracked files plus untracked files that
    .gitignore does not exclude, uncommitted edits included) to the Mac over ssh, runs the
    remote orchestrator (mac/ios-build.sh), keeps the log, and pulls the .ipa back. A HEAD
    package would ship stale code: this repo normally carries dozens of uncommitted files.

    The orchestrator is STAGED on the Mac first (~/.dsh-ios-build/ios-build.sh, sha256-verified)
    and executed from that file, never piped as `bash -s`: the source tar occupies stdin, and
    `bash -s` would parse the tar bytes as shell text (FR-018 / plan D9).

    No EAS, no Expo login, no interactive prompt, no secret on this side: the App Store
    Connect key and issuer live only in ~/.dsh-ios-build.conf on the Mac.

    Exit codes (spec 009, FR-012):
      0 build ok (and upload ok, if requested)
      2 preflight refusal: unreachable, not idle, low disk, bad params
      3 another build holds the lock
      4 build failure (prebuild / pods / compile / export / signing)
      5 upload failure (artifact kept locally)
      6 cleanup assertion failed (disk did not return to baseline, or volume still mounted)

    Run with: powershell.exe -NoProfile -ExecutionPolicy Bypass -File <this file> ...
    (Execution policy is Restricted on this machine; `pwsh` is not installed.)

.PARAMETER DryRun
    Print the full plan (steps, paths, disk budget, upload command) and exit 0. Makes no
    ssh call at all.

.PARAMETER SelfTest
    Run only the Mac-side self-test: stage mac/ios-build.sh on the Mac, then run
    `--self-test` from that staged file, which parses itself with `bash -n` and reports
    macOS/Xcode/pods/altool/disk/idle/lock state. No source package, no volume, no build.
    Report goes to the console and to artifacts/ios/<run>/selftest.log. Exit 0 = essentials
    pass, 2 = they do not.

.PARAMETER FromHead
    Package HEAD instead of the working tree (git archive HEAD). Only for reproducing a
    committed build; the default packages the code as it sits on disk.

.PARAMETER AcceptHostKey
    Accept an unknown host key once (StrictHostKeyChecking=accept-new). The default is
    StrictHostKeyChecking=yes against the pinned known_hosts entry: compare the fingerprint
    that `bash bootstrap-mac.sh` prints on the Mac, then use this switch once.

.PARAMETER Upload
    Upload the .ipa to TestFlight. Opt-in and owner-gated; needs a signed build.

.PARAMETER Force
    Ignore the Mac's user-idle requirement.

.PARAMETER NoSign
    Unsigned build (CODE_SIGNING_ALLOWED=NO). Skips signing, export and upload.

.PARAMETER ShutdownAfterBuild
    Shut the Mac down instead of sleeping when the run ends.

.PARAMETER KeepPodsCache
    Keep a persistent CocoaPods cache on the Mac (changes the disk-baseline math).

.PARAMETER ConfigFile
    Config file to use. Precedence: -ConfigFile, then $env:DSH_IOS_BUILD_CONF, then
    scripts/remote-ios-build/.env.ios-build, then scripts/remote-ios-build/ios-build.conf,
    then the built-in defaults.

.PARAMETER PackageTo
    Test hook: build the source package with exactly the command a real run uses, write it
    to this file, print its size and exit 0. No ssh call. Used by test/package.Tests.ps1 to
    prove the worktree is packaged byte-for-byte.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File Invoke-RemoteIosBuild.ps1 -DryRun

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File Invoke-RemoteIosBuild.ps1 -Profile preview
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$SelfTest,
    [switch]$FromHead,
    [switch]$AcceptHostKey,
    [switch]$Upload,
    [switch]$Force,
    [switch]$NoSign,
    [switch]$ShutdownAfterBuild,
    [switch]$SleepAfterBuild,
    [int]$WaitForHost = 0,
    [string]$SwiftVersion = '',
    [string]$ExpoJsiSwiftExec = '',
    [string]$JsiOverride = '',
    [string]$CoreOverride = '',
    [switch]$JsiSendablePatch,
    [switch]$KeepPodsCache,
    [switch]$Help,
    [string]$ConfigFile = '',
    [string]$PackageTo = '',
    [string]$Profile = '',
    [string]$TeamId = '',
    [string]$QuotaGb = '',
    [string]$FloorGb = ''
)

$ErrorActionPreference = 'Continue'

# Script-relative layout: <repo>/apps/mobile-companion/scripts/remote-ios-build/<this file>
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ScriptsDir = Split-Path -Parent $ScriptDir
$AppRoot = Split-Path -Parent $ScriptsDir

$ExitOk = 0
$ExitPreflight = 2
$ExitLock = 3
$ExitBuild = 4
$ExitUpload = 5
$ExitCleanup = 6

$Defaults = @{
    Host        = ''
    User        = ''
    Port        = '22'
    TeamId      = ''
    Profile     = 'production'
    QuotaGb     = '30'
    FloorGb     = '15'
    IdleSeconds = '600'
    Stage       = '.dsh-ios-build'
}

$KnownKeys = @(
    'DSH_IOS_HOST',
    'DSH_IOS_USER',
    'DSH_IOS_SSH_PORT',
    'DSH_IOS_TEAM_ID',
    'DSH_IOS_PROFILE',
    'DSH_IOS_QUOTA_GB',
    'DSH_IOS_FLOOR_GB',
    'DSH_IOS_IDLE_SECONDS',
    'DSH_IOS_STAGE'
)

function Out-Line {
    param([string]$Text = '')
    [Console]::Out.WriteLine($Text)
}

function Show-Usage {
    Out-Line 'Invoke-RemoteIosBuild.ps1 - remote iOS build driver (Windows PowerShell 5.1)'
    Out-Line ''
    Out-Line 'Usage:'
    Out-Line '  powershell.exe -NoProfile -ExecutionPolicy Bypass -File Invoke-RemoteIosBuild.ps1 [options]'
    Out-Line ''
    Out-Line 'Options:'
    Out-Line '  -DryRun               print the plan, make zero ssh calls, exit 0'
    Out-Line '  -SelfTest             run only the Mac self-test (no package, no build); exit 2 if it fails'
    Out-Line '  -FromHead             package HEAD instead of the working tree (reproduce a commit)'
    Out-Line '  -AcceptHostKey        accept an unknown host key once (default: StrictHostKeyChecking=yes)'
    Out-Line '  -Upload               upload the .ipa to TestFlight (owner-gated, needs signing)'
    Out-Line '  -Force                ignore the Mac idle requirement'
    Out-Line '  -NoSign               unsigned build: no signing, no export, no upload'
    Out-Line '  -ShutdownAfterBuild   shut the Mac down after the run (needs passwordless sudo)'
Out-Line '  -SleepAfterBuild      suspend the Mac after the run (the next build then needs a wake)'
Out-Line '  -WaitForHost <sec>    poll for an unreachable/asleep Mac and start the build when it'
Out-Line '                        answers (e.g. 3600 = wait up to one hour); default 0 = fail fast'
    Out-Line '  -KeepPodsCache        keep a persistent CocoaPods cache on the Mac'
    Out-Line '  -ConfigFile <path>    config file (see precedence below)'
    Out-Line '  -Profile <name>       preview | production | development (default production)'
    Out-Line '  -TeamId <id>          Apple team id (default: from the config file)'
    Out-Line '  -QuotaGb <n>          APFS volume quota, GB (default 30)'
    Out-Line '  -FloorGb <n>          refuse below this free space on the Mac, GB (default 15)'
    Out-Line '  -Help                 this text'
    Out-Line ''
    Out-Line 'Source package: the current working tree - tracked files plus untracked files that'
    Out-Line '  .gitignore does not exclude, uncommitted edits included - minus .git/, .dsh-wiki/,'
    Out-Line '  node_modules/, dist/, artifacts/ and *.log at the app root. -FromHead packages HEAD.'
    Out-Line ''
    Out-Line 'Config precedence: -ConfigFile -> $env:DSH_IOS_BUILD_CONF ->'
    Out-Line '  scripts/remote-ios-build/.env.ios-build -> scripts/remote-ios-build/ios-build.conf ->'
    Out-Line '  built-in defaults. Secrets are never in this file; see ios-build.conf.example.'
    Out-Line ''
    Out-Line 'Exit codes: 0 ok | 2 preflight refusal | 3 lock held | 4 build failure |'
    Out-Line '            5 upload failure | 6 cleanup assertion failed'
}

function Read-BuildConfig {
    param([string]$Path)
    $map = @{}
    if ([string]::IsNullOrEmpty($Path)) { return $map }
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($raw in (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
        $line = $raw.Trim()
        if ($line.Length -eq 0) { continue }
        if ($line.StartsWith('#')) { continue }
        $i = $line.IndexOf('=')
        if ($i -lt 1) { continue }
        $key = $line.Substring(0, $i).Trim()
        $val = $line.Substring($i + 1).Trim()
        if ($val.Length -ge 2 -and $val.StartsWith('"') -and $val.EndsWith('"')) {
            $val = $val.Substring(1, $val.Length - 2)
        } elseif ($val.Length -ge 2 -and $val.StartsWith("'") -and $val.EndsWith("'")) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        if ($KnownKeys -notcontains $key) {
            Out-Line ("WARN config: unknown key '{0}' in {1} (ignored)" -f $key, (Split-Path -Leaf $Path))
            continue
        }
        $map[$key] = $val
    }
    return $map
}

function Get-Setting {
    param([hashtable]$Map, [string]$Key, [string]$Fallback)
    if ($Map.ContainsKey($Key)) {
        $v = [string]$Map[$Key]
        if ($v.Length -gt 0) { return $v }
    }
    return $Fallback
}

function Resolve-ConfigPath {
    param([string]$Explicit)
    if (-not [string]::IsNullOrEmpty($Explicit)) {
        $p = $Explicit
        if (-not [System.IO.Path]::IsPathRooted($p)) {
            $p = Join-Path (Get-Location).Path $p
        }
        if (-not (Test-Path -LiteralPath $p)) {
            Out-Line ("ERROR config: -ConfigFile not found: {0}" -f $p)
            return $null
        }
        return (Resolve-Path -LiteralPath $p).Path
    }
    if (-not [string]::IsNullOrEmpty($env:DSH_IOS_BUILD_CONF)) {
        if (Test-Path -LiteralPath $env:DSH_IOS_BUILD_CONF) {
            return (Resolve-Path -LiteralPath $env:DSH_IOS_BUILD_CONF).Path
        }
        Out-Line ("WARN config: DSH_IOS_BUILD_CONF points at a missing file; falling back")
    }
    $candidates = @(
        (Join-Path $ScriptDir '.env.ios-build'),
        (Join-Path $ScriptDir 'ios-build.conf')
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return (Resolve-Path -LiteralPath $c).Path }
    }
    return ''
}

function Resolve-Exe {
    param([string[]]$Names)
    foreach ($n in $Names) {
        $c = Get-Command $n -ErrorAction SilentlyContinue
        if ($null -ne $c) { return $c.Source }
    }
    return ''
}

function Test-UInt {
    param([string]$Value, [int]$Min, [int]$Max)
    if ([string]::IsNullOrEmpty($Value)) { return $false }
    if ($Value -notmatch '^[0-9]{1,9}$') { return $false }
    $n = [int]$Value
    if ($n -lt $Min) { return $false }
    if ($n -gt $Max) { return $false }
    return $true
}

function Test-NonEmptyZip {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $fi = Get-Item -LiteralPath $Path
    if ($fi.Length -lt 4) { return $false }
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read)
    try {
        $buf = New-Object byte[] 4
        $read = $fs.Read($buf, 0, 4)
        if ($read -lt 4) { return $false }
        return ($buf[0] -eq 0x50 -and $buf[1] -eq 0x4B -and $buf[2] -eq 0x03 -and $buf[3] -eq 0x04)
    } finally {
        $fs.Close()
    }
}

function Invoke-RemoteStream {
    param([string]$CommandLine, [string]$LogPath)

    $comspec = $env:ComSpec
    if ([string]::IsNullOrEmpty($comspec)) { $comspec = 'cmd.exe' }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $comspec
    $psi.Arguments = '/c ' + $CommandLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    try { $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    $writer = New-Object System.IO.StreamWriter($LogPath, $false, (New-Object System.Text.UTF8Encoding($false)))
    $logCapBytes = 50MB
    $written = 0
    $truncated = $false
    try {
        [void]$proc.Start()
        while (-not $proc.StandardOutput.EndOfStream) {
            $line = $proc.StandardOutput.ReadLine()
            Out-Line $line
            if (-not $truncated) {
                [void]$writer.WriteLine($line)
                $written = $written + $line.Length + 2
                if ($written -gt $logCapBytes) {
                    [void]$writer.WriteLine('[log truncated: local copy capped at 50 MB; console output continues]')
                    $truncated = $true
                }
            }
        }
        while (-not $proc.StandardError.EndOfStream) {
            $line = $proc.StandardError.ReadLine()
            Out-Line $line
            if (-not $truncated) {
                [void]$writer.WriteLine($line)
                $written = $written + $line.Length + 2
                if ($written -gt $logCapBytes) {
                    [void]$writer.WriteLine('[log truncated: local copy capped at 50 MB; console output continues]')
                    $truncated = $true
                }
            }
        }
        $proc.WaitForExit()
        return $proc.ExitCode
    } finally {
        $writer.Flush()
        $writer.Close()
        $proc.Dispose()
    }
}

# Hard excludes on top of .gitignore. Tracked files are listed by `git ls-files` even when
# they match .gitignore, so this list is what keeps the 3.2 MB committed .dsh-wiki/ and any
# build output out of the package. Patterns are tar's: `*` also matches `/`.
$HardExcludeArgs = '--exclude ".git/*" --exclude ".dsh-wiki/*" ' +
    '--exclude "*/node_modules/*" --exclude "node_modules/*" ' +
    '--exclude "*/dist/*" --exclude "dist/*" ' +
    '--exclude "*/artifacts/*" --exclude "artifacts/*" ' +
    '--exclude "apps/mobile-companion/*.log"'

# Build the producer half of the transfer as one cmd.exe command line. It is deliberately
# cmd's job, never PowerShell's: PowerShell would decode the tar stream as text and corrupt
# it. Both halves of the pipe run with -C <repo>, so the NUL-separated names `git ls-files`
# writes (--null) are read back exactly, including spaces and non-ASCII characters.
function Get-SourcePackageCommand {
    param([string]$RepoRoot)

    if ($FromHead) {
        # Reproducing a committed build: the tree as HEAD has it, not as it sits on disk.
        return 'git -C "' + $RepoRoot + '" archive --format=tar HEAD'
    }
    return 'git -C "' + $RepoRoot + '" ls-files -z -co --exclude-standard | ' +
        'tar -C "' + $RepoRoot + '" -c -f - --null --no-recursion ' +
        $HardExcludeArgs + ' -T -'
}

# Run one cmd.exe command line and return its exit code. stdout/stderr stay attached to the
# console: this is used for the local packaging hook, where the tar goes to a file.
function Invoke-CmdExit {
    param([string]$CommandLine)

    $comspec = $env:ComSpec
    if ([string]::IsNullOrEmpty($comspec)) { $comspec = 'cmd.exe' }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $comspec
    $psi.Arguments = '/c ' + $CommandLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    try {
        [void]$proc.Start()
        $proc.WaitForExit()
        return $proc.ExitCode
    } finally {
        $proc.Dispose()
    }
}

# FR-018 / plan D9: the orchestrator must run from a FILE on the Mac. `bash -s` would parse
# the source tar on stdin as shell text. The remote $HOME is resolved once and the absolute
# path is embedded in every command: nothing here relies on `$HOME` expanding through cmd.exe.
function Resolve-RemoteHome {
    param([string]$SshExe, [string[]]$SshOptions, [string]$Target)

    $raw = & $SshExe @SshOptions $Target 'echo $HOME' 2>&1
    if ($LASTEXITCODE -ne 0) {
        Out-Line ('ERROR preflight: cannot resolve the remote $HOME (ssh exit {0}); the Mac is unreachable?' -f $LASTEXITCODE)
        Out-Line '  check: tailscale status on both hosts, and that sshd is listening on the Tailscale address'
        return ''
    }
    # NB: do not name this $home — $HOME is a read-only automatic variable in PowerShell, and
    # assignment fails at run time (PS 5.1) even though the parse check cannot see it.
    $remoteHome = ''
    foreach ($line in @($raw)) {
        $t = ([string]$line).Trim()
        if ($t.StartsWith('/')) { $remoteHome = $t; break }
    }
    # The path is pasted into remote command lines, so it stays in a character set that needs
    # no shell quoting and cannot escape $HOME.
    if ($remoteHome -notmatch '^/[A-Za-z0-9._/-]+$') {
        Out-Line 'ERROR preflight: the remote $HOME is empty or unexpected; refusing to build'
        return ''
    }
    return $remoteHome
}

# Stage mac/ios-build.sh at <remote $HOME>/.dsh-ios-build/ios-build.sh and prove the bytes
# arrived intact. Returns the absolute remote path, or '' when staging failed (caller exits 2).
# The staged copy is overwritten on every run; it is the only file the pipeline leaves behind.
function Install-MacScript {
    param(
        [string]$LocalPath,
        [string]$RemoteHome,
        [string]$SshExe,
        [string[]]$SshOptions,
        [string[]]$ScpOptions,
        [string]$Target
    )

    $stageRoot = $RemoteHome + '/.dsh-ios-build'
    $stagedPath = $stageRoot + '/ios-build.sh'

    Out-Line ('  stage     : {0} (sha256-verified before use)' -f $stagedPath)
    $mk = & $SshExe @SshOptions $Target ('mkdir -p ' + $stageRoot + ' && chmod 700 ' + $stageRoot) 2>&1
    if ($LASTEXITCODE -ne 0) {
        Out-Line ('ERROR preflight: cannot create the remote staging directory {0}: {1}' -f $stageRoot, (($mk | Select-Object -First 3) -join ' '))
        return ''
    }

    & $ScpExe @ScpOptions $LocalPath ($Target + ':' + $stagedPath) 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Out-Line ('ERROR preflight: cannot stage the orchestrator at {0} (scp failed)' -f $stagedPath)
        return ''
    }
    $chmod = & $SshExe @SshOptions $Target ('chmod 700 ' + $stagedPath) 2>&1
    if ($LASTEXITCODE -ne 0) {
        Out-Line ('ERROR preflight: cannot chmod 700 the staged orchestrator: {0}' -f (($chmod | Select-Object -First 3) -join ' '))
        return ''
    }

    $localHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $LocalPath).Hash.ToLowerInvariant()
    $remoteHash = ''
    $remoteRaw = & $SshExe @SshOptions $Target ('shasum -a 256 ' + $stagedPath) 2>&1
    if ($LASTEXITCODE -eq 0) {
        $first = [string]($remoteRaw | Select-Object -First 1)
        if ($first -match '^([0-9a-fA-F]{64})') { $remoteHash = $Matches[1].ToLowerInvariant() }
    }
    if ($remoteHash.Length -ne 64 -or $remoteHash -ne $localHash) {
        $shown = '<unreadable>'
        if ($remoteHash.Length -eq 64) { $shown = $remoteHash }
        Out-Line ('ERROR preflight: staged orchestrator sha256 mismatch (local {0}, remote {1}); nothing was built' -f $localHash, $shown)
        return ''
    }
    Out-Line ('  sha256    : {0} (local == remote)' -f $localHash)
    return $stagedPath
}

# The remote self-test is the P0/P1 gate: a syntax error or a misconfigured Mac costs
# seconds instead of a 20-minute build. One ssh call, no tar, no volume, no lock, no build:
# the staged script's own `--self-test` starts with `bash -n "$0"` on the real file, then
# reports the toolchain/disk/idle/lock state. The report streams to selftest.log.
function Invoke-MacSelfTest {
    param([string]$StagedPath, [string]$SshLine, [string]$ArtifactDir, [string]$Floor = '')

    # Reached only after staging succeeded, so the Mac is proven reachable: no artifacts
    # directory is created for an unreachable or unstaged run.
    if (-not (Test-Path -LiteralPath $ArtifactDir)) {
        [void](New-Item -ItemType Directory -Force -Path $ArtifactDir)
    }
    $selfLog = Join-Path $ArtifactDir 'selftest.log'
    Out-Line '  self-test : staged script parses itself with the Mac''s bash (bash -n) inside --self-test'
    # The self-test must judge the same floor the build will use, otherwise -FloorGb is silently
    # ignored by the gate that runs before every build (observed 2026-11-09: -FloorGb 10 was
    # reported as "below the 15 GB floor" and the build was refused).
    $floorArg = ''
    if (-not [string]::IsNullOrEmpty($Floor)) { $floorArg = ' --floor-gb=' + $Floor }
    $cmdLine = $SshLine + ' /bin/bash ' + $StagedPath + ' --self-test' + $floorArg + ' 2>&1'
    return (Invoke-RemoteStream -CommandLine $cmdLine -LogPath $selfLog)
}

# FR-016: power-down is DRIVER-OWNED. It runs only after the artifact and log are on Windows
# and this run's stage directory is deleted, so the Mac cannot fall asleep under a pending
# scp. One ssh call; the action is backgrounded with a 2 s delay so ssh returns before the
# Mac goes down. `pmset sleepnow` is used instead of osascript: the AppleScript form embeds
# double quotes that cmd.exe cannot pass through safely. A failure is a WARNING, never a
# change to the build's exit code.
function Invoke-PowerDown {
    param([string]$SshExe, [string[]]$SshOptions, [string]$Target, [bool]$Shutdown, [bool]$Sleep)

    $sleepCmd = '( sleep 2; pmset sleepnow ) </dev/null >/dev/null 2>&1 & echo POWER:sleep'
    if ($Shutdown) {
        $powerCmd = 'if sudo -n true 2>/dev/null; then ( sleep 2; sudo -n shutdown -h +2 ) </dev/null >/dev/null 2>&1 & echo POWER:shutdown; ' +
            'else ( sleep 2; pmset sleepnow ) </dev/null >/dev/null 2>&1 & echo POWER:sleep-fallback; fi'
    } elseif ($Sleep) {
        $powerCmd = $sleepCmd
    } else {
        # Default: leave the Mac awake. A sleeping remote cannot be woken by this pipeline, so
        # every later build would need a human to touch the machine (observed 2026-11-09).
        $powerCmd = 'echo POWER:stay-awake'
    }

    $out = & $SshExe @SshOptions $Target $powerCmd 2>&1
    $token = ''
    foreach ($line in @($out)) {
        $t = ([string]$line).Trim()
        if ($t.StartsWith('POWER:')) { $token = $t; break }
    }
    switch ($token) {
        'POWER:shutdown' { Out-Line '  power     : shutdown requested (sudo -n shutdown -h +2; driver-owned)' }
        'POWER:sleep' { Out-Line '  power     : sleep requested (-SleepAfterBuild; the next build needs a wake)' }
        'POWER:stay-awake' { Out-Line '  power     : left awake (idle; pass -SleepAfterBuild to suspend the Mac)' }
        'POWER:sleep-fallback' {
            Out-Line 'WARN power: -ShutdownAfterBuild needs passwordless sudo here; fell back to sleep'
        }
        default {
            Out-Line 'WARN power: the Mac did not confirm the power action; it stays awake (build result is unchanged)'
        }
    }
}

function Show-Plan {
    param(
        [string]$ConfigPath,
        [string]$RepoRoot,
        [string]$Commit,
        [string]$RunId,
        [string]$ArtifactDir,
        [string]$Target,
        [string]$SshExe,
        [string]$Team,
        [string]$Quota,
        [string]$Floor,
        [string]$Idle,
        [string]$EffectiveProfile,
        [string]$Source,
        [string]$HostKey
    )

    $signing = 'automatic (App Store Connect key on the Mac)'
    if ($NoSign) { $signing = 'none (-NoSign: unsigned .ipa, no export, no upload)' }
    $remoteStage = '~/.dsh-ios-build/artifacts/' + $RunId
    $sourceDetail = 'tracked + untracked (not ignored), uncommitted edits included'
    if ($FromHead) { $sourceDetail = 'git archive HEAD (committed tree only, -FromHead)' }

    Out-Line '=== PLAN: remote iOS build (dry run, nothing is sent) ==='
    Out-Line ''
    Out-Line ('  repo root        : {0}' -f $RepoRoot)
    Out-Line ('  commit           : {0}' -f $Commit)
    Out-Line ('  source           : {0}' -f $Source)
    Out-Line ('                     {0}' -f $sourceDetail)
    Out-Line ('  excluded         : .git/ .dsh-wiki/ node_modules/ dist/ artifacts/ apps/mobile-companion/*.log')
    Out-Line ('  run id           : {0}' -f $RunId)
    Out-Line ('  artifacts dir    : {0}' -f $ArtifactDir)
    Out-Line ('  config           : {0}' -f (Get-ConfigLabel $ConfigPath))
    Out-Line ('  profile          : {0}' -f $EffectiveProfile)
    Out-Line ('  signing          : {0}' -f $signing)
    Out-Line ('  ssh client       : {0}' -f (Get-ExeLabel $SshExe))
    Out-Line ('  ssh target       : {0}' -f $Target)
    Out-Line ('  ssh options      : BatchMode=yes ConnectTimeout=10 ConnectionAttempts=1 ServerAliveInterval=30')
    Out-Line ('  host key check   : StrictHostKeyChecking={0}' -f $HostKey)
    if ($Team.Length -gt 0) {
        Out-Line ('  apple team       : {0}' -f $Team)
    } else {
        Out-Line '  apple team       : <unset: -TeamId or DSH_IOS_TEAM_ID in the Mac config>'
    }
    Out-Line ('  build volume     : APFS DSHIosBuild, quota {0} GB, mounted at /Volumes/DSHIosBuild' -f $Quota)
    Out-Line ('  disk floor       : {0} GB free on the Mac / (refuse below)' -f $Floor)
    Out-Line ('  idle requirement : {0} s of no user input, -Force overrides' -f $Idle)
    Out-Line ('  remote staging   : {0}' -f $remoteStage)
    Out-Line '  staged script    : <mac $HOME>/.dsh-ios-build/ios-build.sh (sha256-verified, overwritten each run)'
    if ($WaitForHost -gt 0) {
        Out-Line ('  unreachable Mac  : poll every 15 s for up to {0} min, then start the build' -f [int]($WaitForHost / 60))
    } else {
        Out-Line '  unreachable Mac  : fail fast with exit 2 (-WaitForHost <sec> would poll instead)'
    }
    Out-Line ''
    Out-Line '  Remote steps:'
    Out-Line '   0 stage: scp mac/ios-build.sh -> <mac $HOME>/.dsh-ios-build/ios-build.sh, chmod 700,'
    Out-Line '            then sha256 compare (Get-FileHash locally vs shasum -a 256 on the Mac);'
    Out-Line '            a mismatch aborts with exit 2. The script runs FROM THAT FILE, never'
    Out-Line '            `bash -s`, so the tar keeps stdin to itself (FR-018)'
    Out-Line '   1 self-test: the staged file parses itself (bash -n "$0"), then macOS/Xcode/pods/'
    Out-Line '               altool/disk/idle/lock report; a failure aborts here with exit 2'
    Out-Line '   2 preflight: uname / xcode-select -p / xcodebuild -version / free space floor / idle / lock'
    Out-Line '   3 lock: atomic mkdir ~/.dsh-ios-build/lock (stale > 90 min reclaimed with a warning)'
    Out-Line '   4 baseline: df -g / recorded before any write'
    Out-Line '   5 volume: diskutil apfs addVolume <container from diskutil info -plist /> APFS DSHIosBuild -quota'
    if ($FromHead) {
        Out-Line '   6 source: tar -x from the reserved payload fd 3 (not stdin) -> volume/src'
        Out-Line '             (git archive HEAD)'
    } else {
        Out-Line '   6 source: tar -x from the reserved payload fd 3 (not stdin) -> volume/src'
        Out-Line '             (worktree package: git ls-files tracked+untracked, hard excludes applied)'
    }
    Out-Line '   7 deps: npm ci (cache inside the volume)'
    Out-Line '   8 prebuild: expo prebuild --platform ios --no-install (no EAS, no Expo login)'
    Out-Line '   9 pods: pod install (--deployment when a Podfile.lock exists)'
    Out-Line '  10 archive: xcodebuild archive -destination generic/platform=iOS, derived data in the volume'
    Out-Line '  11 export: ExportOptions.plist (no secrets) + xcodebuild -exportArchive -> app.ipa'
    Out-Line '  12 stage: copy the .ipa + ExportOptions.plist to the remote stage dir BEFORE the'
    Out-Line '            upload, so an upload failure (exit 5) still leaves a retrievable artifact'
    if ($Upload) {
        Out-Line '  13 upload: xcrun altool --upload-app (key id + issuer read from the Mac config)'
    } else {
        Out-Line '  13 upload: skipped (pass -Upload to send the build to TestFlight)'
    }
    Out-Line '  14 cleanup: kill caffeinate, unmount, diskutil apfs deleteVolume, remove lock,'
    Out-Line '             assert free space is back within 1 GB of the baseline (else exit 6);'
    Out-Line '             cleanup NEVER sleeps or shuts the Mac down'
    Out-Line '  15 power: DRIVER-owned, issued after retrieval + stage cleanup (never by this script)'
    Out-Line ''
    Out-Line '  Disk budget on the Mac (Apple Silicon, device-only):'
    Out-Line '    source + npm ci                     1.5 GB'
    Out-Line '    expo prebuild + pod install (cold)  3.0 GB'
    Out-Line '    xcodebuild archive DerivedData      6.0 GB'
    Out-Line '    archive + .ipa                      0.5 GB'
    Out-Line ('    total ~11 GB -> quota {0} GB leaves headroom; nothing survives the run' -f $Quota)
    Out-Line ''
    if ($Upload) {
        Out-Line '  Upload command (runs on the Mac only):'
        Out-Line '    xcrun altool --upload-app --type ios --file app.ipa \'
        Out-Line '      --apiKey <DSH_IOS_ASC_KEY_ID from the Mac config> \'
        Out-Line '      --apiIssuer <redacted: never printed, never transferred>'
        Out-Line ''
    }
    Out-Line '  Driver steps after the build:'    Out-Line '   1 retrieve on exit 0 AND exit 5: scp app.ipa + ExportOptions.plist from'
    Out-Line ('     {0}' -f $remoteStage)
    Out-Line '   2 delete that stage dir on the Mac (one ssh call, path checked; best effort)'
    if ($ShutdownAfterBuild) {
        Out-Line '   3 power: one ssh call -> shutdown via sudo -n shutdown -h +2, else sleep'
        Out-Line '            (a failure to power down is a WARNING only)'
    } elseif ($SleepAfterBuild) {
        Out-Line '   3 power: one ssh call -> sleep (-SleepAfterBuild; the next build needs a wake)'
    } else {
        Out-Line '   3 power: left awake by default (an idle Mac, not an occupied one)'
        Out-Line '            pass -SleepAfterBuild to suspend it, -ShutdownAfterBuild to power off'
    }
    Out-Line ''
    Out-Line '  Artifacts (on success, and on an upload failure at exit 5):'
    Out-Line ('    {0}\app.ipa' -f $ArtifactDir)
    Out-Line ('    {0}\ExportOptions.plist' -f $ArtifactDir)
    Out-Line ('    {0}\build.log' -f $ArtifactDir)
    Out-Line ''
    Out-Line '  Exit codes: 0 ok | 2 preflight refusal | 3 lock held | 4 build failure |'
    Out-Line '              5 upload failure | 6 cleanup assertion failed'
    Out-Line ''
    Out-Line '  Dry run made zero ssh calls.'
}

function Get-ConfigLabel {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { return '<built-in defaults>' }
    return $Path
}

function Get-ExeLabel {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { return '<not found on PATH>' }
    return $Path
}

# --------------------------------------------------------------------------- entry

if ($Help) {
    Show-Usage
    exit $ExitOk
}

$ConfigPath = Resolve-ConfigPath $ConfigFile
if ($null -eq $ConfigPath) {
    exit $ExitPreflight
}
$Map = Read-BuildConfig $ConfigPath

$Settings = @{
    Host        = (Get-Setting $Map 'DSH_IOS_HOST' $Defaults.Host)
    User        = (Get-Setting $Map 'DSH_IOS_USER' $Defaults.User)
    Port        = (Get-Setting $Map 'DSH_IOS_SSH_PORT' $Defaults.Port)
    TeamId      = (Get-Setting $Map 'DSH_IOS_TEAM_ID' $Defaults.TeamId)
    Profile     = (Get-Setting $Map 'DSH_IOS_PROFILE' $Defaults.Profile)
    QuotaGb     = (Get-Setting $Map 'DSH_IOS_QUOTA_GB' $Defaults.QuotaGb)
    FloorGb     = (Get-Setting $Map 'DSH_IOS_FLOOR_GB' $Defaults.FloorGb)
    IdleSeconds = (Get-Setting $Map 'DSH_IOS_IDLE_SECONDS' $Defaults.IdleSeconds)
    Stage       = (Get-Setting $Map 'DSH_IOS_STAGE' $Defaults.Stage)
}

# Parameter beats config file.
$EffectiveProfile = $Profile
if ([string]::IsNullOrEmpty($EffectiveProfile)) { $EffectiveProfile = $Settings.Profile }
$EffectiveTeam = $TeamId
if ([string]::IsNullOrEmpty($EffectiveTeam)) { $EffectiveTeam = $Settings.TeamId }
$EffectiveQuota = $QuotaGb
if ([string]::IsNullOrEmpty($EffectiveQuota)) { $EffectiveQuota = $Settings.QuotaGb }
$EffectiveFloor = $FloorGb
if ([string]::IsNullOrEmpty($EffectiveFloor)) { $EffectiveFloor = $Settings.FloorGb }

if ([string]::IsNullOrEmpty($EffectiveProfile)) { $EffectiveProfile = 'production' }
if ([string]::IsNullOrEmpty($EffectiveQuota)) { $EffectiveQuota = '30' }
if ([string]::IsNullOrEmpty($EffectiveFloor)) { $EffectiveFloor = '15' }
$EffectiveIdle = $Settings.IdleSeconds
if ([string]::IsNullOrEmpty($EffectiveIdle)) { $EffectiveIdle = '600' }

# --------------------------------------------------------------------------- validation

$problems = New-Object System.Collections.ArrayList

if ($EffectiveProfile -ne 'preview' -and $EffectiveProfile -ne 'production' -and $EffectiveProfile -ne 'development') {
    [void]$problems.Add(("bad -Profile '{0}' (preview|production|development)" -f $EffectiveProfile))
}
if (-not (Test-UInt $EffectiveQuota 8 200)) {
    [void]$problems.Add(("bad -QuotaGb '{0}' (whole number of GB, 8..200)" -f $EffectiveQuota))
}
if (-not (Test-UInt $EffectiveFloor 5 500)) {
    [void]$problems.Add(("bad -FloorGb '{0}' (whole number of GB, 5..500)" -f $EffectiveFloor))
}
if (-not (Test-UInt $EffectiveIdle 0 86400)) {
    [void]$problems.Add(("bad DSH_IOS_IDLE_SECONDS '{0}' (seconds, 0..86400)" -f $EffectiveIdle))
}
if (-not (Test-UInt $Settings.Port 1 65535)) {
    [void]$problems.Add(("bad DSH_IOS_SSH_PORT '{0}' (1..65535)" -f $Settings.Port))
}
if ($EffectiveTeam.Length -gt 0 -and $EffectiveTeam -notmatch '^[A-Z0-9]{10}$') {
    [void]$problems.Add(("bad -TeamId '{0}' (10 upper-case letters/digits)" -f $EffectiveTeam))
}
# The staging path is used to build one remote `rm -rf` command line, so it stays in a
# character set that needs no shell quoting and cannot escape $HOME.
if ($Settings.Stage -notmatch '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$') {
    [void]$problems.Add(("bad DSH_IOS_STAGE '{0}' (relative path of letters, digits, dot, dash, underscore)" -f $Settings.Stage))
}
if ($NoSign -and $Upload) {
    [void]$problems.Add('-NoSign and -Upload are mutually exclusive (an unsigned .ipa cannot be uploaded)')
}

if ($problems.Count -gt 0) {
    foreach ($p in $problems) { Out-Line ('ERROR params: ' + $p) }
    Out-Line 'Run with -Help for the full option list.'
    exit $ExitPreflight
}

$gitExe = Resolve-Exe @('git.exe', 'git')
if ([string]::IsNullOrEmpty($gitExe)) {
    Out-Line 'ERROR params: git is not on PATH (needed to resolve the repo and build the archive)'
    exit $ExitPreflight
}

$RepoRoot = ''
$gitOut = & $gitExe -C $AppRoot rev-parse --show-toplevel 2>&1
if ($LASTEXITCODE -ne 0) {
    Out-Line ('ERROR params: not a git work tree: {0}' -f ($gitOut -join ' '))
    exit $ExitPreflight
}
$RepoRoot = [string]($gitOut | Select-Object -First 1)
if ([string]::IsNullOrEmpty($RepoRoot)) {
    Out-Line 'ERROR params: git rev-parse returned no repo root'
    exit $ExitPreflight
}

$Commit = ''
$commitOut = & $gitExe -C $RepoRoot rev-parse --short=12 HEAD 2>&1
if ($LASTEXITCODE -eq 0) { $Commit = [string]($commitOut | Select-Object -First 1) }
if ([string]::IsNullOrEmpty($Commit)) { $Commit = 'unknown' }

# Dirty-file count: the log states the package source honestly, so the owner can see that the
# build carries uncommitted work. Scoped to the app, which is what actually gets built.
$DirtyCount = 0
$dirtyOut = & $gitExe -C $RepoRoot status --porcelain -- apps/mobile-companion 2>&1
if ($LASTEXITCODE -eq 0 -and $null -ne $dirtyOut) {
    $DirtyCount = ($dirtyOut | Measure-Object -Line).Lines
}

$SourcePolicy = 'worktree'
if ($FromHead) { $SourcePolicy = 'head' }
if ($FromHead) {
    $SourceLabel = 'HEAD ' + $Commit + ' (-FromHead: committed tree only)'
} else {
    $SourceLabel = 'worktree (HEAD ' + $Commit + ' + ' + $DirtyCount + ' dirty files)'
}

$RunId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$ArtifactDir = Join-Path $AppRoot ('artifacts\ios\' + $RunId)
$LogPath = Join-Path $ArtifactDir 'build.log'

$sshExe = Resolve-Exe @('ssh.exe', 'ssh')
$scpExe = Resolve-Exe @('scp.exe', 'scp')

$hostPart = $Settings.Host
if ([string]::IsNullOrEmpty($hostPart)) { $hostPart = '<mac-host.tailnet.ts.net>' }
$Target = $hostPart
if (-not [string]::IsNullOrEmpty($Settings.User)) { $Target = $Settings.User + '@' + $hostPart }

# Host key checking is "yes" by default: the Mac's key must already be pinned in known_hosts.
# -AcceptHostKey relaxes it to accept-new for the one-time first run only.
$HostKeyPolicy = 'yes'
if ($AcceptHostKey) { $HostKeyPolicy = 'accept-new' }

# --------------------------------------------------------------------------- dry run

if ($DryRun) {
    Show-Plan -ConfigPath $ConfigPath -RepoRoot $RepoRoot -Commit $Commit -RunId $RunId `
        -ArtifactDir $ArtifactDir -Target $Target -SshExe $sshExe -Team $EffectiveTeam `
        -Quota $EffectiveQuota -Floor $EffectiveFloor -Idle $EffectiveIdle `
        -EffectiveProfile $EffectiveProfile -Source $SourceLabel -HostKey $HostKeyPolicy
    exit $ExitOk
}

# --------------------------------------------------------------------------- package only (test hook)

if (-not [string]::IsNullOrEmpty($PackageTo)) {
    $pkgPath = $PackageTo
    if (-not [System.IO.Path]::IsPathRooted($pkgPath)) {
        $pkgPath = Join-Path (Get-Location).Path $pkgPath
    }
    $pkgDir = Split-Path -Parent $pkgPath
    if (-not [string]::IsNullOrEmpty($pkgDir) -and -not (Test-Path -LiteralPath $pkgDir)) {
        [void](New-Item -ItemType Directory -Force -Path $pkgDir)
    }
    # Same producer command the real run uses; only the sink differs (a local file, not ssh).
    $pkgCode = Invoke-CmdExit -CommandLine ((Get-SourcePackageCommand -RepoRoot $RepoRoot) + ' > "' + $pkgPath + '"')
    if ($pkgCode -ne 0 -or -not (Test-Path -LiteralPath $pkgPath)) {
        Out-Line ('ERROR package: the source package command failed (exit {0}): {1}' -f $pkgCode, $SourceLabel)
        exit $ExitPreflight
    }
    Out-Line ('PACKAGED {0}' -f $pkgPath)
    Out-Line ('  source    : {0}' -f $SourceLabel)
    Out-Line ('  bytes     : {0:n0}' -f (Get-Item -LiteralPath $pkgPath).Length)
    exit $ExitOk
}

# --------------------------------------------------------------------------- real run

if ([string]::IsNullOrEmpty($Settings.Host)) {
    Out-Line 'ERROR config: DSH_IOS_HOST is not set (copy ios-build.conf.example and fill it in)'
    exit $ExitPreflight
}
if ([string]::IsNullOrEmpty($sshExe)) {
    Out-Line 'ERROR preflight: ssh client not found on PATH (install the Windows OpenSSH client)'
    exit $ExitPreflight
}

$MacScript = Join-Path $ScriptDir 'mac\ios-build.sh'
if (-not (Test-Path -LiteralPath $MacScript)) {
    Out-Line ('ERROR preflight: the remote orchestrator is missing: {0}' -f $MacScript)
    exit $ExitPreflight
}

$sshOptions = @(
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', ('StrictHostKeyChecking=' + $HostKeyPolicy),
    '-p', $Settings.Port
)

# ssh client + options + target as one cmd.exe fragment: the staging calls, the self-test and
# the artifact fetch all reuse it.
$SshLine = '"' + $sshExe + '" ' + ($sshOptions -join ' ') + ' ' + $Target

if ([string]::IsNullOrEmpty($scpExe)) {
    Out-Line 'ERROR preflight: scp client not found on PATH (install the Windows OpenSSH client)'
    exit $ExitPreflight
}

# scp spells the port -P (lower-case -p means "preserve times"), so it cannot reuse the list.
$scpOptions = @(
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=30',
    '-o', ('StrictHostKeyChecking=' + $HostKeyPolicy),
    '-P', $Settings.Port
)

# --------------------------------------------------------------------------- header

if ($SelfTest) {
    Out-Line ('=== remote iOS self-test {0} ===' -f $RunId)
    Out-Line ('  target    : {0}' -f $Target)
    Out-Line ('  host key  : StrictHostKeyChecking={0}' -f $HostKeyPolicy)
    Out-Line ('  source    : {0}' -f $SourceLabel)
    Out-Line '  self-test : bash -n on the staged script, then the read-only Mac report'
    Out-Line ''
} else {
    Out-Line ('=== remote iOS build {0} ===' -f $RunId)
    Out-Line ('  target    : {0}' -f $Target)
    Out-Line ('  source    : {0}' -f $SourceLabel)
    Out-Line ('  commit    : {0}' -f $Commit)
    Out-Line ('  profile   : {0}' -f $EffectiveProfile)
    Out-Line ('  host key  : StrictHostKeyChecking={0}' -f $HostKeyPolicy)
    Out-Line ('  artifacts : {0}' -f $ArtifactDir)
    Out-Line ''
}

# --------------------------------------------------------------------------- stage (FR-018)

# Staging is also the reachability probe: an unreachable Mac fails here in seconds, before
# any tar is produced and before any artifacts directory exists. The staged file is
# overwritten on every run and is the only file the pipeline leaves on the Mac.
#
# -WaitForHost keeps retrying instead of giving up: the Mac is a remote machine that may be
# asleep or freshly switched on, and a build that starts on its own is worth more than a
# failure that needs a human to re-run the command.
$RemoteHome = Resolve-RemoteHome -SshExe $sshExe -SshOptions $sshOptions -Target $Target
if ([string]::IsNullOrEmpty($RemoteHome) -and $WaitForHost -gt 0) {
    $waitStart = Get-Date
    $deadline = $waitStart.AddSeconds($WaitForHost)
    Out-Line ('  waiting   : Mac not reachable yet; polling every 15 s for up to {0} min' -f [int]($WaitForHost / 60))
    while ([string]::IsNullOrEmpty($RemoteHome) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 15
        $RemoteHome = Resolve-RemoteHome -SshExe $sshExe -SshOptions $sshOptions -Target $Target
        if ([string]::IsNullOrEmpty($RemoteHome)) {
            $waited = [int]((Get-Date) - $waitStart).TotalSeconds
            Out-Line ('  waiting   : still unreachable ({0}s elapsed, {1}s left)' -f $waited, [int]($deadline - (Get-Date)).TotalSeconds)
        }
    }
    if (-not [string]::IsNullOrEmpty($RemoteHome)) {
        Out-Line ('  waiting   : Mac reachable after {0}s' -f [int]((Get-Date) - $waitStart).TotalSeconds)
    }
}
$StagedPath = ''
if (-not [string]::IsNullOrEmpty($RemoteHome)) {
    $StagedPath = Install-MacScript -LocalPath $MacScript -RemoteHome $RemoteHome `
        -SshExe $sshExe -SshOptions $sshOptions -ScpOptions $scpOptions -Target $Target
}
if ([string]::IsNullOrEmpty($StagedPath)) {
    Out-Line ''
    if ($SelfTest) {
        Out-Line 'SELF-TEST FAILED (the orchestrator could not be staged on the Mac); nothing was built and nothing was changed'
    } else {
        Out-Line 'PREFLIGHT REFUSED (the orchestrator could not be staged on the Mac; nothing was built)'
    }
    exit $ExitPreflight
}

# --------------------------------------------------------------------------- self-test

if ($SelfTest) {
    $selfCode = Invoke-MacSelfTest -StagedPath $StagedPath -SshLine $SshLine -ArtifactDir $ArtifactDir -Floor $EffectiveFloor
    Out-Line ''
    if ($selfCode -eq $ExitOk) {
        Out-Line ('SELF-TEST PASS  (report: {0})' -f (Join-Path $ArtifactDir 'selftest.log'))
        exit $ExitOk
    }
    Out-Line ('SELF-TEST FAILED (remote exit {0}); nothing was built and nothing was changed' -f $selfCode)
    exit $ExitPreflight
}

# Self-test gate before every build: parse + toolchain, seconds instead of a 20-minute build.
$selfCode = Invoke-MacSelfTest -StagedPath $StagedPath -SshLine $SshLine -ArtifactDir $ArtifactDir -Floor $EffectiveFloor
if ($selfCode -ne $ExitOk) {
    Out-Line ''
    Out-Line 'PREFLIGHT REFUSED (self-test gate failed; nothing was built)'
    exit $ExitPreflight
}

$remoteArgs = @(
    ('--run-id=' + $RunId),
    ('--commit=' + $Commit),
    ('--source=' + $SourcePolicy),
    ('--dirty-files=' + $DirtyCount),
    ('--profile=' + $EffectiveProfile),
    ('--quota-gb=' + $EffectiveQuota),
    ('--floor-gb=' + $EffectiveFloor),
    ('--idle-seconds=' + $EffectiveIdle)
)
if ($EffectiveTeam.Length -gt 0) { $remoteArgs += ('--team-id=' + $EffectiveTeam) }
if ($FromHead) { $remoteArgs += '--from-head' }
if ($Upload) { $remoteArgs += '--upload' }
if ($NoSign) { $remoteArgs += '--no-sign' }
if ($Force) { $remoteArgs += '--force' }
if ($ShutdownAfterBuild) { $remoteArgs += '--shutdown' }
if ($SleepAfterBuild) { $remoteArgs += '--sleep' }
if ($SwiftVersion.Length -gt 0) { $remoteArgs += ('--swift-version=' + $SwiftVersion) }
if ($ExpoJsiSwiftExec.Length -gt 0) { $remoteArgs += ('--expo-jsi-swift-exec=' + $ExpoJsiSwiftExec) }
if ($JsiOverride.Length -gt 0) { $remoteArgs += ('--jsi-override=' + $JsiOverride) }
if ($CoreOverride.Length -gt 0) { $remoteArgs += ('--core-override=' + $CoreOverride) }
if ($JsiSendablePatch) { $remoteArgs += '--jsi-sendable-patch' }
if ($KeepPodsCache) { $remoteArgs += '--keep-pods-cache' }

# The remote program is the STAGED FILE, never `bash -s`: bash reads it from disk, so fd 0
# stays the tar payload (FR-018). cmd.exe runs the pipe so the tar bytes go from tar to ssh
# untouched: PowerShell would decode the stream as text and corrupt it. The command line must
# NOT start with a quote, or cmd strips the outer quotes (cmd /c quote rule 2).
$cmdLine = (Get-SourcePackageCommand -RepoRoot $RepoRoot) + ' | ' + $SshLine + ' /bin/bash ' +
    $StagedPath + ' ' + ($remoteArgs -join ' ') + ' 2>&1'

Out-Line '  steps     : stage -> self-test -> preflight -> volume -> source (fd 3) -> npm ci -> prebuild -> pods -> archive -> export -> stage artifact -> upload'
Out-Line '  log       : streaming to build.log'
Out-Line ''

$startedAt = Get-Date
$remoteExit = Invoke-RemoteStream -CommandLine $cmdLine -LogPath $LogPath
$elapsed = (Get-Date) - $startedAt
Out-Line ''

# The remote script ends with a single RESULT {json} line. Exit codes stay authoritative.
$resultJson = ''
if (Test-Path -LiteralPath $LogPath) {
    foreach ($l in (Get-Content -LiteralPath $LogPath -ErrorAction SilentlyContinue)) {
        if ($l -match '^RESULT (\{.*\})\s*$') { $resultJson = $Matches[1] }
    }
}
$result = $null
if ($resultJson.Length -gt 0) {
    try {
        $result = $resultJson | ConvertFrom-Json
    } catch {
        Out-Line 'WARN: remote RESULT line is not valid JSON; falling back to the exit code'
        $result = $null
    }
} else {
    Out-Line 'WARN: remote RESULT line missing from the log; using the ssh exit code only'
}

$exitCode = $remoteExit
if ($remoteExit -eq 255) {
    Out-Line 'ERROR: ssh transport failed (exit 255); the build did not run or lost the tunnel'
    $exitCode = $ExitPreflight
}

if ($null -ne $result -and $result.PSObject.Properties.Name -contains 'exit') {
    if ($remoteExit -eq 0 -and [int]$result.exit -ne 0) {
        # The RESULT line disagrees with ssh: trust the reported build status.
        $exitCode = [int]$result.exit
    }
}

$ipaRemote = ''
$plistRemote = ''
$stageDirRemote = ''
if ($null -ne $result) {
    $ipaRemote = [string]$result.ipa
    $plistRemote = [string]$result.exportOptions
    $stageDirRemote = [string]$result.stageDir
}

# FR-016: retrieve on success AND on an upload failure (exit 5) - staging happens before the
# upload, so the .ipa exists outside the volume even when altool rejected the build. Any
# other exit code leaves nothing to fetch. Power-down runs only after this block.
$retrieve = ($exitCode -eq 0 -or $exitCode -eq $ExitUpload)
$retrieved = $false
if ($retrieve) {
    if ([string]::IsNullOrEmpty($ipaRemote)) {
        # Best effort: the staging path is fixed and the remote $HOME was resolved for staging.
        if ([string]::IsNullOrEmpty($RemoteHome)) {
            Out-Line 'ERROR: the artifact exists but the remote artifact path is unknown (no RESULT, no HOME)'
            if ($exitCode -eq 0) { $exitCode = $ExitBuild }
        } else {
            $stageDirRemote = $RemoteHome + '/' + $Settings.Stage + '/artifacts/' + $RunId
            $ipaRemote = $stageDirRemote + '/app.ipa'
            $plistRemote = $stageDirRemote + '/ExportOptions.plist'
        }
    }

    if (-not [string]::IsNullOrEmpty($ipaRemote)) {
        $localIpa = Join-Path $ArtifactDir 'app.ipa'
        $partialIpa = $localIpa + '.partial'
        & $scpExe @scpOptions ($Target + ':' + $ipaRemote) $partialIpa 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-NonEmptyZip $partialIpa)) {
            # Never leave a truncated .ipa behind, and never delete the staged copy: a manual
            # re-fetch is still possible until the 3-day prune.
            if (Test-Path -LiteralPath $partialIpa) { Remove-Item -LiteralPath $partialIpa -Force }
            Out-Line ('ERROR: artifact transfer failed or the .ipa is not a zip payload: {0}' -f $ipaRemote)
            if ($exitCode -eq 0) {
                $exitCode = $ExitBuild
            } else {
                Out-Line 'WARN: the staged .ipa could not be retrieved; the upload failure stands (exit 5)'
            }
        } else {
            Move-Item -LiteralPath $partialIpa -Destination $localIpa -Force
            $retrieved = $true
            Out-Line ('  ipa       : {0} ({1:n0} bytes)' -f $localIpa, (Get-Item -LiteralPath $localIpa).Length)

            if (-not [string]::IsNullOrEmpty($plistRemote)) {
                $localPlist = Join-Path $ArtifactDir 'ExportOptions.plist'
                & $scpExe @scpOptions ($Target + ':' + $plistRemote) $localPlist 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    Out-Line ('  plist     : {0}' -f $localPlist)
                } else {
                    Out-Line '  plist     : not retrieved (optional; it holds no secrets)'
                }
            }

            # The artifact is on Windows now, so this run's staging directory is dead weight:
            # each run leaves ~300 MB on the Mac and three of them would eat the +-1 GB drift
            # budget. One ssh call deletes it. Best effort only - a failure is a WARNING, never
            # a non-zero exit, and the 3-day prune in ios-build.sh stays the safety net. The
            # order is load-bearing: the directory must outlive the transfer above.
            if ($stageDirRemote -match '^/.+/artifacts/[A-Za-z0-9._-]+$') {
                $rmOut = & $sshExe @sshOptions $Target ('rm -rf -- ' + $stageDirRemote) 2>&1
                if ($LASTEXITCODE -eq 0) {
                    Out-Line ('  staging   : removed on the Mac: {0}' -f $stageDirRemote)
                } else {
                    Out-Line ('WARN cleanup: could not remove {0} on the Mac; the 3-day prune will collect it' -f $stageDirRemote)
                    Out-Line ('      ' + ($rmOut -join ' '))
                }
            } elseif (-not [string]::IsNullOrEmpty($stageDirRemote)) {
                Out-Line ('WARN cleanup: refusing to delete an unexpected remote path: {0}' -f $stageDirRemote)
            } else {
                Out-Line 'WARN cleanup: the staged artifact path is unknown; the 3-day prune will collect it'
            }
        }
    }
}

# FR-016: power-down is DRIVER-OWNED and last. The Mac stays awake for the whole build, the
# scp and the stage cleanup above; only now is it safe to sleep. One ssh call; a failure is a
# WARNING and never changes the build's exit code. An abandoned run (dropped tunnel) leaves
# the Mac awake unless -ShutdownAfterBuild (or an external watchdog) is in play.
Invoke-PowerDown -SshExe $sshExe -SshOptions $sshOptions -Target $Target -Shutdown ([bool]$ShutdownAfterBuild) -Sleep ([bool]$SleepAfterBuild)

Out-Line ''
Out-Line '=== summary ==='
Out-Line ('  exit code : {0}' -f $exitCode)
Out-Line ('  duration  : {0:hh\:mm\:ss}' -f $elapsed)
Out-Line ('  commit    : {0}' -f $Commit)
Out-Line ('  source    : {0}' -f $SourceLabel)
Out-Line ('  profile   : {0}' -f $EffectiveProfile)
if ($null -ne $result) {
    Out-Line ('  status    : {0}' -f [string]$result.status)
    if ($result.PSObject.Properties.Name -contains 'source') {
        Out-Line ('  packaged  : {0} ({1} dirty files)' -f [string]$result.source, $result.dirtyFiles)
    }
    Out-Line ('  disk      : {0} GB -> {1} GB free on the Mac (baseline -> final)' -f $result.baselineFreeGb, $result.finalFreeGb)
    Out-Line ('  volume    : deleted={0} lockReclaimed={1}' -f $result.volumeDeleted, $result.lockReclaimed)
    Out-Line ('  signing   : {0} uploaded={1}' -f $result.signing, $result.uploaded)
    if ($result.PSObject.Properties.Name -contains 'power') {
        Out-Line ('  power     : {0} requested (driver-owned, after retrieval)' -f [string]$result.power)
    }
} else {
    Out-Line '  status    : unknown (no RESULT line)'
    Out-Line '  disk      : unknown (no RESULT line)'
}
Out-Line ('  log       : {0}' -f $LogPath)
Out-Line ('  artifacts : {0}' -f $ArtifactDir)
Out-Line ''
if ($exitCode -eq 0) {
    Out-Line 'BUILD OK'
} elseif ($exitCode -eq $ExitUpload) {
    Out-Line 'UPLOAD FAILED (the .ipa is kept locally)'
} elseif ($exitCode -eq $ExitCleanup) {
    Out-Line 'CLEANUP ASSERTION FAILED (check the Mac disk and /Volumes/DSHIosBuild)'
} elseif ($exitCode -eq $ExitLock) {
    Out-Line 'LOCKED (another build is running on the Mac)'
} elseif ($exitCode -eq $ExitPreflight) {
    Out-Line 'PREFLIGHT REFUSED (nothing was built)'
} else {
    Out-Line 'BUILD FAILED (see the log)'
}

exit $exitCode
