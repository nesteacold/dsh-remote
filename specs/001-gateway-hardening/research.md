# Research — 001 Gateway Hardening

Source: beastcore read-only study of `Clarklevis1995/dsh-plugin-mobile-gateway` @ `74ac444c` (2026-11-08).
Labels: (a) measured, (b) read from source, (c) inferred. DSH `dsh-v0.2.2-rc.1` itself was **not** fetched;
DSH-side claims come from how the plugin calls it — re-verify in tasks marked `[verify-dsh]`.

## Codebase facts
- JS ESM, no TS; `node >= 24.9`; main `lib/index.mjs` (3611 lines) (b).
- Deps: `@deepseek-ai/schemastery ^3.18.1`, `qrcode ^1.5.4`, `werift 0.25.2`, `ws ^8.18.0` (b).
- Tests: `npm test` (`node --test` + scripts), `test:webrtc`, `test:package`; 38 test files (a).
- Key files: `lib/index.mjs`, `lib/devices.js` (204), `lib/dsh-host-adapter.mjs` (491),
  `lib/transport-config.mjs` (168), `lib/transport-negotiation.mjs` (521), `lib/cloudflare-tunnel.mjs` (299),
  `lib/cloudflared-binary.mjs` (113), `bin/setup-ip.mjs` (422), `lib/client.js` (2305, admin UI bundle),
  `lib/plugin-management.mjs` (208), `cordis.patch.yml` (45), `helper/dsh_mobile_gateway_helper.py` (185).

## Decisions

### R1. TLS certificate generation
- **Decision**: add dependency `selfsigned` (pinned exact) to generate a per-Host EC P-256 self-signed cert;
  compute fingerprint with built-in `node:crypto` `X509Certificate.fingerprint256`.
- **Rationale**: Node has no API to *create* certs (b); hand-rolled ASN.1/DER (~150 lines) is error-prone in
  security code; `openssl` is not guaranteed on Windows hosts.
- **Alternatives**: hand-written DER (rejected: risk), external `openssl` (rejected: portability).
- Cert + key stored in the plugin data dir, key file never logged; regenerate only on owner action.

### R2. Where TLS lives
- **Decision**: a separate plugin-owned `https.createServer` listener for remote clients; DSH's own
  `webServer.register` routes (loopback) keep only the `/mgw` admin UI and pairing endpoints.
- **Rationale**: `webServer.register`/`registerUpgrade` run on DSH's loopback server (b); LAN listener
  (`index.mjs:3347`) and tunnel (`cloudflare-tunnel.mjs:215`) are already plugin-owned (b). Putting TLS on
  the plugin listener avoids touching DSH core (constitution A1).

### R3. Owner switch `remoteControl.enabled`
- **Decision**: plugin config key `remoteControl.enabled` (default `false`), read `gatewayEnabled` as a
  legacy alias. Turning off: existing `setGatewayMode('disabled')` (closes RTC + `client.close(4004)`,
  `index.mjs:2462-2464`) **plus** `terminate()` after 3 s, `remoteServer.close()`, tunnel stop.
- **Rationale**: no DSH-native equivalent found (c) `[verify-dsh]`.

### R4. Allowlist (FR-005/006)
- **Decision**: operation allowlist `companion-v1` enforced at the router (`index.mjs:3133-3235`) and in
  `dsh-host-adapter.mjs` for device-token callers. v1 ALLOW = sessions `list`, `search`, `projections`,
  `history`, `models` (read), `prompt` (incl. subagents.prompt), `cancel`; approvals list/respond; devices
  list/revoke-self; push-token register/remove; `describeHost` (needed for hello). Everything else DENY.
- Deferred (DENY in v1, revisit per spec 002 need): `sessions.create/fork/rename/updateQueue/attachment/
  selectModel`, `files.upload`, `speech.*`, `schedule.*`, `workspace.*`, `commands.list/execute`.
- Always DENY: `settings.*`, `plugins.*` (all 17 ops), query types `permission`, `set-default`,
  `save-default-model`, `directory-create`.
