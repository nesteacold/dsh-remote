# Feature 008 — Devices page inside DSH Desktop (Qoder-style)

Status: Draft (lead, 2026-11-09). Supersedes 005 phase 2 (the separate desktop app, archived at `apps/_archive/desktop-companion`).
Touches: new `plugins/devices` (`@dsh-ext/devices`). It reuses `plugins/mobile-gateway` and `packages/mobile-protocol` and does not edit them.
Owner decision: no third-party server, no second app. Everything happens inside DSH Desktop, as in Qoder's Settings → Devices (owner screenshot 2026-11-09).

## Target UX (mirrors Qoder Devices)
The plugin adds a page **Devices** to the DSH UI with two tabs.

**Allow connections to this device**
- Toggle "Allow connections" maps to gateway `remoteControl.enabled` + `lanEnabled`. Checkboxes: LAN (on) / Internet (off, disabled: "later spec").
- "Generate pairing code" button, then shows a short-lived pairing string with a Copy button and an expiry countdown. Pairing kind is `desktop`.
- "This device's address" lists every private IPv4:port the TLS listener is reachable on, each with a Copy button.
- "Authorized devices" list: name, kind, last used, "Connected here" badge, **Edit permissions** (scope checkboxes), **Remove access** (revoke → 4401).

**Connect to other devices**
- "Add device": address (ip:port) + pairing string. The plugin, running in the Host's Node process, opens a **pinned** WSS to the other Host (pin from the pairing string), claims the code, and stores the token in the profile storage. The token never reaches the browser.
- A list of remote Hosts with online status. Opening one shows its sessions. Selecting a session shows its history, lets the user send a prompt, and lists pending approvals with allow-once/reject (`argsHash` echo).
- The browser only talks to the local Host's own (loopback, already-authenticated) DSH web server through plugin RPC/routes. So browser pinning is not needed.

