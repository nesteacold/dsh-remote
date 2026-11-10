# Contract — `@dsh-ext/mobile-protocol` v1

Shared by `plugins/mobile-gateway` and `apps/mobile-companion`. Breaking change = v2.

**Revision 2 (2026-11-09, lead)**: aligned with the upstream gateway wire format
(`plugins/mobile-gateway/PROTOCOL.md`) instead of inventing a new envelope — client frames use `type`,
server frames use `kind`. Revision 1 op names (`sessions.list`, …) are withdrawn; v1 is unreleased, so
this is not a breaking change for any shipped client.

**Revision 3 (spec 005, remote desktop client)**: additive, so the wire protocol stays v1. Device `hello`,
`paired` and `device-info` carry `kind` (`mobile`|`desktop`) and `scopes`; a pairing offer carries both;
a type a device's scopes do not cover is answered `auth/forbidden-scope` in band. A record written before
this revision loads as a mobile device with every scope. See
`specs/005-remote-desktop-client/spec.md` FR1–FR6; the six scopes are `sessions:read`, `prompt:send`,
`approval:respond`, `files:read`, `files:write`, `settings:write`.

## 1. Framing

- Transport: one WebSocket over TLS (`wss://`) to the gateway's TLS listener; certificate pinned by
  `certSha256` from the QR. Subprotocol always includes `dsh-mobile-v1`.
- Client → server: `{ "type": "<op>", "requestId": "<client id>", ...params }`. `requestId` is required on
  every request from a companion client (≤ 64 chars, `[A-Za-z0-9._-]`).
- Server → client: `{ "kind": "<kind>", ...data }`. Every response or error caused by a request **echoes
  that request's `requestId`**. Server pushes (`event`, `approval-requested`, …) carry no `requestId`.
  The echo requirement applies to **valid** `requestId` values only: a missing or malformed id is refused
  without echoing the supplied value.
- Error frame: `{ "kind": "error", "code": "<code>", "requestType": "<op>", "requestId": "...", "message"?: "..." }`.

## 2. Pairing QR payload (version 3)

QR/manual text = **unpadded base64url** of UTF-8 JSON (same encoding as upstream v2):

```json
{ "version": 3, "publicUrl": "wss://192.168.1.10:3443/ws/mobile",
  "pairingCode": "<base64url 256-bit>", "expiresAt": 1787112000000,
  "certSha256": "<64 lowercase hex>", "gatewayId": "<uuid v4>", "gatewayName": "my-pc",
  "endpoints": ["wss://192.168.1.10:3443/ws/mobile"] }
```

- `publicUrl` and every `endpoints[]` entry MUST be `wss://`. `expiresAt` is epoch milliseconds, ≤ 5 min ahead.
- Client MUST reject `version !== 3`, non-wss URLs, or a malformed `certSha256`.

## 3. Connection and authentication

1. Client opens WSS and verifies the leaf certificate SHA-256 equals `certSha256` **before sending anything**.
2. First pairing: subprotocols `dsh-mobile-v1, dsh-pair.<pairingCode>`; header `X-DSH-Device-ID:
   <install-scoped UUID>` (fallback subprotocol `dsh-device.<id>`). Pairing code in the URL query is rejected.
3. Server sends once: `{ "kind": "paired", "token": "<device token>", "device": { "id", "name", "createdAt" } }`.
   Client stores the token in the secure store immediately; it is never sent again.
4. Later connections: header `Authorization: Bearer <token>` (fallback subprotocol `dsh-auth.<token>`).
   Token in the URL query is rejected.
5. Server sends `hello`:
```json
{ "kind": "hello", "protocol": 3, "companionProtocol": 1, "minClientVersion": 1,
  "capabilities": ["sessions-read", "prompt", "cancel", "approval-v1"],
  "authenticated": true, "device": { "id": "...", "name": "..." },
  "gatewayId": "...", "dshVersion": "0.2.2-rc.1", "certSha256": "<hex>" }
```
   `capabilities` on the companion channel are exactly the package `CAPABILITIES` the gateway supports;
   `push-v1` is added only when remote push is configured.
6. Client sends `{ "type": "client-hello", "requestId": "...", "companionProtocol": 1, "appVersion": "x.y.z", "platform": "ios|android" }`.
   Server answers `{ "kind": "client-hello", "requestId": "...", "accepted": true }` or an error
   `protocol/unsupported` (with `minClientVersion`) and closes.

