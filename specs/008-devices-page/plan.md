# Plan 008 (rev 2): Native remote session inside DSH Desktop

Owner decision 2026-11-09: graft the native-UI layer of `liguobao/ds-harness-remote` (MIT) onto our `mobile-gateway` transport. Machine A opens machine B's sessions inside A's own DSH Desktop UI, as in Qoder. No account server, no second app.

## Architecture
- **A (controller), plugin `@dsh-ext/devices`:**
  - Settings → Devices page with two tabs: Allow connections and Connect to other devices.
  - A Host switcher next to the workspace list.
  - Remote routing, adapted from `typert-gateway-switch.ts`: when a remote Host is selected, the official `TypertGateway` calls (invoke, stream, dispatchRpc, openWireStream) are routed over a pinned WSS to B's gateway. Every native screen (sessions, prompt, approvals) then shows B's data.
- **B (controlled), `mobile-gateway` plus a new `remote-bridge` channel:**
  - A device paired with kind `desktop` and scope `harness:remote` can tunnel DSH wire calls.
  - Each call is checked against an allowlist adapted from `harness-remote-bridge.ts`.
  - Allowlist entries are mapped to our scopes (sessions:read, prompt:send, approval:respond, …).
  - The remote terminal is **off** (it is not in the allowlist).
- **Removed from upstream:** account/OAuth, r2049 server, WebRTC signaling, Noise and its trust store (TLS pin + device token replace them), Codex/ACP, the npm update check, and the remote_* agent tools.

## Phases
- P0 (beastcore, read-only): an exact map of the upstream files involved and the DSH-private APIs they touch on 0.2.2-rc.1. Produces the minimal fork list, the wire framing, and the allowlist → scope table. Gate: owner sees the private-API risk.
- P1 (coder, gateway owner coordination): the gateway `remote-bridge` channel + allowlist + scope `harness:remote` + tests (deny by default, 4401 revoke, scope mapping). This edits mobile-gateway, so it is announced in COORDINATION.md first.
- P2 (coder): the `@dsh-ext/devices` controller: the forked gateway switch, the pinned transport (reused from `apps/_archive/desktop-companion/lib/pin.mjs`, `client.mjs`, `store.mjs`), the Host switcher UI, and the Devices page.
- P3: reviewer security review (mandatory), then a two-instance end-to-end test on one machine (two DSH profiles/ports) if feasible. Install happens only after owner approval.

## Risks
- The gateway switch patches DSH-private client objects, so every DSH upgrade may break it. Mitigation: a version gate on `engines.dsh`, plus a self-test that disables remote mode with a visible error on mismatch.
- The allowlist must be complete enough for the native UI, yet still deny by default.
- Attribution: keep the MIT notice of ds-harness-remote in forked files plus a NOTICE file.

