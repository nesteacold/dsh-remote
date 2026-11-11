# apps/mobile-companion

DSH Companion — the phone-side controller for a DSH Host (spec `002-companion-app`).
It pairs with the hardened gateway (`plugins/mobile-gateway`, spec `001`), lists sessions,
answers approvals and sends follow-up instructions. It never executes agent work.

React Native + Expo SDK 58 (TypeScript, Expo Router). Contract: `@dsh-ext/mobile-protocol`
(contract v1, **revision 2** — `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md`).

## Layout

```
app/                    Expo Router screens
  _layout.tsx           A020 unlock gate (biometrics / device passcode) + providers
  index.tsx             A022 sessions: 3 tabs, search, needs-decision badge (FlashList)
  pair.tsx              A021 QR scan (expo-camera) + manual paste + every US1 error state
  session/[id].tsx      A023 history, approval cards (≤ 3 taps), composer, cancel
  s/[id].tsx            A025 deep-link landing: dshcompanion://s/<id> -> /session/<id>
  s/index.tsx           A025 deep-link landing without an id -> /
src/core/               Pure TypeScript protocol core — no react-native / expo / node imports
  protocol.ts           re-exports @dsh-ext/mobile-protocol + app-local client codes
  errors.ts             CoreError (contract code | client/* code | passthrough host code)
  qr.ts                 QR v3: unpadded base64url -> JSON, wss/endpoints/pin/epoch-ms expiry
  transport.ts          Transport interface (pin verified before `open`)
  client.ts             paired -> hello -> client-hello, requestId correlation, ping, close codes
  sessions.ts           `sessions`/`search` projection: tabs, search, needsDecision
  history.ts            `history` paging + dedupe + optimistic prompt rows
  approvals.ts          approval card state machine (accepted:false + reason -> review/decided)
  outbox.ts             `message` with stable clientMsgId, retry, dedupe; `session-cancel`
  reconnect.ts          backoff 1,2,5,10,20,30 s + resync plan
  host.ts               PairedHost record (no secrets) for reconnect
  deeplink.ts           dshcompanion://s/<id>?a=<approvalId>
  redact.ts             diagnostics redaction (tokens, codes, pins, arguments)
  debug-log.ts          bounded, redacted debug log
src/app-state.ts        AppController: wires core <-> platform <-> screens (observable snapshot)
src/platform/           RN adapters: secure store, install-id, biometrics, local notifications,
                        pinned transport (A030, over modules/pinned-ws)
modules/pinned-ws/      Local Expo module (A030): WebSocket-over-TLS pinned to the leaf SHA-256
  index.ts              JS API: connect/send/close + onOpen/onMessage/onClose/onError, by id
  src/                  event types, error codes, native-module lookup (null in Expo Go)
  android/              Kotlin: OkHttp per connection + X509ExtendedTrustManager pin
  ios/                  Swift: URLSessionWebSocketTask + trust-challenge pin delegate + podspec
plugins/                withPinnedWsConfig.js (A031): Android network security config,
                        iOS ATS assertion + vi/en InfoPlist.strings registered in the Xcode project
i18n/                   vi + en dictionaries, pairing error mapping, relative time
test/                   node --test suites, fake gateway, Node pinned transport, platform stubs
metro.config.js         watches ../../packages so the file: protocol dependency reloads
```

## Pinned TLS transport (A030)

`React Native`'s built-in `WebSocket` cannot pin a self-signed leaf certificate, so the device
build talks to the gateway through the local Expo module **`modules/pinned-ws`**. It is
autolinked as a local module: `expo-modules-autolinking` scans `./modules` by default
(`nativeModulesDir`), and the module declares itself in `expo-module.config.json`
(`PinnedWsModule` on both platforms, pod `PinnedWs`). Verified offline with:

```powershell
npx expo-modules-autolinking resolve --platform android   # -> pinned-ws -> expo.modules.pinnedws.PinnedWsModule
npx expo-modules-autolinking resolve --platform apple     # -> pinned-ws -> pod PinnedWs
```