HTTP upgrade failures: `401` missing/invalid/revoked credential or expired code; `403` remote control
disabled **or any plaintext (non-TLS) source that is not loopback**. Companion device credentials
(`Authorization: Bearer`, `dsh-auth.`, `dsh-pair.`) are accepted **only on the gateway's own TLS
listener**: on the shared plaintext web-server upgrade the same credential gets `401 auth/required`.
This is not negotiable — the pin is only enforced on the TLS listener, so a plaintext token would
bypass it. Close codes: `4004` gateway disabled (stop auto-reconnect), `4003` re-authenticate, `4401` revoked.

### 3.7 Request framing rules (applies to every §4 operation)

- `requestId` is required for every client operation: a non-empty string of **1–64** characters from
  `[A-Za-z0-9._-]`. Anything else is refused `bad-request` before any Host work, and the refusal does
  not echo the out-of-bounds value.
- A `requestId` still in flight on the same socket is refused `bad-request` (no duplicate correlation
  and no second Host call). Ids are released when their request settles; a socket tracks at most 256.
- Before a `client-hello` has been accepted, only `client-hello` and `ping` run; every other operation
  is refused `bad-request` and no Host call is made. `client-hello` is exempt from device scope checks
  (negotiation must be possible) but grants nothing by itself.
- Push frames carry no `requestId` and are unaffected by these rules.
- At 256 tracked in-flight `requestId`s, further id-bearing requests receive `bad-request` until an
  outstanding request settles.
- Upgrade refusal checks have precedence: a non-loopback plaintext request that also carries query
  credentials may receive `401` rather than `403`. **No plaintext request authenticates a device
  credential.** Credential acceptance requires the gateway's own TLS listener, not merely an encrypted
  socket on a shared web server.


## 4. Operations (allowlist `companion-v1`)

The op identity is the `type` value. Anything else → error `op/forbidden`.

| `type` | Params | Response `kind` | Notes |
|---|---|---|---|
| `client-hello` | `companionProtocol`, `appVersion`, `platform` | `client-hello` | §3 |
| `ping` | — | `pong` | keep-alive, every 25 s |
| `sessions` | — | `sessions` `{items[]}` | upstream list projection (title in `projections.values.title`) |
| `search` | `query` | `search` | |
| `history` | `sessionId`, `beforeSeq?`, `maxMessages?`, `maxBytes?` | `history` | upstream paging |
| `subscribe` | `sessionId` | `subscribed` | starts `event` pushes + replays pending approvals |
| `unsubscribe` | — | `unsubscribed` | |
| `message` | `sessionId`, `text`, `clientMsgId`, `mode?` (`queue`\|`steer`) | `sent` `{sessionId, clientMsgId}` | `sessionId` required (no session creation in v1); idempotent by `clientMsgId` |
| `session-cancel` | `sessionId` | `session-cancelled` `{accepted}` | |
| `approval-response` | `rpcId`, `sessionId`, `approvalId`, `argsHash`, `outcome` | `approval-response` receipt | §5 |
| `device-info` | — | `device-info` `{id, name, createdAt}` | |
| `device-forget` | — | `device-forgotten` | revokes **this** device; server then closes `4401` |
| `push-register` | `platform` (`apns`\|`fcm`), `token` | `push-registered` | only if `push-v1` advertised |
| `push-remove` | — | `push-removed` | only if `push-v1` advertised |

## 5. Approvals

Push:
```json
{ "kind": "approval-requested", "rpcId": "...", "sessionId": "...", "approvalId": "...",
  "toolName": "bash", "callId": "call-42", "reason": "...", "displayReason": { "en": "..." },
  "argsHash": "<64 hex> | null", "argsPreview": "<≤ 2 KB text>", "replay": true }
```
- `argsHash = sha256_hex(JCS({toolName, callId, arguments: JSON.parse(rawArguments)}))`.
  `null` when the gateway cannot bind content (no `callId`, no `tool/call` within 1 s, unparsable arguments):
  the client MUST NOT offer approve/reject; the desktop decides.
- Client deduplicates by `rpcId`.

