# Remote iOS build — DSH Companion (spec 009)

Practical runbook for building `apps/mobile-companion` on the owner's Mac over Tailscale from
the Windows machine, with the Mac left exactly as it was found.

**Purpose**: make the iOS work (A041 build, TestFlight distribution) startable without a local
macOS, without EAS quota, without an Expo login, without a store upload, and without any
credential in this repo.

**Scope** — the scripts under [`../scripts/remote-ios-build/`](../scripts/remote-ios-build/):
`Invoke-RemoteIosBuild.ps1` (Windows driver, PowerShell 5.1), `mac/ios-build.sh` (remote
orchestrator), `mac/bootstrap-mac.sh` (one-time checks), `ios-build.conf.example` (config
template), `test/dryrun.Tests.ps1` (contract test), `test/package.Tests.ps1` (FR-007 source
package regression test).

**Non-goals (explicitly out of bounds here)**

| Not done here | Why / where it belongs |
|---|---|
| `eas build` / `eas submit` / Expo login | consumes quota, needs a credential; D1 |
| GitHub Actions / any CI runner | no git remote exists; needs owner approval |
| iOS Simulator builds and Maestro E2E on the Mac | needs an 8–12 GB runtime; see `device-validation.md` §3 |
| App Store (production) submission, TestFlight beta review | owner + reviewer gate (A043) |
| Android builds | separate toolchain (A040) |
| Signing keys, certificates, provisioning profiles, ASC keys | hard boundary: never read, print or commit |

---

## 1. What runs where

```
Windows (PowerShell 5.1)                         Mac (macOS, Apple Silicon)
────────────────────────                         ──────────────────────────
Invoke-RemoteIosBuild.ps1                        ~/.dsh-ios-build/ios-build.sh (staged file,
  ssh ────────────── Tailscale ───────────────▶    sha256-verified, run as `bash <file>`)
  scp mac/ios-build.sh ───────────────────────▶  self-test (bash -n "$0" + toolchain report)
  worktree package ──────── tar on stdin ──────▶  preflight → APFS volume → build → export
                                                   → stage .ipa outside the volume → upload
  ◀──────────── RESULT {json} + log stream ─────  cleanup: delete volume, assert disk baseline
  scp ◀────────── app.ipa + ExportOptions.plist   (cleanup never sleeps the Mac)
  ssh: delete this run's stage dir, then power down
```

- Source crosses **once**, as a tar of the **current working tree** — tracked files plus
  untracked files that `.gitignore` does not exclude, uncommitted edits included. That is the
  code being tested; `git archive HEAD` would ship stale code (this repo normally carries
  dozens of uncommitted files). Hard excludes on top of `.gitignore`: `node_modules/`,
  `dist/`, `artifacts/`, `.dsh-wiki/` (committed, 3.2 MB), `.git/` and `*.log` at the app
  root. `-FromHead` packages HEAD instead, for reproducing a committed build.
- The orchestrator is **staged on the Mac first** (`~/.dsh-ios-build/ios-build.sh`, mode 700,
  sha256 compared on both sides) and executed from that file — never piped as `bash -s`. The
  tar keeps stdin to itself: the script reserves fd 3 for the payload and points its own
  stdin at `/dev/null` before doing anything else (FR-018 / plan D9).
- Nothing is installed on the Mac: no daemon, no launchd agent, no EAS project (`ps`,
  `launchctl list`, `mount` are clean after a run — SC-006).

## 2. Prerequisites

### 2.1 Windows machine (what exists today)

| Item | Requirement |
|---|---|
| Shell | Windows PowerShell **5.1** (`powershell.exe`); `pwsh` is **not** installed |
| Execution policy | `Restricted` — always call with `-NoProfile -ExecutionPolicy Bypass -File` |
| SSH client | `C:\Windows\System32\OpenSSH\ssh.exe` and `scp.exe` (present) |
| git | on `PATH`; the driver builds the package from `git ls-files -z -co --exclude-standard` (`-FromHead` uses `git archive`) |
| Tailscale | installed and signed in to the same tailnet as the Mac |
| Key | an SSH key that the Mac accepts (`~/.ssh/id_*`, no passphrase **or** loaded in `ssh-agent`) |

`BatchMode=yes` means ssh can never prompt: an unloaded key fails immediately instead of hanging.
Start `ssh-agent` once per session (`Start-Service ssh-agent` after `Set-Service ssh-agent -StartupType Automatic`)
or use a key without a passphrase.

### 2.2 Mac

| Item | Requirement | Checked by |
|---|---|---|
| macOS | Apple Silicon, macOS with Xcode installed | `bootstrap-mac.sh` |
| Xcode | full app (not Command Line Tools), license accepted | `xcode-select -p`, `xcodebuild -version` |
| CocoaPods | `pod --version` | `bootstrap-mac.sh` |
| Node | >= 24 (`engines.node` of the app) | `bootstrap-mac.sh` |
| Remote Login | sshd on, key-only | `systemsetup -getremotelogin` |
| Tailscale | on the tailnet, reachable from the Windows node on 22 | `tailscale status` |
| Free disk | **> 50 GB** on `/` (floor 15 GB at build time, hard cap 30 GB per build) | `df -g /` |
| ASC key | App Store Connect API key in `~/.appstoreconnect/private_keys/` on the Mac | owner only |

## 3. One-time setup

### 3.1 Tailscale ACL

