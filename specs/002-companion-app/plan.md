# Implementation Plan: Mobile Companion App

**Branch**: `002-companion-app` | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

## Summary

Expo (React Native, TypeScript) app in `apps/mobile-companion`, split into a **pure-TS core** (protocol
client, pairing, reconnect, approval state, outbox) that is unit-tested in Node against a fake gateway,
and a thin **UI layer** (Expo Router screens). Pinned WSS needs a small **Expo native module**
(`modules/pinned-ws`, Kotlin + Swift) because RN's built-in WebSocket cannot trust a self-signed
certificate by fingerprint.

## Technical Context

**Language/Version**: TypeScript 5.x, React Native via Expo SDK (latest stable at implementation time, pinned)

**Primary Dependencies**: `expo`, `expo-router`, `expo-secure-store`, `expo-local-authentication`,
`expo-camera` (QR), `expo-notifications` (local first), `@shopify/flash-list`, `@dsh-ext/mobile-protocol`
(workspace). No analytics/crash SDKs (FR-012).

**Storage**: SecureStore for credentials; in-memory + small AsyncStorage-free cache (SecureStore/FS) for
last session list (read-only offline view).

**Testing**: core — `node --test` via `tsx` or Jest with a fake gateway (`test/fake-gateway.ts`);
type check `tsc --noEmit`; UI smoke later with Maestro on emulator.

**Target Platform**: Android 8+ (API 26+), iOS 16+ (TestFlight); dev builds (not Expo Go) because of the
native module.

**Project Type**: mobile app + local native module

**Constraints**: see constitution B1–B4; contract v1 is authoritative.

## Constitution Check

| Principle | Status |
|---|---|
| A2 clients control only | PASS — no execution in app |
| A3 contract-first | PASS — imports `@dsh-ext/mobile-protocol`; no redefined op names |
| A4 secure by default | PASS — pinning before any secret, SecureStore + biometric, no 3rd-party endpoints |
| A6 one folder per unit | PASS — `apps/mobile-companion` incl. its native module |
| B1 native render | PASS — RN views, no WebView |
| B2 pairing | PASS — QR v3, fingerprint verified first |
| B3 safe approvals | PASS — echo `argsHash`; null → no approve button |
| B4 scope | PASS — 4 surfaces; cloud tasks excluded |

## Research decisions

- **D1 Pinned WSS**: RN `WebSocket` uses platform TLS validation and rejects self-signed certs; options
  checked: (a) custom CA install on phone — rejected (user burden, weakens device trust); (b) plain WS —
  rejected (constitution); (c) **Expo module `pinned-ws`**: Android OkHttp `WebSocket` with a TrustManager
  that accepts only the leaf whose SHA-256 equals `certSha256`; iOS `URLSessionWebSocketTask` with
  `urlSession(_:didReceive:completionHandler:)` comparing `SecCertificateCopyData` SHA-256. JS API mirrors
  WebSocket (`connect(url, {certSha256, protocols, headers})`, events open/message/close/error). **Chosen.**
- **D2 Core/UI split**: all protocol logic in `src/core` with an injected transport so tests run in Node
  with `ws` + a self-signed test cert and the real fingerprint check implemented in a Node transport.
- **D3 Push**: MVP uses local notifications raised by the live connection; remote push (APNs/FCM) needs
  owner credentials → deferred task, not blocking MVP.
- **D4 Builds**: Android buildable locally once Android SDK is installed (not present on this machine);
  iOS requires macOS or EAS cloud build with the owner's Expo/Apple accounts → owner action.

## Project Structure

```text
apps/mobile-companion/
├── app.json / package.json / tsconfig.json
├── app/                      # Expo Router screens
│   ├── _layout.tsx           # unlock gate (biometric), providers
│   ├── pair.tsx              # QR scan + errors
│   ├── index.tsx             # sessions (3 tabs, search, badges)
│   └── session/[id].tsx      # messages, approval cards, composer, cancel
├── src/core/                 # pure TS, no RN imports
│   ├── qr.ts                 # parse/validate QR v3
│   ├── client.ts             # hello/client-hello, request/response, errors
│   ├── reconnect.ts          # backoff 1,2,5,..30 s
│   ├── approvals.ts          # card state, hash echo, mismatch → review
│   ├── outbox.ts             # clientMsgId, retry, dedupe
│   └── transport.ts          # interface; RN impl uses pinned-ws
├── src/platform/             # RN adapters: secure store, biometric, notifications, pinned transport
├── modules/pinned-ws/        # Expo native module (android/ Kotlin, ios/ Swift, index.ts)
├── i18n/ (vi, en)
└── test/                     # node tests for src/core + fake gateway
```

## Phasing

1. Scaffold + core (QR, client, reconnect, approvals, outbox) with tests — runnable now.
2. UI screens wired to core with a mock transport (type-checked).
3. `pinned-ws` native module + tests of the Node transport counterpart.
4. Android dev build + emulator smoke (needs Android SDK).
5. iOS build (needs macOS/EAS + owner accounts). Remote push (owner credentials).
6. Reviewer (mandatory: pairing/token/network) before any device distribution.
