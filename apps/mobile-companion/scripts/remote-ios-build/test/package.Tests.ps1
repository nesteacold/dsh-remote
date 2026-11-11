#Requires -Version 5.1
<#
.SYNOPSIS
    Regression test for FR-007: the remote build packages the CURRENT WORKING TREE.

.DESCRIPTION
    No Pester dependency and no network: this file runs as-is on Windows PowerShell 5.1.

        powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\package.Tests.ps1

    The package is built by the driver itself (-PackageTo), so this exercises the same
    command line a real run streams to the Mac, and then reads the tar back:

      (a) a file that `git status` lists as modified is in the package BYTE-FOR-BYTE as it
          sits on disk - and its content differs from the HEAD blob, so a `git archive HEAD`
          package could not pass this check;
      (b) the package carries no .git/, .dsh-wiki/, node_modules/, dist/, artifacts/ entry
          and no *.log at the app root (`.dsh-wiki/` IS tracked, so .gitignore alone would
          not exclude it);
      (c) a deliberately created untracked, not-ignored file is in the package, and is gone
          from the working tree afterwards;
      (d) -FromHead packages HEAD instead: that untracked file is absent and the modified
          file matches the HEAD blob, not the disk file.

    Exit: 0 all checks pass (skips allowed) | 1 at least one check failed.
#>
[CmdletBinding()]
param()

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

$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $PsExe)) { $PsExe = 'powershell.exe' }
$TarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
$GitExe = 'git.exe'

