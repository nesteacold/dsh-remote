# `apps/mobile-companion/e2e` — device validation for A040 / A041 / A034

Everything in this folder exists to test the **app on a real device** (or emulator/simulator)
against the contract in `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md`, without
spending EAS build quota and without a DSH Host.

The operator checklist, prerequisites, per-platform build steps, manual checkpoints and exit
criteria live in [`../docs/device-validation.md`](../docs/device-validation.md). This file is the
map of what is here and what runs today.

## Status: what runs now vs what is device-gated

| Piece | Runs today on this machine? | Needs |
|---|---|---|
| `harness/selftest.mjs` — protocol self-test of the fixture | **Yes** — `node e2e/harness/selftest.mjs` (53 checks, 4 cert modes) | Node ≥ 24 |
| `check-flows.mjs` — static check of every flow (appId/separator, subflow targets, locale coverage, tap anchoring, hook ids, no opaque matchers) | **Yes** — `node e2e/check-flows.mjs` (21 flows, every `id:` resolved against `app/**`) | Node ≥ 24 |
| `run-e2e.mjs --dry-run` — wiring check of every checkpoint | **Yes** — 18/18 checkpoints wired, all control routes answered | Node ≥ 24 |
| `harness/options.test.mjs` — entry-point options: loopback defaults, explicit `--bind`/`--lan-host` opt-in, exposure warning | **Yes** — `node --test e2e/harness/options.test.mjs` | Node ≥ 24 |
| Maestro flows (`maestro/*.yaml`) | **No** | a dev build + `maestro` CLI (+ `adb` for Android) |
| Server-side assertions in `run-e2e.mjs` | **No** | the same, because they read state produced by the app |
| iOS specifics (A041, A034, A047) | **No** | macOS + Xcode or an owner-approved EAS build |

`--dry-run` is the default when `maestro` is not on `PATH`, so the script never silently pretends a
device ran. The fixture binds **and advertises** `127.0.0.1` by default, so a wiring run — or any
run on this machine — exposes nothing beyond loopback. A device on the LAN is an explicit opt-in:
`--bind <hostIP|0.0.0.0> --lan-host <hostIP>` (or `--lan-host 10.0.2.2` for an Android emulator),
and the run prints a warning when it listens beyond loopback (or resolves `--lan-host auto`). The
fixture's control API always stays on `127.0.0.1` and requires `x-fixture-token`.

## Layout

```
e2e/
  harness/
    gateway.mjs      fixture gateway: TLS + contract-v1 frames + loopback control API + scenarios
    options.mjs      entry-point defaults/parsing: loopback bind + loopback pairing host
    certs.mjs        leaf generation; modes ok | wrong | expired | not-yet
    pairing.mjs      QR v3 payload encode (independent of the app parser on purpose)
    selftest.mjs     plays the phone over real TLS; proves the fixture's frames (runs now)
    options.test.mjs option parsing: loopback defaults, explicit LAN opt-in (runs now)
  maestro/
    config.yaml      flow set + shared constants
    subflows/
      unlock.yaml        cold start → past the OS unlock prompt → sessions screen
      pair-paste.yaml    paste a one-time code (the QR alternative)
      open-session.yaml  open a fixture session
    01-launch-unlock.yaml         …  14-update-required.yaml
    15-authoring-create.yaml          …  18-authoring-not-connected.yaml
  run-e2e.mjs        orchestrator: fixture + scenario arming + Maestro + server-side assertions
```

## The fixture is not the gateway

`harness/gateway.mjs` speaks the same TLS/WSS framing, pairing offer (QR v3), `paired`/`hello`/
`client-hello` handshake, `sessions`/`history`/`subscribe` projections and approval receipts as the
real gateway, but it has no DSH session, no token persistence and no hardening. A green run proves
**the app** behaves; it does not prove spec 001's gateway does (that is spec 001's own
`quickstart.md`).

It exists because the alternative — a DSH Host with `remoteControl.enabled` and a live session to
approve — is exactly the environment that is missing here, and because every checkpoint below needs
the *server side* to change on cue (revoke, hash rotation, upgrade refusal, protocol gate).

## Quick start (no device)

