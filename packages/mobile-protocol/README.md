# @dsh-ext/mobile-protocol

Versioned contract between the mobile companion app (spec 002) and the hardened gateway
(`plugins/mobile-gateway`, spec 001): protocol constants, the `companion-v1` operation allowlist,
response kinds, error codes, close codes, approval outcomes and frame shapes. Both sides import this
package so they cannot drift apart silently; the normative definition is
[`contracts/mobile-protocol-v1.md`](../../specs/001-gateway-hardening/contracts/mobile-protocol-v1.md)
(**revision 2**: client frames use `type` + `requestId`, server frames use `kind` and echo
`requestId`; **revision 3** adds device `kind`/`scopes` and `auth/forbidden-scope`,
`specs/005-remote-desktop-client/spec.md`; **revisions 4–5** add the spec 008 remote bridge and its
scopes, additive), and a breaking change requires a new major version of
this package.

- Runtime: `src/index.mjs` — pure ESM, no dependencies, frozen constant tables.
- Types: `index.d.ts` — TypeScript declarations for the same surface (`main` + `types` in
  `package.json`), consumed by `apps/mobile-companion` through `file:../../packages/mobile-protocol`.

## Exports

| Export | Contract § |
|---|---|
| `PROTOCOL_SUBPROTOCOL` (`dsh-mobile-v1`), `SUBPROTOCOL_PREFIXES`, `DEVICE_ID_HEADER`, `pairingSubprotocols()`, `authSubprotocols()`, `deviceSubprotocol()` | §1, §3 |
| `COMPANION_PROTOCOL_VERSION` (1), `MIN_CLIENT_VERSION` (1), `CLOSE_CODES` (4004/4003/4401) | §3 |
| `PAIRING_QR_VERSION` (3) | §2 |
| `OPS` (the §4 `type` column, in table order), `OP_RESPONSES` (§4 response `kind` column) | §4 |
| `CAPABILITIES`, `OPTIONAL_CAPABILITIES` (`push-v1`) | §3.5 |
| `ERROR_CODES` (code → upgrade HTTP status, `null` where the table shows `—`), `PASSTHROUGH_ERROR_CODES` | §6 |
| `APPROVAL_OUTCOMES_CLIENT`, `APPROVAL_OUTCOMES_FINAL`, `RECEIPT_REASONS` | §5 |
| `SERVER_PUSH_KINDS`, `PING_INTERVAL_MS` (25 s) | §1, §4, §5 |
| `DEVICE_KINDS`, `SCOPES`, `DESKTOP_DEFAULT_SCOPES`, `SCOPE_BY_TYPE`, `auth/forbidden-scope` | spec 005 FR2/FR3/FR6 |
| `harness:remote` (scope), `REMOTE_CLIENT_TYPES`, `REMOTE_SERVER_KINDS`, `REMOTE_STREAM_DEFAULT_CREDIT`, `REMOTE_BINARY_CHUNK_BYTES` | spec 008 (revision 4, additive; remote-bridge channel, not §4 ops) |
| `commands:execute`, `workspace:manage`, `credentials:write`, `plugins:manage`, `schedule:write`, `terminal` (scopes), `DESKTOP_ONLY_SCOPES`, `SCOPE_PRESETS` (`standard`, `full`) | spec 008 "full control" (revision 5, additive) |

The spec 008 scopes (`harness:remote` and the six above) are **desktop-only and explicit-only**: none
is in `DESKTOP_DEFAULT_SCOPES`, and a `mobile` or pre-005 record never holds one.
`SCOPE_PRESETS.standard` = `sessions:read`, `prompt:send`, `approval:respond`, `files:read`,
`harness:remote`; `SCOPE_PRESETS.full` = every desktop scope.

## Tests

`npm test` (`node --test`) parses the contract document — the §4 table (escaped `\|` unions
included), the §6 table, the §2/§3/§5 examples and prose — and asserts the exports are exactly what
it says. It fails on any drift, so edit the contract first and this package second.