## Qoder UX reference (owner screenshots 2026-11-09, binding)
- Settings nav group "Connections" with three pages: **Mobile**, **Remote connections**, **Devices**.
- Devices → **Connect to other devices**, empty state: an illustration, "Pair a device", the text "Enable 'Allow connections to this device' on it, then add the device and select its workspace", and an **Add device** button.
- **Add device** dialog: LAN | Internet tabs (Internet disabled for now); **Address** (placeholder `192.168.1.9:41234`, required); **Pairing code** (**8 digits**, required); **Display name** (optional). Note: "Pairing again may expand or reduce access… If no workspaces are available, check permissions under Authorized devices on that device." Buttons Cancel / Add device.
- Allow connections tab: as in the first screenshot (toggle, LAN/Internet, Generate pairing code, This device's address chips, Authorized devices with Edit permissions / Remove access, "Shared workspaces" line).
- Mobile page: a toggle "Allow mobile to control this device" + "Keep this device awake". This maps to the existing mobile-gateway QR flow (later).

### Consequence: 8-digit code instead of a long pairing string
An 8-digit code cannot carry the cert fingerprint. The design must therefore authenticate the TLS cert using the short code, without letting an attacker brute-force it offline:
- Option A (preferred): a PAKE (SPAKE2/CPace) over the TLS channel with the 8-digit code. The derived key MACs both cert fingerprints, and the pin is then stored (TOFU bound to the code).
- Option B: TOFU on the cert, then the client proves the code with an HMAC(code, certSha256 || nonces). The Host allows 3 attempts per code and the code has a 10-minute TTL. The risk is an active MITM on the first connection guessing online, so the odds are 3/10^8 per code.
- The decision goes to beastcore/reviewer in P0; until then the long pairing string stays as an "Advanced" fallback.

## Remote workspace UX (owner screenshot 2026-11-09, binding)
In Qoder the remote Host is used exactly like the local machine:
- **The sidebar merges hosts.** "Local workspaces" comes first, then one group per paired Host (e.g. "Qoder-Sigma"). Each group lists that Host's workspaces (AutoAoW, 9remote, DiskTree…) with their sessions nested under them and unread dots. There is no separate "switch host" mode.
- Opening a remote session renders the **native** conversation and composer. The composer footer shows chips for workspace / **host name** / git branch, and the permission mode ("Full access") and model picker act on the remote Host.
- New Task inside a remote workspace runs on that Host.
- **Offline or deleted remote session:** a banner "This task is no longer available on <host>… read-only local copy" with a "Remove local copy" button. A cached transcript stays readable.
- Remote model unavailable: a "Model status" banner. The model picker lists the remote Host's catalog.

Design consequence: the upstream approach (one global "selected Host" switch) is NOT enough. Routing must be **per call**: each workspace/session id is tagged with its host id, and each `/api` call or stream is dispatched to the local gateway or to the owning remote by that tag. List/follow endpoints (workspace/follow, session/list) must merge local + every connected remote. → beastcore feasibility check on rc.1 (P0b) before P2.

## Pairing flow with Host approval (owner decision 2026-11-09, binding)
**Window 1 – OTP (Host).** "Generate pairing code" shows an 8-digit OTP (10-min TTL, single use) plus this device's addresses. The client types the address + OTP + a display name.

**Window 2 – Pending requests (Host).**
1. The client connects. It TOFU-reads the Host cert, then proves the OTP with an HMAC over (OTP, certSha256, client nonce, server nonce). A wrong proof costs one attempt; after 3 failures the OTP is burned.
2. A valid proof does NOT issue a token. It creates a **pending request** on the Host. The request shows the device name, the client IP, the requested kind/scopes, the time, and a **6-digit verification code** derived from the Host's TLS cert fingerprint (the client presents no certificate) and both nonces. The same code is displayed on the client ("Waiting for approval on the host… code 123 456").
3. The Host user compares the codes, optionally adjusts the scopes, then clicks **Approve** or **Reject**. Only Approve issues the device token, sent over the same connection. Reject, a 5-minute timeout, or a client disconnect discards the request.
4. Several pending requests can wait at once. Approving or rejecting one does not affect the others. Pending requests never get any bridge or RPC access.

Security rationale: the manual Approve plus the code comparison defeats an online MITM or a guessed OTP without needing PAKE. The 2(A) PAKE item is therefore dropped unless review asks for it. The long pairing string remains an "Advanced" path, and it also goes through Window 2.

## Requirements
- FR1 No listener beyond what mobile-gateway already provides; this plugin itself listens on nothing new.
- FR2 Outbound pinned WSS only, and only to addresses the user typed; private ranges by default.
- FR3 Remote tokens are stored per remote Host, never logged, and wiped on 4401.
- FR4 Edit permissions changes the scopes of an existing device. If the gateway lacks a scope-update API, the fallback is "re-pair with new scopes" (which closes old sockets, see 005 T8). Any gateway API addition goes through the gateway owner (see `docs/COORDINATION.md`).
- FR5 Every UI action that changes state (toggle, pair, revoke, permissions) goes through the Host's existing admin auth (loopback + same-origin), never through a remote device.
- FR6 Must run on DSH `0.2.2-rc.1`; the plugin declares `engines.dsh`.

## Non-goals
Internet/NAT traversal (that becomes a later spec, Internet checkbox stays disabled), accounts, remote updates, file browsing.

## Answers (lead + beastcore, 2026-11-09)
- Q1 (a, verified with live cordis_inspect on the running GUI): the slot `settings.section` ("one settings page per list entry", registration `{id, order, label}`) plus `settings.section.icon` put a **Devices** page inside DSH Settings, exactly like Qoder. The client half is plain JS (`lib/client.js` via `window.__ModuleLoader__.load`, `React.createElement`), declared in `package.json` `dsh.client`, following the pattern in `plugins/mobile-gateway/lib/client.js`.
- Q2 (b): the server half calls `webServer.register({kind:'prefix', path:'/devices'})`. The client calls it with same-origin `fetch`. The plugin enforces loopback-only + same-origin for every state-changing request itself, as `/mgw` does.
- Q3 (b): mobile-gateway publishes no service. Admin access is HTTP `/mgw/*` only (status, devices, pair, revoke, remote-control, connection). It has no scope-update route, so "Edit permissions" re-pairs the device. The gateway's own sidebar overlay remains. Ask the gateway owner (via COORDINATION.md) for a config switch that hides it later.

## Open questions (resolved above)
Q1 How does a Cordis plugin add a page/settings section to the DSH web UI on 0.2.2-rc.1 (client inject, slots)?
Q2 Plugin ↔ UI RPC mechanism and its auth.
Q3 Does mobile-gateway expose its admin functions (pair, devices, revoke, toggles, addresses) as a Cordis service the new plugin can call in-process, or only as HTTP `/mgw/*`?
