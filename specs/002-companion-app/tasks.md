# Tasks: Mobile Companion App

**Paths**: `MC/` = `apps/mobile-companion/`. Contract: `packages/mobile-protocol` (from 001 T007).

## Phase 1: Scaffold
- [x] A001 Create Expo TS app in `MC/` (expo-router template, SDK pinned exact), npm workspaces wiring to
  `@dsh-ext/mobile-protocol`; `tsc --noEmit` passes; no analytics deps
- [x] A002 Test harness: `node --test` with `tsx` for `MC/src/core/**`; `npm test` script

## Phase 2: Core (pure TS, tested) — US1–US5
- [x] A010 [US1] `src/core/qr.ts` parse/validate QR v3 (v, endpoint wss only, certSha256 hex64, code, expiresAt); tests
- [x] A011 [US1] `src/core/transport.ts` interface + Node test transport (`ws` + fingerprint check) + fake gateway
  (`test/fake-gateway.ts`, self-signed cert, implements contract v1 subset)
- [x] A012 [US1] `src/core/client.ts` hello / client-hello, version gate (`protocol/unsupported` → typed error),
  error-code mapping, `auth/revoked` → credential wipe callback; tests incl. wrong-cert refusal before send
- [x] A013 [US2] sessions store: list/search/projections, needsDecision from approval events; tests
- [x] A014 [US3] `src/core/approvals.ts`: card state machine, echo argsHash, null → no-approve,
  hash-mismatch → review, not-pending → already decided; tests
- [x] A015 [US4] `src/core/outbox.ts`: clientMsgId, retry, dedupe; cancel op; tests
- [x] A016 [US5] `src/core/reconnect.ts`: backoff 1/2/5/…/30 s, resync without dupes; tests (fake clock)
- [x] A017 redaction helper for app diagnostics (FR-011); test

## Phase 3: UI (typed, mock transport)
- [x] A020 unlock gate `_layout.tsx` (expo-local-authentication, SecureStore)
- [x] A021 `pair.tsx` (expo-camera QR) + error states
- [x] A022 `index.tsx` sessions 3 tabs + search + badge (FlashList)
- [x] A023 `session/[id].tsx` messages, approval cards (≤3 taps), composer, cancel
- [x] A024 i18n vi/en; offline banner; reconnecting banner
- [x] A025 local notification on approval-requested while backgrounded + deep link `dshcompanion://s/<id>?a=<approvalId>`

### Status 2026-11-09
- Phases 1–3 ✅ (commits `e17935d`, this). Lead re-ran: tsc 0, app 171/171, protocol 16/16, check:core OK; no unpinned socket in `src/` or `app/`.
- Open: iOS permission strings English-only (needs `InfoPlist.strings` in A031); session state mapping and history row shape inferred — verify against real gateway in A040.

## Phase 4: Native pinned WSS
- [x] A030 `modules/pinned-ws` Expo module: Android (OkHttp + pinned TrustManager), iOS (URLSessionWebSocketTask
  + challenge delegate), JS API; RN transport adapter
- [x] A031 config plugin / app.json for dev build; no cleartext (Android network security config, iOS ATS default)

### Phase 4 status 2026-11-09
- A030/A031 ✅ in TypeScript (200/200 tests, autolinking resolves `pinned-ws` on android + apple). **Kotlin/Swift are UNCOMPILED** (no Android SDK / Xcode here) — first build in A040/A041 will surface fixes.
- Lead decisions on coder questions:
  - Pin + `checkValidity()`: **keep** (expired leaf rejected); align Node test transport later (A032).
  - Hostname verifier returning true: accepted — identity is the leaf pin; reviewer to confirm.
  - 401/403 upgrade mapping by HTTP status: correct per contract §3/§6.
  - Empty `<trust-anchors>`: keep explicit (documents "no CA trusted").
  - iOS `InfoPlist.strings` not wired into pbxproj → A033.
- [x] A032 Node test transport: certificate validity window checked after matching the leaf pin and before HTTP upgrade; expired/not-yet-valid leaves fail closed. Coder verified typecheck/core checks and 212/212 tests (2026-11-09); native compilation remains unverified.
- [x] A033 iOS localized permission strings wired via `withXcodeProject`: PBXVariantGroup, localized references and one Resources entry; fixture/idempotency/migration tests pass (config suite 23/23; full app coder snapshot 289/289, 2026-11-09). Actual Xcode bundle and localized prompt verification remain required in A041; not native-build verified.
- [ ] A034 iOS: confirm URLSession exposes handshake status for 401/403 mapping (device test).

## Phase 5: Device builds & E2E (environment-gated)
### Real Android toolchain obtained — 2026-11-09
Owner approved and the lead installed the SDK: `C:\Android\sdk` (cmdline-tools 19.0, `platforms;android-37.0`, `build-tools;37.0.0`, `platform-tools`), `JAVA_HOME` repointed from the stale empty DXVK path to Adoptium JDK 21.0.12, `ANDROID_HOME`/`ANDROID_SDK_ROOT` set. First `expo prebuild --platform android` **succeeded** and generated `apps/mobile-companion/android` (gitignored): manifest has `android:usesCleartextTraffic="false"` + `@xml/network_security_config`, `RECORD_AUDIO` removed, generated `network_security_config.xml` trusts no CA and forbids cleartext. Gradle 9.4.1 + AGP 9 + Kotlin 2.2.10 downloaded; Expo autolinks the module as project **`dsh-ext-pinned-ws`**.
- **First real Kotlin compile ran** (`:dsh-ext-pinned-ws:compileDebugKotlin`). It failed with a genuine compiler error, which is exactly the evidence that static tests could not provide:
  `PinnedWsModule.kt:30:15 'registry' hides member of supertype 'Module' and needs an 'override' modifier.`
  Coder dispatched to iterate compile→fix until debug and release Kotlin compile clean, without weakening pin/TLS logic.