JS API (mirrors `src/core/transport.ts`; several sockets at once, routed by `id`):

```ts
import { PinnedWs } from './modules/pinned-ws';        // default export, null in Expo Go
PinnedWs.connect(id, 'wss://192.168.1.10:3443/ws/mobile', {
  certSha256, protocols: ['dsh-mobile-v1', 'dsh-pair.<code>'], headers: { 'X-DSH-Device-ID': installId },
});
PinnedWs.send(id, text); PinnedWs.close(id, 1000, 'app-stop');
// events: onOpen{id, protocol}, onMessage{id, data}, onClose{id, code, reason},
//         onError{id, code, message, status?, observedSha256?}
```

Pinning rules — identical on both platforms, and the only reason this module exists:

- Accepted **only** if `sha256(leaf certificate DER) == certSha256` (lowercase hex,
  constant-time compare). No CA/system trust fallback, no hostname identity, no user-installed
  CA, no "allow invalid" switch, no cleartext.
- The check runs **inside the TLS handshake**, i.e. before the HTTP upgrade request — and thus
  before `Sec-WebSocket-Protocol` (`dsh-pair.` / `dsh-auth.`), `Authorization` or
  `X-DSH-Device-ID` — is sent. On mismatch the handshake is aborted and `onError`
  `client/pin-mismatch` is emitted; nothing was sent.
- Non-`wss://` URLs are refused before any I/O (`client/insecure-url`).
- A refused upgrade reports its HTTP status (`client/upgrade-failed` + `status`), which
  `src/platform/pinned-transport.ts` maps to `auth/required` (401) or `remote/disabled` (403).
- One `OkHttpClient` (Android) / `URLSession` (iOS) per connection: no shared trust state or
  connection pool between sockets.
- Android uses the OkHttp version React Native provides (`compileOnly`, no pinned version);
  iOS uses `URLSessionWebSocketTask` with CryptoKit.

`src/platform/pinned-transport.ts` is the `Transport` the core uses; when the native module is
absent (Expo Go, web, Node tests) it reports `client/pinned-transport-unavailable` and never
opens an unpinned socket.

## Config plugin (A031)

`plugins/withPinnedWsConfig.js` runs during `expo prebuild`:

- Android: writes `android:usesCleartextTraffic="false"` onto `<application>` itself (Expo's app
  config has no such field — `expo-doctor` / EAS reject `android.usesCleartextTraffic` as an
  additional property, so app.json must not set it at all; the generated manifest gets `"false"`
  when the attribute is absent, and any other manifest value is a hard error), points
  `<application>` at `@xml/network_security_config` and generates
  `res/xml/network_security_config.xml` with `cleartextTrafficPermitted="false"` and an empty
  `<trust-anchors>` (no system CAs, no user CAs).