$TempRoot = Join-Path $env:TEMP ('dsh-ios-package-tests-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Force -Path $TempRoot)

$RepoRoot = ''
$gitOut = & $GitExe -C $AppRoot rev-parse --show-toplevel 2>&1
if ($LASTEXITCODE -eq 0) { $RepoRoot = [string]($gitOut | Select-Object -First 1) }

function Remove-TempRoot {
    if (Test-Path -LiteralPath $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Driver {
    param([string[]]$ArgList)
    $out = & $PsExe -NoProfile -ExecutionPolicy Bypass -File $Driver @ArgList 2>&1
    return @{
        ExitCode = $LASTEXITCODE
        Output   = ($out | Out-String)
    }
}

function Get-TarEntries {
    param([string]$TarPath)
    $lines = & cmd.exe /d /c ('"' + $TarExe + '" -tf "' + $TarPath + '"') 2>&1
    if ($LASTEXITCODE -ne 0) { return @() }
    return @($lines | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_.Length -gt 0 })
}

function Expand-TarTo {
    param([string]$TarPath, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Destination)) {
        [void](New-Item -ItemType Directory -Force -Path $Destination)
    }
    & cmd.exe /d /c ('"' + $TarExe + '" -xf "' + $TarPath + '" -C "' + $Destination + '"') 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Get-Sha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Get-HeadBlobSha256 {
    param([string]$RelativePath)
    $out = Join-Path $TempRoot ('head-' + [guid]::NewGuid().ToString('N') + '.bin')
    & cmd.exe /d /c ('"' + $GitExe + '" -C "' + $RepoRoot + '" cat-file -p "HEAD:' + $RelativePath + '" > "' + $out + '"') 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { return '' }
    return (Get-Sha256 $out)
}

function Convert-ToNative {
    param([string]$RelativePath)
    return (Join-Path $RepoRoot ($RelativePath -replace '/', '\'))
}

$HardExcludePattern = '(^|/)(node_modules|dist|artifacts|\.dsh-wiki|\.git)/'
$AppRootLogPattern = '^apps/mobile-companion/[^/]+\.log$'

# The test file must not survive a failed run, so it is created and removed inside try.
$UntrackedRel = 'apps/mobile-companion/dsh-package-test-' + [guid]::NewGuid().ToString('N') + '.txt'
$UntrackedAbs = Convert-ToNative $UntrackedRel

try {
    if ([string]::IsNullOrEmpty($RepoRoot)) {
        No 'git repo root is resolvable from the driver' 'git rev-parse --show-toplevel failed'
        exit 1
    }
    if (-not (Test-Path -LiteralPath $TarExe)) {
        No 'bsdtar is available to read the package back' ('missing: ' + $TarExe)
        exit 1
    }
    Ok ('repo root: ' + $RepoRoot)

    # ------------------------------------------------------------------ (a) a dirty file
    Write-Host '--- (a) uncommitted edits are packaged byte-for-byte ---'
    $dirtyRel = ''
    $statusOut = & $GitExe -C $RepoRoot status --porcelain -- apps/mobile-companion 2>&1
    if ($LASTEXITCODE -eq 0) {
        foreach ($line in @($statusOut)) {
            if ($line -match '^.[MD]\s+(.+)$') {
                $candidate = $Matches[1].Trim()
                if (Test-Path -LiteralPath (Convert-ToNative $candidate)) {
                    $dirtyRel = $candidate
                    break
                }
            }
        }
    }
    if ([string]::IsNullOrEmpty($dirtyRel)) {
        Skip 'a modified working-tree file is packaged byte-for-byte' 'no modified file under apps/mobile-companion'
    } else {
        Ok ('dirty file chosen: ' + $dirtyRel)
        $dirtyAbs = Convert-ToNative $dirtyRel
        $diskHash = Get-Sha256 $dirtyAbs
        $headHash = Get-HeadBlobSha256 $dirtyRel
        Assert-True ($headHash.Length -gt 0) 'HEAD has a blob for the chosen file' 'git cat-file HEAD:<path> failed'
        Assert-True ($headHash -ne $diskHash) 'the chosen file really differs from HEAD (uncommitted edit)' ('HEAD=' + $headHash + ' disk=' + $diskHash)
    }

    $pkgPath = Join-Path $TempRoot 'worktree.tar'
    $pkg = Invoke-Driver @('-PackageTo', $pkgPath)
    Assert-True ($pkg.ExitCode -eq 0) '-PackageTo exits 0' ('exit ' + $pkg.ExitCode + ' output: ' + $pkg.Output)
    Assert-True (Test-Path -LiteralPath $pkgPath) 'the package file exists'
    if (-not (Test-Path -LiteralPath $pkgPath)) { exit 1 }
    Assert-True ((Get-Item -LiteralPath $pkgPath).Length -gt 1048576) 'the package is a full tree, not a stub' ((Get-Item -LiteralPath $pkgPath).Length.ToString() + ' bytes')
    Assert-True ($pkg.Output.Contains('source    : worktree (HEAD')) '-PackageTo reports the worktree source line' $pkg.Output

    $entries = Get-TarEntries $pkgPath
    Assert-True ($entries.Count -gt 200) 'the package lists the repository files' ('entries: ' + $entries.Count)
    Assert-True ([bool]($entries -contains 'apps/mobile-companion/package.json')) 'the app layout is preserved (package.json at its real path)'

    $extractDir = Join-Path $TempRoot 'worktree'
    Assert-True (Expand-TarTo $pkgPath $extractDir) 'the package extracts'

    if (-not [string]::IsNullOrEmpty($dirtyRel)) {
        $extractedAbs = Join-Path $extractDir ($dirtyRel -replace '/', '\')
        Assert-True (Test-Path -LiteralPath $extractedAbs) ('the package contains the dirty file: ' + $dirtyRel)
        $packagedHash = Get-Sha256 $extractedAbs
        Assert-True ($packagedHash -eq $diskHash) 'the packaged bytes equal the working-tree bytes' ('package=' + $packagedHash + ' disk=' + $diskHash)
        Assert-True ($packagedHash -ne $headHash) 'the packaged bytes are NOT the HEAD blob (a git archive HEAD package would fail here)' ('package=' + $packagedHash + ' HEAD=' + $headHash)
    }

    # --------------------------------------------------- (b) hard excludes are respected
    Write-Host '--- (b) node_modules/, dist/, artifacts/, .dsh-wiki/, .git/ and app-root *.log are excluded ---'
    $badEntries = @($entries | Where-Object { $_ -match $HardExcludePattern })
    Assert-True ($badEntries.Count -eq 0) 'no hard-excluded directory entry in the package' (($badEntries | Select-Object -First 5) -join '; ')
    $logEntries = @($entries | Where-Object { $_ -match $AppRootLogPattern })
    Assert-True ($logEntries.Count -eq 0) 'no *.log at the app root in the package' ($logEntries -join '; ')
    Assert-True (-not [bool]($entries -contains '.dsh-wiki')) '.dsh-wiki/ is not packaged even though it is committed'

    # ------------------------------------------------- (c) untracked-but-not-ignored file
    Write-Host '--- (c) an untracked, not-ignored file is packaged ---'
    $untrackedText = 'dsh package test ' + [guid]::NewGuid().ToString('N') + "`r`nsecond line: cafe" +
        [char]0x00E9 + ' - not ignored' + "`r`n"
    [System.IO.File]::WriteAllText($UntrackedAbs, $untrackedText, (New-Object System.Text.UTF8Encoding($false)))
    & $GitExe -C $RepoRoot check-ignore -q -- $UntrackedRel 2>&1 | Out-Null
    Assert-True ($LASTEXITCODE -ne 0) 'the test file is untracked AND not git-ignored' 'git check-ignore reports it as ignored'

    $pkg2Path = Join-Path $TempRoot 'worktree-with-untracked.tar'
    $pkg2 = Invoke-Driver @('-PackageTo', $pkg2Path)
    Assert-True ($pkg2.ExitCode -eq 0) 'a second -PackageTo run exits 0' ('exit ' + $pkg2.ExitCode)
    $entries2 = Get-TarEntries $pkg2Path
    Assert-True ([bool]($entries2 -contains $UntrackedRel)) 'the untracked file is in the package' ('missing entry: ' + $UntrackedRel)
    $extractDir2 = Join-Path $TempRoot 'worktree2'
    [void](Expand-TarTo $pkg2Path $extractDir2)
    $untrackedExtracted = Join-Path $extractDir2 ($UntrackedRel -replace '/', '\')
    Assert-True ((Get-Sha256 $untrackedExtracted) -eq (Get-Sha256 $UntrackedAbs)) 'the untracked file is packaged byte-for-byte'

    # ------------------------------------------- (d) -FromHead still packages HEAD
    Write-Host '--- (d) -FromHead packages HEAD, not the working tree ---'
    $headPkgPath = Join-Path $TempRoot 'head.tar'
    $headPkg = Invoke-Driver @('-PackageTo', $headPkgPath, '-FromHead')
    Assert-True ($headPkg.ExitCode -eq 0) '-PackageTo -FromHead exits 0' ('exit ' + $headPkg.ExitCode + ' output: ' + $headPkg.Output)
    Assert-True ($headPkg.Output.Contains('source    : HEAD ')) '-FromHead reports the HEAD source line' $headPkg.Output
    $headEntries = Get-TarEntries $headPkgPath
    Assert-True (-not [bool]($headEntries -contains $UntrackedRel)) 'the untracked file is absent from the HEAD package'
    $headExtractDir = Join-Path $TempRoot 'head'
    [void](Expand-TarTo $headPkgPath $headExtractDir)
    if (-not [string]::IsNullOrEmpty($dirtyRel)) {
        $headExtractedAbs = Join-Path $headExtractDir ($dirtyRel -replace '/', '\')
        Assert-True ((Get-Sha256 $headExtractedAbs) -eq $headHash) 'the HEAD package carries the HEAD blob, not the dirty file' ('head package=' + (Get-Sha256 $headExtractedAbs) + ' HEAD=' + $headHash)
        Assert-True ((Get-Sha256 $headExtractedAbs) -ne $diskHash) 'the HEAD package differs from the working tree' ''
    }
} finally {
    # Never leave test junk in the working tree, even after an assertion failure above.
    if (Test-Path -LiteralPath $UntrackedAbs) { Remove-Item -LiteralPath $UntrackedAbs -Force -ErrorAction SilentlyContinue }
    Remove-TempRoot
}

Write-Host ''
if (Test-Path -LiteralPath $UntrackedAbs) {
    No 'the test file was removed from the working tree' ('left behind: ' + $UntrackedAbs)
} else {
    Ok 'the test file was removed from the working tree'
}
Write-Host ('=== ' + $script:Passed + ' passed, ' + $script:Failed + ' failed, ' + $script:Skipped + ' skipped ===')
if ($script:Failed -gt 0) { exit 1 }
exit 0