Only the owner's Windows node may reach the Mac on 22. In the Tailscale admin console
(Access controls):

```json
{
  "acls": [
    { "action": "accept", "src": ["tag:owner-windows"], "dst": ["tag:build-mac:22"] }
  ],
  "tagOwners": {
    "tag:owner-windows": ["autogroup:owner"],
    "tag:build-mac": ["autogroup:owner"]
  }
}
```

- Tag both machines (`tailscale tag --advertise-tags=...`) so the rule matches by tag, not by
  a name that can drift.
- Do **not** put the Mac's sshd behind Tailscale SSH: this pipeline uses the Mac's own sshd
  with your key, and `--upload` needs the keychain the way sshd sees it.

### 3.2 sshd hardening (on the Mac, in person, with sudo)

The bootstrap script **prints** this block; it never runs it. `ListenAddress` is the Mac's
Tailscale address (`tailscale ip -4`), so sshd is not reachable on LAN/Wi-Fi at all.

```bash
sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak-$(date +%Y%m%d)
sudo sh -c 'cat >> /etc/ssh/sshd_config <<HARDEN
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
ListenAddress <100.x.y.z>
HARDEN'
sudo sshd -t                                   # validate before restarting
sudo launchctl kickstart -k system/com.openssh.sshd
```

Then verify from Windows (one line, must print `1` with no prompt):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "ssh -o BatchMode=yes -o ConnectTimeout=10 <user>@<mac> 'true'; \$LASTEXITCODE"
```

First connection: the driver uses `StrictHostKeyChecking=yes` by default, so an unknown Mac
is **refused**, not trusted. On the first run only:

1. On the Mac, `bash bootstrap-mac.sh` prints the sshd host key fingerprints
   (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, plus the RSA fallback).
2. Compare that SHA256 line with what Windows sees
   (`ssh-keygen -F <mac-host> -l`, or `ssh-keyscan <mac-host> | ssh-keygen -lf -`).
3. If they match, run the driver once with `-AcceptHostKey` (`accept-new`). After that the key
   is pinned in `known_hosts` and a changed key is refused again.

`-AcceptHostKey` is **one-shot**: it accepts whatever key answers, so use it only after the
out-of-band comparison, and never leave it in a script or a shell alias. Tailscale lowers but
does not remove the risk — it authenticates the tunnel, not this key, so a node whose tailnet
key was stolen, or a re-imaged Mac, still needs the fingerprint check.

### 3.3 Bootstrap the Mac once

```bash
# on the Mac (copy mac/bootstrap-mac.sh over, or paste it in)
bash bootstrap-mac.sh                 # read-only: reports ok/warn/fail, exits 2 if blocked
bash bootstrap-mac.sh --apply-guards  # also writes ~/.dsh-ios-build.conf (mode 600)
```

`--apply-guards` writes only non-secret defaults (host name, user, team-id placeholder,
quota/floor/idle). Fill in by hand on the Mac:

| Key in `~/.dsh-ios-build.conf` | What to put there |
|---|---|
| `DSH_IOS_TEAM_ID` | Apple Developer team id (10 chars) |
| `DSH_IOS_ASC_KEY_ID` | App Store Connect key **id** (identifier, not a secret) |
| `DSH_IOS_ASC_KEY_PATH` | absolute path of the key file inside the ASC key directory |
| `DSH_IOS_ASC_ISSUER_ID` | the issuer value — **Mac only**, never copied anywhere else |

The file is mode 600 and lives outside the repo. `bootstrap-mac.sh` is idempotent: run it as
often as you like; an existing config is never overwritten. It also prints the sshd host key
fingerprints — keep that output next to the Windows machine for the first `-AcceptHostKey`
run (§3.2).

### 3.4 Configure the Windows side

```powershell
cd apps\mobile-companion\scripts\remote-ios-build
Copy-Item ios-build.conf.example .env.ios-build   # already git-ignored
notepad .env.ios-build                            # host, user, team id
```

Config precedence, highest first:

1. `-ConfigFile <path>`
2. `$env:DSH_IOS_BUILD_CONF`
3. `scripts/remote-ios-build/.env.ios-build` (git-ignored)
4. `scripts/remote-ios-build/ios-build.conf` (also read; keep it uncommitted)
5. built-in defaults (quota 30 GB, floor 15 GB, idle 600 s, profile `production`)

This file holds **no secret**: host, user, port, team id, disk policy, profile.

## 4. Running a build

### 4.1 Dry run first (P0, works today, no Mac needed)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps\mobile-companion\scripts\remote-ios-build\Invoke-RemoteIosBuild.ps1 -DryRun
```

Prints the ssh target, the source package (worktree or HEAD, HEAD sha, dirty-file count),
commit, quota, floor, volume path, host key policy, every remote step, the disk budget,
the artifact paths and the upload command (key **id** only). Makes **zero** ssh calls and
changes nothing. Exit 0.

