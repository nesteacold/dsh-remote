# Feature Specification: Mobile Companion App

**Feature Branch**: `002-companion-app`

**Created**: 2026-11-09

**Status**: Draft

**Package**: `apps/mobile-companion` (consumes `packages/mobile-protocol` v1)

**Input**: Owner goal "hoàn thành mobile app". Scope from `docs/roadmap/dsh-companion-spec.md` §1, §5b and
constitution Part B, constrained to the operations of `contracts/mobile-protocol-v1.md` (spec 001).

## Context

The DSH Host keeps executing agent sessions. The hardened gateway (spec 001) exposes a narrow, pinned,
versioned WSS API. This app is the phone-side controller: pair, watch sessions, answer approvals,
send instructions, get notified. It never executes agent work and never wraps the DSH web UI.

Where the old roadmap draft differs from contract v1, **contract v1 wins** (e.g. approval outcomes are
`allowed-once` / `rejected` only; "Edit + note" is done by rejecting and sending a follow-up prompt).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pair my phone with my computer (Priority: P1)

I scan the QR code shown by the gateway on my computer; the app verifies it is talking to that exact
computer and stores its credential securely.

**Why this priority**: Nothing else works without a trusted pairing.

**Independent Test**: Against a test gateway, scan a QR → paired; scan an expired or reused QR → clear
error; point the app at a host with a different certificate → refused.

**Acceptance Scenarios**:

1. **Given** a valid QR (v3), **When** I scan it, **Then** the app connects over WSS, checks the
   certificate fingerprint before sending anything, pairs, and shows the host name.
2. **Given** the certificate does not match the QR fingerprint, **When** connecting, **Then** the app aborts
   and explains the host is not trusted; no code or token is sent.
3. **Given** a paired device, **When** I reopen the app, **Then** biometric/device-passcode unlock is
   required before the credential is used.
4. **Given** the gateway revokes this device, **When** the app next connects, **Then** it removes the stored
   credential and returns to pairing.
5. **Given** the host speaks a protocol version the app does not support, **When** connecting, **Then** the
   app shows "update app" or "update host" instead of failing silently.

---

### User Story 2 - See what my agents are doing (Priority: P1)

I see my sessions grouped as running / idle / archived, with a clear badge on any that waits for my decision.

**Why this priority**: Monitoring is the reason to open the app.

**Independent Test**: With a test gateway serving 200 sessions, browse tabs, search, pull to refresh; trigger
a pending approval → badge appears.

**Acceptance Scenarios**:

1. **Given** paired, **When** I open the app, **Then** sessions load in three tabs with title, state and
   updated-ago.
2. **Given** a session gets a pending approval, **When** the event arrives, **Then** its row shows a
   "needs decision" badge within 5 seconds.
3. **Given** I type in search, **When** results return, **Then** only matching sessions are shown.

---

### User Story 3 - Approve or reject exactly what I see (Priority: P1)

Inside a session I read the conversation and approval cards; approving sends back the exact hash of what
was shown.

**Why this priority**: Unblocking agents from the phone is the core value (the gap in other apps).

**Independent Test**: Test gateway emits an approval; approve → applied once; change arguments server-side
and approve with the old hash → app shows "this request changed, review again".

**Acceptance Scenarios**:

1. **Given** an approval card with `argsHash`, **When** I approve or reject, **Then** the response carries
   that hash and the card updates to the result.
2. **Given** the server answers `approval/hash-mismatch`, **When** shown, **Then** the card reloads and asks
   me to review again.
3. **Given** `argsHash` is null, **When** shown, **Then** the card says "decide on your computer" and has no
   approve button.
4. **Given** the approval was resolved elsewhere, **When** I act, **Then** I see "already decided".
5. Approve/reject takes at most 3 taps from opening the card.

---

### User Story 4 - Steer a running session (Priority: P2)

I send a follow-up instruction or cancel a session from the phone.

**Independent Test**: Send a prompt twice with the same client id while offline/online → applied once.

**Acceptance Scenarios**:

1. **Given** a session, **When** I send text, **Then** it is delivered once even if I retry after a network drop.
2. **Given** a running session, **When** I tap cancel and confirm, **Then** the session is cancelled.

---

### User Story 5 - Stay connected on a phone network (Priority: P2)

The app keeps working through screen lock, Wi-Fi/4G switches and short outages.

