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

## Dependencies
Phase 2 needs 001 T007 (contract constants). Phase 5 needs 001 MVP (Phases 1–5) and environment/owner items.
