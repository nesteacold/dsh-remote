---
description: "Task list for 001 Gateway Hardening"
---

# Tasks: Mobile Gateway Hardening

**Input**: `specs/001-gateway-hardening/` — spec.md, plan.md, research.md (R1–R11), data-model.md,
contracts/mobile-protocol-v1.md, quickstart.md

**Tests**: required — spec success criteria SC-001…SC-007 are test-defined.

**Paths**: plugin `plugins/mobile-gateway/` (abbrev. `MG/`), contract `packages/mobile-protocol/` (abbrev. `MP/`).
Upstream line numbers refer to `74ac444c` and shift as edits land — re-locate by symbol.

**Owner decisions in force**: new dependency `selfsigned` approved (2026-11-08), exact version pin.

## Format: `[ID] [P?] [Story] Description`
- **[P]** parallel-safe (different files, no unmet dependency) · **[Story]** US1…US5

---

## Phase 1: Setup

- [x] T001 Import upstream into `MG/` with `git subtree add --prefix plugins/mobile-gateway https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway 74ac444c7ff0ef396cd3680e8f49b178e1b32928` (squash off, history kept)
- [x] T002 Run upstream suite unchanged: `npm ci && npm test` in `MG/`; record literal output as baseline (failures are recorded, not fixed here)
- [x] T003 [P] Create `MG/UPSTREAM.md`: base repo/commit, MIT notice, table of local changes (filled as tasks land)
- [x] T004 [P] Rename package to `@dsh-ext/mobile-gateway`, add `"engines": {"dsh": "0.2.2-rc.1", "node": ">=24.9"}`, add `selfsigned` exact pin in `MG/package.json` (US5/FR-009 groundwork)
- [x] T005 [P] Scaffold `MP/` (`package.json` `@dsh-ext/mobile-protocol` 1.0.0, `src/index.mjs`, `test/`)

### Phase 1 results (2026-11-08)
- T001 ✅ subtree commit `73f5415`; tree identical to upstream `74ac444c` (verified by tree hash).
- T002 ⚠️ baseline red on Windows only: `test/auth.test.mjs:67` asserts POSIX mode `0o600`, NTFS returns
  `0o666`; the `&&` chain aborts, so `lan`, `cloudflared-binary`, `cloudflare-tunnel`,
  `public-endpoint-check`, `gateway-tools`, `multi-gateway`, `test:webrtc` never ran. Everything executed
  passed (77/77 `node --test` + 147 dispatch). Upstream ships `pnpm-lock.yaml`; we add `package-lock.json`
  (npm is the repo standard) — use `npm ci`, not `npm install` (npm tries to build optional `canvas`).
- T003–T005 ✅. `selfsigned` pinned `5.5.0` (CJS, depends on `@peculiar/x509` + `pkijs`).
- Old package id `dsh-plugin-mobile-gateway` is a **runtime id** (`cordis.patch.yml:7`, `lib/client.js:5`,
  setup-ip marker, tests) — renamed only in `package.json` name for now; see T005a.

- [x] T002a Make file-permission handling platform-aware: guard `chmod`/`mode` in `lib/devices.js`,
  `gateway-state.mjs`, `cloudflare-tunnel.mjs`, `cloudflared-binary.mjs`, `file-upload.mjs`; on Windows
  restrict secrets files with an ACL for the current user (`icacls` /inheritance:r /grant:r) or document the
  limit; platform-gate the POSIX assertion in `test/auth.test.mjs:67` and add a Windows equivalent. Then run
  the full suite so the 7 skipped files produce a real baseline (prerequisite for SC-007 and T016).
- [ ] T005a Decide runtime id: keep loader name `dsh-plugin-mobile-gateway` (bundle/client id) vs rename to
  `@dsh-ext/mobile-gateway` everywhere (`cordis.patch.yml:7`, `lib/client.js:5`, `bin/setup-ip.mjs`, helper,
  `test/package-install.test.mjs:44`, `test/setup-ip.test.mjs`). Lead decision; default = rename together
  with T012 so `package.json` name and loader name match.