- Note: prebuild rewrote the app's `package.json` dev scripts to `expo run:android` / `expo run:ios` (standard prebuild behaviour; keep now that a native project exists). EAS identity (`owner`, `slug`, `projectId`) unchanged.
- **Kotlin module verified by the lead directly** (2026-11-09): `:dsh-ext-pinned-ws:compileDebugKotlin` → `BUILD SUCCESSFUL`, `:dsh-ext-pinned-ws:compileReleaseKotlin` → `BUILD SUCCESSFUL`, `e:` count 0 in both, 93 `.class` files produced. Single compiler fix was `PinnedWsModule.kt:30` renaming `registry` → `pinnedRegistry` (Expo's `Module.registry` is `ModuleRegistry`, not our socket registry). App-side `:app:compileDebugKotlin` also compiled (only a deprecation warning).
- **Local APK build conclusively impossible on this Windows host** (environment, not product code). Root cause and evidence: CMake mirrors the absolute source path of out-of-tree sources into the object directory (`CMakeFiles/react_codegen_…dir/C_/…/node_modules/react-native-gesture-handler/shared/shadowNodes/react/renderer/components/rngesturehandler_codegen`). Even with `LongPathsEnabled=1`, the SDK `ninja` does not honour long paths. Measured attempts: (a) original path → fails in `react-native-screens` and `react-native-worklets`; (b) project copied to `C:\w\app` (real short path, real `node_modules` copy) → those pass, then fails in the `react-native-gesture-handler` codegen target whose mirrored path is ~250–300 chars; (c) `node_modules` relocated to a short real root with a junction → Node cannot resolve `@react-native/gradle-plugin` because the short root must end in `node_modules`, and even the shortest workable layout leaves the mirrored component over 260. All temporary state was reverted (`C:\mbapp`, `C:\w`, `C:\n` removed; `node_modules` back in place); verified afterwards: `require.resolve('react-native/package.json')` and the gradle-plugin resolve succeed, `npm run typecheck` exit 0, **451/451 tests pass**.
- **Android emulator is provisioned and booted** as the device-verification target: `C:\Android\sdk` now has `emulator` 37.2.13 + `system-images;android-36;google_apis;x86_64`; AVD `dsh` created (pixel_6, x86_64); headless boot reached `sys.boot_completed=1`, `adb devices` = `emulator-5554 device`, API 36. Ready to `adb install` the EAS APK.
- **iOS project generation is blocked on Windows by Expo itself**: `expo prebuild --platform ios` prints "Skipping generating the iOS native project files. Run npx expo prebuild again from macOS or Linux" and exits 1. So the A033 pbxproj localization wiring can only be validated on macOS (fixture tests remain the only local evidence).
- **Device-transport path verified on the running emulator** (2026-11-09): `adb reverse tcp:34444 tcp:34444` configures, and `nc` from inside the emulator to `127.0.0.1:34444` returns `EXIT=0` while the host listener is up — so the app under test can reach a host-side fixture gateway over loopback through `adb reverse` (TLS pinning works unchanged because the tunnel is transparent TCP). Device shell has `nc`/`toybox` at `/system/bin` but **no `curl`**. This is the transport the device runbook should use instead of LAN binding, and it needs no firewall change.


- **FIRST DEVICE RUN — 2026-11-09 (real evidence, Android 36 emulator)**
  - EAS preview build **succeeded**: `e530bc27-bee5-4841-91e2-4784455b4091`, APK 114,357,273 bytes, SHA-256 `F30F5FFA…252ECE`, downloaded from the EAS artifact URL.
  - `adb install` **succeeded**; package `com.dshext.companion`, `versionCode=1`, `versionName=0.1.0`, `minSdk=24`, `targetSdk=36`.
  - App launches with **no crash**: process alive, `topResumedActivity=…MainActivity`, no `FATAL EXCEPTION` in logcat; screenshot is a valid 1080×2400 PNG showing the rendered gate.
  - **Runtime permissions match the design**: `CAMERA`, `USE_BIOMETRIC`, `POST_NOTIFICATIONS` declared; **`RECORD_AUDIO` and `READ_EXTERNAL_STORAGE` absent** (merged-manifest verify at runtime).
  - **The biometric gate is real, not mocked**: without a device lock the app shows "Set up a screen lock…"; after `locksettings set-pin 1234` the app invoked the **system BiometricPrompt** (`mCurrentFocus=Window{… BiometricPrompt}`, `BiometricService: handleAuthenticate … CredentialAvailable: true`). Screenshots are black while the prompt is up — the prompt runs on a secure surface, which is a platform protection, not an app bug. Entering the PIN through the prompt returned focus to MainActivity and the app advanced.
  - **Main screen renders**: "No sessions in this tab yet" + "Pair a computer"; tapping it opens the pairing screen with camera consent, the paste field and the Pair button (disabled while empty).
  - **Fail-closed negative test (real)**: submitting a corrupted pairing string produced "Could not pair — Pairing failed. Show a new code and try again." while the host fixture recorded **tcpConnections=0, tlsHandshakesCompleted=0, upgradeAttempts=0, offeredPairingCodes=0** — the app rejected the code locally and sent **zero bytes** to the network (SC-002 behaviour on device).
  - **BLOCKED (harness limitation, not product)**: a *successful* pairing on the emulator could not be automated *in the early attempts* — `adb shell input text` corrupted the token. This is now **solved** (see the successful-pairing entry below); the earlier diagnostics are kept because they explain the failure mode.
  - **SUCCESSFUL PAIRING ON DEVICE (2026-11-10)** — the milestone the previous rounds could not reach. With a clean emulator (fresh reboot), input injected in 40-char chunks and verified byte-exact through `uiautomator dump` (**435/435 chars, `exact=True`**), tapping **Pair** produced a real pairing against the loopback fixture gateway:
    - fixture evidence: `upgradeAttempts=2`, **`upgradeRefusals=0`**, `tcpConnections=2`, `tlsHandshakesCompleted=2`, **`tlsFailures=0`**, `offeredPairingCodes=1`, `consumedPairingCodes=1`, `deviceIds=[fe30878d-327b-4964-b2c5-fac40327efee, …]`.
    - device evidence (root read of the app's private storage, values redacted): `SecureStore.xml` holds exactly `install-id`, **`hosts`** and **`token.<gatewayId>`** where `<gatewayId>` = `c2e7d274-a934-4ffb-9501-6e0d141bfce1`, i.e. the fixture's own gateway id from that run. The app therefore parsed the QR, completed TLS with the **certificate pin accepted**, redeemed the one-time code exactly once, received a device id, and **persisted the credential and host record durably** — the `M9/A048` "persist immediately" design, verified on hardware-level storage.
    - the app then showed "Connecting to dsh-e2e…" and finally "Could not reach that computer", and the fixture recorded `clientHellos=0` with `openConnections=0`: the **authenticated re-connect after pairing failed** in this fixture setup. It is tracked as an open defect, **not** worked around.
    - **Diagnosis of that defect (same session)**: a temporary Node harness (since deleted, working tree clean) drove the app's own `CompanionClient` + `NodePinnedTransport` through the identical sequence against the same fixture: `paired` → **READY** → `sessions` returned the real fixture rows (`sess-alpha`, `sess-beta`, …), then a **fresh client reconnected with the captured token** → **READY** → `sessions` again OK. So the core client, protocol handling and the fixture are all correct.
    - **Pinpointed cause (supersedes the earlier "unauthenticated" reading)**: `srv-<n>` is *not* proof of a missing credential — the fixture assigns it when a socket has a valid token but no `X-DSH-Device-ID` header, which the app deliberately omits once paired. A second device run with per-socket diagnostics added to the fixture (`[fixture-conn]` line on close, names/booleans only) produced the decisive picture: **socket 1 (pairing)** `authenticated=true pairing=true`, device header present, 2 protocols offered, closed `1000 "pairing-finished"`, `frames=0` — normal; **socket 2 (bearer)** authenticated and stayed open, yet `clientHellos=0` and `frames=0`. So the app opens the authenticated bearer socket, the gateway sends `hello`, and the app **never replies with `client-hello`** — while the identical sequence succeeds in Node through the app's own client. The remaining fault is therefore in the device-side delivery of the *second* socket's inbound frames (audit-trail hypothesis: the native module emits the `hello` for socket 2 before/without the JS listener for that socket id being wired, or the second socket's events are attributed to the first). Confirming it needs either a debug build or a boolean `authHeaderPresent`/`messageCount` surfaced from the native `onOpen`/`onMessage`.
    - Coder fix already applied and verified in JS (`451/451`, typecheck, core check clean): the bearer credential now rides **two carriers** — `Authorization: Bearer …` *and* the contract §3.4 `dsh-auth.<token>` subprotocol — so a single dropped header can no longer silently strip the credential; plus a fixture-fidelity change so an authenticated socket resolves its device from the token. Neither can fix a missing inbound `hello`; the native event-delivery investigation above is the next step.
    - **Second device run, over the emulator's host alias instead of `adb reverse`** (`--lan-host 10.0.2.2`, endpoint `wss://10.0.2.2:3443`), with per-socket fixture diagnostics: pairing socket again normal (`authenticated, pairing, deviceHeader set, 2 protocols, closed 1000 "pairing-finished", frames 0`), and the bearer socket now reports `authenticated=true, pairing=false, offeredProtocolCount=1, frames=0, code=1006` — an **abnormal** close. Two conclusions: (a) the `adb reverse` hypothesis is **disproved** (real LAN path behaves identically), and (b) the bearer socket **is authenticated** (the Authorization header arrives) yet the app destroys it abnormally with zero frames, i.e. the client aborts before sending `client-hello`. `offeredProtocolCount=1` confirms this run used the **old JS bundle** (pre-dual-carrier fix), so the next step is a rebuilt APK carrying the JS fix, and — if it still fails — the native `onOpen`/`onMessage` boolean instrumentation to separate "JS never replied" from "native never delivered `hello`".
  - Root cause of the earlier input corruption (for the runbook): a long `adb shell input text` on a *stale* emulator session splits/corrupts the token; after a clean reboot, chunked injection of 40 chars with `uiautomator dump` verification is byte-exact. The QR TTL is 5 minutes — the code must be submitted within that window or the gateway answers `pairing/expired` (observed once and diagnosed).

- [~] A040 [env: Android SDK] Android build **DONE via EAS** — APK built, installed and launched on the Android-36 emulator with the biometric gate, main screen and pairing screen verified, plus a fail-closed zero-byte rejection of a bad code (see the device-run block above). Remaining: the positive pairing → list → open → approve → reconnect flow, blocked by emulator text-injection limits rather than by the app.
- [ ] A041 [owner: macOS/EAS + Apple account] iOS build + same flow
- [ ] A042 [owner: APNs/FCM credentials] remote push via gateway
- [ ] A043 reviewer (`sol61-opus55`) full review — mandatory before distribution. Initial independent source review 2026-11-09: **FAIL**, no Critical demonstrated, 10 Major findings; remediation and re-review required (see below).

### Independent review remediation — 2026-11-09
Evidence: source review only, not native compilation. Do not distribute or consume another EAS build until verified build blockers are fixed.
- [x] A044 Native build blockers M1–M4: strict module JSON, Kotlin exception property, Swift `Error`/close-code types, redundant `URLSessionTaskDelegate` conformance removed, explicit OkHttp 4.9.2 matching installed RN. **Now verified by a real compiler** (not static): `compileDebugKotlin` and `compileReleaseKotlin` both `BUILD SUCCESSFUL`, 0 `e:`, 93 class files; one genuine error found and fixed (`PinnedWsModule.kt:30` `registry` → `pinnedRegistry`). Swift remains uncompiled (no macOS).
- [x] A045 Controller M5/M6: background lock tears down the authenticated client and reconnect loop, generation/attempt guards on every post-await mutation, authoritative one-shot close, failed-native-connect terminal close, 10 s handshake deadline (open/hello/ACK), ready→Reconnector.onOpen/resync wiring, cold-start initialization sequenced before unlock. Reviewer accepted the targeted areas; 451/451 tests and typecheck pass. No device proof.
- [x] A046 Contract M7: canonical `sessionId`/`running` rows project into local session model; shared types/JSDoc corrected, legacy `id`/`state` fallback documented. Coder verified protocol 20/20, focused sessions 23/23, typecheck and core checks (2026-11-09). `argsPreview` remains type-optional for pre-2.1 compatibility.
- [x] A047 iOS M8: explicit pinned-leaf DER validity window (strict UTCTime/GeneralizedTime, full TBS structure and extension shape) evaluated after the pin and before `.useCredential`; one shared checker now serves BOTH challenge routes; no CA fallback, HTTP 401/403 upgrade status mapped. 94 focused static/mirror tests pass, including real gateway-shaped P-256 certs. Swift uncompiled and no device TLS test.
- [x] A048 Pairing M9: `paired` accepted single-shot only on a pairing socket in `waiting-hello`; token persisted immediately (one-use recovery) while success now requires the accepted `client-hello` ACK on the intended connection, bounded by `pairAckTimeoutMs` and aligned with the client handshake deadline; terminal outcomes reject without claiming a connection and keep the credential/host for retry. Race tests cover slow storage, lock, forget, revoke and newer pairing.
- [x] A049 Approval M10: every hash ever refused for a card is permanently non-decidable (A→B→A covered), identity (approval/rpc/session) validated, reload applies only a genuinely fresh replayed view, controller waits for `replay:true` matching identity, stale cache never re-enables buttons. Card 25/25, controller M10 27/27.
- [x] A050 Minor follow-ups: orphan request isolation, iOS upgrade-status mapping, strict QR bounds (300000 ms TTL, canonical 32-byte code, UUID v4, input size bound), production diagnostic buffers reduced to counters with token clearing, actionable update-required overlay, native socket generation ownership and bounded tombstones, TLS-localization resources registered. Consolidated verification: 451/451 app tests, Expo Doctor 20/20.
- [ ] A051 Final distribution gate: **remaining** — installable APK (EAS build queued/verifiable), iOS build (needs macOS + Apple account), on-device E2E (pairing, TLS pin, 401/403, reconnect, biometrics, localized prompts), remote push credentials, and a final whole-product reviewer pass. Native Kotlin now compiles; Swift/device behaviour does not yet have evidence.

### Current acceptance checkpoint — 2026-11-09
- Final targeted independent reviewer: **no Major findings in scoped source re-review** of credential instance ordering (revoke AND forget), initialization/lifecycle guards and all-refused-hash history. This supersedes the earlier REQUEST CHANGES checkpoint below; it is not a whole-product/native/device acceptance.
- Lead directly reran `npm run typecheck`, `npm run check:core`, `npm test`: **451/451 pass**, 70 suites, 0 fail; offline Expo Doctor **20/20 pass**. These results supersede older concurrent-tree snapshots.
- Native source fixes and E2E infrastructure implemented: shared pin+validity check on both iOS challenge routes, structural DER checks, socket generation ownership, strict QR, Xcode localization resources, hook-based flows, loopback-default fixture. Kotlin/Swift remain uncompiled and all device flows remain unexecuted.
- Owner approved constitution v1.1.1 `argsHash`/normal-refusal alignment; workspace rules and coder/reviewer briefs synchronized. Prior terminology conflict resolved without changing wire vocabulary.
- Still required: actual Android/iOS compilation and devices, native TLS/401403/races/biometrics/localization evidence, real hardened gateway integration, remote push credentials/integration and final distribution review. Gateway core remains reserved by active spec005 session per owner confirmation.

### Historical focused re-review — 2026-11-09 (REQUEST CHANGES, superseded for targeted source above)
- M5 remains open: credential save/delete must share per-gateway revision ownership; queued/in-flight revoke cleanup must never delete replacement same-gateway token, while lock/other-host switch must not retain revoked old credentials. Coder dispatched in app-state/controller-race scope.
- M5 cold start remains open: await initialization before unlock and guard delayed start state writes; layout/client coder dispatched, app-state initialization guards require same-owner follow-up.
- M10 remains open: a single refused hash is insufficient for A→B→A; per-card refused-hash history coder dispatched.
- M9 ordinary source flow accepted by reviewer: immediate persistence plus bounded accepted-ACK success, subject to remaining M5 races. M6 local-close and reconnect-generation source fixes accepted; error-only handshake timer robustness follow-up in progress.
- Lead directly measured typecheck/core checks and 427/427 app tests before last added case; coder later measured 428/428. Neither substitutes for independent acceptance or native/device tests.
- Normative contract uses `argsHash` and normal refusal receipts; constitution/role brief still say `payloadHash`/409. Resolve documentation inconsistency before gateway integration; do not silently change wire vocabulary.

### Re-review checkpoint — 2026-11-09
- Controller first-pass snapshot: 289/289 tests, typecheck/core checks pass. Independent reviewer still rates M5/M6/M9/M10 PARTIAL: green tests missed production-adapter close semantics, silent handshake deadlines, delayed storage/biometric/revoke races and refused-hash replay. Do not use that snapshot as final acceptance.
- Follow-up ownership: pairing + async storage guards (`app-state.ts`, controller tests) still in progress; revocation post-delete generation guard queued to that owner. Production close/error/deadline implementation complete: authoritative one-shot close, failed native connect terminal close and 10000 ms open/hello/ack deadline; focused client/production-adapter tests 61/61, coder full snapshot 398/398, typecheck/core checks pass. Refused-hash/identity core defense and biometric/stopped-resync guards implemented with focused tests; independent integrated re-review remains required. Pair ACK waiter currently has separate bounded timeout; reconcile client timeout/disconnect handling in final controller review.
- Reviewer confirms N1 orphan ordinary request isolation, N6 diagnostic secret-buffer removal and N7 actionable update-required UI fixed at source level; no rendered-device proof.
- Native follow-up implemented explicit OkHttp 4.9.2 matching installed RN, pinned leaf DER validity + HTTP response status mapping (16/16 static guards). Structural tail parser follow-up: 59/59 focused mirror/static tests including actual gateway-shaped generated leaf. Native lifecycle race coder and focused independent reviewer still pending. Swift/Kotlin remain uncompiled.

### ROOT CAUSE FOUND — the device sent no application frame at all (2026-11-10)
This supersedes every earlier diagnosis in the device-run section above (the "no credentials", "adb reverse" and "dropped hello" readings were all wrong).

- **Symptom**: pairing completed and the token was stored, but the gateway received **zero frames** from the phone on **both** sockets, the bearer socket was closed by the client at its 10 s deadline (`1006`), and the app showed only "Could not reach that computer". Nothing in `adb logcat` or the fixture evidence explained it.
- **How it was found**: the failure is decided inside JS, and a release build's JS console goes nowhere, so a redacting, opt-in file trace was added to the app's existing `DebugLog` (`src/platform/debug-log-file.ts`, enabled only by an `EXPO_PUBLIC_DSH_DEBUG_LOG=1` build via the new `diagnostic` eas.json profile) plus a transport-level trace, and pulled with `e2e/device/pull-debug-log.ps1`. With `setprop log.tag.PinnedWs DEBUG` the native lines and the JS lines could be correlated by socket ref.
- **Evidence**: the JS trace showed `connecting → waiting-hello → waiting-client-hello` on the bearer socket (so `hello` **was** delivered and processed), then **no `send` line at all**, then `client/timeout`; the native log showed `onOpen` and `onMessage ... delivered=1` and **no `send` line either**; the fixture showed `frames=0`.
- **Cause**: `defaultRequestId()` threw. React Native 0.88.1 exposes no Web Crypto, so `globalThis.crypto.randomUUID` is `undefined` on a device, and the old implementation threw `client/bad-state`. `sendClientHello()` calls it **before** `transport.send`, so the exception unwound into the native listener hook, which `addPinnedWsListener` swallows **by design** — the client stayed in `waiting-client-hello` looking healthy while nothing was ever written. `defaultClientMsgId()` in `outbox.ts` had the identical defect, so the handshake fix alone would have moved the failure to the first prompt.
- **Why every test and check was green**: Node **has** `crypto.randomUUID`. The whole suite exercised a code path the device never takes. Seven consecutive EAS builds were "correct" by tests and broken on hardware.
- **Fix (verified by execution)**: both generators now fall back in three steps — `crypto.randomUUID()` → `getRandomValues()`-based RFC 4122 v4 → a documented, never-throwing counter/random fallback that still satisfies the contract (`requestId` `[A-Za-z0-9._-]{1,64}`; `clientMsgId` 1..128, mirrored from the gateway's own rule at `plugins/mobile-gateway/lib/index.mjs:4447-4452`). Additionally: a frame-build/send failure now surfaces as an emitted `client/*` error plus a terminal connection finish instead of an exception escaping into the listener, `startPing()` is wrapped (a throw in a timer callback is an uncaught exception on device), and `outbox` ids are seeded from the per-install id at the `app-state` layer so the host's at-most-once dedup key cannot collide across restarts. App suite **484/484**, typecheck + `check:core` clean.
- **Method lesson recorded**: a green unit suite cannot prove a runtime it does not model. Any code that touches `globalThis.crypto`, timers, `Intl`, storage or the native bridge needs at least one device-executed check before it is called done.

### VERIFIED END-TO-END ON DEVICE — first working run (2026-11-10)
After the crypto fix, the same scripted pairing run (`e2e/device/run-pairing-with-trace.ps1`) produced the first genuine device success:

- Fixture evidence: **`hellos=2`, `frames=3`, `open=1`** — the phone finally wrote application frames:
  ```
  {"type":"client-hello","requestId":"fbmw9xc2qf0z8t.1.0tq93nw0","companionProtocol":1,"appVersion":"0.1.0","platform":"android"}
  {"type":"client-hello","requestId":"fbmw9xc2qf0z8t.2.1daun151",...}      ← bearer socket
  {"type":"sessions","requestId":"fbmw9xc2qf0z8t.3.1d5qoc00"}             ← real op after `ready`
  ```
  The ids are the documented portable fallback (`<processTag>.<counter>.<random>`), which the gateway accepts and echoes.
- Native evidence: `send id=… dispatched live=1` / `send id=… ok chars=127` / `send id=… ok chars=59` — the send path is exercised and acknowledged, and the previously silent `no-live-socket` path is not hit.
- **Rendered result on the emulator** (screenshot captured): the app shows the session list fetched over the pinned WSS connection — header "DSH Companion", search field, Running/Idle/Archived filters, and the fixture's session row "Refactor gateway TLS — running · updated 1 min", plus "Pair a computer" / "Forget this computer".
- What this proves: pin-verified TLS, `paired` → token persisted, close of the one-time socket, bearer reconnect with the stored token, `hello` → `client-hello` → ack → `ready`, and a real `sessions` request answered and rendered.
- Not yet exercised on device: opening a session, sending a prompt, the approval card/decision path, revoke/reconnect after a token drop, localised permission dialogs, and the 401/403 mapping. The trace tail also shows the expected `connect-failed` retry loop once the fixture is stopped, which is correct behaviour.

### VERIFIED END-TO-END — session open and prompt write (2026-11-10, same session)
Continuing the same device run (a second scripted pairing against a fresh fixture), the read **and write** paths were exercised and proven:

- Frame log from the fixture (12 frames) shows the whole conversation: `client-hello` ×2 → `sessions` → `ping` ×2 → `subscribe {sessionId:'sess-gamma'}` → `history {sessionId:'sess-gamma'}` → `ping` → … → **`message`**.
- The write: `{"type":"message","requestId":"fbmw9xgff40ii9.b.1rb9bo00","sessionId":"sess-gamma","text":"hello_from_device","clientMsgId":"mw9xjlx2.cmw9xjlx20ic30281.1.08i0dnj1ns"}` — and the fixture's `prompts` array recorded exactly one applied prompt with that `clientMsgId`. The id is the install-scoped form (`<installId>.<processTag>.<counter>.<random>`), which is what the app-state injection produces on a device with no Web Crypto.
- Rendered proof (screenshots captured): the session detail screen shows the fetched transcript (`USER: Please refactor the TLS listener` / `ASSISTANT: Working on it.`), the newly sent turn (`USER: hello_from_device` with the `sending…` marker), the composer cleared and the Send button disabled, plus "Stop session". The session list screen was also verified to filter correctly by tapping the Running/Idle/Archived chips (the fixture's archived row appeared under Archived).
- UI hooks resolved from `uiautomator dump` on the device: `sessions-tab-running|idle|archived`, `session-row-sess-gamma`, `session-composer`, `session-send` — the same ids the Maestro flows use, so the flows and the manual path agree.
- Still to exercise on device: the approval card + decision (exact `argsHash`), revoke and re-pair, the localised permission dialogs, and the 401/403 mapping.

### VERIFIED END-TO-END — approval card, exact decision and hash-mismatch (2026-11-10, same session)
The product's core security flow was exercised on the emulator against the fixture and proved correct:

- **Card renders from a gateway push.** `POST /scenario/approval/raise` (approvalId `apv-device1`, `shell.exec`, preview `npm test`) produced the card in the open session; `uiautomator dump` shows the hooks `approval-card-apv-device1`, `approval-approve-apv-device1`, `approval-reject-apv-device1` and the copy "Approval needed: shell.exec" / "npm test".
- **Approve sends the exact hash.** Tapping Approve emitted
  `{"type":"approval-response","requestId":"fbmw9xgff40ii9.k.0htjj571","rpcId":"rpc-80418483","sessionId":"sess-gamma","approvalId":"apv-device1","argsHash":"3a4696a6cdebcdd2c45fc26a03124a746b01f0e6a30409ad14d521c3b37122f4","outcome":"allowed-once"}`
  and the fixture recorded `argsHash === expectedArgsHash`, `accepted: true`, `outcome: "allowed-once"` — the decision is bound to exactly the request that was shown, applied at most once. The card then rendered "Allowed once" with no controls.
- **A changed request is refused, not silently applied.** Raising `apv-mismatch` and then rotating the hash server-side (`/scenario/approval/mismatch-once`) made the same Approve action produce a receipt with `accepted: false`, `reason: "hash-mismatch"` and `argsHash !== expectedArgsHash`. The UI did **not** pretend success: it showed "This request changed since you opened it. Review it again." with a **Review again** action, and the request stays pending — the normal-refusal form required by the constitution v1.1.1 alignment.
- `protocolViolations` stayed **empty** across every one of these actions (12 → 20 frames), i.e. no frame broke the wire contract.
- Remaining device work: revoke / re-pair / token expiry, the localised permission dialogs, and the 401/403 mapping.

### VERIFIED END-TO-END — wrong certificate leaks no credential (2026-11-10, same session)
The claim that mattered most — *a credential is never sent to a server whose leaf does not match the pin* — was measured on the device, not argued. The fixture was started with `--cert-mode wrong` (it serves a certificate whose leaf hash differs from the one in the pairing QR) and a normal pairing was attempted:

```
tcpConnections=1  tlsHandshakesCompleted=0  tlsFailures=2
upgradeAttempts=0  offeredPairingCodes=0  consumedPairingCodes=0  clientHellos=0  frames=0
```

- TLS **never completed** (`tlsHandshakesCompleted=0`, two aborted attempts), so **no HTTP upgrade reached the server** (`upgradeAttempts=0`) and therefore no credential could be presented: the pairing code was never offered and never consumed, and not a single frame was written.
- The app told the user the truth and did not invent a generic failure: **"That computer is not the one the code belongs to. Nothing was sent. If its certificate changed, pair again with a fresh code."**
- This is the device-side proof of contract §3.1 (no application frame without a verified leaf) and of the "secure by default" rule: the one-time code stays valid, so a genuine re-pair is still possible.

### Device run — revoked device is now explained (2026-11-10)
The gateway revoking a device (`code=4401`) was measured: the client reached `state: "revoked"`, stopped retrying, and the stored `token.*` entry was removed while `install-id` and `hosts` survived. The screen, however, showed only the empty state, because `app/index.tsx` returned the no-host layout **before** rendering the banner. Fixed by extracting a single `Banner` component used by **both** layouts (keeping the `banner` test hook and the localised accessibility label), so a revocation is explained wherever the user lands.

Verified on the device after the fix, on both screens the user can land on:
- session detail: a warning banner "This device was removed from the computer. Pair again to continue." above the (now empty) transcript;
- session list / no-host state: the same banner above "No sessions in this tab yet." and the "Pair a computer" action — the exact branch that used to swallow it.

Post-revocation storage was read directly on the device (`shared_prefs/SecureStore.xml`): `install-id` and `hosts` are still present while **no `token.*` entry remains**, i.e. the revoked credential is gone and the device identity needed to pair again is kept. The revoked copy already existed in both catalogues ("This device was removed from the computer. Pair again to continue." / "Thiết bị này đã bị xoá khỏi máy tính. Hãy ghép đôi lại để tiếp tục."). A new source-level test guards the no-host branch, and one honest detail is recorded: the first version of that test counted the literal `testID="banner"` text and therefore matched the component's own doc comment — fixed by removing the literal from the comment and counting real JSX hooks instead of raw text (no threshold was relaxed). App suite **495/495**, typecheck clean.

### VERIFIED END-TO-END — full credential lifecycle: revoke → explain → re-pair (2026-11-10)
The last untested link of the credential lifecycle was closed on the device, on the **same app install** that had just been revoked (no data wipe between the steps):

1. The gateway revoked the device; the socket closed `4401`, the client showed the revoked banner, and the stored `token.*` was removed while `install-id` and `hosts` survived (measured earlier).
2. From that exact revoked state, "Pair a computer" was tapped, a fresh one-time code was pasted, and pairing succeeded: fixture `hellos=2, frames=3, consumedPairingCodes=1, openConnections=1`.
3. The UI returned to a working session list — the banner is gone and "Refactor gateway TLS / running" is listed with search and the Running/Idle/Archived filters.
4. Storage read back on the device afterwards: `install-id` (**unchanged**), `hosts`, and a **new** `token.<newGatewayId>` — the device identity is stable across a revocation while the credential is replaced, which is exactly what the M5 ownership work existed to guarantee. The bearer socket connects with `headerNames=[authorization]`.

So the whole lifecycle is device-verified: pair → use → revoke (told clearly, credential dropped) → re-pair → use again.

### VERIFIED ON DEVICE — permanent upgrade refusal now terminates (2026-11-10)
Found by testing the 403 path on hardware, then fixed and re-verified:

- **Defect**: with the fixture answering the WebSocket upgrade with **HTTP 403**, the transport mapped the status to `remote/disabled` correctly, but the client only turned that code into the terminal `gatewayDisabled` outcome when it arrived as an **in-band `kind:'error'` frame**. An upgrade-level refusal travels through the transport's *error event*, so the client merely emitted `error`, closed with `retry: true`, and the reconnect loop hammered a permanently refused host forever; the `gatewayDisabled` handler in `app-state` (banner `gateway-off`, `reconnector.stop()`) never ran. Measured trace before the fix: the same four lines repeating every 30 s (`client/upgrade-failed` → `error remote/disabled` → `closed` → `disconnected {retry:true}`).
- **Fix**: a pure, exported `classifyUpgradeRefusal(code, details)` in the core reads only the code and `details.status` (never a message string): 403 → `gatewayDisabled`, state `gateway-disabled`, close **4004**, `retry: false`; 401 → `reauthRequired`, state `reauth-required`, close **4003**, `retry: false` (deliberately does **not** wipe the credential — that stays reserved for `auth/revoked`/4401); any other status keeps retrying exactly as before. `details.status` was confirmed to be populated end to end (native `status` → `PinnedWsError` → transport `details`), so no string parsing is involved.
- **Re-verified on the device**: after arming 403 and dropping the socket the fixture recorded `upgradeAttempts=3, upgradeRefusals=1, openConnections=0` and **stopped there** (previously it grew without bound), and the screen showed the correct, honest state: **"Remote control is off on your computer. Auto-reconnect is paused."**
- App suite **502/502**, typecheck clean. One existing test had to be widened (`deferred<{code:number}>` → `{code:number|string}`) because the `reauthRequired` payload now carries either the 4003 close code or the contract code `auth/required` — no assertion was loosened.

## BLOCKING PROTOCOL GAP found against the live gateway (2026-11-10) — **RESOLVED and verified against the live Host**

**Status: FIXED and proven end-to-end against the real gateway, not a fixture.** The whole chain now runs: challenge → proof → pending → desktop approval → `paired` → `hello` → real session data. Measured frames from the live LAN listener (`wss://100.64.1.2:30081/ws/mobile`, pin `906be9d7…`):

```
+10ms  OPEN
+11ms  <- {kind:'pairing-challenge', serverNonce, certSha256:'906be9d7…', otpRequired:false}
+12ms  <- {kind:'pairing-pending', verificationCode:'755490', requestId, expiresAt}
+13ms  >>> desktop approves that requestId via the /mgw management API
+88ms  <- {kind:'paired', token:'_4WVBaT8…', device:{id, name:'e2e-approval', kind:'mobile', scopes:[6]}}
+98ms  <- {kind:'hello', gatewayId, gatewayName:'the-owner-pc', protocol:3, companionProtocol:1,
             dshVersion:'0.2.2-rc.1', authenticated:true, capabilities:['sessions-read','prompt','cancel','approval-v1']}
+99ms  <- {kind:'session-archives'}, {kind:'session-queues'}, {kind:'projection-baseline'}   ← real Host state
```

The test device was then revoked through `POST /mgw/devices/<id>/revoke` → `{"revoked":true}`, leaving only the owner's desktop device — verification leaves no residue.

Delivered in three slices, each keeping the suite green (the original single 6-file change was twice handed back rather than half-landed, which produced the mechanical edit map that let the third attempt land in one pass):
- **A** — `packages/mobile-protocol`: `PAIRING_PROOF_TYPE`, `PAIRING_NONCE`, frozen `PAIRING_CLOSE_CODES` (separate from `CLOSE_CODES`, whose exact-equality test would otherwise break), `createClientNonce()` that **throws** rather than degrade to `Math.random`, frame typedefs + `index.d.ts`.
- **B** — the client half: answers the challenge once, emits `pairingPending`, maps 4403/4408/4410 by **code** to distinct errors, and — the hard part — stops the old deadlines governing the approval wait: `pairing-pending` clears the transport handshake budget and arms a deadline from the Host's `expiresAt` (capped, never shortened, by a 5 min + 30 s `pairApprovalTimeoutMs`), and `AppController.pair()`'s hard-coded 20 s `withTimeout` became a deferred re-armed from `expiresAt`. `otpRequired: true` fails honestly with `client/pairing-otp-unsupported` instead of sending a proof the Host would close on; an OTP entry screen is a separate spec.
- **C** — both fixtures strict: `test/support/fake-gateway.ts` (what all tests pair through) and `e2e/harness/gateway.mjs` now send the challenge, refuse any other pre-admission frame with `op/forbidden` (3rd → 4403), close 4403 `pairing/bad-nonce` / 4410 for a missing `otpProof`, consume the one-time code, and mint `paired`+`hello` only after an explicit approve; controls `approvePairing`/`rejectPairing`/`expirePairing`, with `autoApprovePairing` default true so existing tests kept their shape. Device controls: `POST /scenario/pairing/{require-approval,otp,approve,reject,expire}`.

**Final counts**: app suite **550 pass / 0 fail / 0 skipped**, `typecheck` + `check:core` clean, `e2e/harness/selftest.mjs` 72/72.

**The most useful signal from slice C**: strictness exposed exactly one failure in 541 — `test/transport.test.ts` hand-wrote `client-hello` onto an unadmitted pairing socket, i.e. a test that had been asserting the broken behaviour. It was fixed to speak the protocol with its original assertions kept; no fixture was weakened and no `src/` file changed in that slice. Because the fixture can now no longer express "a client that never answers the challenge" — precisely the shipped bug — the nine new tests drive a raw `ws` client to keep that failure mode covered.

### Device verification against the live Host over LAN/TLS — the real product loop, on hardware (2026-11-10)

The pairing-proof work was verified twice: at protocol level, and then **on the Android device against the owner's own running Host** — this is the first time the companion has paired with a real computer rather than a fixture.

Build: `1BbthqmXKO2to0QV-WcP9ByhnE17pMWJbndBTAzCiWI.apk`, 114,442,613 bytes, SHA-256 `0D482F87BFCCE5AE940F6E15CC4D85D6C9C58AFECA32D642D2F45A6173A8A6C0`, `versionCode 2`.

What happened, in order:
1. `pm clear` + launch → the unlock gate, then the pairing screen.
2. The app normally requires a screen lock before it will pair (correct: the credential must be protected); the emulator had none after a wipe, so a PIN was set.
3. A LAN-pinned offer was minted with `{publicUrl:'wss://100.64.1.2:30081/ws/mobile', endpoints:[same]}` — 482-char pairing string — pasted into the app in 30-char chunks and confirmed **byte-exact (482/482)** before submitting.
4. Submitting produced a **pending request on the Host**, auto-approved by a watcher through the same route the desktop UI uses (`POST /mgw/pending/<id>/approve`):
   ```
   PENDING  id=7fab35d5-446a-4e76-be92-67d6936606aa code=132822  16:12:57
   APPROVED id=7fab35d5-446a-4e76-be92-67d6936606aa             16:12:58
   ```
5. The app then showed the **owner's real session list** — ten live DSH sessions with their titles and relative update times ("Bạn là chuyên gia reverse", "You are the implementation coder", "Bản Android iOS của DSH", …) — and `GET /mgw/status` reported `connectedClients = 2` with the device listed as `mobile`, `lastSeenAt` current.

**Conclusion**: the whole chain works on hardware against the real Host — TLS pin, LAN endpoint, challenge, proof, pending, desktop approval, `paired` token, `hello`, and real session data.

Also confirmed: the desktop side of the two-party flow **already has a UI** — `@dsh-ext/devices` ships a `PendingRequests` view that polls `/mgw/pending` and posts to `/mgw/pending/<id>/approve|reject`, with the exact copy the flow needs ("Check that the code below is the same one shown on the other device before you approve"), in English and Vietnamese. So the approval step is usable by a human without any API call, which is what makes the 5-minute wait practical.

Measured environment notes for repeat runs: after `pm clear` the Gboard IME accepts no injected text until `pm clear com.google.android.inputmethod.latin` (the recorded fix), and `adb shell input text` truncates a long paste, so the pairing string must be typed in 25–30-char chunks and verified byte-exact.


The companion could not pair with the real gateway at all, and the cause was a missing half of the pairing protocol — not the network. Reproducing the companion's exact first connection against the live LAN listener gave: `paired` → `pairing-challenge` → `op/forbidden` ("only the pairing proof is accepted before the Host approves") → `pairing-rejected` → close `4408 pairing/timeout`; on the device this appeared as `tls pinMatched=true` → `onOpen` → `close 1006` after ~9.5 s. Grepping the whole tree found **no implementation of `pairing-challenge` / `serverNonce` / a proof anywhere** — not in the app, not in `packages/mobile-protocol`, and not in either fixture, which accepted the bare frame and is why every pairing test passed while the product could not pair. This was the **second "green but vacuous" gate found the same day** (the first was the flaky-port helper whose probe silently validated nothing), and both share one lesson: a check must be proven to fail when it should, not merely to pass.

**The companion cannot pair with the real gateway, and the cause is a missing half of the pairing protocol — not the network.** Measured, not inferred.

Reproducing the companion's exact first connection against the live LAN listener (`wss://100.64.1.2:30081/ws/mobile`, TLS pin matched) gives, frame by frame:

```
+   11ms OPEN -> {"type":"paired","requestId":"pair-1","pairingCode":"…","clientVersion":"1.0.0"}
+   12ms <- {"kind":"pairing-challenge","serverNonce":"…","certSha256":"906be9d7…","otpRequired":false}
+   13ms <- {"kind":"error","code":"op/forbidden","requestType":"paired",
            "message":"only the pairing proof is accepted before the Host approves"}
+15013ms <- {"kind":"pairing-rejected","reason":"pairing/timeout"}
+15015ms CLOSE code=4408 reason="pairing/timeout"
```

On the device the same attempt shows `tls pinMatched=true` → `onOpen protocolNegotiated=true` → `close code=1006` after ~9.5 s, which is this same rejection seen from the client side (the socket is dropped without a close frame from the app's perspective).

**Cause**: the gateway answers the first `paired` frame with a `pairing-challenge` carrying a `serverNonce` and requires a **pairing proof** derived from it before the Host approves; a bare `paired` is refused with `op/forbidden` and the offer dies as `pairing/timeout` (close 4408). The app sends only the bare `paired` frame. Grepping the whole tree, **no code anywhere implements `pairing-challenge` / `serverNonce` / a pairing proof** — not `apps/mobile-companion/src/core`, not `packages/mobile-protocol`, and not the e2e fixture `apps/mobile-companion/e2e/harness/gateway.mjs`, which accepts the bare frame and is therefore why every pairing test passes while the real product cannot pair.

Also observed and worth fixing: the gateway upgrades to 101 **without echoing a `Sec-WebSocket-Protocol`**, which `ws` treats as a protocol error (it failed my first probes with "Server sent no subprotocol") while OkHttp tolerates it. Any test harness built on `ws` must therefore send the subprotocol as a plain header, or the real gateway's behaviour will look like a bug in the client.

**What this means for the goal**: all device evidence gathered earlier used the fixture gateway, so it proves the app's own behaviour but does **not** prove interoperability with the shipped Host plugin. Until the proof step exists in the contract, the app and the fixture, pairing against a real computer cannot succeed. This is the single highest-priority defect in the product.

**Next steps (in order)**: (1) read the gateway's proof requirement precisely from `plugins/mobile-gateway/lib/index.mjs` (the `pairing-challenge` producer and its verifier) and write it into `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md`; (2) implement the client half in `packages/mobile-protocol` + the app's pairing flow; (3) teach the e2e fixture to issue a challenge and verify the proof, so the gate can never again pass while the product fails; (4) re-run the device pairing against the live gateway.

### CORRECTIONS to the gap above, from reading the gateway source (2026-11-10)

The contract is now written — `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md` §3.8 (revision 6) — and reading the gateway turned up four things that change both the diagnosis and the plan:

1. **There is a mandatory desktop-approval step between the proof and `paired`.** After a valid proof the gateway sends `{kind:'pairing-pending', verificationCode, requestId, expiresAt}` (`lib/index.mjs:5173`) and the socket then waits for the **Host user to approve on the desktop**; `paired` + `hello` are emitted from the approve path only. The pending TTL is `PENDING_TTL_MS = 5 * 60 * 1000` (`lib/pairing-requests.mjs:23`) and expiry ends the socket with `pairing/expired` + 4410. **Pairing is a ~5-minute two-party flow, not a 20-second handshake** — which is also why the user must see `verificationCode` and compare it with the desktop.
2. **That breaks two existing client deadlines, which is the real implementation risk.** `src/core/client.ts:139-143` defines `handshakeTimeoutMs` (10 s default) as the bound for the whole handshake, and `src/app-state.ts:698` races `pairedOnce` against a hard-coded 20 s. Both must be suspended on `pairing-pending` and replaced by an approval deadline, or the socket dies while the user walks to their desktop. This lands in `app-state`, not just the client.
3. **`pairing-challenge` is not triggered by a `paired` frame** — the gateway sends it unconditionally on accept (`:5176`), and the app has **no outbound `paired` frame at all** (`client.ts` handles `paired` inbound only, `:879`). The `{"type":"paired",…}` in the trace above came from the Node probe I wrote, not from the app. **The app's defect is precisely: it never answers the challenge.** Do not "fix" it by removing a frame nothing sends.
4. **The 530 tests do not use `e2e/harness/gateway.mjs`.** They pair through `test/support/fake-gateway.ts` (703 lines). An anti-drift rule that only changes the e2e harness would not bite, so the strict mode must go into **both** files.

Two landmines worth recording: adding the pairing close codes to `CLOSE_CODES` breaks `packages/mobile-protocol/test/contract.test.mjs:199` (exact-equality assertion) — use a separate frozen `PAIRING_CLOSE_CODES`; and the distinct per-code user copy lives in `app/pair.tsx:140-158` + `i18n/index.ts`, so those two files must be in scope for any change that promises distinct messages.

**Delivery plan — three slices, each leaving the suite green** (a single 6-file protocol change was offered back rather than half-landed, which was the right call):
- **A — protocol constants only** (additive, zero risk): `PAIRING_PROOF_TYPE`, `PAIRING_NONCE`, `PAIRING_CLOSE_CODES`, `createClientNonce()`, frame typedefs + `index.d.ts`.
- **B — client handshake, backward compatible**: answer the challenge, emit `pairingPending`, suspend both deadlines and add the approval deadline, map 4403/4408/4410 to distinct codes and messages. A fixture that sends `paired` with no challenge still works, so nothing goes red mid-change.
- **C — fixtures become strict, done LAST** (flips all pairing tests at once): `test/support/fake-gateway.ts` **and** `e2e/harness/gateway.mjs` issue the challenge, refuse a bare second `paired` with `op/forbidden`, and require a well-formed `clientNonce`; then the new tests.

### MEASURED ON DEVICE — first real LAN/TLS connection to the owner's live gateway (2026-11-10)
This is the acceptance test the review kept flagging as unproven, and it was run against the **real gateway in the running DSH host**, not the e2e fixture:

- The live gateway reports `lan.enabled/listening true`, `tls true`, `host 100.64.1.2` (Tailscale), `port 30081`, `certSha256 906be9d7…dfbca`, and `pairingTtlMs 300000` — i.e. it is running today's code.
- The emulator reaches that address directly (`ping` 1.9–3.5 ms) and its TCP port opens (`toybox nc -z` exit 0), so no `adb reverse` was involved.
- `POST /mgw/pair` on the loopback management route returns 201 with a 523-char pairing string whose payload carries both endpoints and the real `certSha256`. Passing `{publicUrl, endpoints}` pinned to `wss://100.64.1.2:30081/ws/mobile` produces a 482-char string whose `publicUrl` is the LAN endpoint — this is how a phone-reachable offer is minted, because the gateway derives `publicUrl` from the address the management request arrived on and management routes are loopback-only by design (a request to the LAN listener on `/mgw/pair` correctly returns 404).
- **Two device attempts, and the native trace tells the whole story** (`PinnedWs`, release build):
  - loopback endpoint → `onFailure exception=java.net.ConnectException` immediately. Correct: inside the emulator `127.0.0.1` is the emulator, so this endpoint can never work from a phone, and the app surfaces "Could not reach that computer."
  - Tailscale endpoint → `tls pinMatched=true validityOk=true` → `onOpen protocolNegotiated=true` → then `close code=1006 reasonLen=17` about 9.5 s later, with the host reporting `connectedClients=0`.
- **Conclusion**: the LAN/TLS/certificate-pinning path itself is PROVEN to work from the device (the pin matched and the WebSocket opened). What does not yet complete is the **application handshake after `open`** against the live host, so the offer is not redeemed. That is the next concrete defect to chase, and it is now a narrow, well-instrumented one rather than "LAN unproven". Note the emulator is x86_64 (log line "Unexpected CPU variant for x86: x86_64") and the host runs the gateway on the Tailscale interface; the same run must be repeated from an arm64 phone before any exposure claim.
- Two environment facts worth keeping: a `-wipe-data` cold boot was needed again because the package manager stopped resolving `MainActivity` (the recorded symptom), and after a wipe Gboard needs `pm clear com.google.android.inputmethod.latin` before `adb shell input text` accepts characters. Also, `adb shell input text` silently truncates a long paste (~435 chars observed), so the 482/523-char pairing string must be typed in 25–30-char chunks and verified byte-exact before submitting.
### MEASURED ON DEVICE — notifications cannot fire while the app is backgrounded (2026-11-10)
Closing the reviewer's notification gate produced a **product limitation, not a defect**, and it is worth stating plainly because it changes what can be promised:

- The app only posts an approval notification when `AppState` is `background`/`inactive` and the frame is not a replay (`app-state.ts` ~1686: `frame.replay !== true && APP_STATE_TRACKED.includes(this.appState) && !this.pendingNotifications.has(frame.rpcId)`). That is correct behaviour — it avoids nagging while the user is looking at the card.
- **But the socket does not survive backgrounding.** Measured: after `adb shell input keyevent KEYCODE_HOME`, the fixture reports `openConnections = 0` and the frame count stops. This is the documented credential boundary (A020/M5: the credential must not stay usable off-foreground), so the app cannot receive the approval push that would trigger the notification.
- Consequence: with the app backgrounded there is **no** delivery path for a pending approval. `POST_NOTIFICATIONS` was also found ungranted on a fresh install (`granted=false` until granted), but even after granting it, no notification appears because the push never arrives. **Local notifications are therefore not a substitute for remote push (APNs/FCM)**, which stays an owner-gated blocker — exactly the caveat the independent review raised.
- What would be needed for real background delivery: a remote push path with its own credentials (owner-gated, out of scope), or an explicit product decision to keep a socket alive while backgrounded — which would contradict the credential-boundary rule and must not be done casually.
### VERIFIED ON DEVICE — transient drop recovery and the lock gate (2026-11-10)
Two more device gates measured on the emulator, both from the reviewer's list:

- **Transient drop recovers by itself.** With the app paired and live, the fixture closed the socket with `1011` (`/scenario/close`). Fixture counters before: `tlsHandshakesCompleted=2, openConnections=1, frames=6`. After 30 s: **`tlsHandshakesCompleted=3, openConnections=1, frames=9, clientHellos=3`** — the app re-handshook, re-sent `client-hello` and resumed frames, and the rendered session list stayed intact throughout (no flicker, no loss). This is the retry path working on hardware, in contrast to the 403 path which correctly stops.
- **Locking the phone drops the connection on purpose.** With the screen locked, `openConnections` went to `0` and frames stopped — the bearer socket is not kept alive behind the lock. On unlock the app demands the biometric gate ("Unlock DSH Companion"); cancelling it leaves the app at **"Unlock cancelled. Your credential stays locked."** with `openConnections=0`, i.e. the stored credential is never used before authentication. That is the security property the unlock gate exists for, observed rather than argued.
- Not covered by this run (needs a physical phone or a second emulator profile): the lock/unlock cycle completed to a reconnected state end-to-end, notification/deep-link taps, and the localised permission prompts.

### RELEASE ARTIFACT — Android release APK built, installed and exercised (2026-11-10)
A real release build (not the diagnostic profile) was produced and verified on the emulator, so the Android half of the product is now demonstrably shippable to the owner's own phone:

- New `release-apk` EAS profile: `distribution: internal`, `android.buildType: apk`, `EXPO_PUBLIC_DSH_DEBUG_LOG: "0"`. The `diagnostic` profile remains the only one with `"1"`, and `preview`/`production` set it explicitly to `"0"` so an ambient environment variable cannot switch file tracing on in a shipped build.
- Build `vMm4Msdkpyh8RcAZioFq5k1TQXA-jmMzSr5956E24zI.apk`, 114,432,681 bytes, SHA-256 `05A1A91A1F5AE92E1D4BFF1AFBC8AECE85C75F92BA100ACDBADB4AF2A0EDA8D0`, `versionName 0.1.0`, `versionCode 1`, `minSdk 24`, `targetSdk 36`.
- **Tracing is provably off in the shipped build**: after a clean install and first launch, `ls /data/user/0/com.dshext.companion/files/` contains only the profile-installer artifact — `dsh-companion-debug.log` is absent (`TRACE_ABSENT`), whereas the diagnostic build writes it. This closes the reviewer's "production tracing is disabled by convention" concern with an observation.
- Full flow on that release APK: launch → unlock → pair (435-char code accepted, byte-exact) → `hellos=2, frames=3, openConnections=1, consumedPairingCodes=1` at the fixture → the session list renders ("Refactor gateway TLS / running · updated 1 min"). Screenshot captured.
- Note for automation: `adb shell pm clear` plus a reinstall can leave the app in the background, so a script that taps fixed coordinates will silently drive the launcher instead of the app. Read the current screen (`uiautomator dump`) and derive bounds from it before tapping; that is how the release run above was made reliable.

### VERIFIED ON DEVICE — deep links no longer render a router error (2026-11-10)
Found while closing the reviewer's notification/deep-link gate:

- **Symptom**: `adb shell am start -a android.intent.action.VIEW -d "dshcompanion://s/sess-gamma"` opened **"Unmatched Route — Page could not be found"** with the URL `dshcompanion:///s/sess-gamma`, instead of the session. The app advertised the scheme, `src/core/deeplink.ts` parsed both documented forms, and `app/_layout.tsx` already subscribed to `Linking.addEventListener('url')` — but Expo Router resolves the URL **path** against the file routes first, and there was no route for `s/<id>`, so its error screen won.
- **Fix**: added thin landing routes that make the URL resolvable and hand off — `app/s/[id].tsx` (validates the id, then `<Redirect href={/session/<id>} />` with `encodeURIComponent`, because the router already decoded the segment once) and `app/s/index.tsx` (id-less form → `/`). Both `dshcompanion://s/<id>` and `dshcompanion:///s/<id>` normalise to the same router path, so one route covers both. Registered inside the **unlocked** branch of the gate's `Stack`, so a cold start still shows the unlock screen first, and the routes contain no controller/connection logic.
- **Second defect, found by testing the locked case on device**: with the app locked, the deep link reached the gate correctly (unlock screen, no router error), but after unlocking the app landed on the session **list** instead of the target session. Cause: `handleDeepLink` returned early when locked **without storing** the parsed link, while its comment claimed "the gate resumes it after unlock (see `resumeDeepLink`)" — a function that **never existed**. The gate's `controller.takeDeepLink() ?? initialNotificationUrl()` therefore had nothing to hand back for an intent that arrived while locked (`initialNotificationUrl()` only covers a notification cold start).
- **Fix**: park the parsed link *before* the lock check (never navigate while locked, so the gate still owns the boundary), let `takeDeepLink()` consume it so one link routes exactly once, and have `reachDeepLink` clear only the link it consumed so a newer one survives. Dangling `resumeDeepLink` reference removed. Five regression tests were added and were proved to bite (restoring the old early-return gave `pass 2 / fail 3`).
- Verified: `npm run typecheck` clean, `npm run check:core` clean, app suite **526 tests, 526 pass, 0 fail, 0 skipped**. On device: both URL forms now enter the app with no routing error, and a locked-app link survives unlock.
- Operational note: hand-editing `persist.sys.locale` on the emulator image wedges its package manager (a known-good APK stops resolving its launcher activity while `aapt2 dump badging` still reports it) — a `-wipe-data` cold boot restores it, and after a wipe the Gboard IME needs `pm clear com.google.android.inputmethod.latin` before `adb shell input text` accepts characters again.

## Known open defect (recorded 2026-11-10) — FIXED the same day

**Was**: stale row — a revoked computer could stay in the device list while the store already dropped it. **Now fixed**; this section stays as the record of the diagnosis because four earlier attempts failed and the reason matters.

The fix that worked: drop the record from the in-memory list **inside the same credential transaction, immediately BEFORE `forgetHost` resolves**, matched by exact identity (`deviceId`+`pairedAt`, never by `gatewayId`).

**Corrected cause (measured after the fix, supersedes the identity-mismatch theory recorded earlier).** Instrumenting the un-skipped test with 50 ms probes showed the prune did **not** miss and `deleted` was **not** empty — the revision check passed and the prune matched. It simply ran ~200 ms too late:

| t (ms) | store | memory | tokens |
|---|---|---|---|
| 50–200 | [B, A] | [B, A] | A, B |
| 250 | **[B]** | still A | [B] |
| 450 | [B] | **[B]** | [B] |

`forgetHost` removes the record first, then deletes the token and **verifies the wipe by reading the key back**; that verify read sits behind the same store delay, so its promise settles a full round-trip after the record has already left the store — past the test's 400 ms window. That is also why the earlier "commit-time identity prune" attempt had no effect: it still awaited `forgetHost`.

Verified: the pinning test is un-skipped with **no assertion changed** and passes; the app suite is **526 tests, 526 pass, 0 fail, 0 skipped**; `typecheck` and `check:core` clean.

Two consequences worth knowing (both accepted, neither a defect):
- The record now leaves the list one store round-trip **before** the hosts write lands. A wipe that fails at the list write still drops the record — the same policy the callers' own prune already had, with the window now before rather than after.
- `takeDeepLink()` consumes the parked link so one link routes exactly once, which means a link taken by the gate whose unlock attempt then goes stale (`app/_layout.tsx:122`) is dropped rather than re-offered. Re-offering would need the gate to hand the link back.

Kept for the record — what the earlier attempts got wrong:
- Measured: `after selectHost memory=[A, B] disk=[A, B]` → `after repair settled memory=[A, B] disk=[A, B]` → `after 400 ms memory=[A, B] disk=[A]`. Disk correct, memory stale.
- Failed attempts, each measured against the suite: (a) store re-read + list install in `onRevoked` early → stale; (b) the same later → replaced list order and broke `M5: a delayed revocation cleanup never clobbers a host selected while it is parked`; (c) identity prune *after* `forgetHost` → no effect, because of the verify-read tail above; (d) store-merge filter after all deletions → no effect, same reason.
- Operational note: `test/scope-kind.test.mjs` T4 occasionally fails with undici `bad port` when the random ephemeral port lands on a port `fetch` refuses (e.g. 6000/10080). It is environmental — re-running gives 15 zero-fail groups — but it should be made deterministic by binding a port the test itself validates.

## Final release-gate review (2026-11-10) — verdicts and the one defect it caught

An independent whole-product review (app + gateway) returned: **owner's Android phone = READY WITH CONDITIONS**, **Play Store = NOT READY**, **iOS = NOT READY**.

The condition that mattered was a real defect it found, now fixed and proven:
- **`deleteToken` claimed a completed wipe when the verify read threw** (`src/platform/secure-store.ts`). The whole point of reading the key back is that "the store acknowledged the delete but kept the entry" is a **failed** wipe — yet a *throwing* verify read returned success, so `onRevoked`/`forget` skipped `store/cleanup-failed` and the user was told the credential was gone while it could still be on disk. This directly contradicted the function's own docstring.
- **Fix**: a throwing verify read is now a failed attempt — same bounded retry, and after `TOKEN_DELETE_ATTEMPTS` the same `CoreError('store/cleanup-failed')`. The read still goes straight to `SecureStore.getItemAsync` (never `readToken()`, which maps read errors to "absent" and would hide exactly this case).
- **Proven to bite, not assumed**: reintroducing the old `return;` by hand made the suite **528 pass / 2 fail** (`does not report success when the verification read throws`), and restoring the fix returned it to green. Four new tests cover: acknowledged-but-retained, entry-gone-but-read-throws, exactly-N verify failures then a healthy wipe, and the healthy path; the store stub gained `failTokenVerifyReads()` / `retainTokenDeletes()`.
- App suite now **530 tests, 530 pass, 0 fail, 0 skipped**; `typecheck` + `check:core` clean.

Review verdicts still open (recorded honestly, not defects hidden as limitations):
- **Play Store**: artifact size — the measured APK is 114,432,681 B ≈ 109.1 MiB against the constitution's ≤100 MiB budget; plus store paperwork (AAB/signing, privacy/data-safety, permission declarations) and remote push.
  - Exact wording matters here: constitution B4 says *"Defaults from Qoder Mobile: artifact <= 100 MiB"* — it is a **default target adopted from the reference product**, and "artifact" is not further defined. Three readings are possible and the owner should pick one rather than have the lead pick silently: (a) the released APK file itself, (b) what a user actually downloads from the store (AAB split per device/ABI — much smaller), (c) the installed footprint. Under (a) the universal APK fails and the fix is a per-ABI build; under (b) the store AAB is the artifact that must be measured. Both numbers are being measured rather than argued.
  - **Measured answer (2026-11-10)**: every artifact a user actually receives meets the budget; only the *universal* APK exceeds it, and it does so purely because of unused ABIs. Production AAB `X9ajqopR1bbkB_GpJn2yLDt6UfHPvifME4pCCKNGOqw.aab` = **75,878,033 B ≈ 72.36 MiB** (SHA-256 `0F18F4C11A7CB1DEED7A8C9C314F83EF3FF48B32C8631AE55F5F2A8BB5E0DF26`) — already under the budget. Inside that AAB the native payload is `arm64-v8a` **25.93 MiB**, `armeabi-v7a` 17.69 MiB, `x86` 27.95 MiB, `x86_64` 27.36 MiB, i.e. **≈73 MiB of the universal APK is the three ABIs a phone never uses** (`x86`/`x86_64` exist for the emulator alone). An arm64-only build computes to ≈**40.8 MiB** of base content and a store install downloads only its own ABI. So reading (b) is satisfied as-is, reading (a) is satisfied by a per-ABI build, and **no budget exception and no feature removal is required**.
- **iOS**: uncompiled and unverified; Android evidence cannot qualify it.
- **Physical-phone LAN/TLS** remains an explicit acceptance test — emulator + `adb reverse` does not establish firewall/routing behaviour on the owner's network.

Also recorded: the reviewer confirmed the day's focused changes look sound by reading (exact-record pruning, locked deep-link retention, re-check before navigation, secret-minimal listener reporting, structural SID-based DACL verification, TLS checks before/after writing, devices-plugin detection defaulting to "show").

### Test-suite stability note (measured, operational)
`npm test` in the gateway can fail on **timing-sensitive** tests when the machine is heavily loaded — `approval-hash.test.mjs`'s 2 KiB preview test (3 s `waitUntil`) and `remote-switch.test.mjs`'s persisted-config test failed while several heavy jobs ran in parallel, and each passed in isolation. After stopping the emulator and killing leftover `node` processes from earlier runs, the same suite was **exit 0 with 15 zero-fail groups**. Treat a red run under load with suspicion and re-run quiet before believing it; the real flake (undici bad ports) was fixed separately and is gone (3 consecutive green runs).

## Dependencies
Phase 2 needs 001 T007 (contract constants). Phase 5 needs 001 MVP (Phases 1–5) and environment/owner items.