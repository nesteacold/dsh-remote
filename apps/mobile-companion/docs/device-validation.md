# Device validation — DSH Companion (A040 / A041 / A034)

Practical checklist for validating the companion app on real Android and iOS targets against
contract v1 (`specs/001-gateway-hardening/contracts/mobile-protocol-v1.md`, revision 3).

**Purpose**: make the environment-gated work (A040 Android build + E2E, A041 iOS build + E2E,
A034 iOS 401/403 mapping) startable the moment a device or a macOS runner exists — without spending
EAS build credits, without a store upload, without credentials in this repo, and without a paid
account action.

**Scope of this document** — the app under test is `apps/mobile-companion`. Executable helpers live
in [`../e2e/`](../e2e/README.md).

**Non-goals (explicitly out of bounds here)**

| Not done here | Why / where it belongs |
|---|---|
| `eas build` (cloud) | consumes build quota; use a local build (§2/§3) until the owner approves spending |
| store / TestFlight / Play upload | owner approval + reviewer sign-off (A043) |
| signing keys, keystores, provisioning profiles, APNs/FCM secrets | hard boundary: never read, print or commit |
| remote push end-to-end | A042, needs owner-supplied APNs/FCM credentials |
| proving the *gateway* works | spec 001's own `quickstart.md`; this document proves the *app* |

---

## 1. What is executable now vs device-gated

| # | Check | Runs on this machine today | Gate |
|---|---|---|---|
| L-1 | Fixture protocol self-test (53 checks, 4 cert modes) | **yes** — `node e2e/harness/selftest.mjs` | none |
| L-2 | Wiring of all 14 device checkpoints, all control routes, all flow files. Default is loopback-only (`--bind`/`--lan-host` `127.0.0.1`) | **yes** — `node e2e/run-e2e.mjs --dry-run` | none |
| L-3 | Static validity of every flow (appId/separator, subflow targets, vi+en coverage, tap anchoring, every `id:` resolved against the `testID`s in `app/**`, no opaque value in a matcher) | **yes** — `node e2e/check-flows.mjs` | none |
| L-4 | Entry-point options: loopback defaults for both entries, explicit `--bind`/`--lan-host` opt-in, exposure warning, no listener started | **yes** — `node --test e2e/harness/options.test.mjs` | none |
| D-1 | Android dev build + emulator flows (A040) | no | Android SDK + JDK 17 |
| D-2 | Android physical device | no | USB debugging + (debug) signing only |
| D-3 | iOS simulator flows (A041) | no | macOS + Xcode |
| D-4 | iOS physical device | no | Apple account + provisioning (owner) |
| D-5 | A034 (401/403 status on URLSession) | no | macOS + Xcode (or an approved EAS build) |

Everything in the D rows is blocked only by toolchain, not by code or by this scope.

---

## 2. Android (A040)

### 2.1 Prerequisites

- JDK 17, Android SDK with platform 35+ and build-tools; `ANDROID_HOME` set.
- An **emulator with a Google APIs image** and API level matching the app's `minSdk` (Expo SDK 58).
- A screen lock, so the unlock gate has something to authenticate against:
  ```powershell
  adb shell locksettings set-pin 1234
  # or the emulator's Settings > Security > Fingerprint and enrol one fingerprint
  ```
- Verify the emulator's biometric can be driven from the host:
  ```powershell
  adb -e emu finger touch 1        # "touch the sensor" — this is what answers the OS prompt
  ```
- `maestro` CLI. If the network installer hangs on this machine (it has before), install it from an
  offline archive and confirm with `maestro --version`.

### 2.2 Build without EAS quota

```powershell
cd apps/mobile-companion
npx expo prebuild --platform android --clean      # applies plugins/withPinnedWsConfig.js
npx expo run:android --device                      # local Gradle build + install
```

- This is a **local** build: no EAS project is touched and no quota is consumed.
- `--device` prompts for a target; pick the running emulator or the USB device.
- `eas build --local` is a valid alternative but needs an Expo login (a credential dependency) and
  still requires the SDK/Xcode locally — prefer `expo run:*` for this checklist.