```powershell
cd apps/mobile-companion

# 1. Protocol self-test of the fixture: 53 checks, all four certificate modes.
node e2e/harness/selftest.mjs
node e2e/harness/selftest.mjs --cert-mode wrong
node e2e/harness/selftest.mjs --cert-mode expired
node e2e/harness/selftest.mjs --cert-mode not-yet

# 2. Static check of the flows, including every hook id against app/**.
node e2e/check-flows.mjs

# 3. Wiring check of all 18 device checkpoints (fixture + control routes + flow files).
#    Loopback only by default: nothing on this machine is reachable from outside.
node e2e/run-e2e.mjs --dry-run

# 4. Entry-point options: loopback defaults, explicit LAN opt-in, exposure warning (no listener).
node --test e2e/harness/options.test.mjs
```

## Running against a device

The fixture is loopback-only unless you opt in. Pick the line that matches the target:

```powershell
# Android emulator: 10.0.2.2 is the emulator's alias for the host's loopback, so the listener
# stays on 127.0.0.1 and only the pairing QR advertises the emulator-visible address.
node e2e/run-e2e.mjs --platform android --lan-host 10.0.2.2

# iOS simulator: shares the host's loopback, so the default is enough.
node e2e/run-e2e.mjs --platform ios

# Physical device on the LAN: opt in to a non-loopback bind AND advertise the host's LAN IP.
node e2e/run-e2e.mjs --platform android --bind 0.0.0.0 --lan-host <host-LAN-IP>
node e2e/run-e2e.mjs --platform ios     --bind 0.0.0.0 --lan-host <host-LAN-IP>
# (`--bind <host-LAN-IP>` binds one interface instead of 0.0.0.0.)

# Pairing code is rotated per checkpoint automatically; for a manual run, start the fixture:
node e2e/harness/gateway.mjs --bind 0.0.0.0 --lan-host <host-LAN-IP> --port 3443 --control-port 3444
# …then, in the app: Pair a computer → paste the printed code

# One checkpoint, with its own fixture instance:
node e2e/run-e2e.mjs --only T-07 --bind 0.0.0.0 --lan-host <host-LAN-IP>
```

A non-loopback bind prints `warning: the fixture's TLS/WSS port is bound to … — reachable from other
machines on this network …` before the first checkpoint; that warning is the reminder that only a
device run on a trusted network should use it. The control API is not configurable: it stays on
`127.0.0.1` with `x-fixture-token` for every mutation.

The orchestrator prints a `report.json` path containing, per checkpoint: the flow, the armed
scenario, the server-side assertions with results, and the fixture's evidence
(`upgradeAttempts`, `offeredPairingCodes`, `approvalReceipts`, `openConnections`, …). Attach that
file to the A040/A041 task record; it is the difference between "the screen looked right" and "the
phone sent exactly this".

## Certificate modes (the `wrong` / `expired` / `not-yet` checkpoints)

| Mode | Advertised `certSha256` | Served leaf | Expected app behaviour |
|---|---|---|---|
| `ok` | the served leaf | valid window | pairing succeeds |
| `wrong` | a different leaf | valid window | `client/pin-mismatch`; **no upgrade request at all** |
| `expired` | the served leaf | `notAfter` in the past | refused: the pin matches, validity must fail |
| `not-yet` | the served leaf | `notBefore` in the future | refused: the pin matches, validity must fail |