### 4.2 Self-test first (the P0/P1 gate, needs the Mac but no build)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps\mobile-companion\scripts\remote-ios-build\Invoke-RemoteIosBuild.ps1 -SelfTest
```

One staging step, then one short ssh call — no tar, no volume, no build:

1. `mac/ios-build.sh` is scp'd to `~/.dsh-ios-build/ios-build.sh` on the Mac, `chmod 700`'d,
   and its sha256 is compared with the local file (a mismatch aborts with exit 2);
2. `ios-build.sh --self-test` runs **from that file**, so it begins with `bash -n "$0"` — a
   real parse of the exact bytes that will build (a typo would otherwise surface 20 minutes
   into a build). It then reports `uname -s -m`, the macOS version, `xcode-select -p`,
   `xcodebuild -version`, the Xcode license/first-launch state, `pod --version`, `xcrun altool`
   availability, free GB against the floor, idle seconds, lock state and a stale
   `/Volumes/DSHIosBuild`.

The report streams to the console and to `artifacts/ios/<run>/selftest.log`. Exit 0 when the
essentials pass, exit 2 otherwise. Every real run repeats staging and this gate before the
build and aborts before transferring any source if it fails.

### 4.3 Real runs

```powershell
$d = 'apps\mobile-companion\scripts\remote-ios-build\Invoke-RemoteIosBuild.ps1'

# P1: toolchain smoke test, unsigned, proves prebuild+pods+xcodebuild and the disk lifecycle
#     -JsiSendablePatch is REQUIRED on this Mac (Xcode 26.0.1 / Swift 6.2): without it the archive
#     fails in "Build ExpoModulesJSI xcframework" — see specs/009-remote-ios-build/blocker-toolchain.md
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $d -NoSign -Profile development -Force -JsiSendablePatch

# P2: signed .ipa with automatic signing (ASC key on the Mac)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $d -Profile preview

# P3: TestFlight — owner-approved run only (repo rule A043)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $d -Profile production -Upload

# machine busy? -Force skips the idle check. Build then shut the Mac down:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $d -Force -ShutdownAfterBuild

# reproduce a committed build instead of packaging the working tree:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $d -FromHead

# first run against a new Mac: compare the fingerprint bootstrap-mac.sh printed, then
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $d -AcceptHostKey

# help (exit 0, documents the exit codes)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $d -Help
```

| Flag | Effect |
|---|---|
| `-DryRun` | print the plan (incl. source line and dirty count), no ssh, exit 0 |
| `-SelfTest` | stage the orchestrator, then run only the Mac self-test (`bash -n "$0"` + report); no package, no volume, no build |
| `-FromHead` | package `git archive HEAD` instead of the working tree (committed build) |
| `-AcceptHostKey` | one-shot `StrictHostKeyChecking=accept-new`; default is `yes` (pinned key) |
| `-Upload` | `xcrun altool --upload-app` on the Mac; exit 5 on failure and the `.ipa` is still retrieved |
| `-Force` | ignore the ≤ 600 s idle requirement (policy line still logged) |
| `-NoSign` | `CODE_SIGNING_ALLOWED=NO`, unsigned `.ipa`, no export, no upload |
| `-SleepAfterBuild` | driver-owned, after retrieval: `pmset sleepnow`. **The next build then needs someone to wake the Mac** |
| `-ShutdownAfterBuild` | driver-owned, after retrieval: `sudo shutdown -h +2` when NOPASSWD works, else warn + sleep |
| `-KeepPodsCache` | keep a CocoaPods cache under `~/.dsh-ios-build/cocoapods`; the disk assertion then accounts for its size |
| `-Profile` | `preview` / `production` / `development` — selects the export method only |
| `-TeamId`, `-QuotaGb`, `-FloorGb` | override the config file |
| `-ConfigFile` | explicit config path |

### 4.4 What the run does on the Mac

1. **stage** — `mac/ios-build.sh` goes to `~/.dsh-ios-build/ios-build.sh` (scp, `chmod 700`,
   sha256 compared with the local file; a mismatch aborts with exit 2). The remote program is
   that file — never `bash -s`, which would parse the tar payload as shell text.
2. **self-test** — the staged file parses itself (`bash -n "$0"`), then the read-only
   prerequisite report; failure terminates the run with exit 2 before any source is transferred.
3. **preflight** — `uname`, `xcode-select -p`, `xcodebuild -version`, free-space floor, idle
   check, APFS container lookup (`diskutil info -plist /`), signing preconditions.
4. **lock** — atomic `mkdir ~/.dsh-ios-build/lock`; a stale lock (> 90 min, holder pid gone) is
   reclaimed with a warning line.
5. **baseline** — `df -g /` recorded before any write.
6. **volume** — `diskutil apfs addVolume <container> APFS DSHIosBuild -quota 30g`, mounted at
   `/Volumes/DSHIosBuild`.
7. **source** — `tar -x` from the reserved payload fd 3 (never stdin) into
   `/Volumes/DSHIosBuild/src`: the worktree package by default, `git archive HEAD` with
   `--from-head`.
8. **deps** — `npm ci` with its cache inside the volume.
9. **prebuild** — `expo prebuild --platform ios --no-install` (never EAS).
10. **pods** — `pod install --deployment` when a `Podfile.lock` exists; a first prebuild has no
    lockfile, so it falls back to plain `pod install` (logged).
11. **archive** — `xcodebuild archive -destination 'generic/platform=iOS'`, derived data
    inside the volume; signed runs add `-allowProvisioningUpdates` plus the ASC key.
12. **export** — generated `ExportOptions.plist` (no secrets) + `xcodebuild -exportArchive`.
    `--no-sign` packages `Payload/…app` with `ditto` instead.
13. **stage** — the `.ipa` + `ExportOptions.plist` are copied to
    `~/.dsh-ios-build/artifacts/<run-id>` **before** the upload attempt, so an upload failure
    (exit 5) still leaves a retrievable artifact outside the volume.
14. **upload** — only with `-Upload`.
15. **cleanup** (always, including on failure and on `INT`/`TERM`/`HUP`) — kill `caffeinate`,
    unmount, `diskutil apfs deleteVolume`, remove the lock, delete staged runs older than 3 days,
    then assert free space is within the drift budget of the baseline. Cleanup **never** sleeps
    or shuts the Mac down.

Power-down is not a remote step: the remote script simply exits and the driver decides when
the Mac may sleep. See §4.6 for the exact order.

### 4.5 Artifacts

```
apps/mobile-companion/artifacts/ios/<UTC-timestamp>/
  app.ipa                 signed (or unsigned with -NoSign); zip payload verified on arrival
  ExportOptions.plist     no secrets; safe to attach to a task
  build.log               full remote log (local copy capped at 50 MB, truncation marked)
  selftest.log            the self-test report (also written by -SelfTest alone)
