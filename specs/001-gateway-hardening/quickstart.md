# Quickstart — verify 001 Gateway Hardening

Run on the Host from `dsh-ext/plugins/mobile-gateway`. Literal command output goes in the coder report.

1. Unit + contract tests: `npm test` (upstream suite + new tests per FR).
2. Default-off check (SC-001): install with default config, then
   `Get-NetTCPConnection -State Listen | ? OwningProcess -eq <dsh pid>` → only 127.0.0.1 entries.
3. Remote disabled (FR-002): with a valid token call any op → `remote/disabled` 403.
4. Enable + pair (US2): set `remoteControl.enabled=true`, generate QR in `/mgw`, run the test client
   `node test/client/pair.mjs <qr.json>` → receives token; replay the same code → `pairing/expired`.
5. Pinning (SC-003): run test client against an intercepting proxy with another cert → aborts before
   sending code/token.
6. Allowlist (SC-002): `node --test test/allowlist.test.mjs` enumerates every adapter op → only
   `companion-v1` ops succeed.
7. Approval hash (SC-004): `node --test test/approval-hash.test.mjs` → mismatch 409, match applied once.
8. Kill switch (SC-005): toggle off while connected → all sockets closed ≤ 5 s.
9. Log hygiene (SC-006): run steps 4–8 with log capture, `node test/log-scan.mjs <log>` → no token,
   code or arguments.
