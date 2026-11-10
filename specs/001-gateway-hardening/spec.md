# Feature Specification: Mobile Gateway Hardening

**Feature Branch**: `001-gateway-hardening`

**Created**: 2026-11-08

**Status**: Draft

**Package**: `plugins/mobile-gateway` (+ `packages/mobile-protocol`)

**Input**: Owner decision 2026-11-08 (option A): fork `Clarklevis1995/dsh-plugin-mobile-gateway` v0.12.0
@ `74ac444c7ff0ef396cd3680e8f49b178e1b32928` as the Host-side layer, fix the audit findings
(`docs/arch-notes/audit-clarklevis-20261108.md`), and expose a narrow API for our own RN + Expo companion app.

## Context

The upstream gateway is a valid Cordis plugin with good pairing (one-time 5-minute code, hashed
per-device tokens, isolated revocation). It fails the constitution by default: plaintext LAN WebSocket
on all interfaces, near-full Host API reachable from a phone token, a route that disables auth, approvals
without content binding, and no DSH version pin. This feature makes the gateway safe to expose before
any device build. The companion app itself is a separate feature.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Nothing is reachable until the owner turns it on (Priority: P1)

As the Host owner, I install the gateway and nothing listens beyond this machine and no phone can
connect until I explicitly enable remote control.

**Why this priority**: Prevents the C1 exposure (plaintext listener on every interface) by default.

**Independent Test**: Install the forked plugin with default config, list listening sockets and call
companion endpoints from another LAN machine.

**Acceptance Scenarios**:

1. **Given** a fresh install with defaults, **When** listening sockets are listed, **Then** no gateway
   socket is bound to anything but 127.0.0.1 and no plaintext LAN listener exists.
2. **Given** `remoteControl.enabled` is off, **When** any companion endpoint is called with a valid token,
   **Then** it is refused (403) and nothing about sessions is returned.
3. **Given** remote control is turned off while a phone is connected, **When** the change applies,
   **Then** the phone's connection is closed within 5 seconds.

---

### User Story 2 - A phone pairs over an encrypted, pinned channel (Priority: P1)

As the owner, I pair my phone by scanning a QR code; the phone talks to the Host only over an
encrypted channel whose certificate fingerprint came from that QR code.

**Why this priority**: Fixes C1/M1 — a token must never travel in clear and a man-in-the-middle must fail.

**Independent Test**: Pair a test client using the QR payload, then repeat with a different certificate
presented by an interception proxy.

**Acceptance Scenarios**:

1. **Given** remote control is on, **When** the owner generates a pairing QR, **Then** it contains the
   endpoint, a one-time code valid for at most 5 minutes, and the certificate fingerprint.
2. **Given** a client presents the code over an encrypted connection with the matching fingerprint,
   **When** pairing completes, **Then** it receives a per-device token and the code can never be reused.
3. **Given** a connection whose certificate does not match the pinned fingerprint, **When** the client
   connects, **Then** the connection is aborted and no token or code is sent.
4. **Given** the pairing code is sent in a URL query string, **When** the gateway receives it, **Then**
   it is rejected.

---

### User Story 3 - A leaked phone token cannot take over the Host (Priority: P1)

As the owner, if my phone is lost, its token can only do the companion's job — read sessions, send
prompts, cancel, answer approvals — never install plugins, change settings, or manage workspaces.

**Why this priority**: Fixes C2 — today a phone token can install or remove plugins and mutate settings.

**Independent Test**: With a valid device token, call every upstream operation; only allowlisted ones succeed.

**Acceptance Scenarios**:

1. **Given** a valid device token, **When** it calls plugin install/remove, version exemption, settings
   mutate/update, workspace create/archive, or schedule operations, **Then** each is refused.
2. **Given** a valid device token, **When** it calls an allowlisted operation, **Then** it succeeds.
3. **Given** any request, **When** it tries to disable authentication, **Then** no route exists to do so
   and authentication stays required.
4. **Given** the owner revokes one device, **When** that device retries, **Then** it is refused and its
   live connection closes, while other paired devices keep working.

---

### User Story 4 - I approve exactly what I saw (Priority: P2)

As the owner approving a dangerous tool call from my phone, my approval applies only to the exact
arguments shown to me.

**Why this priority**: Fixes M2 — approvals today bind only to an id, not to content.

**Independent Test**: Request an approval, alter the pending call's arguments, then submit the decision
with the original hash.

**Acceptance Scenarios**:

1. **Given** a pending approval, **When** it is sent to the phone, **Then** it includes a hash of the
   canonical tool arguments.
2. **Given** a decision carrying the matching hash, **When** submitted, **Then** it is applied once.
3. **Given** a decision whose hash does not match the pending call, **When** submitted, **Then** it is
   rejected (409) and the call stays pending.
4. **Given** the same decision is submitted twice, **When** processed, **Then** the second has no effect.

