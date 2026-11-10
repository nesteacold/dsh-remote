# Implementation Plan: Mobile Gateway Hardening

**Branch**: `001-gateway-hardening` | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-gateway-hardening/spec.md`

## Summary

Import `Clarklevis1995/dsh-plugin-mobile-gateway` v0.12.0 @ `74ac444c` (MIT) into
`plugins/mobile-gateway/` with history-preserving attribution, then close the audit findings with the
smallest changes: loopback-only by default, owner switch `remoteControl.enabled`, a plugin-owned TLS
listener with QR-pinned fingerprint, an operation allowlist `companion-v1`, approvals bound to a JCS
sha256 of tool arguments, `engines.dsh`, no third-party STUN/update endpoints, and log redaction.
The app-facing contract is extracted to `packages/mobile-protocol` v1. Details: [research.md](research.md).

## Technical Context

**Language/Version**: JavaScript ESM (`.mjs`), Node ≥ 24.9 (upstream unchanged; no TS migration in this feature)

**Primary Dependencies**: `ws ^8.18`, `werift 0.25.2` (kept, disabled by default), `qrcode ^1.5.4`,
`@deepseek-ai/schemastery ^3.18.1`; **new** `selfsigned` (exact pin) for cert generation (R1)

**Storage**: plugin data dir — devices registry, pairing offers, host cert/key (owner-only file mode)

**Testing**: `node --test` (upstream 38 files kept) + new tests per FR; test client script for pairing/pinning

**Target Platform**: DSH Host `dsh-v0.2.2-rc.1` on Windows/macOS/Linux

**Project Type**: DSH Cordis plugin + shared contract package (monorepo `dsh-ext`)

**Performance Goals**: kill switch closes all connections ≤ 5 s; pairing round trip < 2 s on LAN

**Constraints**: no DSH core changes (A1); no plaintext beyond loopback (A4/B2); no third-party network
calls by default; logs contain no secrets

**Scale/Scope**: single owner, ≤ 10 paired devices; touches ~8 upstream files (see Structure)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
|---|---|---|
| A1 Extend, never fork DSH core | PASS | Plugin only; TLS on plugin-owned listener; `engines.dsh`; sqlite override removed (R2, R10) |
| A2 Host executes, clients control | PASS | Gateway only relays; no execution added |
| A3 Contract-first | PASS | `packages/mobile-protocol` v1 + `client-hello` version check (R8) |
| A4 Secure by default | PASS (after change) | Loopback default, TLS + pin, allowlist, redaction (R2–R4, R11) |
| A5 Evidence | PASS | research labelled; `[verify-dsh]` items become explicit tasks |
| A6 One folder per unit | PASS | `plugins/mobile-gateway/`, `packages/mobile-protocol/` |
| B2 Owner switch & pairing | PASS | `remoteControl.enabled` default false; QR TTL 5 min with `certSha256` |
| B3 Safe approvals | PASS | `argsHash` + 409; missing args → desktop only (R5) |
| B5 Base | PASS | Fork of v0.12.0 @ 74ac444, MIT attribution kept |

New dependency `selfsigned` is the only addition; justified in Complexity Tracking.

**Post-design re-check**: PASS — contracts and data model introduce no new violations.

## Project Structure

### Documentation (this feature)

```text
specs/001-gateway-hardening/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/mobile-protocol-v1.md
└── tasks.md            # next: /speckit-tasks
```

### Source Code (repository root)

```text
plugins/mobile-gateway/            # imported via git subtree from upstream @74ac444c
├── UPSTREAM.md                    # NEW: base commit, license, list of local changes
├── package.json                   # name @dsh-ext/mobile-gateway, engines.dsh, + selfsigned
├── cordis.patch.yml               # loopback default, remoteControl.enabled=false, no sqlite override
├── lib/
│   ├── index.mjs                  # router allowlist, remote switch, TLS listener, approval hash, hello
│   ├── tls.mjs                    # NEW: cert create/load, fingerprint
│   ├── allowlist.mjs              # NEW: companion-v1 ops
│   ├── approval-hash.mjs          # NEW: JCS canonicalize + sha256
│   ├── redact.mjs                 # NEW: log redaction (used by logging.mjs)
│   ├── devices.js                 # pairing offer adds certSha256; code via subprotocol only
│   ├── dsh-host-adapter.mjs       # deny non-allowlisted ops for device callers
│   ├── transport-config.mjs       # STUN default [] ; no injected default
│   ├── logging.mjs                # route through redact
│   └── client.js                  # remove auth toggle, update checks, turn label
├── bin/setup-ip.mjs               # disabled in v1 (hard false)
└── test/
    ├── (upstream tests kept)
    ├── remote-switch.test.mjs     # NEW
    ├── tls-pin.test.mjs           # NEW
    ├── allowlist.test.mjs         # NEW
    ├── approval-hash.test.mjs     # NEW
    ├── log-scan.test.mjs          # NEW
    └── client/pair.mjs            # NEW test client

packages/mobile-protocol/
├── package.json                   # @dsh-ext/mobile-protocol, version 1.0.0
├── src/index.mjs                  # constants, op list, error codes, frame shapes (JSDoc types)
└── test/contract.test.mjs
```

**Structure Decision**: one Cordis plugin + one shared contract package inside the existing monorepo
layout. Upstream is imported with `git subtree` so its history and MIT attribution stay traceable
(same pattern used for `plugins/dsh-wiki`).

## Phasing for tasks

1. Import upstream (subtree) + `UPSTREAM.md`; baseline `npm test` must pass unchanged.
2. P1 stories first: US1 (loopback + switch), US2 (TLS + pin + QR v3), US3 (allowlist + remove auth toggle).
3. US4 approval hash (needs `[verify-dsh]` on `tool/call.arguments` ordering).
4. US5 `engines.dsh` + sqlite override removal; FR-010/011/012 cleanups.
5. Extract `packages/mobile-protocol`; gateway imports it.
6. Reviewer (mandatory: auth/pairing/network exposure) before merge.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| New dependency `selfsigned` | Node cannot create X.509 certs natively | Hand-written ASN.1/DER (~150 lines) is high-risk security code; `openssl` not guaranteed on Windows |
| Keeping disabled tunnel/WebRTC code in tree | Smallest diff vs upstream eases future rebases | Deleting it enlarges the diff and loses upstream sync; it stays hard-disabled and untested-off-path |