- **Rationale**: today `PLUGIN_REQUEST_TYPES` is blocked only when there is *no* device (`index.mjs:3219`) —
  i.e. a device token can manage plugins (b). Spec FR-005 lists exactly the companion surfaces.

### R5. Approval content binding (FR-008)
- **Decision**: gateway caches `tool/call` events (`d.arguments`, `index.mjs:390`) by `callId`; on
  `approval/request` computes `argsHash = sha256_hex(JCS({toolName, callId, arguments}))` (RFC 8785
  canonical JSON; if `arguments` is a string, parse first). Frame carries `argsHash` + truncated
  `argsPreview`; response must echo `argsHash`; mismatch → 409, approval stays pending.
  **If no arguments are found for the callId, mobile approval is refused** (decision falls back to desktop).
- **Rationale**: DSH's `approval/request` frame has no args (b); binding must be computed gateway-side.
  Race between `tool/call` and `approval/request` order handled by the refuse-if-missing rule (c) `[verify-dsh]`.

### R6. `fallbackApproval` behaviour
- **Finding**: does **not** auto-approve; delegates to the downstream approval chain (`pending.next()`,
  likely desktop) or rejects on error (`index.mjs:2711-2718`) (b). Risk: forwards `undefined` when downstream
  returns something else (`:2692`) (c).
- **Decision**: keep delegation; coerce any non-`allowed-once` result to "not decided by mobile" (no
  pass-through of unknown values); add a test.

### R7. WebRTC / STUN (FR-010)
- **Finding**: WebRTC only when `transport.enabled` and intent header `negotiate-v1` (`:3325`); TURN rejected by
  regex (`transport-config:67-72`); default STUN = `stun.cloudflare.com`, and empty list is replaced by it
  (`:1-6`) (b).
- **Decision**: default STUN `[]`, never inject a default; `transport.enabled=false`; capability
  `webrtc-upgrade-v1` advertised only when the owner enables it. Remove "turn" path label from admin UI.

### R8. Protocol pinning
- **Finding**: `INTERACTION_PROTOCOL_REVISION='question-approval-v2'` is only logged (`:184,:2798`); hello has
  `protocol:3` + capabilities, no client version negotiation (b).
- **Decision**: new contract `packages/mobile-protocol` v1 (see `contracts/`): server `hello` →
  client `client-hello` → server rejects with `protocol/unsupported` on mismatch.

### R9. Removed author/third-party endpoints (FR-011)
- Remove update checks to GitHub Clarklevis releases (`client.js:636,1429`).
- Cloudflare tunnel, `cloudflared` auto-download, `public-setup` helper, `bin/setup-ip.mjs`
  (cloud metadata probe): **disabled by default and excluded from v1**; remote-outside-LAN goes through the
  owner's VPN (Tailscale) to the TLS listener. Kept in tree behind a hard `false` until a later spec.

### R10. `session-query-sqlite` override (FR-009)
- **Decision**: remove from default `cordis.patch.yml`; ship as opt-in snippet in README.
  Consequence: mobile search may be slower/limited until the owner opts in (documented).

### R11. Logging (FR-012)
- **Decision**: central `redact()` in `logging.mjs` for tokens, pairing codes, `argsPreview`/arguments,
  Authorization headers; stop logging full URLs with credentials (`index.mjs:3379`); test greps captured logs.

## T009 verification on DSH source (2026-11-08)

Source: `deepseek-harness` tag `dsh-v0.2.2-rc.1` @ `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` (beastcore, read-only).
The installed desktop build could not be compared (packed `app.asar`).

### V1. `tool/call.arguments` (amends R5)
- `tool/call` is a **session event**; `arguments` is **always a raw JSON string** from the model
  (`packages/core/session/src/types.ts:369`, `packages/llm/llm/src/types.ts:112-119`) (b).
- Appended once from the assembled block, **before** the pre-execute → approval pipeline for the same
  `callId` (`packages/core/tools/src/batch.ts:157-159, 243-249`; `pipeline.ts:199-204`) (b) — but only when
  the batch has a `log`; otherwise approval may arrive with no `tool/call` at all (b).
