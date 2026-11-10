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

- **The pinned-ws native code is uncompiled.** A030's Kotlin and Swift sources have never been
  built here: this machine has no Android SDK and no macOS/Xcode, so `modules/pinned-ws/android`
  and `modules/pinned-ws/ios` are checked by review only. The JS half (module surface, transport
  adapter, error mapping) is covered by `test/pinned-transport.test.ts`; the first device build
  (A040/A041) is the first real compile.
- `npx expo prebuild --platform android --no-install` completes here (verified in an isolated
  copy with a real `node_modules` copy; a junction-based copy hung the Expo CLI) and writes the
  expected manifest and `res/xml/network_security_config.xml`. This is project generation only,
  not a native compile: the Android SDK is not installed (A040/A041 do the first real build).
  The A031 mods are also covered by `test/config-plugin.test.ts` and
  `npx expo config --type introspect`.
- **A033 is verified against a fixture, not against Xcode.** No `ios/` project has ever been
  generated or built on this machine (no macOS/Xcode): the `InfoPlist.strings` registration
  (`PBXVariantGroup` + `Resources` build phase, written by the plugin's `ios.xcodeproj` mod) is
  exercised in `test/config-plugin.test.ts` on a realistic fixture `project.pbxproj` parsed and
  written with the same `xcode` library Expo uses, including idempotency and the
  duplicate-registration cleanup. Xcode's own resolution of that project, and the localised
  permission prompt on a device, remain unverified until A041.
- Remote push (APNs/FCM) is not wired: notifications are **local only**, raised from the live
  connection (US6, D3).
- Android build needs the Android SDK (not installed on this machine); iOS needs macOS/EAS.
- The app must run as a **dev build** (not Expo Go): Expo Go has no `pinned-ws` module, and the
  app deliberately refuses to connect without it.
