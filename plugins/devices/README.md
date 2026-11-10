# @dsh-ext/devices

A **Devices** page inside DSH Settings (Qoder-style), spec `specs/008-devices-page`. Private package, `engines.dsh: 0.2.2-rc.1`.

- **Allow connections to this device** — switch the local `mobile-gateway` on/off (LAN), generate a `desktop` pairing code (copy + expiry countdown), see this device's addresses, list authorized devices, remove access, edit permissions.
- **Connect to other devices** — paste an address + pairing string from another Host; this Host dials it (pinned WSS), then lists its sessions, shows history, sends prompts and decides approvals.

It needs `@dsh-ext/mobile-gateway` loaded in the same profile (the page drives its `/mgw/*` admin routes). It does not edit the gateway, DSH core, or the protocol package.

## Install (local folder)

Not published. Add the folder to a profile with the plugin manager (`dsh plugin add` accepts a local path):

```
dsh plugin --profile <name> add C:\path\to\dsh-ext\plugins\devices
```

or add it from the plugin manager UI ("install from folder"). This appends the package to `dsh.profile.bundles`, applies `cordis.patch.yml` (one `devices` row, consumes `webServer`) and bundles `lib/client.js` (`dsh.client`, web). Restart the web profile; **Settings → Devices** appears.

`ws` is not yet a dependency of this folder (no network install in this workspace). `lib/remote-client.mjs` resolves `ws` normally and otherwise falls back to `../../mobile-gateway/node_modules/ws`. For a standalone install add `"ws": "^8.18.0"` to `dependencies` and run `npm install`.

Config (`cordis.patch.yml`): `dataDir` (default `~/.dsh/devices-page`), `allowPublicRemotes` (default `false`), `remoteSessions` (default `true`, the multi-host gateway wrapper), `sessionCacheMaxBytes` (default 2 MiB per transcript file) and `sessionCacheRotations` (default 2) for the offline copy below.

## Usage