- **First build expected to fail to compile**: the Kotlin/Swift in `modules/pinned-ws` has never been
  compiled (A030/A044). If Gradle fails there, record the literal error in A044 and stop — do not
  hand-patch around it in this task.

### 2.3 Run the matrix

```powershell
cd apps/mobile-companion
node e2e/harness/selftest.mjs                     # fixture sanity first (no device)
# Android emulator: 10.0.2.2 is the emulator's alias for the host loopback.
node e2e/run-e2e.mjs --platform android --lan-host 10.0.2.2    # all 14 checkpoints, report.json
# Physical Android device on the same LAN: opt in explicitly.
node e2e/run-e2e.mjs --platform android --bind 0.0.0.0 --lan-host <host-LAN-IP>
node e2e/run-e2e.mjs --platform android --only T-12 --bind 0.0.0.0 --lan-host <host-LAN-IP>
```

The fixture listens on and advertises `127.0.0.1` by default, so nothing on the host is reachable
from another machine unless `--bind`/`--lan-host` say otherwise. A **physical** device therefore
needs both flags (the run prints a warning when it binds beyond loopback), and the host firewall
must allow the TLS port. The control API stays on `127.0.0.1` and requires `x-fixture-token`
whatever `--bind` says.

The orchestrator starts one fixture per checkpoint, rotates the single-use pairing code, arms the
server-side scenario, runs the Maestro flow, then asserts the server-side property. Playwright-style
screenshots are on the emulator; attach the `report.json` path it prints.

### 2.4 Verified adb-only path (no Maestro) — 2026-11-10

Maestro is not required to prove the device side. This sequence was executed for real against the
Android-36 x86_64 emulator and is scripted in `e2e/device/run-device-pairing.ps1`:

```powershell
# 0. Prepare the device once: a screen lock is required by the unlock gate, and a clean IME state
#    matters (see the warning below).
adb shell locksettings set-pin 1234
adb shell pm clear com.dshext.companion
# 1. Opt in to the native diagnostics BEFORE the run (they are off by default in release builds).
adb shell setprop log.tag.PinnedWs DEBUG
adb logcat -c
# 2. Install the APK produced by EAS (see 2.2) and run the scripted flow.
.\e2e\device\run-device-pairing.ps1 -Apk C:\path\to\dsh-companion.apk
# 3. Read the native evidence for the connection under test.
adb logcat -d -s PinnedWs:D
```

What this path has already proven on a real (emulated) device: APK installs and launches, the
**system BiometricPrompt** is the unlock (screenshot stays black by design — secure surface), the
main screen and the pairing screen render, a corrupted pairing string is refused locally with **zero
TCP/TLS traffic**, and a **valid** pairing string completes TLS with the certificate pin accepted,
redeems the one-time code exactly once and persists the token + host record in the app's encrypted
store.

Two hard-won operational facts:

- **The pairing code expires in 5 minutes.** Generate it, then submit it inside that window or the
  gateway answers `pairing/expired` (the app shows "This pairing code expired or was already used").
- **Type the pairing string in ~40-character chunks.** One long `adb shell input text` call corrupts
  the token (observed: the fragment `…ZWEi…` became `…ZŴẾi…`, i.e. diacritics applied to base64url).
  Verify the field byte-exactly with `adb shell uiautomator dump` before tapping **Pair** — the
  script does this and refuses to submit when the text does not match.

---

## 3. iOS (A041)

### 3.1 Prerequisites (macOS)

- Xcode 16+, CocoaPods, an iOS simulator (16.4+ recommended).
- Xcode **Features > Face ID > Enrolled**, then `Features > Face ID > Matching Face` to answer the
  unlock prompt. There is no CLI equivalent; this is the one unavoidable manual step per unlock.
- `maestro` CLI on the Mac.

### 3.2 Build without EAS quota

```bash
cd apps/mobile-companion
npx expo prebuild --platform ios --clean
npx expo run:ios            # simulator; local Xcode build, no EAS
```

