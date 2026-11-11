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
   **Rev 6 correction:** this frame does NOT arrive immediately on a first pairing. It is sent only after
   the pairing-proof exchange and after the Host user approves on the desktop — see §3.8. A client that
   waits for `paired` without answering the challenge will be closed with `4408 pairing/timeout`.
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


### 3.8 Pairing proof exchange (revision 6, additive — measured against the live gateway 2026-11-10)

A pairing connection (subprotocol `dsh-pair.<code>`, header `X-DSH-Device-ID`) is a **restricted state
machine, not a MobileConnection**. This section was missing from revisions 1–5 and its absence made the
companion unable to pair with the real Host: the client was closed with `op/forbidden` and then
`4408 pairing/timeout` while every fixture-based test passed.

Immediately after the WebSocket opens, the gateway sends exactly one challenge (it is NOT triggered by
any client frame):

```json
{ "kind": "pairing-challenge", "serverNonce": "<base64url, 24 random bytes>", "certSha256": "<64 lowercase hex>", "otpRequired": false }
```

`certSha256` is the pinned leaf the client just verified. `otpRequired` is `false` for the QR / long
pairing-string flow and `true` for an OTP flow.

Until this client has been admitted, the ONLY frame it may send is `pairing-proof`. Any other frame is
refused with `{ "kind": "error", "code": "op/forbidden", "requestType": "<type>", "message": "only the
pairing proof is accepted before the Host approves" }`; the third refusal closes the socket with **4403**
and reason `pairing/refused`.

The client MUST answer exactly once:

```json
{ "type": "pairing-proof", "clientNonce": "<16–64 chars of [A-Za-z0-9_-]>" }
```

- `clientNonce` is mandatory and MUST match `^[A-Za-z0-9_-]{16,64}$` (≥ 96 bits of randomness
  RECOMMENDED). A missing or ill-formed nonce closes the socket with **4403**, reason `pairing/bad-nonce`.
- When the challenge had `otpRequired: true`, `otpProof` is REQUIRED and carries the client's
  one-time-code proof; a wrong or expired proof closes with **4410**, reason `pairing/expired`.
- When `otpRequired` is `false` (long pairing string) the string is itself the secret: a well-formed
  proof reserves it and raises one pending request. `otpProof` MUST be absent.

After a valid proof the socket stays open while the **Host user approves on the desktop**:

```json
{ "kind": "pairing-pending", "verificationCode": "<short human code>", "requestId": "<id>", "expiresAt": 0 }
```

`verificationCode` MUST be shown to the user — they compare it with what the desktop displays. `expiresAt`
is epoch milliseconds; the pending window is **5 minutes**. While pending the client MUST NOT send any
frame and MUST NOT treat the pairing as failed or as successful: success is only `paired`. **Any client
handshake deadline that spans this window is a defect** — the approval wait must be governed by its own
deadline, not by the transport handshake timeout.

On approval the gateway sends `paired` and then `hello` exactly as §3.3 / §3.5, and the `client-hello`
exchange takes over. On refusal or expiry it sends `{ "kind": "pairing-rejected", "reason": "<reason>" }`
and closes.

Pairing close codes (additions to the §3 close-code list):

| Code | Reasons (examples) | Meaning | Client behaviour |
|---|---|---|---|
| 4403 | `pairing/refused`, `pairing/bad-nonce`, `pairing/busy`, `pairing/disabled` | The Host refused this pairing attempt | Show "rejected"; do not retry automatically |
| 4408 | `pairing/timeout` | No valid proof before the handshake deadline | Show "timed out"; retry with a fresh code |
| 4410 | `pairing/expired` | The one-time code or the pending request expired | Show "expired or already used"; a new code is required |

A bare `paired` frame is NOT part of the pairing connection and clients MUST NOT send it.

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
| `message` | `sessionId`, `text`, `clientMsgId`, `mode?` (`queue`\|`steer`) | `sent` `{sessionId, clientMsgId}` | `sessionId` required (this op never creates a session; revision 7 adds `session-create` for that); idempotent by `clientMsgId` |
| `session-cancel` | `sessionId` | `session-cancelled` `{accepted}` | |
| `approval-response` | `rpcId`, `sessionId`, `approvalId`, `argsHash`, `outcome` | `approval-response` receipt | §5 |
| `device-info` | — | `device-info` `{id, name, createdAt}` | |
| `device-forget` | — | `device-forgotten` | revokes **this** device; server then closes `4401` |
| `push-register` | `platform` (`apns`\|`fcm`), `token` | `push-registered` | only if `push-v1` advertised |
| `push-remove` | — | `push-removed` | only if `push-v1` advertised |
| `workspaces` | — | `workspaces` | revision 7, scope `sessions:author`: this Host's workspace list. A device without `workspace:manage` receives a projected list: each item carries `workspaceId` and a `name` — the Host's `name`/`title`, else the last path segment; a workspace with no label at all is omitted — while the absolute `path`, member `sessionIds`, timestamps and the top-level `archivedSessionIds` are omitted. A device holding `workspace:manage` receives the full Host shape |
| `session-create` | `requestId`, `workspaceId?` \| `cwd?`, `title?` | `session-created` | revision 7, scope `sessions:author`; the workspace must exist on that Host. A device without `workspace:manage` MUST name a non-blank `workspaceId` and may not send `cwd` or `agentPreset` (any value, including `null`): refused `remote/argument-denied` with no Host call |
| `models` | `sessionId?` | `models` | revision 7, scope `sessions:author`: the catalog, or one session's models |
| `select-model` | `sessionId`, `provider`, `model`, `reasoningEffort?` | `select-model` | revision 7, scope `sessions:author`; session-scoped, never Host settings |

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