`expired` / `not-yet` are the cases that distinguish a *pin* from a *pin plus validity window*. The
fixture serves them faithfully; whether the app refuses them is decided by the **native** trust
manager (`PinnedTrustManager` on Android, A047's validity window on iOS). Node's TLS stack accepts
them by design (the pin is the trust anchor), so the self-test only asserts that the fixture is set
up correctly and says so in its output.

## Test hooks the flows use

The screens carry `testID`s (`app/pair.tsx`, `app/index.tsx`, `app/session/[id].tsx`), so the flows
address elements **by hook** instead of by placeholder/label guesswork:

| Hook (`testID`) | Rendered in | Used for |
|---|---|---|
| `pair-manual-input` | `app/pair.tsx:116` | focus the paste field |
| `pair-submit` | `app/pair.tsx:131` | submit; `disabled` while the field is empty, so `enabled: true` is also the "the paste landed" proof |
| `session-composer` | `app/session/[id].tsx:159` | focus the composer / "session screen is open" |
| `session-send` | `app/session/[id].tsx:170` | send; `disabled` while the composer is empty |
| `session-row-<sessionId>` | `app/index.tsx:167` | open a specific session (`session-row-sess-alpha`, `-sess-beta`, `-sess-gamma`) |
| `sessions-tab-<tab>` | `app/index.tsx:96` | switch tabs without matching copy: `sessions-tab-running`, `-idle`, `-archived` |
| `approval-card-<approvalId>` | `app/session/[id].tsx:202` | wait for one specific card (`approval-card-apv-hash`, `-apv-null`) |
| `approval-approve-<approvalId>` / `approval-reject-<approvalId>` | `app/session/[id].tsx:235`, `:244` | decide a card; **absent** for a null-hash or refused card — that absence is the security assertion |
| `approval-state-<approvalId>` | `app/session/[id].tsx:208`–`:223` | the per-card notice/outcome line (`approval-state-apv-hash`) |
| `banner` | `app/index.tsx:71`, `app/session/[id].tsx:99` | whether *any* banner is up; the localised copy still decides *which* one |
| `workspace-home` | `app/(tabs)/index.tsx:101` | "we are on the Workspace tab", not a conversation |
| `new-session` | `app/(tabs)/index.tsx:205` | the authoring action; its `enabled` state is the grant/workspace gate (spec 011) |
| `new-session-reason` | `app/(tabs)/index.tsx:212` | *why* authoring is unavailable — the line separates "not granted" from "connecting" |
| `new-session-error` | `app/(tabs)/index.tsx:216` | the visible failure after a refused `session-create` (never a silent no-op) |
| `session-title` | `app/session/[id].tsx:199` | the created session really opened (header title, not just a route push) |

### Ids and escaping (read this before adding a selector)

React Native exposes `testID` to Maestro as the element id (accessibility identifier on iOS,
resource id/view tag on Android), and **Maestro matches `id` as a regular expression**. The flows
therefore stay inside a deliberately boring alphabet, and `check-flows.mjs` enforces it:

- the literal parts are written by us (`session-row-`, `approval-approve-`, …) and contain no
  metacharacters;
- the dynamic tails are checked against the code that produces them: `SESSION_ID` must be one of
  the fixture ids (`sess-alpha`, `sess-beta`, `sess-gamma`), `APPROVAL_ID` one of `apv-hash` /
  `apv-null` (`harness/gateway.mjs`), `SESSION_TAB` one of the app's tab enum values
  (`app/index.tsx`);
- an interpolated id tail must match `[A-Za-z0-9._-]`; anything else (a host-supplied session id
  with `.`/`+`/`(` or a real approval id) has to be escaped before it can be used in `id:` —
  or matched by a prefix instead of a whole value;
- **opaque runtime values are never interpolated into a matcher**. `PAIR_QR` / `EXPIRED_QR` and the
  expected `argsHash` are credentials-shaped strings: unescaped they are a broken regex, and Maestro
  logs its selectors. The paste is proved by `pair-submit`'s `enabled` state instead (FR-011).

Steps that still have no hook are matched by copy in **both** locales (`^Unlock$|^Mở khoá$` for
short labels, `.*substring.*` for sentences): the unlock gate button, the search field, "Review
again", "Cancel session", the pair error box and the update-required overlay. That is a copy-matching
limitation, not a missing-hook blocker, and the app defaults to Vietnamese for any device locale
that is not `vi`/`en` (`i18n/index.ts`, `detectLocale`), hence the alternation.

### What stays manual (and why)

| Step | Why it cannot be a flow |
|---|---|
| answering the biometric / passcode prompt | an OS dialog, not the app's view tree: `adb -e emu finger touch 1` (Android) or Features > Face ID > Matching Face (iOS) — see `subflows/unlock.yaml` |
| scanning the QR with the camera | needs a real camera aimed at a QR; T-02 covers paste, §5.1 of `docs/device-validation.md` covers the scan |
| OS permission prompts in the device language | A033 evidence: the dialogs belong to the platform (§5.2) |
| `expired` / `not-yet` certificate refusal | decided by the platform trust manager, not by the app's JS (A032/A047) |
| the install itself (dev build) | a local `expo run:*` build; nothing here uploads or installs |

### Remaining known gaps (not manual, just not hooked yet)

- the search field (`sessions.search` placeholder) — no `testID`;
- the pair error box and the update-required overlay — asserted by copy, both locales;
- `Review again` / `Cancel session` / `Forget` — plain buttons addressed by copy.

## Checkpoint → task map

| Checkpoint | Flow | Task | Server-side property asserted |
|---|---|---|---|
| T-01 cold start locked | `01-launch-unlock.yaml` | A040/A041 (A020) | nothing sent before unlock |
| T-02 pair by paste | `02-pair.yaml` | A040/A041 (A021, A046) | one code consumed, one socket, no violations |
| T-03 list/tabs/search | `03-session-list.yaml` | A040/A041 (A022, A046) | `sessions` + `search` requested |
| T-04 send prompt | `04-send-prompt.yaml` | A040/A041 (A023) | one prompt with a `clientMsgId` |
| T-05 approve exact hash | `05-approval-approve.yaml` | A040/A041 (US3) | receipt hash == pushed hash |
| T-06 null hash no buttons | `06-approval-null-hash.yaml` | A040/A041 (US3 §3) | the approval was never decided |
| T-07 mismatch → review again | `07-approval-hash-mismatch.yaml` | A040/A041 (A049) | refused hash ≠ accepted hash |
| T-08 network drop | `08-reconnect.yaml` | A040 (US5) | one socket after recovery |
| T-09 background lock | `09-background-relock.yaml` | A040/A041 (M5) | peak sockets ≤ 2, one at the end |
| T-10 revoke wipe | `10-revoke-wipe.yaml` | A040/A041 (FR-009) | no socket, credential gone |
| T-11 expired code copy | `11-pair-errors.yaml` | A040/A041 | no upgrade attempt |
| T-12 wrong certificate | `12-pair-wrong-cert.yaml` | A040/A041 (SC-002) | zero upgrades, no code/device id |
| T-13 401/403 mapping | `13-upgrade-refusals.yaml` | **A034** | refusal status recorded verbatim |
| T-14 protocol mismatch | `14-update-required.yaml` | A040/A041 (FR-004) | `client-hello` refused, socket closed |
| T-15 create a session | `15-authoring-create.yaml` | **Spec 011** | exactly one `session-create` for the chosen workspace; the created row served afterwards |
| T-16 authoring without the grant | `16-authoring-no-scope.yaml` | **Spec 011** | **zero** authoring frames (no `session-create`, not even `workspaces`) |
| T-17 `session-create` refused | `17-authoring-create-refused.yaml` | **Spec 011** | the tap reached the Host, nothing was created, the socket stayed up |
| T-18 not connected | `18-authoring-not-connected.yaml` | **Spec 011** | no handshake, zero authoring frames, no permission accusation on screen |

## Session authoring (spec 011) — the journey these four checkpoints lock down

The "create a session from the phone" path had no harness coverage: it was only in unit tests
(`newSessionAvailability`, `grantState`) and in manual device runs, so the UI half could rot
silently. `T-15`…`T-18` now drive it end to end, and they assert the **honest-failure** branches
too, because those are the ones that kept regressing: a device without `sessions:author` must show
the permission reason and send nothing; a refused `session-create` must show a failure line on the
same screen; and a connection that is not ready must never be reported as a permission problem.

State that drives them (control API, token-guarded `POST`):

| Route | Body | Effect |
|---|---|---|
| `/scenario/scopes` | `{"scopes":["sessions:read"]}` | what `hello.device.scopes` claims; `null` omits the field (older gateway → UNKNOWN, not "denied") |
| `/scenario/session-create-refuse` | `{"enabled":true,"code":"internal"}` | refuse `session-create`; a non-scope `code` is what the app reports as "could not create the session" |

The fixture's default scope set is `sessions:read`, `sessions:author`, `prompt:send`,
`approval:respond`, so the happy path needs no arming. `session-create` answers with a deterministic
id (`sess-created-1`) and serves `Created from phone` from every later `sessions`/`search` answer,
so the flow can address the new row by hook/text instead of an opaque value.

**Known limitation, stated rather than hidden:** on a cold start with no session list yet, the
Workspace home renders its loading state (`home.loadingSessions`) and does not draw the authoring
block at all (`app/(tabs)/index.tsx`), so the `authoring.connecting` / `authoring.reconnecting` copy
is not reachable on screen in that state. `T-18` therefore asserts what a device can prove — no
permission accusation, no enabled action, no authoring frame — and the connecting/reconnecting
decision stays covered by the unit tests for `newSessionAvailability`. Asserting that exact copy on
a device would need the home to render its action area while loading (an app change, not a flow
change).

## Notes and limits

- **No credentials, no EAS spend.** The fixture generates a self-signed leaf in memory per run; no
  key is ever written to disk. `run-e2e.mjs` never invokes EAS, never uploads and never installs.
- **Loopback by default; LAN is an explicit opt-in.** `run-e2e.mjs` and `harness/gateway.mjs` bind
  and advertise `127.0.0.1` unless `--bind`/`--lan-host` say otherwise: `--bind 0.0.0.0` (or the host
  IP) + `--lan-host <host-LAN-IP>` for a physical device, `--lan-host 10.0.2.2` for an Android
  emulator. A non-loopback bind prints a warning at startup. The control API is always `127.0.0.1`
  plus `x-fixture-token`, independent of `--bind`.
- **Android-only flow.** `08-reconnect.yaml` uses `setAirplaneMode`, which is a no-op on iOS
  simulators; use `POST /scenario/drop` plus the banner assertions there
  (`docs/device-validation.md` §4, T-08 and §5.4).
- **Local emulator only** for T-08: airplane mode kills Wi-Fi, so a device driven over adb-over-
  network would disconnect its own test.
- **Bundle id** in the flows is `com.dshext.companion` (`app.json`). Change it in `config.yaml` and
  every flow if the app's id changes. `config.yaml` lists `01-*` … `14-*`; `check-flows.mjs` fails
  if a numbered flow exists but is unlisted.
- The orchestrator's `http` calls are Node `fetch`; the Maestro built-in `http` client is an
  alternative for flows that must act mid-run, but its environment-variable exposure inside
  `runScript` was not verified here, so this repo keeps server-side actions in `run-e2e.mjs`.
- **No green run exists yet.** Nothing in this folder has been executed against a device, an
  emulator or Maestro on this machine: the flows are structurally checked (`check-flows.mjs`), their
  hooks are checked against `app/**`, and the wiring is dry-run — that is all this machine can prove.
  Do not report T-01…T-14 as passing without a `report.json` from a device run.

## Two-party pairing controls (contract §3.8)

The harness implements the real pairing handshake — `pairing-challenge` on accept, proof-only before
admission, then `pairing-pending` until someone approves — so a device run can exercise the flow that
a real computer performs. Default is **auto-approve**, which keeps the existing flows unchanged.
Token-guarded (`x-fixture-token`), `POST`:

| Route | Body | Effect |
|---|---|---|
| `/scenario/pairing/require-approval` | `{"enabled":true}` | hold every pairing in `pairing-pending` until you decide |
| `/scenario/pairing/otp` | `{"enabled":true}` | next challenge sends `otpRequired: true` |
| `/scenario/pairing/approve` | — | desktop Approve → the app receives `paired` then `hello` |
| `/scenario/pairing/reject` | `{"reason":"pairing/busy"}` | `pairing-rejected` then close **4403** |
| `/scenario/pairing/expire` | `{"reason":"pairing/expired"}` | `pairing-rejected` then close **4410** |

`approve`/`reject`/`expire` answer **409** with the current `pending` list when nothing is waiting.
The harness console prints the `verificationCode` and `requestId` of every pending pairing (no
secrets) so it can be compared with what the phone shows.

Real two-party run: start the harness, `POST /scenario/pairing/require-approval {"enabled":true}`,
paste the pairing string into the app, check the phone displays the same verification code, then
`POST /scenario/pairing/approve`. `reject` and `expire` produce the refused/expired screens.

Evidence fields the harness records: `pairingChallenges`, `pairingProofs`, `pairingRefusals`,
`pairingApprovals`, `pairingRejections`, `pendingPairings`.