- Simulator builds need no signing identity.
- A **physical** iPhone needs an Apple account, a team and a provisioning profile — owner-gated
  (credentials). Do not start that without the owner's explicit go-ahead.
- Same expectation as Android: `modules/pinned-ws/ios` (Swift) has never been compiled (A044/A047).
  Record literal Xcode errors in A044/A047.

### 3.3 Run the matrix

```bash
node e2e/harness/selftest.mjs
node e2e/run-e2e.mjs --platform ios                 # simulator: shares the host loopback
node e2e/run-e2e.mjs --platform ios --only T-13     # A034
node e2e/run-e2e.mjs --platform ios --bind 0.0.0.0 --lan-host <host-LAN-IP>   # physical iPhone on the LAN
```

T-08 (network drop) is Android-only as a flow (`setAirplaneMode` is a no-op on iOS simulators). On
iOS use the fixture's socket kill plus the same banner assertions:

```bash
curl -X POST http://127.0.0.1:3444/scenario/drop -H "x-fixture-token: <token>"
```

---

## 4. Test matrix

`report.json` fields in the "server-side" column are the assertions `run-e2e.mjs` performs. A UI-only
green is **not** a pass for any row that has a server-side property.

| ID | Scenario (as requested) | Flow | Observables on the device | Server-side property | Task |
|---|---|---|---|---|---|
| T-01 | Launch → unlock gate, nothing usable before unlock | `01-launch-unlock.yaml` | gate title `DSH Companion`; after unlock, empty state + pair CTA | `upgradeAttempts === 0` before unlock | A040/A041 |
| T-02 | **Paste QR** code → pair → canonical session list | `02-pair.yaml` | pair screen → list shows `Refactor gateway TLS` | 1 code consumed, 1 socket, `client-hello` received | A040/A041 |
| T-02m | **Scan** the QR with the camera (manual) | — (see §5.1) | camera preview, scan → same list as T-02 | same as T-02 | A040/A041 |
| T-03 | List tabs / canonical rows / search | `03-session-list.yaml` | Running/Idle/Archived each show only their row; search narrows | `sessions` + `search` frames | A040/A041 (A046) |
| T-04 | Open session → send prompt | `04-send-prompt.yaml` | history renders; optimistic prompt row appears | one prompt, non-empty `clientMsgId` | A040/A041 |
| T-05 | **Approval carries the exact hash** | `05-approval-approve.yaml` | card shows tool/reason/preview; approve → "Allowed once" | receipt `argsHash` byte-identical to the pushed hash | A040/A041 |
| T-06 | **No approve when `argsHash` is null** | `06-approval-null-hash.yaml` | "Decide on your computer"; no approve/reject rendered | `apv-null` never decided, still pending | A040/A041 |
| T-07 | **Mismatch stays disabled** until a fresh view | `07-approval-hash-mismatch.yaml` | "This request changed…"; buttons gone; "Review again" → buttons back; second approve succeeds | first receipt `hash-mismatch`, later receipt accepted with a different hash | A040/A041 (A049) |
| T-08 | **Forced network drop → reconnect** | `08-reconnect.yaml` (Android) | reconnecting banner appears then clears; list intact | exactly 1 socket after recovery; no duplicate prompt | A040 |
| T-09 | **Background lock → re-unlock, single socket** | `09-background-relock.yaml` | gate returns on background; list returns after re-unlock | peak sockets ≤ 2, exactly 1 at the end | A040/A041 (M5) |
| T-10 | **Revoke → credential wiped** | `10-revoke-wipe.yaml` | pair CTA returns, list gone; a second cold start stays unpaired | no live socket, credential gone | A040/A041 |
| T-11 | Expired / malformed code rejected client-side | `11-pair-errors.yaml` | "expired or already used" copy only | `upgradeAttempts === 0` | A040/A041 |
| T-12 | **Wrong certificate → no upgrade credentials** | `12-pair-wrong-cert.yaml` | "not the computer the code belongs to. Nothing was sent." | **zero upgrade requests**, no pairing code, no device id | A040/A041 (SC-002) |
| T-12e | **Expired certificate → refused** | `12-pair-wrong-cert.yaml` with `--cert-mode expired` | pairing fails without offering the code to a socket | handshake may complete; validity check must refuse | A040/A041 (A032/A047) |
| T-12n | **Not-yet-valid certificate → refused** | same with `--cert-mode not-yet` | as above | as above | A040/A041 (A047) |
| T-13 | **401 / 403 mapping** | `13-upgrade-refusals.yaml` (two variants) | 401 → "expired or already used"; 403 → "remote control is off"; never the generic "Pairing failed" | refusal status recorded verbatim | **A034** |
| T-14 | Protocol mismatch → actionable update screen | `14-update-required.yaml` | "Update DSH on your computer", version, Retry + pair another | `client-hello` refused, socket closed | A040/A041 (FR-004) |