1. On the host to be controlled: Settings → Devices → turn on **Allow connections** → **Generate pairing code** → Copy.
2. On the controlling host: **Connect to other devices** → address (`192.168.1.20:3081`, from the other host's address chips) + paste the string → **Pair and connect**.
3. Open the remote host → sessions → history → send a prompt; pending approvals show **Allow once / Reject**.
4. **Edit permissions** cannot change a paired device (the gateway has no scope-update route): it generates a new pairing code with the chosen scopes; the device must pair again, which closes its old sockets (4401, spec 005 T8).

## Security model

- **No new listener.** The plugin only registers `/devices` on the Host web server. Every request (GET included) must come from loopback **and** be same-origin, else 403. The browser never sees a remote token.
- **Outbound only, pinned.** The pairing string carries `certSha256`. The peer certificate is read off the TLS handshake; on a mismatch that handshake is all that was sent (no pairing code, no token). The WebSocket then runs on that same verified socket, so the pin is the whole trust decision and the Host's CA store is never consulted — the gateway's certificate is self-signed and Electron's TLS (BoringSSL) refuses it as a CA-store anchor, which is why chain building must not decide (spec 008). No `Origin` header is sent; credentials go only in `dsh-pair.<code>` (first pairing) and `Authorization: Bearer` — never in URLs.
- **Addresses.** The typed `ip:port` must match an endpoint in the pairing string; only loopback/private/Tailscale addresses are accepted unless `allowPublicRemotes: true`.
- **Tokens.** One file per remote, `tokens/<id>.token`, mode 0600 (dir 0700) on POSIX; on Windows ACL inheritance is removed and only the current user is granted (`icacls`). Never logged, returned or placed in `remotes.json`. On close `4401` the token is overwritten and deleted and the remote is marked `revoked` (no auto-reconnect). Removing a remote deletes its token.
- **Approvals.** Pending approvals are buffered per remote. A decision echoes the **server-buffered** `argsHash`, never one supplied by the page; a request without a hash is desktop-only; a decision is applied at most once (the gateway is authoritative). A remote approval/question card is also re-published into the native conversation `$events` stream with its ids in the `h:<hostId>:` namespace, so it appears in the native approval card; answering it routes back to that host only (an approval through the bridge's hash-bound `$events/result`, a question through the bridge's `userQuestions/answer` with the card's own tool-call id — never through the admin-only `question-answer` frame), and a disconnect withdraws it. An id that arrives from a remote is opaque: it is always wrapped in that host's namespace, and a payload that already carries a namespace tag is refused (`remote/id-leak`).
- **Offline copy.** Every `session/follow` frame of an opened remote session is appended to `sessions/<host-slug>-<sha256(hostId)>/<session-slug>-<sha256(sessionId)>.jsonl` (one JSON object per line, size-capped; rotations live in a `rot/` subdirectory). An id is never used as a file name — it is hashed — so a session id containing `:`, `..` or a rotation-shaped suffix cannot alias another file, and two ids differing only by case stay distinct. Only session frames are written, never a token or header. While that host is offline, `GET …/sessions/:sid/history` and the native session view replay the copy read-only; prompts are refused with `remote/host-offline`. **Remove local copy** deletes the files.
- Scopes are enforced by the remote gateway; a `desktop` pairing defaults to `sessions:read`, `prompt:send`, `approval:respond`.

## Wrapped DSH internals (constitution A1.1)

Rendering a remote Host's session in the **native** DSH UI needs one thing rc.1 has no
public API for: the controller's single `typertGateway` instance has to answer for more than one
Host. Under A1.1 (owner-approved 2026-11-09) this plugin wraps **exactly two methods of the live
service object it obtains from the Host** — never a prototype, module export or DSH file:

- `typertGateway.dispatchRpc` (listens for the wrapped method's rc.1 arity `4`)
- `typertGateway.openWireStream` (arity `7`)

Conditions, all implemented in `lib/host-router.mjs`:

- **Self-test against the pinned release.** `engines.dsh` is `0.2.2-rc.1`, and the running DSH
  version is resolved from the Host's own boot package (`lib/dsh-runtime-version.mjs`). The wrap
  happens only when that version equals the pin and both carrier methods have the expected shape.
- **Failure mode.** Any mismatch (unknown version, another version, a missing method, a changed
  `openWireStream` arity) means **no wrap at all**, the originals stay untouched, and the reason
  (`dsh-version-unknown`, `dsh-version-mismatch`, `dispatchRpc-missing`, `openWireStream-missing`,
  `openWireStream-signature`) is returned by `GET /devices/remotes` as `routing.reason` and shown
  on the Devices page ("Sidebar grouping: multi-host routing is off: …"). Remote mode is off; local
  DSH behaviour is unchanged.
- **Exact restore.** `dispose` puts the original methods back, and only if a method is still the one
  this plugin installed — a wrapper installed later by someone else is never clobbered or removed.
- **No authorization weakening.** The wrapper only routes; the remote gateway remains the sole
  authority for what a paired device may do, and every routed call still carries the device token
  and the device's scopes.
- **Review gate.** Every DSH version bump needs a reviewer pass over the wrapper before it is
  enabled — update `PINNED_DSH_VERSION` only together with `engines.dsh` and that review.

## Tests

`npm test` runs plain scripts (spawning `node --test` workers is EPERM in the sandbox): `guards` (loopback/same-origin), `pin` (pin mismatch sends no credential bytes), `store` (token file perms, 4401 wipe), `client` (slots, labels, flows), `host-router` (multi-host routing/rename/merge), `interactions` (remote approval/question cards in the native `$events` stream), `session-cache` (offline transcript copy: write, replay, refusal, delete, rotation), `e2e` (real `mobile-gateway` in-process: pair as `desktop` → sessions → history → prompt → approval → revoke), `e2e-otp` (OTP + Host approval through `POST /devices/pairings`) and `pairing-trust` (that route pairs against a listener whose certificate no CA store can chain to: the pin is the trust decision). Tests borrow `ws`, `selfsigned`, `react` and `react-test-renderer` from `../mobile-gateway/node_modules`.