- `approval/request` carries no arguments and `callId` is **optional**
  (`packages/interaction/user-approval/src/types.ts:63-76`) (b).
- Arrival order at the plugin is **not guaranteed**: `tool/call` comes via the session stream,
  `approval/request` via the remote-event waterfall (`packages/api/remotes/src/remote-events.ts:28`) (c).
- **Amended decision**: `argsHash = sha256_hex(JCS({toolName, callId, arguments: JSON.parse(str)}))`.
  `argsHash = null` (mobile may not decide; desktop decides) when: no `callId`, no `tool/call` arrives within a
  short wait window (≤ 1 s) after `approval/request`, or `JSON.parse` fails.

### V2. Approval outcomes (replaces R6)
- Valid outcomes are exactly `allowed-once | rejected | cancelled | unavailable`; there is **no "always"**
  (`user-approval/src/index.ts:56`, `types.ts:32`) (b).
- The waterfall returns whatever a handler returns; only `next()` delegates
  (`vendor/cordis/src/events.ts:246-261`) (b). Unknown values and throws are normalized to `unavailable`
  = **rejected, fail-closed** (`user-approval/src/index.ts:306-318`) (b). Session policy `never` → `rejected`.
- **Correction**: returning `undefined` does **not** hand off to the desktop — it rejects immediately.
- **Amended decision**: when mobile does not decide (no client, `argsHash:null`, timeout), the gateway handler
  must `return next()` so the desktop UI decides. Coercing unknown values is unnecessary (DSH already
  fail-closes); instead test that every non-decision path calls `next()`.

### V3. Native `remoteAccess` (amends R3)
- DSH has `@deepseek-ai/dsh-api-remote-access`: the Gateway calls `remoteAccess.decide()` before every call
  from a non-owner Peer and filters outgoing events; owner always allowed; unregistered principal kinds are
  denied `no-allow` (`packages/api/gateway/src/index.ts:215, 633, 814-821`;
  `packages/api/remote-access/src/index.ts:153, 199-215`) (b).
- No boolean `remoteControl`/`remoteAccess.enabled` setting exists (b, negative).
- **Amended decision**: keep the plugin switch `remoteControl.enabled` (still the only on/off), and make
  mobile peers run as a **dedicated non-owner principal** with a registered policy via
  `ctx.remoteAccess.registerPolicy(kind, policy)` that mirrors `companion-v1`. This puts DSH's own access
  control behind the plugin allowlist (defense in depth). If the gateway currently connects as owner, that
  must change.

### V3 follow-up — T022a design, 2026-11-09
- Source inspection confirms gateway `api` and `deviceApi` currently share `{kind:'owner'}`: Host-side policy defense is inert (b, `lib/index.mjs` owner peer construction).
- Pinned DSH `0.2.2-rc.1` source/installed distribution: `registerPolicy(kind, {bindings, explain?})` returns a disposer, is effect-scoped and rejects duplicate kinds. Bindings match exact resource kind/id, not wildcard; unregistered principal is denied. Gateway validates arguments before policy evaluation; a bypass test must use descriptor-valid arguments to reach `remote-access/denied` (b).
- Implementation direction: per-device non-owner Peer `{kind:'dsh-ext-mobile-device', deviceId}`, positive endpoint guard shared with policy roles, empty Fetch allowlist, dispose peer on disconnect/revoke, invalidate policy on device/session changes. Keep loopback owner peer separate. Session bindings must enumerate visible session ids; no wildcard assumption.
- Proposed endpoint mapping requires runtime verification: session list/search/follow/page/events/control/prompt/cancel; subagent prompt/interrupt resource resolver and exact event action names remain unverified. Do not authorize speculative endpoints merely to make tests pass.
- Evidence is source-only, not a live Host measurement; dedicated policy integration remains pending behind current approval writer.

## Still open
- Real-world arrival order over the network (measured in T024 tests with a delayed `tool/call`).
- Whether an aborted stream can append `tool/call` with incomplete arguments (covered by parse-failure → null).