### 4.1 Certificate modes and what each one proves

```powershell
# Loopback (default) for host-side checks; add --bind 0.0.0.0 --lan-host <host-LAN-IP> for a phone.
node e2e/harness/gateway.mjs --cert-mode wrong    --port 3443 --control-port 3444
node e2e/harness/gateway.mjs --cert-mode expired  --port 3443 --control-port 3444
node e2e/harness/gateway.mjs --cert-mode not-yet  --port 3443 --control-port 3444
```

| Mode | Expected result on device | Failure means |
|---|---|---|
| `ok` | pairs; list renders | the happy path is broken |
| `wrong` | refuses with "nothing was sent"; **no HTTP upgrade reaches the fixture** | the pin is checked after the upgrade, or not at all — a security defect |
| `expired` | refuses (pin matches, validity must fail) | the trust manager checks the hash only; A032/A047 regressed |
| `not-yet` | refuses | same as above |

For `wrong`/`expired`/`not-yet` the decisive evidence is the fixture's `GET /state`:
`upgradeAttempts`, `offeredPairingCodes`, `deviceIds`. Read them in `report.json` →
`results[].fixtureEvidence`; do not accept a screenshot as proof of "nothing was sent".

### 4.2 Stable test hooks the flows use

The flows address the app through the `testID`s the screens render, not through copy where a hook
exists. Read the hook from `app/` when a flow fails — a changed hook is a test-authoring fix, and
`node e2e/check-flows.mjs` fails before a device run if a selector names a hook the app no longer
renders.

| Hook | Rendered in | Drives |
|---|---|---|
| `pair-manual-input`, `pair-submit` | `app/pair.tsx` | paste + submit; the submit button is disabled while the field is empty, so `enabled: true` proves the paste landed |
| `session-composer`, `session-send` | `app/session/[id].tsx` | compose + send a prompt |
| `session-row-<sessionId>` | `app/index.tsx` | open / assert a specific row (`sess-alpha`, `sess-beta`, `sess-gamma`) |
| `sessions-tab-<tab>` | `app/index.tsx` | switch tab (`running`, `idle`, `archived`) — locale-independent |
| `approval-card-<approvalId>` | `app/session/[id].tsx` | wait for one card (`apv-hash`, `apv-null`) |
| `approval-approve-<approvalId>`, `approval-reject-<approvalId>` | `app/session/[id].tsx` | decide that card; **absent** when the card may not be decided (null hash, refused, resolved) — that absence is what T-06/T-07 assert |
| `approval-state-<approvalId>` | `app/session/[id].tsx` | the per-card notice/outcome line |
| `banner` | `app/index.tsx`, `app/session/[id].tsx` | whether a banner is up; the localised copy still decides which banner (T-08/T-09) |