- iOS: rejects `NSAllowsArbitraryLoads` / `NSExceptionDomains` when app.json tries to add them
  (Expo's own template defaults are left untouched), and writes `en.lproj` + `vi.lproj`
  `InfoPlist.strings` with the camera / Face ID usage strings, so the permission prompt is
  localised. The two `.lproj` files are then registered in `project.pbxproj` (A033) as an
  `InfoPlist.strings` `PBXVariantGroup` in the app group — one `<locale>.lproj/InfoPlist.strings`
  file reference per locale plus a single `Resources` build-phase entry — because Xcode copies
  only resources the project references; writing the files alone never reaches the bundle.
  Registration is idempotent (a second `expo prebuild` over the same project changes nothing) and
  folds a plain file-reference registration of the same paths into the variant group, so no
  duplicate `InfoPlist.strings` can reach the bundle. `vi` is also added to the project's
  `knownRegions`. What proves the translation is the first iOS build (A041); the project
  registration itself is covered by `test/config-plugin.test.ts` against a parsed fixture project.

## Contract package

`@dsh-ext/mobile-protocol` is a `file:../../packages/mobile-protocol` dependency (this folder is
its own npm package, **no root workspace**). `metro.config.js` adds `../../packages` to
`watchFolders` so Metro resolves and hot-reloads it; re-run `npm install` after changing the
package's `package.json` (npm copies rather than symlinks on Windows).

## Commands

```powershell
npm install                 # exact-pinned versions (Expo SDK 58)
npx tsc --noEmit            # type check app + core + tests
npm test                    # node --test via tsx; fake gateway + platform stubs
npm run check:core          # fails if src/core imports react-native / expo / node / platform
npx expo config --type prebuild   # resolved plugins, permissions, Info.plist keys
npx expo-modules-autolinking resolve --platform android   # offline: shows pinned-ws is linked
npm start                   # dev build (Expo Go has no pinned-ws module)
```

Tests start a fake gateway on an ephemeral `127.0.0.1` port with a certificate generated in
process (`selfsigned`); no certificate or key is ever written to disk or committed.

## Current limitations

Updated 2026-11-10 — the Android side is now built, installed and exercised on an emulator, so
several earlier caveats no longer apply. `specs/002-companion-app/tasks.md` carries the measured
device evidence; this list is the short version.

- **Android is real; iOS is not.** The Kotlin module compiles (`:dsh-ext-pinned-ws:compileDebugKotlin`),
  EAS has produced release APKs, and on an Android 36 emulator the app has been verified for:
  pairing over pinned TLS, session list + filters, opening a session, sending a prompt (frame on
  the wire and the prompt applied by the gateway), the approval card with an **exact `argsHash`**
  decision plus a `hash-mismatch` refusal that keeps the request pending, a wrong certificate
  leaking **no** credential (`tlsHandshakesCompleted=0`, no upgrade, pairing code unused),
  revocation (retry stops, the stored token is wiped, the banner explains it), re-pairing
  afterwards, transient-drop recovery, the lock/unlock gate, and deep links (both documented URL
  forms, including a link that arrives while locked).
  **Swift has still never been compiled** — no macOS/Xcode here — so `modules/pinned-ws/ios` is
  review-only and A033's `InfoPlist.strings` registration is exercised against a fixture
  `project.pbxproj`, not Xcode. iOS is a distribution blocker, not a caveat.
- **Remote push (APNs/FCM) is not wired**: notifications are **local only**, raised from the live
  connection (US6, D3). Measured consequence: backgrounding the app closes the authenticated socket
  (the credential boundary), so an approval push cannot arrive and no notification can fire while
  the app is in the background. Local notifications are therefore **not** a substitute for remote
  push.
- **A physical phone over the LAN is unproven.** All device evidence is an emulator, mostly with
  `adb reverse`; firewall/routing behaviour on a real network is still an acceptance test.
- **No dev-client/Expo Go path for the transport**: the app must run as a build that contains the
  `pinned-ws` module (Expo Go has none) and it deliberately refuses to connect without it.
- **Build profiles** (`eas.json`): `preview` (internal APK), `diagnostic` (APK, JS file tracing ON —
  diagnostics only), `release-apk` (APK, tracing OFF), `production` (AAB for the store, tracing OFF).
  On artifact size: the store AAB measures 75,878,033 B ≈ **72.36 MiB** and is under the ≤100 MiB
  budget, while the *universal* release APK is 114,432,681 B ≈ 109.1 MiB — over it, purely because
  the APK embeds four ABIs' native libraries. Inside the AAB, `arm64-v8a` is 25.93 MiB and
  `armeabi-v7a`/`x86`/`x86_64` add ≈73 MiB; the `x86`/`x86_64` slices exist for emulators only, and a
  store install downloads just its own ABI. An arm64-only build would be ≈40.8 MiB if a single-ABI
  APK is ever wanted, but no such profile is defined today because the budget is already met.
- **Android SDK on this machine is a partial install**: `platforms;android-37.0`,
  `build-tools;37.0.0`, platform-tools and an emulator are present, which is enough to compile the
  Kotlin module and drive a device, but a full local `assembleRelease` still hits a Windows
  long-path limit in the C++/CMake step — use EAS for APKs.