```

`artifacts/` is git-ignored. A partial `.ipa` is deleted, never left behind.

**Staging does not accumulate on the Mac.** The driver retrieves the `.ipa` on **exit 0 and on
exit 5** (upload failure: staging ran before the upload, so the artifact survived). After a
successful `scp` it deletes this run's `~/.dsh-ios-build/artifacts/<run-id>` directory in one
ssh call (best effort: a failure is a WARNING, never a non-zero exit). The ordering is
load-bearing — the staged `.ipa` must outlive the transfer — and the 3-day prune stays as the
safety net for interrupted runs. Without that deletion each run would leave ~300 MB, and three
runs would eat the ±1 GB drift budget on their own.

The last line of the log is `RESULT {…}`:

```json
RESULT {"runId":"20261109T155159Z","exit":0,"primaryExit":0,"status":"ok","commit":"51f9b7774d15",
"source":"worktree","dirtyFiles":57,"profile":"production","signing":"automatic","uploaded":false,
"teamId":"…","bundleId":"com.dshext.companion","quotaGb":30,"floorGb":15,"baselineFreeGb":81,
"finalFreeGb":81,"volumeDeleted":true,"lockReclaimed":false,"durationSec":1180,"ipa":"…/app.ipa",
"exportOptions":"…/ExportOptions.plist","stageDir":"…","power":"stay-awake","startedAt":"…"}
```

`source` is `worktree` or `head`; `dirtyFiles` is the uncommitted-file count the package
carried (`0` with `-FromHead`). `ipa`/`exportOptions` point at the **staged** copies (outside
the deleted volume), which is exactly what the driver `scp`s. `power` is the *requested*
action (`stay-awake` by default, `sleep` with `-SleepAfterBuild`, `shutdown` with
`-ShutdownAfterBuild`); the remote script reports it and never performs it. The log
states the same thing in the `run:` line.

The exit code stays authoritative. If the `RESULT` line is missing (killed ssh, truncated
stream) the driver says so, falls back to the ssh exit code, and — on exit 0 or 5 — derives
the staging path from the remote `$HOME` it already resolved for staging.

### 4.6 After the build: order and power

The whole point of FR-016 is the order. On the driver side, after the remote script exits:

1. read the remote exit code and `RESULT`;
2. on **exit 0** (build ok) or **exit 5** (upload failed) `scp` `app.ipa` + `ExportOptions.plist`
   into `artifacts/ios/<run-id>/`; a `.partial` file is discarded, never left as a truncated
   `.ipa`; any other exit code has no artifact to fetch;
3. delete this run's stage directory on the Mac (one ssh call, path checked);
4. **power** — one ssh call, driver-owned: **left awake by default** (`POWER:stay-awake`; an idle
   Mac, not an occupied one). With `-SleepAfterBuild`, `pmset sleepnow` after a 2 s delay; with
   `-ShutdownAfterBuild`, `sudo -n shutdown -h +2` when passwordless sudo works, otherwise a
   warning and sleep. A failure here is a **WARNING only** and never changes the exit code.

The default is awake on purpose: a suspended Mac cannot be woken by this pipeline, so sleeping by
default made every follow-up build require a human at the machine (observed 2026-11-09). Use
`-SleepAfterBuild` only when you do not intend to build again soon. An **abandoned run** (a
dropped tunnel, or a driver killed with Ctrl-C) never reaches step 4: the Mac stays **awake**
until it sleeps on its own power policy, or you sleep it by hand. The cleanup trap on the Mac
still deleted the volume, and the staged `.ipa` remains until the 3-day prune.

### 4.7 What this pipeline leaves on the Mac

Exactly two things, both under `~/.dsh-ios-build/` and both safe to delete:

| Path | What | Lifetime |
|---|---|---|
| `~/.dsh-ios-build/ios-build.sh` | the staged orchestrator (~35 KB, mode 700) | overwritten by the next run; delete it any time |
| `~/.dsh-ios-build/artifacts/<run-id>/` | this run's `.ipa` + `ExportOptions.plist` | deleted by the driver after a successful retrieval; the 3-day prune is the safety net |
| `~/.dsh-ios-build/lock/` | single-flight marker | removed by the cleanup trap; recover by hand only when the holder pid is gone (§8) |

The APFS build volume is always deleted (that is exit 6 if it survives), `caffeinate` is killed
by the cleanup trap, and nothing is installed: no daemon, no launchd agent, no EAS project.
`bash ~/.dsh-ios-build/ios-build.sh --self-test` still works after a run if you want to inspect
the Mac, and `rm -rf ~/.dsh-ios-build` returns the Mac to its pre-pipeline state.

## 5. Phases

| Phase | Needs a Mac | What it proves | Command |
|---|---|---|---|
| **P0** | no | scripts parse under PS 5.1; `-DryRun` prints the plan, zero ssh; contract + package tests green | §4.1 + `test/dryrun.Tests.ps1` + `test/package.Tests.ps1` |
| **P0/P1 gate** | yes (no build) | the Mac's bash parses `ios-build.sh`; toolchain, license, pods, altool, disk, idle, lock all reported in seconds | `-SelfTest` (§4.2) |
| **P1** | yes | toolchain: prebuild, pods, `xcodebuild archive`, unsigned `.ipa`, full disk lifecycle | `-NoSign -Profile development -Force` |
| **P2** | yes | automatic signing with the ASC key; signed `.ipa` on Windows | `-Profile preview` |
| **P3** | yes | TestFlight end-to-end, one owner-approved run | `-Profile production -Upload` |

P1 is the important one: it exercises every part that can leak disk without spending a signing
identity. Do not jump to P3. Run `-SelfTest` before touching P1 — every real run repeats it
anyway, right after staging the orchestrator.

## 6. Exit codes

| Code | Meaning | Typical cause |
|---|---|---|
| 0 | build ok (and upload ok, if requested) | — |
| 2 | preflight refusal: unreachable, not idle, low disk, bad params | tunnel down, someone typing, `< 15 GB` free, typo in a flag |
| 3 | another build holds the lock | a second run, or a stale lock (reclaimed after 90 min) |
| 4 | build failure (prebuild / pods / compile / export / signing) | broken source, missing identity, expired profile |
| 5 | upload failure (artifact kept locally) | ASC key rejected, issuer mismatch, network |
| 6 | cleanup assertion failed (disk did not return to baseline, or volume still mounted) | a leaked mount, a stuck volume, a real disk leak |

The driver maps the remote code through unchanged; ssh transport failure (255) becomes 2.

## 7. Disk budget

| Step | Peak on the volume |
|---|---|
| source + `npm ci` | 1.5 GB |
| `expo prebuild` + `pod install` (cold) | 3.0 GB |
| `xcodebuild archive` derived data | 6.0 GB |
| archive + `.ipa` | 0.5 GB |
| **total** | **~11 GB** in a 30 GB quota (2.7× headroom) |

Postflight assertion: `final_free >= baseline_free - 1 GB` (drift budget 1 GB), plus "the volume
no longer exists". Both must hold; otherwise exit 6 even if the build succeeded.

One-time baseline cleanup on the Mac (owner runs by hand; `bootstrap-mac.sh` only prints it):

```bash
xcrun simctl delete unavailable
rm -rf ~/Library/Developer/Xcode/iOS\ DeviceSupport/*
rm -rf ~/Library/Developer/Xcode/Archives/*
rm -rf ~/Library/Developer/Xcode/DerivedData/*
pod cache clean --all
tmutil thinlocalsnapshots / 10000000000 1
df -g /
```

## 8. Recovery

| Symptom | Cause | Fix |
|---|---|---|
| exit 3 with a holder named | a build really is running, or a wedged one | if no build is running: `rm -rf ~/.dsh-ios-build/lock` on the Mac; otherwise wait. A lock older than 90 min with a dead pid is reclaimed automatically |
| exit 6, `/Volumes/DSHIosBuild still exists` | unmount failed (a process still holds a file) | `lsof +D /Volumes/DSHIosBuild` → stop that process → `diskutil unmount force /Volumes/DSHIosBuild` → `diskutil apfs deleteVolume /Volumes/DSHIosBuild` |
| exit 6, disk did not return to baseline | a leak outside the volume (pods cache, `~/Library/Developer/Xcode/*`) | `df -g /` and compare; the next run logs the delta. With `-KeepPodsCache` the drift budget is widened by the cache size on purpose |
| exit 6 but no volume and `< 1 GB` drift | normal APFS metadata churn | re-run once; if it persists, run the baseline cleanup (§7) and record the delta |
| exit 5 (upload failed) | ASC key/issuer rejected, wrong team, network | the `.ipa` **is** kept: it was staged before the upload and the driver retrieved it on exit 5, so `artifacts/ios/<run>/app.ipa` is on Windows. Fix the Mac config and re-run `-Upload`, or upload that file by hand |
| exit 4, `identity count: 0` | no signing identity in the Mac keychain, and no ASC key configured | open Xcode → Settings → Accounts, sign in, download the certificate — or configure the ASC key so automatic signing can create one (then the same state is only a WARNING) |
| exit 4, `identity count: 0` **with** an ASC key | automatic signing could not create the certificate (key rejected, wrong team, network) | read the log above the warning for Xcode's provisioning message; verify `DSH_IOS_ASC_KEY_ID` / `DSH_IOS_ASC_KEY_PATH` / `DSH_IOS_ASC_ISSUER_ID` on the Mac |
| exit 4, provisioning/profile | expired profile or wrong team | `-TeamId` with the right team; Xcode refreshes the profile on the next run |
| exit 4, pods | `Podfile.lock` mismatch or a CDN hiccup | re-run; if it repeats, delete the volume leftovers (§ above) and retry — the cache lives in the volume, so a corrupted cache cannot survive a run |
| exit 2, low disk | Mac below the floor | §7 baseline cleanup, or lower `-FloorGb` deliberately (never below 5) |
| exit 2, not idle | recent keyboard/mouse on the Mac | wait 10 min, or `-Force` (the policy line records that you did) |
| exit 2, unreachable, ≤ 30 s | tunnel up but sshd not listening on the Tailscale address | `sudo sshd -t`; check `ListenAddress`; `tailscale status` on both hosts |
| exit 2, `Host key verification failed` | the Mac's key is not in `known_hosts` yet (default is `StrictHostKeyChecking=yes`) | compare the fingerprint `bootstrap-mac.sh` printed, then re-run once with `-AcceptHostKey` |
| exit 2, `SELF-TEST FAILED` | the Mac-side gate failed: syntax, Xcode, pods, disk, or unreachable | read `artifacts/ios/<run>/selftest.log`; fix the `[fail]` lines it lists |
| `known_hosts` mismatch | the Mac was reinstalled / IP reused | verify the fingerprint out of band, then `ssh-keygen -R <mac>` once |
| log truncated | local copy hit 50 MB | the full stream is on the console; nothing else is affected |
| Mac slept mid-build | someone closed the lid | the watchdog (90 min) fails the run; the cleanup trap still runs. Keep the lid open (or on power) for P1–P3 |

Stale lock, step by step:

```bash
# on the Mac
cat ~/.dsh-ios-build/lock/owner      # pid, start time, run id
ps -p <pid>                          # empty output = the holder is gone
rm -rf ~/.dsh-ios-build/lock         # only when the pid is gone
```

Leftover volume, step by step:

```bash
diskutil list | grep -i dshiosbuild
lsof +D /Volumes/DSHIosBuild 2>/dev/null    # who still holds it
diskutil unmount force /Volumes/DSHIosBuild
diskutil apfs deleteVolume /Volumes/DSHIosBuild
df -g /
```

### 8.1 Dropped tunnel mid-build

If the ssh tunnel drops (Wi-Fi flap, the Mac's Tailscale restarts, `Ctrl-C` on Windows) while a
build is running:

1. The Mac side usually keeps running: the ssh session gets `SIGHUP`/EOF, the `trap` fires, the
   volume is deleted, the lock is released, and the watchdog (90 min) is the backstop if the
   trap cannot run. **Do not start a second run immediately** — it is refused with exit 3 while
   the first job still holds the lock; that is the intended protection.
2. Power-down does **not** happen: step 4 of §4.6 belongs to a driver that is gone. The Mac
   stays awake (and caffeinate dies with the shell). Sleep it by hand if that matters.
3. A dropped tunnel before the `scp` means no `.ipa` on Windows. The `.ipa` is staged on the
   Mac and survives the volume deletion; the 3-day prune will remove it. Retrieve it by hand:

```bash
# on Windows, with the run id from the log/console
scp -P <port> <user>@<mac>:~/.dsh-ios-build/artifacts/<run-id>/app.ipa .
scp -P <port> <user>@<mac>:~/.dsh-ios-build/artifacts/<run-id>/ExportOptions.plist .
```

4. If the lock survives (pid gone), see the stale-lock steps above. Resume with a fresh run:
   the staged orchestrator is overwritten, and `-Force` is only needed if someone is typing on
   the Mac.

## 9. Secrets never leave the Mac

This is the load-bearing rule of the whole pipeline; a violation fails the feature (SC-004).

| Secret | Where it lives | What the pipeline does with it |
|---|---|---|
| App Store Connect API key | Mac only, `~/.appstoreconnect/private_keys/`, mode 600 | passed to `xcodebuild`/`altool` as a path; never read, never printed, never transferred |
| ASC issuer value | Mac only, `~/.dsh-ios-build.conf`, mode 600 | passed as `--apiIssuer`; **redacted** in every log line |
| Signing certificate / private key | Mac keychain only | `security find-identity` prints a **count**, never a name |
| Provisioning profile | Mac only (`-allowProvisioningUpdates`) | never copied; not an artifact |
| SSH private key | Windows `~/.ssh` | used by `ssh`/`scp`; the driver never logs the command line's key path |

Enforced in code, not by convention:

- the remote script never enables `set -x`, and every log line passes through a redactor that
  drops `AuthKey…`, PEM armour, `issuer…` and `.p8`-suffixed names;
- the Windows driver never passes a key path or issuer on the ssh command line — only
  `--run-id`, `--commit`, `--profile`, `--quota-gb`, `--floor-gb`, `--idle-seconds`, `--team-id`
  and the boolean flags;
- `-DryRun` prints the upload command with the key id and a redacted issuer;
- `ios-build.conf.example` contains no key id, no issuer, no key path, and
  `bootstrap-mac.sh --apply-guards` refuses to write either;
- `test/dryrun.Tests.ps1` fails on an issuer-shaped UUID, a PEM block, or a base64 key body in
  any of the scripts or in this runbook.

The transfer direction is one-way by construction: `mac/ios-build.sh` (a script, no secrets)
and the worktree package (or, with `-FromHead`, `git archive HEAD`) are the only things that
travel to the Mac, and `app.ipa` + `ExportOptions.plist` are the only things that come back.

## 10. Verified locally vs. gated

| # | Check | Runs on this machine today | Gate |
|---|---|---|---|
| L-1 | Driver + both tests parse with 0 errors under the PS 5.1 parser | **yes** — `Parser::ParseFile` | none |
| L-2 | `-DryRun` exits 0, prints the plan (worktree source, dirty count, host key policy), makes zero ssh calls | **yes** — `test/dryrun.Tests.ps1` asserts it (black-holed host, < 5 s) | none |
| L-3 | Bad params exit 2 with a message (not a PS binding error) | **yes** | none |
| L-4 | The package is the working tree: a dirty file byte-for-byte, no `.dsh-wiki`/`node_modules`/`dist`/`artifacts`/`.git`/`*.log`, an untracked file included, `-FromHead` carrying HEAD | **yes** — `test/package.Tests.ps1` builds the real package and reads it back | none |
| L-5 | `-SelfTest` fails fast (exit 2, < 12 s) and leaves no artifacts directory | **yes** — localhost port 1 refuses immediately; the Mac-side report itself needs a Mac | a reachable Mac |
| L-6 | Shell contract: `set -Eeuo pipefail`, cleanup trap, `RESULT`, `--self-test`, no `set -x`, LF endings | **yes** — static assertions | none |
| L-7 | No issuer-shaped UUID / PEM block in the scripts and this runbook | **yes** | none |
| L-8 | `bash -n` on both scripts | **not here** — Git Bash cannot start under the sandbox (`couldn't create signal pipe, Win32 error 5`); `-SelfTest` does exactly this on the Mac before every build. A keyword-balance check (if/fi, case/esac, while/do/done, then) is the local substitute | a shell that starts, or the Mac |
| L-9 | FR-016/017/018 static contract: no `bash -s` command, staged absolute script path, `exec 3<&0` + `exec </dev/null`, `extract_source` on fd 3, stage-before-upload order, retrieval on exit 0 **and** 5, no remote sleep on the exit path, identity warning/failure split | **yes** — `test/dryrun.Tests.ps1` §10 | none |
| D-1 | P0/P1 gate: `-SelfTest` against the real Mac | no | Mac + Tailscale |
| D-2 | P1 unsigned build end-to-end | no | Mac + Tailscale |
| D-3 | P2 signed `.ipa` | no | signing identity + ASC key on the Mac |
| D-4 | P3 TestFlight upload | no | owner approval (A043) + ASC key |

Everything in the D rows is blocked only by toolchain, not by code or by this scope.

## 11. Known limitations

- **Nothing has been run against a Mac yet.** P0 is complete and repeatable here (including the
  FR-007 package test); the P0/P1 gate and P1–P3 are the first real executions, and the first P1
  run is where `expo prebuild`, the A030/A031 plugins and the `InfoPlist.strings` registration
  (`device-validation.md` §3, A033) meet a real Xcode.
- **Script delivery has not run against a real Mac yet.** The orchestrator is now staged
  (`~/.dsh-ios-build/ios-build.sh`, sha256-verified) and executed from that file, and it
  reserves fd 3 for the payload before anything else; the contract test asserts all of that
  statically. The first P1 run is what proves it on macOS. If bash ever consumes payload bytes
  there, the symptom is `source extraction failed (truncated package stream?)` and the log
  shows it within seconds, before `npm ci`.
- `pod install --deployment` requires a `Podfile.lock`; the first prebuild has none, so the
  script logs the fallback and runs plain `pod install`. After the first lockfile exists the
  strict mode applies.
- `altool` is deprecated by Apple. If a future Xcode drops it, the pipeline reports exit 5 (or a
  preflight warning from `bootstrap-mac.sh`) and keeps the `.ipa`; upload then goes through
  Transporter.app.
- `--keep-pods-cache` deliberately widens the disk drift budget by the cache size; without the
  flag the ±1 GB assertion is strict.
- `-FromHead` packages the raw `git archive HEAD` tree, so the committed `.dsh-wiki/` (3.2 MB)
  rides along; the hard excludes only apply to the worktree path. `dist/`, `artifacts/` and
  `node_modules/` are not tracked, so they never appear in either package.
- **Exit 5 keeps the artifact (resolved).** `main()` stages the `.ipa` before `upload_ipa`, so
  a failed upload leaves it outside the volume; the driver retrieves it on exit 0 and exit 5,
  and prints `UPLOAD FAILED (the .ipa is kept locally)` only when that is true.
- **Sleep uses `pmset sleepnow`, not an AppleScript.** The driver issues the power action
  through `ssh`/`cmd.exe`, where the `osascript -e 'tell application "System Events" …'` form
  embeds double quotes that cmd.exe cannot pass through intact. `pmset sleepnow` needs no GUI
  session and no password. `-ShutdownAfterBuild` still prefers `sudo -n shutdown -h +2` and
  falls back to sleep with a warning.
- **Environment normalisation is part of the build, not the owner's dotfiles (FR-019).** ssh
  starts a non-login shell with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so `node`, `npm` and `pod`
  (all in `/opt/homebrew/bin`) were invisible and `pod install` aborted with
  `Unicode Normalization not appropriate for ASCII-8BIT` because the locale was not UTF-8.
  `ios-build.sh` now prepends the Homebrew/user-gem bin dirs and forces a UTF-8 locale itself;
  `-SelfTest` reports both (`cocoapods: … at /opt/homebrew/bin/pod`, `locale: UTF-8`).
- The Windows log copy is capped at 50 MB (truncation is marked in the file); the console keeps
  the complete stream.
- **A build now completes with `--jsi-sendable-patch` (measured twice).** The unpatched default still stops at
  `JavaScriptObject.swift:946: error: sending 'slot' risks causing data races`, because `expo-modules-jsi@58.0.22`
  compiles through a nested `xcodebuild` under `env -i` that no flag of ours can influence. The working command is

  ```powershell
  $d = apps\mobile-companion\scripts\remote-ios-build\Invoke-RemoteIosBuild.ps1
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $d -NoSign -Force -JsiSendablePatch
  ```

  It applies two edits inside the disposable volume only: `JavaScriptValue.Slot` gains `@unchecked Sendable`, and
  the Slot is constructed **outside** the `JavaScriptActor.assumeIsolated` closure so the raw pointer never crosses
  the isolation boundary. Result: `exit=0`, `done: build ok`, `app.ipa` ~10.7 MB containing
  `Payload/DSHCompanion.app/{DSHCompanion, main.jsbundle, Info.plist}` with `com.dshext.companion`, and cleanup
  still returns the disk to baseline (`23 GB -> 23 GB`). **This patches third-party concurrency code in a client
  that handles pairing credentials — it is opt-in, needs a reviewer pass before the signed/production path uses
  it, and must be retired once Expo ships a jsi that compiles natively (or Xcode is upgraded).**
- **The build currently stops at `expo-modules-jsi` — a toolchain mismatch, not a pipeline bug.** All of these
  were measured on the owner's Mac (Xcode 26.0.1, Swift 6.2, macOS 26.6.2 arm64): source transfer, `npm ci`,
  `expo prebuild --platform ios`, `pod install`, signing-flag handling, volume lifecycle and cleanup all succeed;
  the archive fails while compiling `expo-modules-jsi@58.0.22` (the latest published version). The package
  declares `swift_version = '6.0'` and builds its xcframework from a Pods script phase that runs a nested
  `xcodebuild` under `env -i`, so no build setting of ours can reach it, and it fails with
  `JavaScriptObject.swift:946: error: sending 'slot' risks causing data races`.
  `--patch-expo-jsi` (opt-in, off by default) injects `SWIFT_VERSION=5` into that nested build. It fixes the
  data-race error but the package also needs Swift-6-only C++ interop, so the failure simply moves on:
  bare-slash regex → `'exception' not found` → `'jsi/jsi.h' not found`. **Do not treat it as a fix.**
  `--expo-jsi-swift-exec <path>` was the second attempt: keep Swift 6 mode and swap only the compiler for the
  Command Line Tools' Swift 6.1.2 (which the nested script accepts via `SWIFT_EXEC`). It fails too — Swift 6.1
  cannot read Xcode 26's `Swift.swiftmodule/arm64e-apple-ios.swiftinterface`
  (`error: f…` at `swift-interface-format-version: 1.0`), so an older compiler cannot be mixed with a newer SDK.
  Conclusion, measured: no build-setting lever on this machine produces a working `expo-modules-jsi`. The real
  options are an Xcode new enough for this package (its own script comments reference Xcode 26.4/27) or an Expo
  version that matches the installed Xcode — both owner decisions.
- **Cleanup deletes the volume by name, not by path (FR-021).** `diskutil apfs deleteVolume "$VOL_PATH"` fails
  silently once the volume is unmounted, and an unmounted leftover is invisible to `/Volumes` and to `df` while
  still holding 1–3 GB. Six runs left six such volumes (16.5 GB) and drained the Mac from 22 GB to 9 GB free.
  Cleanup now deletes by volume name until none remains, verifies the container, treats a leftover as exit 6,
  the self-test reports orphans, and the next run reclaims them before adding a new volume. Proven: a real run
  reports `cleanup: volume DSHIosBuild deleted (verified: none left in the APFS container)` and
  `free space 23 GB -> 23 GB (within 1 GB)`.
- **Free-space readings lag after a volume delete (measured, correcting an earlier false alarm).**
  Four back-to-back builds showed `df` free space falling 22 → 18 → 15 → 13 GB while every cache and
  developer directory stayed byte-identical (`~/Library/Caches` 1.7 GB, `~/Library/Developer` 14 GB,
  `~/.npm` 646 MB, `/var/tmp` 1.1 GB, no orphaned `/Volumes/DSHIosBuild`). APFS returns the deleted
  volume's blocks lazily and macOS counts purgeable space; a re-measurement later showed 1 GB coming
  back. The pipeline was **not** leaking. The cleanup assertion still holds: budget 1 GB, settle loop
  of 6 × 10 s, and on failure it names the usual outside-the-volume caches.
- **What is verified locally vs only on the Mac.** Verified on Windows without a Mac:
  `bash -n` on both shell scripts, `ios-build.sh --help`/bad-argument/non-macOS-guard executed for
  real, `npm ci` with the `file:../../packages/mobile-protocol` dependency (575 packages, link OK),
  `expo config --type prebuild` (all 6 config plugins, bundle id, 5 infoPlist keys), the packaging
  byte-equality regression test, and the full driver self-test contract. **Not** verifiable without
  macOS: `expo prebuild --platform ios` (Expo refuses to generate `ios/` on Windows), the
  `ios.xcodeproj` mods in `plugins/withPinnedWsConfig.js` (only applied at real prebuild), `pod
  install`, `xcodebuild archive`, and signing. That is exactly the P1 gate.