## Revision 7 (spec 011 session authoring, additive)

Four client ops join §4: `workspaces`, `session-create`, `models`, `select-model`, answered with
`workspaces`, `session-created`, `models` and `select-model`. They are gated by ONE new scope,
`sessions:author` — for both device kinds on purpose: a paired phone may start its own session, and
the owner decides per device. It is never a default and never implicit; `full` includes it.

What the scope permits is exactly: list this Host's workspaces, list the model catalog (or one
session's models), create a session, and pick the provider/model for a session the device may already
address. `session-create` places the session in a `workspaceId` that exists on that Host; a `cwd`
outside every known workspace still needs `workspace:manage`. `select-model` is session-scoped: it is
NOT `settings:write` and it cannot change Host defaults or agent presets.

**Workspace visibility is the Host's own per-item decision.** DSH's `workspace/follow` baseline
filters each item through `remoteAccess.allows({kind:'workspace', id})`, so a device sees a workspace
only where its policy binds that exact workspace id — a `global` action alone yields `items: []` with
no error, which is how "this computer has no workspaces" reached a phone on a Host with nine. The
gateway therefore registers one `workspace` binding per workspace id of the Host, whose only action is
`workspace/follow`, for a device that holds `sessions:author`, and registers none for a device that
does not. `name` is the Host's `name` or `title`; when both are empty the last path segment is used
(`…\DXVK_Project` → `DXVK_Project`), and a workspace with no label at all is omitted rather than shown
as a bare id. An absolute path, member session ids, timestamps and the archive list are never sent to a
device without `workspace:manage`.

Everything else stays refused for every device, whatever scopes it holds: creating, renaming or
archiving a workspace; forking, renaming or archiving a session; queue control; attachments; slash
commands; `settings/*`; the plugin and schedule families. Feature 012 turns that list into the single
hard blocklist and makes every other capability grantable per device.

**Never-default is a named rule, not a comment.** Because `sessions:author` is mobile-grantable it
would otherwise fall into BOTH default computations (the gateway's pairing-offer default and the device
registry's default), handing a newly paired phone the right to start agent work without the owner
choosing it. The contract therefore exports
`NEVER_DEFAULT_SCOPES = Object.freeze(['sessions:author'])`, and both default sites must subtract that
set. A default grant never contains a member of it; an EXPLICIT `scopes` argument that names it keeps
it, and an explicit empty list stays empty (never "no choice, so take the default"). See
`plugins/mobile-gateway/test/session-authoring-defaults.test.mjs`.
**Sub-agent sessions (revision 7, measured on a live Host where 827 of 861 sessions were
sub-agents).** A `sessionId` on `models` may name a direct sub-agent. DSH itself refuses a root
address for a sub-agent header (`session/agent-busy`, "subagent Sessions require their durable
parent address"), so the gateway resolves the durable parent from the `session/list` rows its own
peer may already list and re-reads with `{kind:'subagent', parentSessionId, childSessionId,
mode:'unknown'}`. The reply is the SAME shape as for a root session and carries no parent field, so
a device learns no session it could not already list; a stale or wrong parent is refused by DSH
(`subagent/unauthorized`), and an unresolvable parent keeps `session/agent-busy` with no blind retry.

`select-model` cannot work on a sub-agent at all: DSH's request schema has no address parameter and
resolves a child outright. It therefore answers the STABLE code `subagent/model-inherited` (message:
the sub-agent inherits its parent's model, without naming the parent) instead of the misleading
`session/agent-busy`. Clients must render that as "this session follows its parent's model", never as
a failure to reach the computer.
**`session-create` is decided on the target Workspace as well as globally.** A Remote call resolves
one resource per registered resource *kind* and **every** one of them must be allowed
(`dsh-api-gateway` `callResources()`); the workspace controller registers a field kind on
`workspaceId`, so a `session-create` that names a workspace is decided on
`{kind:'workspace', id:<workspaceId>}` in addition to `global`. A device holding `sessions:author`
therefore carries **exactly two** actions on each per-workspace binding it is granted —
`workspace/follow` and `session/create` — and nothing else. A device without the scope holds no
workspace binding at all, so it can neither list nor create. Every workspace-independent authoring op
(`models`, `select-model`) is unaffected, and creating, renaming or archiving a **workspace** remains
refused for every device.