---

### User Story 5 - The gateway only runs on the DSH version it was built for (Priority: P3)

As the owner, the gateway declares the DSH version it supports and does not silently change unrelated
Host configuration.

**Why this priority**: Fixes M4; protects against silent breakage on DSH upgrades.

**Independent Test**: Inspect package metadata and the installed composition; attempt install on a
mismatched DSH version.

**Acceptance Scenarios**:

1. **Given** the package metadata, **When** read, **Then** it declares DSH `0.2.2-rc.1` compatibility.
2. **Given** a default install, **When** the Host composition is inspected, **Then** no unrelated Host
   plugin configuration (e.g. session-query storage) is overridden.

### Edge Cases

- Host machine has no LAN-reachable address; owner uses a tunnel/VPN instead → pairing QR carries the
  tunnel endpoint and its fingerprint.
- Certificate is regenerated → previously paired devices fail pinning and must re-pair; the owner is told why.
- Pairing code expires mid-scan → clear error, new code required.
- Two phones pair concurrently → each gets its own token; revoking one does not affect the other.
- Approval resolved on desktop first → phone decision returns "not pending".
- Peer-to-peer mode requested → no third-party STUN unless the owner configures one.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Gateway MUST bind only to 127.0.0.1 by default; any non-loopback listener MUST be
  explicitly enabled by the owner and MUST be encrypted.
- **FR-002**: Gateway MUST refuse all companion traffic unless `remoteControl.enabled` is on (default off),
  and MUST close live companion connections when it is turned off.
- **FR-003**: Gateway MUST NOT offer any unencrypted remote transport; plaintext `ws://` beyond loopback
  MUST be removed.
- **FR-004**: Pairing QR MUST carry endpoint, one-time code (TTL ≤ 5 min, single use) and certificate
  fingerprint; the code MUST NOT be accepted via URL query string.
- **FR-005**: Gateway MUST expose companion operations only under a versioned narrow API
  (`/api/mobile/v1`) limited to: list/read sessions, read messages, send prompt, cancel, list pending
  approvals, submit approval decision, register/remove push token, list/revoke own device.
- **FR-006**: Device tokens MUST be refused for plugin management, version exemptions, settings,
  workspaces, schedules, commands execution and file upload/download.
- **FR-007**: Authentication MUST be permanently required; the route that disables it MUST be removed.
- **FR-008**: Each pending approval MUST carry a hash of canonical tool arguments; decisions MUST be
  verified against it (mismatch → 409) and be idempotent.
- **FR-009**: Package MUST declare DSH `0.2.2-rc.1` compatibility and MUST NOT override unrelated Host
  plugin configuration by default.
- **FR-010**: Peer-to-peer mode MUST default off and MUST NOT use any third-party STUN/TURN unless the
  owner configures one.
- **FR-011**: Upstream author endpoints (self-update, tunnel binary auto-download without hash check,
  cloud metadata probes) MUST be removed or disabled by default.
- **FR-012**: Tokens, pairing codes and approval arguments MUST NOT appear in logs.

### Key Entities

- **Device**: paired phone; id, name, platform, hashed token, pairedAt, lastSeen, revoked.
- **PairingOffer**: one-time code (hashed), expiry, endpoint, certificate fingerprint.
- **PendingApproval**: approval id, session id, tool name, display reason, argsHash, state.
- **RemoteControlState**: enabled flag, bound endpoints, active connections.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With default config, a LAN port scan of the Host finds zero gateway listeners.
- **SC-002**: 100% of non-allowlisted upstream operations are refused for a device token (automated test
  enumerates them).
- **SC-003**: An interception proxy with a different certificate obtains no token or pairing code in
  100% of attempts.
- **SC-004**: A decision with a mismatched argument hash is rejected in 100% of attempts; a matching one
  is applied exactly once.
- **SC-005**: Turning remote control off closes all companion connections within 5 seconds.
- **SC-006**: Log capture across a full pair → prompt → approve → revoke run contains no token, code or
  approval argument.
- **SC-007**: Upstream gateway test suite still passes for retained behaviour, plus new tests for each FR.

## Assumptions

- Base: gateway v0.12.0 @ `74ac444`, MIT; fork keeps the license and attribution.
- DSH upstream pinned to `dsh-v0.2.2-rc.1`; `remoteControl.enabled` is a setting owned by our fork until
  DSH offers one natively.
- Remote access outside the LAN goes through a tunnel/VPN the owner controls (e.g. Tailscale); a public
  relay is out of scope (P2).
- Certificate is self-signed per Host with fingerprint pinning; a private CA is a later option.
- The companion app (RN + Expo) is feature `002`; this feature delivers only the Host side and a test client.
- Open audit items (WebRTC fallback details, `fallbackApproval` behaviour, protocol pinning) are resolved
  during `/speckit-plan` research.