## Lead decisions 2026-11-09 (secure defaults, owner may override)
- Approvals: 1(a). The bridge never forwards `/result` raw. It maps the call onto the hash-bound approval path (argsHash computed Host-side from the exact pending request); a mismatch or missing hash means a refusal, and the request stays pending.
- Short code: 2(A) PAKE (CPace/SPAKE2 over the TLS channel, binding both cert fingerprints) is the target. P1 ships with the existing long pairing string (Advanced); the 8-digit PAKE is P1b after a reviewer design check.
- Denied by default on the bridge: credentials/*, settings/replace|mutate, pluginManager/*, schedule/create|run|update|delete|edit, commands/execute, terminal/*.

## Owner decision 2026-11-09 16:40: two-window pairing
Window 1 is the OTP; Window 2 is the pending list with manual Approve/Reject and a 6-digit verification code on both sides (spec.md section 'Pairing flow with Host approval'). This replaces the 2(A) PAKE plan. It ships as phase P1b (gateway pairing state machine + Host UI in plugins/devices + client wait screen), after P1.

## Endpoint argument audit (beastcore, rc.1 source, 2026-11-09)
- Owner peers bypass remoteAccess (dsh-api-gateway/src/index.ts:804). All argument constraints live in remote-bridge.mjs. Future option: a custom principal kind + registerPolicy (unverified).
- Allowed as-is: session/prompt (no slash interpretation; commands go via commands/execute), session/control (read stream), session/fork, workspace/rename, workspace/archiveSession, subagents/prompt, userQuestions/answer, attachWait, sessionReferenceResolver/candidates, toolResults/watch, job/kill, workspaceFiles/list.
- Allowed with constraints:
  - session/create: workspaceId only, and it must be in workspace/follow; drop cwd and agentPreset.
  - session/selectModel: provider/model must be in modelCatalog (it also changes the global default).
  - goals/*: cap maxGoalRounds.
  - fileReferences/list: reject an absolute query or one containing '..'.
  - workspaceFiles/read|readBytes|stat|changes and officeToPdf/render: relative path only, with no '..', no drive or ':', and no NUL (baseFile is checked too).
  - agentPresets/select: only owner-approved preset ids (default none, so effectively deny).
- Deny: commands/execute, workspace/create, workspace/delete, directoryPicker/*, settings/*, credentials/*, pluginManager/*, schedule mutations, terminal/*. workspaceFiles/readAll|readRelated do not exist on rc.1.
- The slash-prefix prompt guard added in the interim fix is unnecessary per (b) but harmless; keep it as defence in depth.

## Owner decision 2026-11-09 16:55: full control (overrides the deny list above)
The owner wants remote control identical to working on the Host. Nothing is blocked by design. Instead, each capability is a per-device scope that the Host owner grants in Window 2 (Approve) or later via Edit permissions:
- commands:execute: commands/execute, including /permission.
- workspace:manage: workspace/create, workspace/delete, directoryPicker/*, plus session/create with cwd/agentPreset, and absolute/outside-workspace paths for workspaceFiles/*, officeToPdf, fileReferences.
- settings:write (existing): settings/*, agentPresets/select with any id, session/selectModel.
- credentials:write: credentials/set|unset (write-only; secrets are never returned or logged).
- plugins:manage: pluginManager/*.
- schedule:write: schedule mutations.
- terminal: terminal/* (the remote PTY via the Host's own terminal service; frames are never logged).
- The UI preset "Full control" ticks all of them. "Standard" = sessions:read, prompt:send, approval:respond, files:read. Default at Approve = Standard; the owner may pick Full control.
Invariants that stay (not blocks, safety rails): TLS pin + manual Host approval + per-device revoke (4401); approvals still bound to argsHash; per-device rate/size limits; audit line per call (endpoint + device, never args). The argument constraints from the audit apply only when the device LACKS the matching scope.
Constitution note: 'narrowest API that works' is satisfied per device, since the owner chooses the grant. This was recorded as an owner-approved interpretation, not a relaxation of TLS/auth/revoke.

## P0b result (beastcore 2026-11-09, (b)/(c)) and the P2 design
- Feasible on rc.1. Ids are free strings, so they get the namespace `h:<hostId>:<id>`. The wrapper renames ids both ways, including nested fields (, subagent parent/child ids, client-chosen sessionId in session/create).
- Calls carry no session context. Routing goes by address.sessionId / sessionId / workspaceId / agentId. Global calls (llm/*, skills/list, permissionPresets/catalog, settings/*) default to Local; for a remote session the client half passes a host hint. Verify whether the permission picker uses settings or session/control.
- Follow merge: one local stream plus N remote streams feed a merged map. It emits a merged baseline, then renamed upsert/delete frames, and a 'replace' when a remote reconnects. session/list concatenates and sorts by updatedAt (merged cursor).
- Sidebar grouping: rc.1 has no group/header slot, so P2 REPLACES the single slot `sidebar.workspaces` with a host-grouped browser (Local workspaces + one group per Host, sessions nested, unread dots, search). The UI drift risk is accepted, guarded by an engines.dsh pin and a self-test fallback to the stock sidebar.
- Host chip: slot conversation.input.left (session scope), read from the `h:` prefix.
- Offline copy: the plugin caches session/page + events in its own data dir and replays them read-only, with the banner + 'Remove local copy'. It never writes to SessionStore.
- Effort: about 2-3x the single-switch plan. P2a = multi-host gateway wrapper + id rename + follow merge (+ tests with two fake remotes); P2b = sidebar replacement + host chip + banners; P2c = offline cache.

## Owner decision 2026-11-09: models for remote sessions
For a remote session, everything model-related comes from and acts on the remote Host: model picker list, selection, reasoning effort, defaults and provider credentials.
- Route to the owning Host: session/modelCatalog, session/selectModel, session/initializeDefaultModel, llm/list*, and model/provider settings reads made while a remote session is open (the client half passes the host hint).
- The local machine's providers and keys are never offered for, or sent to, a remote session. The prompt runs on the Host with the Host's model.
- If the Host's model is unavailable, show the 'Model status' banner from the Host's answer. Never fall back to a local model.
- Bridge scope: selecting a model inside a remote session is allowed under prompt:send. Changing the Host's global default model still needs settings:write.

## Owner decision 2026-11-09 17:00: no limits by default
- Per-device limits (connections, streams, in-flight, rate) and the result cap are OFF by default (value 0 means unlimited). They stay available only as optional Host config knobs in the Devices page ('Advanced').
- The number of paired or connected devices is the owner's choice; there is no cap.
- Kept, because these are transport rather than limits: large or binary results still travel as chunked stream frames with credit flow control, so a big file transfers completely without one giant message. A one-shot remote-call whose result is too large for a single WS frame is transparently upgraded to a stream instead of being refused.

## Correction 2026-11-09 17:55 (verified in source)
On rc.1, session/selectModel and session/initializeDefaultModel write the Host's GLOBAL default model (dsh-api-session-controller/lib/index.js:716 and :3945). Picking a model in a remote session therefore needs settings:write, which is in the 'Full control' preset. With only Standard, the remote session uses the Host's current default model, and the picker is read-only with the hint 'needs Settings permission'. modelCatalog stays under prompt:send. This supersedes the 'Bridge scope' bullet of the models decision.