**Ids are regexes.** Maestro treats `id` as a regular expression, so the flows keep to
`[A-Za-z0-9._-]`: the literal hook prefixes are ours, and the dynamic tails are fixture ids
(`sess-alpha`, `apv-hash`, `apv-null`) or the app's tab enum — none needs escaping.
`check-flows.mjs` resolves every `id:` against `app/**` and fails if an interpolated tail is not one
of those known ids or contains a regex metacharacter. If a flow is ever pointed at a **real**
gateway, its ids come from the host: escape them (or match a prefix such as `session-row-.*`) before
using them in `id:`. Opaque values — the pairing code, the expected `argsHash` — are never
interpolated into any matcher: the paste is proved by `pair-submit`'s enabled state, which also keeps
the single-use code out of Maestro's selector log (FR-011).

Steps with no hook stay copy-matched in both locales: the unlock gate button, the search field,
"Review again" / "Cancel session", the pair error box and the update-required overlay. That is a
copy-matching limitation of those steps, **not** a reason to treat T-01…T-14 as manual.

---

## 5. Manual checkpoints (cannot be automated as-is)

Each of these is a step a human must perform and record. Mark them in the task record as manual.
They are manual because the step happens **outside the app's view tree** (an OS dialog, a camera, a
platform trust decision, a device language setting) — not because a test hook is missing; the flows
themselves are hook-addressed wherever the screens provide one (§4.2).

### 5.1 Scanning the QR (vs pasting)

- T-02 covers paste (deterministic). Scanning needs the camera:
  ```powershell
  # print the pairing text, then render it as a QR on the host (any QR generator) and point the phone at it.
  # A phone can only reach a non-loopback bind, so opt in explicitly (the run warns about it).
  node e2e/harness/gateway.mjs --bind 0.0.0.0 --lan-host <host-LAN-IP> --port 3443 --control-port 3444
  ```
- The app requires the `wss://` endpoint on the pairing QR to be reachable from the phone: the
  fixture is loopback-only by default, so start it with an explicit opt-in
  (`--bind <hostIP|0.0.0.0> --lan-host <host-LAN-IP>`), make sure the phone is on the same network,
  and allow the TLS port through the host firewall. The run prints a warning when it binds beyond
  loopback; the control API stays on `127.0.0.1`.
- Record: preview shown, scan accepted once, second scan of the same code rejected (single-use).

### 5.2 Localised permission prompts (A033)

Both OS dialogs must be in the **device language**, not English-only:

1. Set the device language to Vietnamese (Android: Settings > System > Languages; iOS: Settings >
   General > Language & Region).
2. Clear app data (`adb shell pm clear com.dshext.companion`) so the prompts reappear, or reset
   permissions (`adb shell pm revoke com.dshext.companion android.permission.CAMERA`).
3. Launch, open the pair screen → camera prompt in Vietnamese.
4. Background/re-unlock → biometric prompt in Vietnamese.

Expected Android strings come from `expo-camera`'s `cameraPermission` in `app.json`; iOS strings come
from `InfoPlist.strings` written by `plugins/withPinnedWsConfig.js` (**A033 is open**: the `.lproj`
wiring into `pbxproj` is unverified — a first iOS build that shows English strings confirms A033 is
still open; record a screenshot).

### 5.3 Face ID / device passcode unlock

- The unlock prompt is an OS dialog. Answering it is:
  - Android emulator: `adb -e emu finger touch 1` (after enrolling a fingerprint), or type the PIN;
  - iOS simulator: Features > Face ID > Matching Face;
  - physical devices: the tester's own biometrics.
- A cancelled prompt must show "Unlock cancelled. Your credential stays locked." and keep the app
  locked (`unlock.cancelled`); check this at least once, it is the negative case.

### 5.4 iOS network drop (T-08 substitute)

No airplane mode on the simulator. Use the fixture's socket kill and check the banner:

```bash
curl -X POST http://127.0.0.1:3444/scenario/drop -H "x-fixture-token: <token-from-/state>"
```

---

## 6. Exit criteria per task

### A040 — Android dev build + E2E

- [ ] `npx expo prebuild --platform android` and `npx expo run:android` produce an installable debug
      build (record the literal Gradle result; native compile errors belong to A044).