Response: `{ "type": "approval-response", "requestId", "rpcId", "sessionId", "approvalId", "argsHash", "outcome": "allowed-once" | "rejected" }`.
`cancelled`/`unavailable` are host states and are never sent by the client.

Receipt: `{ "kind": "approval-response", "requestId", "rpcId", "sessionId", "approvalId", "outcome", "accepted": true }`
or `accepted: false` with `reason` ∈ `not-pending` (already decided / handed to desktop),
`hash-mismatch` (content changed — client reloads the card and asks the user to review again).

Final state push: `{ "kind": "approval-resolved", "rpcId", "sessionId", "approvalId", "outcome": "allowed-once" | "rejected" | "cancelled" | "unavailable" }`.

## 5a. Clarifications (rev 2.1, 2026-11-09 — from app integration)

- The client is **ready only after** `{kind:"client-hello", requestId, accepted:true}`; `hello` alone is not enough.
- Server negotiates back exactly `dsh-mobile-v1` as the subprotocol (never echoes `dsh-pair.`/`dsh-auth.`/`dsh-device.`).
- `paired` is sent only on pairing connections, never on Bearer connections.
- An approval refusal (`not-pending`, `hash-mismatch`) is a **normal receipt** with `requestId` and
  `accepted:false`, never an error frame.
- Error frame with `requestId` fails that request only; without `requestId` it fails all pending requests.
- When the owner switch is turned off, established sockets are closed with **4004** (in addition to new
  upgrades getting 403), so the client can show "turn on remote control".
- `argsPreview` is always a string.
- `history` reply: `{kind:"history", requestId, items[], hasMore}`; rows carry `seq`, `role`, `text`, `createdAt`.
- `sessions` rows carry `sessionId`, `updatedAt` (epoch ms), `running`, `projections.values.title`; the client
  derives running/idle/archived.

## 6. Error codes

| code | HTTP (upgrade) | Meaning |
|---|---|---|
| `auth/required` | 401 | missing credential |
| `auth/revoked` | 401 | device revoked (WS close `4401`) |
| `auth/forbidden-scope` | — | revision 3: this device's scopes do not cover the op |
| `remote/disabled` | 403 | owner switch off |
| `op/forbidden` | — | type not in `companion-v1` |
| `pairing/expired` | 401 | code expired or already used |
| `protocol/unsupported` | — | companion protocol version mismatch |
| `bad-request` | — | invalid params |
| `session-not-found` | — | host error passthrough |

Other host error codes (e.g. `agent-busy`, `internal`) may be passed through unchanged; clients show a
generic error for codes they do not know.
## Revision 4 (spec 008 P1, additive)
Scope `harness:remote` (desktop-only, explicit). Client frames: `remote-call {requestId, endpoint, args}`, `remote-stream-open {streamId, endpoint, args}`, `remote-stream-cancel {streamId}`, `remote-stream-credit {streamId, n}`. Server frames: `remote-result {requestId, ok, value|error}`, `remote-frame {streamId, seq, value}`, `remote-stream-closed {streamId, error?}`. `/result` is never forwarded raw; it is bound to the pending approval's `argsHash` (mismatch: `accepted:false, reason:'hash-mismatch'`, stays pending).

`remote-call` requires a valid `requestId` (§3.7). `remote-stream-open`, `remote-stream-cancel` and
`remote-stream-credit` may omit `requestId`; when supplied it is validated. Id-bearing asynchronous
call/open requests share the socket's duplicate-in-flight and 256-id admission rules.

## Revision 5 (spec 008 P1b + full control, additive)
Pairing with Host approval, subprotocol `dsh-pair-otp.v1`: `pairing-challenge {serverNonce}`, then `pairing-proof {clientNonce, otpProof=HMAC-SHA256(otp, certSha256||clientNonce||serverNonce)}`, then `pairing-pending {verificationCode}` (6 digits; both sides display it), then on Host Approve the existing `paired` frame; on Reject `pairing-rejected`, close 4403. A wrong or expired code or a pending timeout closes 4410. The long pairing string also waits for approval when `requireHostApproval` is set (default true).
Desktop-only explicit scopes: `commands:execute`, `workspace:manage`, `credentials:write`, `plugins:manage`, `schedule:write`, `terminal`. Presets `standard` / `full`. Bridge limits default to 0, meaning unlimited (owner decision).