**Independent Test**: Drop the network for 30 s mid-session → reconnects, no duplicate or missing messages.

**Acceptance Scenarios**:

1. **Given** the connection drops, **When** the network returns, **Then** the app reconnects with backoff
   (1 s, 2 s, 5 s, then up to 30 s) and shows a reconnecting banner meanwhile.
2. **Given** reconnection, **When** history is refreshed, **Then** no message is duplicated or lost.

---

### User Story 6 - Get notified when a decision is needed (Priority: P3)

I get a notification when an agent waits for me; tapping it opens that session and card.

**Independent Test**: With the app backgrounded, raise an approval → notification; tap → correct card.

**Acceptance Scenarios**:

1. **Given** push is enabled, **When** an approval is requested, **Then** a notification arrives containing
   only session/approval ids and a short title — no code, arguments or secrets.
2. **Given** I tap it, **When** the app opens, **Then** it navigates to the session and the approval card
   within 3 seconds after unlock.

### Edge Cases

- QR scanned while the host's remote control is off → "turn on remote control on your computer".
- Host certificate regenerated → pinning fails → guided re-pair.
- Several hosts paired → the app lists hosts; MVP supports one active host at a time.
- Session list larger than the 500-item / 30-day history window → older items hidden with a note.
- Artifact larger than 100 MiB → show "open on computer" instead of downloading.
- App opened offline with cached data → shows cached list read-only with an offline banner.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: App MUST render natively (React Native + Expo); no WebView of the DSH web UI.
- **FR-002**: App MUST pair only via QR payload v3 and MUST verify the certificate fingerprint before
  sending any code or token.
- **FR-003**: Credentials MUST be stored only in the platform secure store (Keychain / Keystore) and MUST
  require biometric or device passcode to unlock on app start.
- **FR-004**: App MUST perform the `client-hello` version handshake and MUST show an explicit update message
  on `protocol/unsupported`.
- **FR-005**: App MUST use only operations in `@dsh-ext/mobile-protocol` OPS; it MUST import the contract
  package rather than redefine names.
- **FR-006**: Approval responses MUST echo the received `argsHash`; cards with `argsHash: null` MUST NOT
  offer approval.
- **FR-007**: Prompts MUST carry a unique `clientMsgId` and be safe to retry.
- **FR-008**: App MUST reconnect with bounded backoff and avoid duplicate/missing messages after reconnect.
- **FR-009**: App MUST handle revocation (`auth/revoked`) by deleting the stored credential.
- **FR-010**: Push payload handling MUST NOT require any secret in the notification; content is fetched over
  the authenticated connection after open.
- **FR-011**: App MUST NOT log or display tokens, pairing codes or full tool arguments in diagnostics.
- **FR-012**: App MUST contain no analytics, crash reporting or third-party network endpoints by default.

### Key Entities

- **PairedHost**: host name, endpoint, certSha256, deviceId, credential reference (in secure store).
- **SessionSummary**: id, title, state (running/idle/archived), updatedAt, needsDecision.
- **ApprovalCard**: approvalId, rpcId, sessionId, toolName, argsPreview, argsHash (nullable), status.
- **OutgoingPrompt**: clientMsgId, sessionId, text, status (queued/sent/acked/failed).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user pairs in under 60 seconds from opening the app.
- **SC-002**: 100% of connections to a host with a non-matching certificate are refused before any secret is sent.
- **SC-003**: A pending approval appears as a badge within 5 seconds of being raised.
- **SC-004**: Approve/reject in ≤ 3 taps; hash mismatch always produces the review-again state.
- **SC-005**: After a 30-second network drop, zero duplicated or lost messages in the session view.
- **SC-006**: Scrolling a 200-session list stays smooth on a mid-range Android phone (no visible frame drops).
- **SC-007**: Automated end-to-end test (pair → list → open → approve → reconnect) passes against the gateway
  from spec 001 on both Android and iOS simulators.

## Assumptions

- Gateway from spec 001 is the only server; contract v1 is authoritative.
- One active host at a time in MVP; multiple stored hosts allowed.
- Push delivery uses the owner's own APNs/FCM credentials configured on the Host; until those exist,
  US6 is verified with local notifications from the live connection (no third-party push server).
- Distribution in MVP is internal (Expo dev build / TestFlight / Play internal); store submission needs
  owner approval and is out of this feature.
- UI languages: Vietnamese and English.