- [ ] `node e2e/harness/selftest.mjs` passes (fixture sanity).
- [ ] T-01, T-02, T-03, T-04, T-05, T-06, T-07 pass with their server-side assertions.
- [ ] T-08 (Android-only) passes: banner appears then clears, one socket after recovery.
- [ ] T-09 passes: peak sockets ≤ 2, one live socket after re-unlock.
- [ ] T-10 passes: credential wiped, second cold start stays unpaired.
- [ ] T-12 passes: `upgradeAttempts === 0` in `report.json`.
- [ ] T-12e / T-12n recorded (pass or fail with the literal native error).
- [ ] T-11 passes; T-13 recorded for both statuses; T-14 recorded.
- [ ] `report.json` attached to the task.

### A041 — iOS build + same flows

- [ ] Local Xcode build installs on the simulator (or an owner-approved EAS build exists).
- [ ] T-01…T-07, T-09, T-10, T-12, T-12e, T-12n, T-13, T-14 pass on iOS.
- [ ] T-08 replaced by the socket-kill variant (§5.4) and passes.
- [ ] A033 evidence captured: camera + Face ID prompts in the device language (§5.2).
- [ ] A047 recorded: expired / not-yet-valid leaf refused with the pin matching (T-12e/T-12n).
- [ ] `report.json` attached.

### A034 — URLSession exposes 401/403 for the upgrade mapping

- [ ] Fixture armed `upgrade-status 401`: app shows the **expired/used** copy.
- [ ] Fixture armed `upgrade-status 403`: app shows the **remote control off** copy.
- [ ] Neither run shows the generic "Pairing failed. Show a new code and try again." copy
      (`client/upgrade-failed`) — that would mean the status was lost.
- [ ] If the status is *not* surfaced: record the literal native error/close info from the Xcode
      console and stop — the fix belongs to `modules/pinned-ws/ios` (not this scope).

---

## 7. Known risks this run is expected to surface

The independent review (A043) left these open; the first device build is where they become visible,
so capture literal output rather than working around them:

| Risk | Where it shows up | Owner task |
|---|---|---|
| Kotlin/Swift never compiled | first `expo run:android` / `run:ios` | A044 |
| OkHttp version resolution (`compileOnly`) | Gradle dependency resolution | A044 |
| iOS pinned leaf validity window | T-12e / T-12n | A047 |
| Pairing single-shot / token persistence | T-02, T-10 | A048 |
| Mismatch re-enabling from stale cache | T-07 | A049 |
| 401/403 status on URLSession | T-13 | **A034** |
| Localised iOS permission strings | §5.2 | A033 |
| Native socket lifecycle under lock | T-09 (`peakOpenConnections`) | A045 |

---

## 8. Evidence to capture

1. `report.json` from `run-e2e.mjs` (per checkpoint: armed scenario, assertion results, fixture
   evidence).
2. Maestro's screenshots for the failing/edge steps (it writes them next to the flow run).
3. Literal build output for the first successful `expo run:*` (or the compile errors, if it fails).
4. For T-12: the `fixtureEvidence` block showing `upgradeAttempts: 0` and empty
   `offeredPairingCodes`/`deviceIds`.
5. For §5.2: screenshots of both permission prompts in Vietnamese.
6. Logcat slice for T-09/T-10 (`adb logcat -d | Select-String -Pattern 'pinned|Pinned|ws'`) — never
   attach anything containing a token, pairing code or tool arguments (FR-011).

## 9. Reporting template (paste into the task)

```
Task: A040 | A041 | A034
Build: <expo run:android|run:ios> <commit> — local, no EAS
Device: <model / API level | simulator + iOS version>
Fixture: cert-mode <ok|wrong|expired|not-yet>, port <n>
Result: PASS | FAIL
Checkpoints: T-01..T-14 → <id: pass/fail/skip + one line>
Server-side evidence: upgradeAttempts=<n>, openConnections=<n>, receipts=<n>, refused=<n>
Deviations: <literal error / screenshot path / report.json path>
Notes: <anything the lead must decide>
```