### Phase 2 results (2026-11-09, commit `ad158f6`)
- T002a ✅ `lib/secure-file.mjs` (POSIX chmod; win32 `icacls` via arg array, warn-and-continue);
  `auth.test.mjs` asserts the real Windows ACL. T006 ✅ redact in `log()`, 16/16. T007/T008 ✅ contract 5/5.
  Lead re-ran: auth PASS, dispatch 147 PASS, protocol 5/5, redact+logging 16/16.
- Remaining red on Windows: `cloudflare-tunnel.test.mjs:63`, `multi-gateway.test.mjs:111` (same POSIX mode
  class) and `lan.test.mjs:272` (needs `cloudflared` on PATH). Decisions:
  - [x] T002b platform-gate those two mode assertions like `auth.test.mjs` (ACL check on win32).
  - [x] T002c `lan.test.mjs:272`: tunnel is hard-disabled in v1 (T031) → make that test case expect
    `disabled`, not `online`; do not install `cloudflared`.
- Decision on `CAPABILITIES`: contract v1 lists only the companion capabilities; gateway `hello` must advertise
  exactly `@dsh-ext/mobile-protocol` CAPABILITIES to companion clients (T029); upstream's 28 legacy
  capabilities stay only for the legacy admin client, never sent on the companion channel.

### Phase 3 decisions (lead, 2026-11-09)
- T002b/T002c ✅ full `npm test` green on Windows (coder); extra POSIX-mode assertion at
  `lan.test.mjs:277` fixed the same way; tunnel block in `lan.test.mjs` skipped only when `cloudflared` is
  absent and still asserts the missing-binary error.
- Effective remote switch = `remoteControl.enabled` (explicit wins; legacy `gatewayEnabled` alias) **and**
  runtime `gatewayMode !== 'disabled'`.
- Disabled HTTP paths answer **403** `remote/disabled` (was 503); 401 stays for missing/invalid credentials.

### Phase 3 results (2026-11-09)
- US1 ✅ full `npm test` exit 0 on Windows (lead re-ran). Fixed 2 upstream bugs: transport had no `terminate()`; `MobileConnection.terminate()` was graceful-only.
- Switch is a permission, not a start signal. Gateway-mode disabled with switch on keeps upstream 503.
- Carry-over: code default `lanHost` still `0.0.0.0` (index.mjs ~2359) → fix in T017; ACL assert duplicated in 4 tests → helper in T033.

## Phase 2: Foundational (blocks all stories)

- [x] T006 [P] `MG/lib/redact.mjs` + route `MG/lib/logging.mjs` through it (tokens, pairing codes, Authorization, arguments/argsPreview) (FR-012)
- [x] T007 [P] `MP/src/index.mjs`: protocol constants (`protocol`, `protocolVersion:1`, `minClientVersion:1`), op list `companion-v1`, error codes, frame shapes per contract
- [x] T008 [P] `MP/test/contract.test.mjs`: op list and error codes match `contracts/mobile-protocol-v1.md`
- [x] T009 [verify-dsh] beastcore (done 2026-11-08, results in research.md V1–V3): read DSH `dsh-v0.2.2-rc.1` source for (a) `tool/call.arguments` type and ordering vs `approval/request`, (b) semantics of non-standard downstream approval results, (c) any native remote-access setting. Report feeds T024, T026, T011.

**Checkpoint**: redaction + contract package exist; T009 report received.

---

## Phase 3: US1 — Nothing reachable until enabled (P1) 🎯

**Independent test**: quickstart steps 2, 3, 8.

- [x] T010 [P] [US1] Test `MG/test/remote-switch.test.mjs`: defaults bind loopback only; disabled → `remote/disabled` 403; toggle off closes all sockets ≤ 5 s (SC-001, SC-005)
- [x] T011 [US1] Config key `remoteControl.enabled` (default false, alias `gatewayEnabled`) in schema `MG/lib/index.mjs` (~233-268) (FR-002, R3)
- [x] T012 [US1] `MG/cordis.patch.yml`: `lanEnabled:false`, host `127.0.0.1`, `remoteControl.enabled:false` (FR-001)
- [x] T013 [US1] Gate every companion entry (upgrade ~3287, rtc ~3278, approval ~3495, router) on the switch (FR-002)
- [x] T014 [US1] Kill switch: on disable → existing close(4004) + `terminate()` after 3 s, close remote listener, stop tunnel (R3)

## Phase 4: US2 — Encrypted, pinned pairing (P1)

**Independent test**: quickstart steps 4, 5.

- [ ] T015 [P] [US2] Test `MG/test/tls-pin.test.mjs` + test client `MG/test/client/pair.mjs`: pair with QR v3; replay code → `pairing/expired`; wrong-cert proxy → abort before sending code/token; code in query → rejected (SC-003)
- [ ] T016 [P] [US2] `MG/lib/tls.mjs`: create/load EC P-256 self-signed cert via `selfsigned`, owner-only key file, `fingerprint256` → hex (R1)
- [ ] T017 [US2] Replace plaintext LAN `http.createServer` (~3347) with plugin-owned `https.createServer` using T016; non-loopback bind only when switch on (FR-001, FR-003, R2)
- [ ] T018 [US2] Remove Tailscale `ws:` enforcement (~2941/2986); only `wss://` endpoints emitted (FR-003)
- [ ] T019 [US2] Pairing payload v3 with `certSha256` (~2991-2998), TTL ≤ 5 min kept; `MG/lib/devices.js` stores offer per data-model (FR-004)
- [ ] T020 [US2] Accept pairing code only via subprotocol `dsh-companion.pair.<code>`; reject query `pairingCode` (~2076) (FR-004)

## Phase 5: US3 — Leaked token cannot take over (P1)

**Independent test**: quickstart step 6.

- [ ] T021 [P] [US3] Test `MG/test/allowlist.test.mjs`: enumerate every op in `dsh-host-adapter.mjs` + query types; only `companion-v1` succeeds for device tokens; revoke isolates one device (SC-002)
- [ ] T022 [US3] `MG/lib/allowlist.mjs` (imports `MP` op list); enforce in router (~3133-3235) and `MG/lib/dsh-host-adapter.mjs` for device callers; deny `plugins.*`, `settings.*`, `permission`, `set-default`, `save-default-model`, `directory-create` (FR-005, FR-006, R4)
- [ ] T022a [US3] Run mobile peers as a dedicated non-owner principal and register a DSH `remoteAccess` policy mirroring `companion-v1` (`ctx.remoteAccess.registerPolicy`); test that a non-allowlisted call is denied by DSH (`remote-access/denied`) even if the plugin check is bypassed (research V3)
- [ ] T023 [US3] Remove `POST /mgw/auth` (~2961-2975), auth toggle UI in `MG/lib/client.js` (~2025-2038), `requireAuth ||` bypass (~3316), `allowQueryToken` (~268); auth always on (FR-007)

## Phase 6: US4 — Approve exactly what I saw (P2)

**Independent test**: quickstart step 7. Depends on T009.

- [ ] T024 [P] [US4] Test `MG/test/approval-hash.test.mjs`: frame has `argsHash`; mismatch → `approval/hash-mismatch` 409 and stays pending; match applied once; duplicate → `not-pending`; `argsHash:null` when no `callId`, `tool/call` delayed > 1 s, or unparsable arguments; `approval/request` arriving before `tool/call` within 1 s still hashes correctly (SC-004, research V1)
- [x] T025 [P] [US4] `MG/lib/approval-hash.mjs`: RFC 8785 JCS + sha256 hex of `{toolName, callId, arguments: JSON.parse(str)}`; parse failure → null (research V1). Coder verified 29/29 focused tests including RFC/golden vectors, Unicode, numeric semantics and fail-closed inputs (2026-11-09). Pure primitive only; integration T024/T026/T027 and independent review remain open.
- [ ] T026 [US4] Cache `tool/call` arguments by `callId` (~390) with ≤ 1 s wait for late arrival; add `argsHash`/`argsPreview` to approval frame (~2493-2503, ~3509-3522); verify on response (~2763) (FR-008)
- [ ] T027 [US4] `fallbackApproval` (~2711) and every non-decision path (no client, `argsHash:null`, timeout) must `return next()` so desktop decides — never return `undefined` (= immediate reject); test each path (research V2)

## Phase 7: US5 — Version pin, no foreign config (P3)

- [x] T028 [US5] Removed the foreign `session-query-sqlite` patch: bundle patch now has exactly one insert row (the gateway's own); README documents the owner opt-in snippet, the whole-config replacement caveat and the disabled-search default. Verified with js-yaml JSON_SCHEMA plus real `loadOverlayPatches` from the pinned DSH; remote-switch/multi-gateway still pass (2026-11-09). No repo test covers patch loading — gap reported, not papered over. Residual: `docs/remote-gateway-refactor-plan.md:44` is stale (lead doc).
- [x] T029 [P] [US5] Hello/client-hello per contract with `protocol`, `protocolVersion`, `minClientVersion`, `capabilities` and `protocol/unsupported` on mismatch, plus the missing dispatch fence: before an accepted `client-hello` only `client-hello` and `ping` run; `client-hello` is exempt from the device scope gate and channel-neutral so a zero-scope device can negotiate but still cannot act. Verified by coder 2026-11-09 (dispatch-fence 12/12, full `npm test` exit 0); independent review of the fence pending. Follow-up flagged: `packages/mobile-protocol` still maps `client-hello` to `sessions:read` in `SCOPE_BY_TYPE`, which the gateway now exempts — protocol owner to confirm or drop the mapping.

- [x] T036 Fence remediation bundle (from the source reviews): plaintext shared upgrade refuses device credentials and non-loopback sources; uniform requestId validation with duplicate-in-flight refusal; pre-negotiation dispatch gate; framing fences ordered before scope refusals; `requestId` echoed only when it matches the contract pattern (malformed ids are never reflected). Lead-verified 2026-11-09: `node --check` OK, `dispatch-fence` 12/12 with a mutation proof (reverting the echo predicate fails B4), full gateway `npm test` **exit 0, 14 zero-fail groups**. Test harnesses were migrated from plaintext to TLS and now negotiate `client-hello`. Contract §1/§3/§3.7/Rev-4 rows updated by the lead to match. Remaining: independent reviewer pass on the final bytes; the 008 bridge path shares `frameFence` and was checked by the same tests.

## Phase 8: Polish & cross-cutting

- [ ] T030 [P] FR-010: STUN default `[]` and no injection implemented; owner-explicit servers preserved, explicit empty remains empty (legacy empty preferences now host-candidates-only). Coder verified framing/preferences/negotiation/no-egress 32/32 using stubs, no external STUN contacted (2026-11-09). Remaining: capability opt-in gate, stale UI/docs and `turn` labels, package-install expectation, independent re-review; do not mark whole task complete.
- [x] T031 [P] FR-011 complete: GitHub release checks and tunnel/public-setup UI removed; backend hard-refuses (`CLOUDFLARED_ENABLED=false`, `CLOUDFLARE_TUNNEL_ENABLED=false`, `PUBLIC_SETUP_DISABLED=true`, typed `cloudflare/disabled` 403); dead wiring removed from `lib/index.mjs` — no `/mgw/cloudflare*`, no `/mgw/public-setup`, no `callSystemHelper`/`HELPER_SOCKET`, no tunnel import/schema/status/construction, `publicUrlFile` read branch gone (owner `publicUrl` kept). Lead verified directly: `node --check` passes and full `npm test` **exit 0, 0 fail** (2026-11-09). Docs updated across 12 files; `package-lock.json` stale `bin` fixed; package description corrected. Residual: `helper/` still listed in `package.json` `files` with nothing referencing it; no live-Host run.
- [x] T032 [P] `MG/test/log-scan.test.mjs` added and registered: one full QR/direct pair → prompt → hash-bound approve → reject → revoke run plus denial/failure paths (reused code, foreign Origin, query credential, no credential, hash-mismatch receipt, scope refusal, revoked token) capturing both the console sink and the log file; asserts no device token, pairing code, QR payload, `dsh-*` subprotocol credential, `Bearer` header or raw tool-argument canary, while `argsHash` (public to device) is not asserted absent and `argsPreview` delivery is asserted by design. Mutation-checked with a planted token and planted canary (both fail, restored). Verified 2026-11-09: focused 1/1 ×4, logging group 17/17, full `npm test` exit 0. Covers spec 001 pairing only; spec 008 OTP/Host-approval path is a follow-up. Prompt text is logged truncated to 60 chars by design (product decision, not a leak).
- [ ] T033 Full `npm test` in `MG/` and `MP/`; compare with T002 baseline (SC-007); fill `MG/UPSTREAM.md` change table
- [ ] T034 Run `quickstart.md` steps 1–9, record literal output
- [ ] T035 **reviewer** (`sol61-opus55`) independent review of the whole diff — mandatory (auth/pairing/network exposure); fix Critical/Major before merge. Initial source review 2026-11-09: FAIL / DO NOT EXPOSE. Exact-approval hash binding missing; owner principal bypass, plaintext shared upgrade, external STUN/tunnel/update paths, package-relative imports outside distributable, missing negotiation fence and scope-filtered pushes require remediation.

### Remediation ownership checkpoint — 2026-11-09
- Pure JCS/hash primitive: coder dispatched, NEW `lib/approval-hash.mjs` + `test/approval-hash-unit.test.mjs` only. End-to-end approval protection remains missing until integrated.
- Browser admin egress slice implemented: GitHub polling/release-driven install UI and tunnel/public-setup actions removed; pairing/device controls preserved. Updated stale UI expectations; combined connection-choice/no-egress/diagnostics tests 35/35 pass (2026-11-09). New no-egress test still needs package test-script registration. This does NOT disable backend tunnel paths or complete T031.
- Core integration (`index.mjs`, adapter, allowlist, devices, protocol) is serialized after explicit handoff from concurrent spec005 owner; do not overwrite interleaved changes. Integrator must implement hash join/receipt/fallback, dedicated non-owner policy, positive adapter allowlist, TLS-only credential entry, hello/requestId fence and scoped pushes.
- Backend transport/tunnel hard-disable and packaging/runtime-id changes await reserved scopes/handoff. No current package-install test: it performs dependency network installs.
- Current wire contract overrides stale task wording: pairing subprotocol is `dsh-pair.<code>`; hash refusal is a normal receipt `accepted:false, reason:'hash-mismatch'`, not HTTP409.
- Final gate requires settled full tests, offline package entry validation, log-scan/E2E and independent re-review. Filenames or green unit tests alone do not establish safe exposure.

---

## Dependencies & order

- Phase 1 → Phase 2 → stories. T009 (beastcore) runs in parallel with Phase 2 but blocks T024–T027.
- US1, US2, US3 are P1; recommended order US1 → US2 → US3 (all edit `lib/index.mjs`, so do not run in
  parallel). US4 after T009. US5 and Phase 8 after the P1 stories.
- [P] tasks inside a phase touch different files and may be delegated concurrently.

## Delegation

| Tasks | Role | Model |
|---|---|---|
| T001–T008, T010–T034 | coder | `r9-fallback / ds41-cmc-ccsonnet` |
| T009 | beastcore | `r9-commandcode / cc/claude-opus-5-5` |
| T035 | reviewer | `r9-fallback / sol61-opus55` |

Coder rules: one phase per dispatch, smallest change, literal test output, no commit (lead commits after
review of each phase).

## MVP

US1 + US2 + US3 (Phases 1–5) = safe-to-expose gateway. US4/US5/Phase 8 complete the spec before the
companion app (spec 002) connects to a real device.
