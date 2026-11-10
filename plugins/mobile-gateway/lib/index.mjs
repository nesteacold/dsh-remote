import { isTailscaleIp, tailscaleInterfaceStatus } from './tailscale-addresses.mjs'
import { isAllowedMobileSource, isPrivateNetworkHostname } from './network-addresses.mjs'
import { createNetworkDiagnostics } from './network-diagnostics.mjs'
import { log } from './logging.mjs'
import { setSecureFileLogger } from './secure-file.mjs'
import { stringifyWireFrame } from './wire-json.mjs'
import { MobileConnection } from './mobile-connection.mjs'
import { WebSocketMobileTransport } from './ws-mobile-transport.mjs'
import { createTransportNegotiator } from './transport-negotiation.mjs'
import { TRANSPORT_DEFAULTS, normalizeTransportConfig, managedStunServers } from './transport-config.mjs'
import { assistantFinish, failureDetails, toolResultDetails, turnReasonDetails } from './session-event-details.mjs'
import { toolImages } from './tool-images.mjs'
import { REMOTE_DISABLED, REMOTE_DISABLED_STATUS, resolveRemoteControl } from './remote-control.mjs'
// dsh-plugin-mobile-gateway — persistent Host plugin.
//
// Two directions:
//  1. Agent -> mobile: registers a WebSocket endpoint at /ws/mobile on the dsh
//     web server and forwards agent session output (the same `session/event`
//     feed the browser UI consumes) to connected mobile clients as curated
//     JSON text frames.
//  2. Mobile -> agent: clients send a message through the same socket; the
//     plugin admits it through the DSH Remote Gateway Host API.
//     so it enters the target session exactly like a browser-submitted prompt.
//
// Wire protocol (JSON text frames):
//   first pair:       Sec-WebSocket-Protocol: dsh-mobile-v1, dsh-pair.<one-time-code>
//                     X-DSH-Device-ID: <stable installation UUID>
//                     (or dsh-device.<id> in the subprotocol list)
//                     -> { "kind": "paired", "token", "device" } (exactly once)
//   later connects:   Authorization: Bearer <device-token>
//                     or Sec-WebSocket-Protocol: dsh-mobile-v1, dsh-auth.<device-token>
//   client -> server: { "type": "ping" }
//                     { "type": "subscribe", "sessionId": "..." }  (optional filter)
//                     { "type": "unsubscribe" }
//                     { "type": "message", "sessionId"?, "text"?, "images"?:
//                       [{ "mediaType", "data", "name"? }], "files"?: [{ "receiptId" }], "mode"?: "queue"|"steer",
//                       "workspaceId"?, "cwd"?, "clientTimeZone"? }
//                        sessionId omitted -> a new session is created first; the
//                        new session can be placed in a workspace via workspaceId
//                        (or cwd; at most one, workspaceId wins)
//                     { "type": "workspaces" }                     -> workspace list
//                     { "type": "sessions" }                       -> session list
//                     { "type": "history", "sessionId", "beforeSeq"?, "maxMessages"?,
//                       "maxBytes"?, "view"?: "conversation" }
//                        -> raw SessionEvent page (scheme A), capped at maxBytes
//                           (default 4 MiB); hasMore + nextBeforeSeq page backward;
//                           view:"conversation" trims chunk/header events and tool output
//                     { "type": "attachment", "sessionId", "attachmentId" }
//                        -> verified image metadata + canonical base64 bytes
//                     { "type": "file-list", "requestId"?, "sessionId", "path"? }
//                     { "type": "file-resolve", "requestId", "sessionId", "path" }
//                     { "type": "file-download-open", "requestId", "sessionId", "path" }
//                     { "type": "file-download-read", "transferId", "offset" }
//                     { "type": "file-download-cancel", "transferId" }
//                     { "type": "search", "query" }                -> session search
//                     { "type": "host" }                           -> host.describe snapshot (incl. default provider/model)
//                     { "type": "default-model" }                   -> agentDefaultModel.currentSelection()
//                     { "type": "save-default-model", "provider", "model", "reasoningEffort"? }
//                     { "type": "directories", "path"? }           -> server dir listing (fs-based)
//                     { "type": "directory-create", "path", "name" } -> create one child directory
//                     { "type": "workspace-create", "path" }       -> create workspace over a dir
//                     { "type": "fork", "sessionId", "atSeq"? }    -> branch a new session from a completed turn
//                     { "type": "session-cancel", "sessionId" }     -> stop the active turn and retain queued work
//                     { "type": "queue-update", "sessionId", "itemId",
//                       "action": "edit"|"remove"|"steer", "text"? }
//                        -> edit/remove one pending item or move it into the current turn
//                     { "type": "session-archive", "sessionId" }    -> hide a session from workspace surfaces
//                     { "type": "session-rename", "sessionId", "title" } -> persist a user-owned session title
//                     { "type": "models", "sessionId"? }           -> per-session catalog (with sessionId) or global (without)
//                     { "type": "providers" }                       -> configurable provider list (live/dormant)
//                     { "type": "commands", "sessionId" }          -> slash-command catalog for this session
//                     { "type": "command-execute", "sessionId", "line", "images"? } -> execute a Host command
//                     { "type": "command-options", "sessionId", "command" } -> normalized submenu options
//                     { "type": "command-select", "sessionId", "command", "optionId" } -> apply submenu option
//                     { "type": "select-model", "sessionId", "provider", "model", "reasoningEffort"? }
//                     { "type": "permission-options", "sessionId"? } -> permission presets (+ session knobs)
//                     { "type": "permission", "sessionId", "name" }  -> switch preset via /permission command
//                     { "type": "context-usage", "sessionId" }       -> tokenUsage + contextPressure projections
//                     { "type": "session-stats", "sessionId" }       -> sessionStats + tokenUsage projections
//                        (the input-box stats strip source)
//                     { "type": "tasks", "sessionId" }               -> current todo-list projection
//                     { "type": "goal", "sessionId" }                -> current goal projection
//                     { "type": "goal-edit", "sessionId", "ref", "objective"?, "maxGoalRounds"? }
//                     { "type": "goal-pause"|"goal-resume"|"goal-clear", "sessionId", "ref" }
//                     { "type": "plugin-catalog"|"plugin-inspect"|"plugin-install"|"plugin-settings"|..., "requestId", ... }
//                        -> paired control connection; see PROTOCOL.md section 18
//                     { "type": "agent-presets" }                     -> preset roster (+ isDefault)
//                     { "type": "defaults" }                          -> default agent preset + default permission
//                     { "type": "set-default", "target": "agent-preset"|"permission", "value" }
//                     { "type": "question-answer", "rpcId", "sessionId", "answers": [...] }
//                     { "type": "question-cancel", "rpcId", "sessionId" }
//                     { "type": "approval-response", "rpcId", "sessionId", "approvalId",
//                       "argsHash", "outcome": "allowed-once"|"rejected" }
//   server -> client: { "kind": "hello", "protocol": 3, "capabilities": ["images", "commands", "tasks", "goals", "plugin-management-v1", "session-cancel", "queue-control", "session-archive", "session-rename", "file-downloads"],
//                       "authenticated", "device"?, "port", "clients" }
//                     { "kind": "pong", "at" }
//                     { "kind": "subscribed", "sessionId" }
//                     { "kind": "sent", "sessionId", "mode", "command"? }
//                     { "kind": "workspaces" | "sessions" | "history" | "search", ...data }
//                     { "kind": "commands", "sessionId", "groups": [
//                       { "id", "title", "items": [{ "id", "name", "description", "ui" }] }
//                     ] }
//                     { "kind": "command-options", "sessionId", "command", "options": [
//                       { "id", "label", "detail"?, "description"?, "selected" }
//                     ] }
//                     { "kind": "command-executed", "sessionId", "line", "commandId", "result" }
//                     { "kind": "command-selected", "sessionId", "command", "selected" }
//                     { "kind": "attachment", "sessionId", "attachment", "data" }
//                     { "kind": "file-list", "requestId"?, "sessionId", "path", "entries" }
//                     { "kind": "file-resolved", "requestId", "sessionId", "path", "name", "mediaType", "size", "modifiedAt" }
//                     { "kind": "file-download-opened", "requestId", "transferId", "sessionId",
//                       "path", "name", "mediaType", "size", "chunkBytes" }
//                     { "kind": "file-download-chunk", "transferId", "offset", "data", "eof", "sha256"? }
//                     { "kind": "file-download-cancelled", "transferId" }
//                     { "kind": "file-upload-opened", "requestId", "uploadId", "sessionId", "name", "size", "chunkBytes", "maxBytes", "idleTimeoutMs" }
//                     { "kind": "file-upload-chunk-accepted", "requestId", "uploadId", "sessionId", "nextOffset" }
//                     { "kind": "file-upload-completed", "requestId", "uploadId", "sessionId", "receiptId", "file", "sha256" }
//                     { "kind": "file-upload-cancelled", "requestId", "uploadId", "sessionId" }
//                     { "kind": "session-cancelled", "sessionId", "accepted": true }
//                     { "kind": "queue-item-updated", "sessionId", "itemId", "action", "accepted": true }
//                     { "kind": "session-queues", "queues": { "<sessionId>": [...] } }
//                     { "kind": "session-queue", "sessionId", "items": [...] }
//                     { "kind": "session-archived", "sessionId", "archivedSessionIds" }
//                     { "kind": "session-renamed", "sessionId", "title", "seq" }
//                     { "kind": "session-archives", "archivedSessionIds" }
//                     { "kind": "session-title-changed", "sessionId", "title", "seq", "time", "source"? }
//                     { "kind": "error", "code", "message", "requestType"?, "sessionId"? }
//                     { "kind": "event", "sessionId", "seq", "time", "event": { ... } }
//                     { "kind": "tasks", "sessionId", "asOfSeq", "todos" }
//                     { "kind": "goal", "sessionId", "asOfSeq", "goal" }
//                     { "kind": "goal-edit"|"goal-pause"|"goal-resume", "sessionId", "ref" }
//                     { "kind": "goal-clear", "sessionId", "cleared": true }
//                     { "kind": "tasks-updated", "sessionId", "asOfSeq", "todos" }
//                     { "kind": "goal-updated", "sessionId", "asOfSeq", "goal" }
//                     { "kind": "turn-outline-updated", "sessionId", "asOfSeq", "turnOutline": [...] | null }
//                     { "kind": "question-requested", "rpcId", "sessionId", "questions", "replay"? }
//                     { "kind": "question-response", "rpcId", "sessionId", "action", "accepted", "reason"? }
//                     { "kind": "question-resolved", "rpcId", "sessionId", "outcome" }
//                     { "kind": "approval-requested", "rpcId", "sessionId", "approvalId",
//                       "toolName", "callId"?, "reason"?, "argsHash": "<64 hex>"|null,
//                       "argsPreview": "...", "replay"? }
//                     { "kind": "approval-response", "rpcId", "sessionId", "approvalId",
//                       "outcome", "accepted", "reason"? }
//                     { "kind": "approval-resolved", "rpcId", "sessionId", "approvalId", "outcome" }
//
// Spec 005 (remote desktop client): every device record has a `kind`
// (`mobile`|`desktop`) and `scopes`; a pairing offer carries both (POST
// /mgw/pair) and the top-level `pairingString` is the QR payload in base64url
// for copy-paste. A device whose record carries `scopes` has each inbound
// `msg.type` checked against `SCOPE_BY_TYPE` before any Host call and is
// answered `auth/forbidden-scope` when its scopes lack the one required. A
// WS upgrade whose Origin is present must be listed in `allowedOrigins`.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { WebSocketServer } from 'ws'
import devicesModule from './devices.js'
import { createDshHostAdapter, SESSION_FORMAT_VERSION } from './dsh-host-adapter.mjs'
import { createDeviceAccess } from './device-peers.mjs'
import { loadOrCreateTlsIdentity, tlsServerOptions } from './tls.mjs'
import {
  CLOSE_REVOKED, COMPANION_CAPABILITIES, COMPANION_DEVICE_GUARD, COMPANION_PROTOCOL_VERSION,
  MIN_CLIENT_VERSION, OP_FORBIDDEN, PROTOCOL_UNSUPPORTED, isCompanionType, scopeDenial,
} from './allowlist.mjs'
import { approvalArgsHash } from './approval-hash.mjs'
import { createRemoteBridge, REMOTE_SCOPE } from './remote-bridge.mjs'
import { createPairingRequests, otpProof, verificationCode } from './pairing-requests.mjs'
import { createSpeechInputManager, SPEECH_REQUEST_TYPES } from './speech-input.mjs'
import { createFileUploadManager, FILE_UPLOAD_REQUEST_TYPES, FILE_UPLOAD_DEFAULTS } from './file-upload.mjs'
import { handlePluginQuery, PLUGIN_REQUEST_TYPES } from './plugin-management.mjs'
import { createSessionFollower } from './session-follower.mjs'
import { parseSessionTarget, TEAM_PROJECTION_KINDS } from './session-target.mjs'
import { createGatewayState, GATEWAY_MODES, PAIRING_ROUTES } from './gateway-state.mjs'
import { gatewayProbeHeader } from './gateway-probe.mjs'
import { webRestartAvailable, prepareWebRestart } from './gateway-tools.mjs'
import { serializeMessageText, userMessageTextParts } from './message-text.mjs'
import { handleScheduleQuery, SCHEDULE_REQUEST_TYPES } from './schedule-management.mjs'
import { DEVICE_KINDS, SCOPES, REMOTE_CLIENT_TYPES, DESKTOP_DEFAULT_SCOPES } from '@dsh-ext/mobile-protocol'
import QRCode from 'qrcode'

const { createRegistry, clampPairingTtlMs, MAX_PAIRING_TTL_MS } = devicesModule

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()
const MAX_PREVIEW = 400
const DEFAULT_WS_PATH = '/ws/mobile'
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000
const DEFAULT_GATEWAY_WAIT_TIMEOUT_MS = 5 * 60 * 1000
// T014: after close(4004), how long a socket may linger before terminate().
// SC-005 requires every companion connection gone within 5 s of switch-off.
const CLOSE_GRACE_MS = 3_000
const DEFAULT_FILE_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024
const DEFAULT_FILE_DOWNLOAD_CHUNK_BYTES = 512 * 1024
const DEFAULT_FILE_DOWNLOAD_IDLE_MS = 2 * 60 * 1000
const DEFAULT_FILE_DOWNLOAD_MAX_TRANSFERS = 4
const INTERACTION_PROTOCOL_REVISION = 'question-approval-v2'
// T024/T026 (contract §5): the approval frame carries `argsHash` + `argsPreview`.
// `tool/call` and `approval/request` arrive over different Host streams in no
// guaranteed order, so a request waits at most this long for the matching
// `tool/call` before the content is declared unbound (desktop-only).
const APPROVAL_TOOL_CALL_WAIT_MS = 1_000
const APPROVAL_TOOL_CALL_TTL_MS = 10 * 60 * 1000
const APPROVAL_TOOL_CALL_LIMIT = 256
// The cache is bounded by count, age and total raw characters. One `tool/call`
// can carry a megabyte-scale argument string (a pasted file), so a count limit
// alone still permits an unbounded heap. 4 MiB of UTF-16 code units is ample for
// the approvals that can be in flight at once; content that does not fit is not
// cached, which leaves that approval unbound and desktop-only (contract §5).
const APPROVAL_TOOL_CALL_MAX_TOTAL_CHARS = 4 * 1024 * 1024
// Contract §5/§5a: `argsPreview` is at most 2 KB of text and always a string.
// The bound counts UTF-8 bytes — what the frame actually costs — not UTF-16 code
// units: 2048 CJK characters are 6 KB on the wire, and `slice()` on code units
// can cut a surrogate pair in half and emit text the phone cannot decode.
const APPROVAL_PREVIEW_MAX_BYTES = 2 * 1024
// DSH 0.1.1 allows up to 100 MiB of decoded images in one prompt. Base64 plus
// the JSON envelope needs roughly 4/3 of that on the wire. Keep this separately
// configurable so deployments may choose a lower transport ceiling.
const DEFAULT_MAX_WS_PAYLOAD_BYTES = 144 * 1024 * 1024
const MAX_MANAGEMENT_BODY_BYTES = 16 * 1024
// Contract §4: `message` is idempotent per device by `clientMsgId`. A retry
// inside this window answers the original `sent` frame instead of prompting again.
const CLIENT_MSG_DEDUPE_MS = 10 * 60 * 1000
const MAX_CLIENT_MSG_IDS_PER_DEVICE = 512
// Contract §3.5: pairing QR payload version. TODO use @dsh-ext/mobile-protocol
const PAIRING_QR_VERSION = 3
// Spec 008 P1b: requested next to `dsh-mobile-v1` to open the OTP / approval
// pairing socket. A marker only — it carries no secret and is never negotiated.
const PAIR_OTP_PROTOCOL = 'dsh-pair-otp.v1'
const CLOSE_PAIRING_REJECTED = 4403
// Not 4401: that tells a client to wipe a stored credential. Here nothing was issued.
const CLOSE_PAIRING_EXPIRED = 4410
const PAIRING_HANDSHAKE_MS = 15_000
const PAIRING_NONCE = /^[A-Za-z0-9_-]{16,64}$/
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const COMMAND_UI_OVERRIDES = Object.freeze({
  permission: Object.freeze({
    kind: 'select',
    optionsRequest: 'command-options',
    selectionRequest: 'command-select',
  }),
  model: Object.freeze({
    kind: 'select',
    optionsRequest: 'command-options',
    selectionRequest: 'command-select',
  }),
})
const COMMAND_CATALOG_COPY = Object.freeze({
  zh: Object.freeze({
    locale: 'zh-CN',
    commandsTitle: '命令',
    skillsTitle: '技能',
    userOnly: '仅用户',
    modelDescription: '选择本会话使用的模型',
    hints: Object.freeze({
      plan: '描述你的任务以生成计划',
      goal: '输入目标，智能体将持续执行',
    }),
  }),
  en: Object.freeze({
    locale: 'en',
    commandsTitle: 'Commands',
    skillsTitle: 'Skills',
    userOnly: 'user-only',
    modelDescription: 'Select the model for this conversation',
    hints: Object.freeze({
      plan: 'describe your task to generate plan',
      goal: 'describe the objective for a long-running task',
    }),
  }),
})

// Cordis validates this schema at plugin load and fills these defaults. Keep
// the defaults conservative: installing the bundle must never create an
// unauthenticated network control plane.
/** Error code for a request outside the allowlist (contract §4, §6). */

const Config = Schema.object({
  path: Schema.string().default(DEFAULT_WS_PATH),
  // T023: device authentication is always required. The key is kept (and still
  // reported in /mgw/status) so an existing config file keeps loading, but a
  // `false` value has no effect — there is no route that turns auth off.
  requireAuth: Schema.boolean().default(true),
  // Legacy upstream key: alias of `remoteControl.enabled`. Kept so existing
  // deployments (and the upstream suite) keep working; resolved in apply().
  gatewayEnabled: Schema.boolean().default(false),
  // The owner switch (T011 / FR-002). Default off: installing the bundle must
  // never make the Host remotely reachable. An explicit value here wins over
  // `gatewayEnabled`; see resolveRemoteControl().
  remoteControl: Schema.object({
    enabled: Schema.boolean().default(false),
  }).default({}),
  gatewayMode: Schema.union(GATEWAY_MODES),
  gatewayStateFile: Schema.string().default(''),
  gatewayName: Schema.string().default(''),
  endpoints: Schema.array(Schema.string()).default([]),
  // HTTPS port of the plugin-owned TLS listener. 0 = ephemeral port (tests); the
  // bound port is reported by /mgw/status and used in the pairing QR.
  // 30081, not 3081: on Windows a listener inside the OS dynamic port range can
  // collide with an outbound connection's source port and fail to bind at random.
  // That range is 49152-65535 by default but is commonly retuned — one machine we
  // measured ran 1024-15000, which covers 3081. 20000-39999 stays outside both.
  lanPort: Schema.natural().min(0).max(65535).default(30081),
  tlsCertificateDir: Schema.string().default(''),
  webrtc: Schema.object({
    enabled: Schema.boolean().default(false),
    mode: Schema.union(['prefer-webrtc', 'ws-only']).default('prefer-webrtc'),
    stunServers: Schema.array(Schema.string()).default([...TRANSPORT_DEFAULTS.stunServers]),
    negotiationTimeoutMs: Schema.natural().min(100).max(60000).default(12000),
    rtcConnectTimeoutMs: Schema.natural().min(100).max(60000).default(8000),
    bindTimeoutMs: Schema.natural().min(100).max(30000).default(5000),
    maxFrameBytes: Schema.natural().min(1024).max(16384).default(16384),
    maxLogicalMessageBytes: Schema.natural().min(1024).max(16777216).default(16777216),
    maxPendingNegotiations: Schema.natural().min(1).max(32).default(8),
    maxActiveGroups: Schema.natural().min(1).max(64).default(16),
  }).default({}),
  gatewayWaitTimeoutMs: Schema.natural().min(30_000).max(30 * 60 * 1000).default(DEFAULT_GATEWAY_WAIT_TIMEOUT_MS),
  maxPayloadBytes: Schema.natural().min(1024 * 1024).max(160 * 1024 * 1024).default(DEFAULT_MAX_WS_PAYLOAD_BYTES),
  fileDownloadsEnabled: Schema.boolean().default(true),
  fileDownloadMaxBytes: Schema.natural().min(1024 * 1024).max(2 * 1024 * 1024 * 1024).default(DEFAULT_FILE_DOWNLOAD_MAX_BYTES),
  fileDownloadChunkBytes: Schema.natural().min(64 * 1024).max(1024 * 1024).default(DEFAULT_FILE_DOWNLOAD_CHUNK_BYTES),
  fileDownloadIdleMs: Schema.natural().min(10_000).max(30 * 60 * 1000).default(DEFAULT_FILE_DOWNLOAD_IDLE_MS),
  fileDownloadMaxTransfers: Schema.natural().min(1).max(16).default(DEFAULT_FILE_DOWNLOAD_MAX_TRANSFERS),
  fileUploadsEnabled: Schema.boolean().default(FILE_UPLOAD_DEFAULTS.fileUploadsEnabled),
  fileUploadMaxBytes: Schema.natural().min(1024 * 1024).max(2 * 1024 * 1024 * 1024).default(FILE_UPLOAD_DEFAULTS.fileUploadMaxBytes),
  fileUploadChunkBytes: Schema.natural().min(64 * 1024).max(1024 * 1024).default(FILE_UPLOAD_DEFAULTS.fileUploadChunkBytes),
  fileUploadMaxTransfers: Schema.natural().min(1).max(16).default(FILE_UPLOAD_DEFAULTS.fileUploadMaxTransfers),
  fileUploadIdleMs: Schema.natural().min(10_000).max(30 * 60 * 1000).default(FILE_UPLOAD_DEFAULTS.fileUploadIdleMs),
  fileUploadCommitTimeoutMs: Schema.natural().min(10_000).max(30 * 60 * 1000).default(FILE_UPLOAD_DEFAULTS.fileUploadCommitTimeoutMs),
  adminLoopbackOnly: Schema.boolean().default(true),
  // Spec 005 FR5: origins a WebSocket upgrade may carry. Empty by default: the
  // companion apps are native and send no Origin, so only an explicit entry can
  // admit a browser-style client.
  allowedOrigins: Schema.array(Schema.string()).default([]),
  // Spec 008 P1b: a valid pairing proof (OTP or the long pairing string) only
  // opens a pending request the Host user must Approve. `false` restores the
  // direct claim of the long pairing string (QR flow of the phone app).
  requireHostApproval: Schema.boolean().default(true),
  // Spec 008 (owner decision 2026-11-09): optional per-device limits of the
  // remote bridge. 0 = unlimited, the default for every knob; only a positive
  // value turns that one limit on. Not an authorization setting.
  remoteBridgeLimits: Schema.object({
    maxConnectionsPerDevice: Schema.natural().default(0),
    maxStreamsPerDevice: Schema.natural().default(0),
    maxInflightPerDevice: Schema.natural().default(0),
    callsPerSecond: Schema.natural().default(0),
    maxResultBytes: Schema.natural().default(0),
  }).default({}),
  publicUrl: Schema.string().default(''),
  deviceFile: Schema.string().default(''),
  // Contract §2: `expiresAt` is at most five minutes ahead, so the config cannot
  // ask for a longer offer (the registry clamps again for callers that bypass
  // schema validation).
  pairingTtlMs: Schema.natural().min(30_000).max(MAX_PAIRING_TTL_MS).default(DEFAULT_PAIRING_TTL_MS),
  // T023 (FR-007): removed. A stale value in a config file is ignored; declared
  // so an old YAML key does not fail validation, never honoured.
  allowQueryToken: Schema.boolean().default(false),
  lanEnabled: Schema.boolean().default(false),
  // T017 (FR-001): loopback by default. A non-loopback value is only listened on
  // with the owner switch on and `lanEnabled: true`, and that listener is TLS.
  lanHost: Schema.string().default('127.0.0.1'),
  lanAdvertiseHost: Schema.string().default(''),
})

// The owner switch is resolved by `resolveRemoteControl` (lib/remote-control.mjs):
// `remoteControl.enabled` when explicitly set, else the legacy `gatewayEnabled`.

// Extract plain text from a ContentBlock[] (text blocks only).
function textOf(blocks) {
  let text = ''
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function imagesOf(blocks) {
  const images = []
  for (const block of blocks) {
    if (!block || block.type !== 'image' || !block.attachment) continue
    const attachment = block.attachment
    images.push({
      attachmentId: attachment.attachmentId,
      mediaType: attachment.mediaType,
      bytes: attachment.bytes,
      width: attachment.width,
      height: attachment.height,
      ...(attachment.name ? { name: attachment.name } : {}),
    })
  }
  return images
}

function filesOf(blocks) {
  return blocks.filter(block => block?.type === 'file' && block.attachment).map(({ attachment }) => ({
    attachmentId: attachment.attachmentId, name: attachment.name, bytes: attachment.bytes,
  }))
}

// Build the small, owned JSON wire record for one session event. Reads only
// leaf fields of the live SessionEvent — never serializes live objects.
function buildWireEvent(session, event) {
  const base = { kind: 'event', sessionId: String(session.id), seq: event.seq, time: event.time,
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
  }
  const d = event.data || {}
  switch (event.type) {
    case 'user/message': {
      const images = imagesOf(d.content || [])
      const files = filesOf(d.content || [])
      const textParts = userMessageTextParts(d.content)
      return Object.assign(base, {
        event: {
          type: 'user/message',
          text: textOf(d.content || []),
          ...(textParts ? { textParts } : {}),
          ...(typeof d.source?.rpcId === 'string' ? { requestId: d.source.rpcId } : {}),
          source: d.source && d.source.kind,
          ...(typeof d.id === 'string' && d.id ? { raw: { id: d.id } } : {}),
          ...(images.length ? { images } : {}),
          ...(files.length ? { files } : {}),
        },
      })
    }
    case 'assistant/message': {
      const blocks = (d.message && d.message.content) || []
      let text = ''
      let reasoning = ''
      const toolCalls = []
      const images = imagesOf(blocks)
      for (const block of blocks) {
        if (!block) continue
        if (block.type === 'text' && typeof block.text === 'string') text += block.text
        else if (block.type === 'reasoning' && typeof block.text === 'string') reasoning += block.text
        else if (block.type === 'tool-call') toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments })
      }
      return Object.assign(base, {
        event: { type: 'assistant/message', turn: d.turn, step: d.step, text, reasoning, toolCalls,
          ...(assistantFinish(d) ? { finish: assistantFinish(d) } : {}),
          ...(d.interrupted === true ? { interrupted: true } : {}),
          ...(d.usage === undefined ? {} : { usage: d.usage }),
          ...(images.length ? { images } : {}),
        },
      })
    }
    case 'assistant/attempt':
      return Object.assign(base, { event: { type: event.type, turn: d.turn, step: d.step, stream: d.stream,
        ...(assistantFinish(d) ? { finish: assistantFinish(d) } : {}) } })
    case 'llm/retry':
    case 'llm/retry-started':
      return Object.assign(base, { event: { type: event.type, turn: d.turn, step: d.step,
        retryId: d.retryId, retry: d.retry,
        ...(event.type === 'llm/retry' ? { provider: d.provider, mode: d.mode,
          maxRetries: d.maxRetries, delayMs: d.delayMs, failure: failureDetails(d.failure) } : {}),
      } })
    case 'session/title':
      return Object.assign(base, {
        event: {
          type: 'session/title',
          title: d.title,
          ...(d.source ? { source: d.source } : {}),
        },
      })
    case 'agent-preset/selected':
      return Object.assign(base, { event: { type: event.type, agentPreset: d.agentPreset } })
    case 'deliverables/presented':
      return Object.assign(base, {
        event: { type: event.type, turn: d.turn, callId: d.callId,
          files: (Array.isArray(d.files) ? d.files : [])
            .filter(file => file && typeof file.path === 'string' && file.path.trim())
            .map(file => ({ path: file.path,
              ...(typeof file.description === 'string' ? { description: file.description } : {}),
            })),
        },
      })
    case 'tool/call':
      return Object.assign(base, {
        event: { type: 'tool/call', turn: d.turn, step: d.step, callId: d.callId, name: d.name, arguments: d.arguments },
      })
    case 'tool/result': {
      const images = toolImages(d)
      let preview = ''
      for (const block of (d.message && d.message.content) || []) {
        const content = block?.type === 'tool-result' ? block.content || [] : [block]
        for (const inner of content) {
          if (inner.type === 'text' && typeof inner.text === 'string') preview += inner.text
        }
      }
      if (preview.length > MAX_PREVIEW) preview = preview.slice(0, MAX_PREVIEW) + '…'
      return Object.assign(base, {
        event: {
          type: 'tool/result',
          turn: d.turn,
          step: d.step,
          callId: d.message?.toolCallId ?? d.message?.source?.callId,
          isError: d.message?.isError === true || !!d.error || ((d.message && d.message.content) || []).some(block => block?.type === 'tool-result' && block.isError === true),
          preview,
          ...toolResultDetails(d),
          ...(images.length ? { images } : {}),
          ...(d.error ? { error: d.error } : {}),
        },
      })
    }
    case 'tool/ptc-dispatch':
    case 'tool/code-dispatch': {
      const images = toolImages(d, event.type)
      return Object.assign(base, { event: { type: event.type, turn: d.turn, step: d.step,
        rootCallId: d.rootCallId, parentCallId: d.parentCallId, subCallId: d.subCallId,
        name: d.name, arguments: d.arguments, isError: d.isError === true,
        ...toolResultDetails({ message: { content: d.content } }),
        ...(images.length ? { images } : {}),
        ...(d.error ? { error: d.error } : {}),
      } })
    }
    case 'command/run':
      return Object.assign(base, {
        event: {
          type: 'command/run',
          commandId: d.commandId,
          name: d.name,
          ...(typeof d.args === 'string' ? { args: d.args } : {}),
          ...(d.source ? { source: d.source } : {}),
        },
      })
    case 'command/done':
      return Object.assign(base, {
        event: {
          type: 'command/done',
          commandId: d.commandId,
          outcome: d.kind,
          ...(typeof d.text === 'string' ? { text: d.text } : {}),
          ...(typeof d.sourceEventSeq === 'number' ? { sourceEventSeq: d.sourceEventSeq } : {}),
        },
      })
    case 'compaction/start':
      return Object.assign(base, {
        event: {
          type: 'compaction/start',
          compactionId: d.compactionId,
          ...(d.sourceCommandId ? { sourceCommandId: d.sourceCommandId } : {}),
          turn: d.turn ?? null,
        },
      })
    case 'compaction/summary':
      return Object.assign(base, {
        event: {
          type: 'compaction/summary',
          compactionId: d.compactionId,
          ...(d.sourceCommandId ? { sourceCommandId: d.sourceCommandId } : {}),
          shadowedItemCount: Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs.length : null,
          shadowedTokenCount: typeof d.shadowedTokenCount === 'number' ? d.shadowedTokenCount : null,
        },
      })
    case 'compaction/end':
      return Object.assign(base, {
        event: {
          type: 'compaction/end',
          compactionId: d.compactionId,
          ...(d.sourceCommandId ? { sourceCommandId: d.sourceCommandId } : {}),
          turn: d.turn ?? null,
          ...(typeof d.error === 'string' ? { error: d.error } : {}),
        },
      })
    case 'turn/start':
    case 'turn/end':
    case 'step/start':
    case 'step/end':
      return Object.assign(base, {
        event: { type: event.type, turn: d.turn, step: d.step, reason: d.reason && d.reason.kind,
          ...(turnReasonDetails(d.reason) ? { reasonDetails: turnReasonDetails(d.reason) } : {}) },
      })
    default:
      return Object.assign(base, { event: { type: event.type } })
  }
}

function parseWireImages(rawImages, requestType) {
  const images = rawImages === undefined ? [] : rawImages
  if (!Array.isArray(images)) {
    return { error: { kind: 'error', code: 'bad-request', message: 'images must be an array', requestType } }
  }
  if (images.length > 20) {
    return { error: { kind: 'error', code: 'bad-request', message: 'a request can contain at most 20 images', requestType } }
  }
  const imageParts = []
  for (let index = 0; index < images.length; index++) {
    const image = images[index]
    if (!image || typeof image !== 'object') {
      return { error: { kind: 'error', code: 'bad-request', message: `images[${index}] must be an object`, requestType } }
    }
    if (!IMAGE_MEDIA_TYPES.has(image.mediaType)) {
      return { error: { kind: 'error', code: 'bad-request', message: `images[${index}].mediaType is unsupported`, requestType } }
    }
    if (typeof image.data !== 'string' || image.data.length === 0) {
      return { error: { kind: 'error', code: 'bad-request', message: `images[${index}].data must be a non-empty base64 string`, requestType } }
    }
    if (image.name !== undefined && (typeof image.name !== 'string' || image.name.length > 255)) {
      return { error: { kind: 'error', code: 'bad-request', message: `images[${index}].name must be a string of at most 255 characters`, requestType } }
    }
    imageParts.push({
      type: 'image',
      mediaType: image.mediaType,
      data: image.data,
      ...(image.name ? { name: image.name } : {}),
    })
  }
  return { value: imageParts }
}

function commandNameOf(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return null
  const end = trimmed.search(/\s/)
  return (end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)) || null
}

async function listHostCommands(host, sessionId) {
  const listed = await host.commands.list(sessionId, new AbortController().signal)
  if (!Array.isArray(listed)) throw new Error('commands/list returned an invalid catalog')
  return listed
}

async function executeHostCommand(host, sessionId, line, images, requestType) {
  try {
    const execution = await host.commands.execute(sessionId, line, images, new AbortController().signal)
    if (execution === undefined || execution === null) {
      return { kind: 'error', code: 'unknown-command', message: `unknown or malformed command: ${line}`, requestType, sessionId }
    }
    log(`command executed: session=${sessionId} line=${JSON.stringify(line)} commandId=${execution.commandId} outcome=${execution.result.kind}`)
    return {
      kind: 'command-executed',
      sessionId,
      line,
      commandId: execution.commandId,
      result: execution.result,
    }
  } catch (error) {
    const code = error && error.code ? error.code : 'internal'
    const message = error && error.message ? error.message : String(error)
    log(`command rejected: session=${sessionId} ${code}: ${message}`)
    return { kind: 'error', code, message, requestType, sessionId }
  }
}

async function admitCommand(host, msg) {
  const sessionId = requireSessionId(msg)
  if (sessionId.error) return sessionId.error
  const line = typeof msg.line === 'string' ? msg.line.trim() : ''
  const name = commandNameOf(line)
  if (!name) {
    return { kind: 'error', code: 'bad-request', message: 'command-execute requires a slash-prefixed line', requestType: 'command-execute', sessionId: sessionId.value }
  }
  const parsedImages = parseWireImages(msg.images, 'command-execute')
  if (parsedImages.error) return { ...parsedImages.error, sessionId: sessionId.value }
  try {
    const listed = await listHostCommands(host, sessionId.value)
    const descriptor = listed.find((command) => command && command.name === name)
    if (!descriptor) {
      return { kind: 'error', code: 'unknown-command', message: `command not found: /${name}`, requestType: 'command-execute', sessionId: sessionId.value }
    }
    if (parsedImages.value.length > 0 && !commandAcceptsAttachments(descriptor)) {
      return { kind: 'error', code: 'bad-request', message: `/${name} does not accept image attachments`, requestType: 'command-execute', sessionId: sessionId.value }
    }
    return executeHostCommand(host, sessionId.value, line, parsedImages.value, 'command-execute')
  } catch (error) {
    const code = error && error.code ? error.code : 'internal'
    const message = error && error.message ? error.message : String(error)
    return { kind: 'error', code, message, requestType: 'command-execute', sessionId: sessionId.value }
  }
}

// Handle one mobile -> agent message through the official host API. Returns
// the wire frame to send back, or null when nothing should be sent.
async function admitMessage(api, msg) {
  const target = parseSessionTarget(msg, { optional: true })
  if (target.error) return target.error
  const requestIdentity = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
  const rejectMessage = frame => ({ ...frame, requestType: 'message', ...target.value, ...requestIdentity })
  if (target.value.parentSessionId !== undefined && target.value.subagentMode !== 'continuable') {
    return { kind: 'error', code: 'subagent/not-resumable', requestType: 'message', ...target.value,
      ...requestIdentity, message: 'only continuable subagents accept messages' }
  }
  const preset = parseAgentPreset(msg, 'message')
  if (preset.error) return rejectMessage(preset.error)
  if (preset.value !== undefined && typeof msg.sessionId === 'string' && msg.sessionId.trim()) {
    return rejectMessage({ kind: 'error', code: 'bad-request',
      message: 'use select-agent-preset before sending a message to an existing session' })
  }
  if (msg.requestId !== undefined && (typeof msg.requestId !== 'string' || !msg.requestId.trim() || msg.requestId.length > 128)) {
    return rejectMessage({ kind: 'error', code: 'bad-request', message: 'requestId must contain 1..128 characters' })
  }
  let text
  try { text = serializeMessageText(msg.text, msg.textParts) }
  catch (error) { return rejectMessage({ kind: 'error', code: 'bad-request', message: error.message }) }
  const parsedImages = parseWireImages(msg.images, 'message')
  if (parsedImages.error) return rejectMessage(parsedImages.error)
  const imageParts = parsedImages.value
  const files = msg.files === undefined ? [] : msg.files
  if (!Array.isArray(files) || files.length > 20 || files.some(file => !file || typeof file.receiptId !== 'string'
    || !file.receiptId.trim() || file.receiptId.length > 256)
    || new Set(files.map(file => file.receiptId)).size !== files.length) {
    return rejectMessage({ kind: 'error', code: 'bad-request', message: 'files must contain at most 20 distinct receiptId entries' })
  }
  if (files.length && (target.value.parentSessionId !== undefined || typeof msg.sessionId !== 'string' || !msg.sessionId.trim())) {
    return rejectMessage({ kind: 'error', code: target.value.parentSessionId ? 'subagent/attachment-invalid' : 'bad-request',
      message: 'file receipts require an existing ordinary session' })
  }
  if (files.length && (typeof msg.requestId !== 'string' || !msg.requestId.trim() || msg.requestId.length > 128)) {
    return rejectMessage({ kind: 'error', code: 'bad-request', message: 'file messages require a requestId of 1..128 characters' })
  }
  if (!text && imageParts.length === 0 && files.length === 0) {
    return rejectMessage({ kind: 'error', code: 'bad-request', message: 'message requires text, images or uploaded file receipts' })
  }
  const mode = msg.mode === 'steer' ? 'steer' : 'queue'

  let sessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim() !== '' ? msg.sessionId.trim() : undefined
  try {
    if (sessionId === undefined) {
      // New session: optionally place it in a workspace (at most one of
      // workspaceId / cwd, per the host create contract; workspaceId wins).
      const createPayload = {}
      if (preset.value !== undefined) createPayload.agentPreset = preset.value
      if (typeof msg.workspaceId === 'string' && msg.workspaceId.trim() !== '') {
        createPayload.workspaceId = msg.workspaceId.trim()
      }
      if (typeof msg.cwd === 'string' && msg.cwd.trim() !== '') {
        if (createPayload.workspaceId) log('mobile message: both workspaceId and cwd given, using workspaceId')
        else createPayload.cwd = msg.cwd.trim()
      }
      const created = await api.sessions.create(createPayload)
      sessionId = created.sessionId
      log(`mobile message created new session ${sessionId} (${JSON.stringify(createPayload)})`)
    }

    const resp = await api.sessions.prompt({
      ...target.value,
      sessionId,
      mode,
      ...requestIdentity,
      // Match the official WebUI ordering: images first, optional text last.
      content: [...imageParts, ...files.map(file => ({ type: 'file', receiptId: file.receiptId })),
        ...(text ? [{ type: 'text', text }] : [])],
      ...(typeof msg.clientTimeZone === 'string' && msg.clientTimeZone.trim() ? { clientTimeZone: msg.clientTimeZone.trim() } : {}),
    })
    log(`mobile message accepted: session=${sessionId} mode=${mode} images=${imageParts.length} text="${text.slice(0, 60)}"`)
    return {
      kind: 'sent',
      sessionId,
      mode,
      ...requestIdentity,
      ...(target.value.parentSessionId === undefined ? {} : {
        parentSessionId: target.value.parentSessionId, subagentMode: target.value.subagentMode,
        messageId: resp.messageId,
      }),
      ...(resp.command ? { command: resp.command } : {}),
    }
  } catch (error) {
    const code = error && error.code ? error.code : 'internal'
    const message = error && error.message ? error.message : String(error)
    log(`mobile message failed: ${message}`)
    return { kind: 'error', code, message, requestType: 'message', ...target.value,
      ...requestIdentity, ...(sessionId ? { sessionId } : {}) }
  }
}

// Proxy one read-only query to the official host API (the same surface the
// browser uses). Success returns `{ kind: <type>, ...value }`; failure returns
// the uniform `{ kind: 'error', code, message, requestType }` frame.
async function proxyQuery(api, type, method, payload, signal) {
  try {
    const value = signal ? await method(payload, signal) : await method(payload)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${type} returned an invalid response`)
    }
    log(`query ok: ${type}`)
    return { kind: type, ...value }
  } catch (error) {
    const code = error && error.code ? error.code : 'internal'
    const message = error && error.message ? error.message : String(error)
    log(`query failed: ${type} -> ${code}: ${message}`)
    return { kind: 'error', code, message, requestType: type }
  }
}

// Projection queries must keep the caller's request identity on failure.
// They need the opening cut and projections, not the full conversation body.
async function querySessionProjection(api, requestType, sessionId) {
  const history = await proxyQuery(api, 'history', api.sessions.history.bind(api.sessions), { sessionId, maxMessages: 1 })
  return history.kind === 'error' ? { ...history, requestType, sessionId } : history
}

function fileTransferError(code, message, requestType, sessionId) {
  return {
    kind: 'error',
    code,
    message,
    requestType,
    ...(sessionId ? { sessionId } : {}),
  }
}

function fileMediaType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.apk': return 'application/vnd.android.package-archive'
    case '.doc': return 'application/msword'
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.ipa': return 'application/octet-stream'
    case '.json': return 'application/json'
    case '.pdf': return 'application/pdf'
    case '.ppt': return 'application/vnd.ms-powerpoint'
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case '.txt': return 'text/plain'
    case '.xls': return 'application/vnd.ms-excel'
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.zip': return 'application/zip'
    default: return 'application/octet-stream'
  }
}

function workspaceRelativePath(root, target) {
  const relative = path.relative(root, target)
  return relative ? relative.split(path.sep).join('/') : '.'
}

function isInsideWorkspace(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function normalizedWorkspaceInput(value, { allowEmpty = false } = {}) {
  if (value === undefined && allowEmpty) return '.'
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed && allowEmpty) return '.'
  if (!trimmed || trimmed.includes('\0') || path.isAbsolute(trimmed)) return null
  if (trimmed.split(/[\\/]+/).includes('..')) return null
  return trimmed
}

// Owns only workspace-scoped, regular-file downloads. The host API has an
// image-only attachment read path, so arbitrary document/archive bytes must be
// guarded here instead of accepting a host path from the mobile client.
function createFileTransferManager(api, options) {
  const transfers = new Map()

  const closeTransfer = async (transferId) => {
    const transfer = transfers.get(transferId)
    if (!transfer) return false
    transfers.delete(transferId)
    try {
      await transfer.handle.close()
    } catch {
      // A failed close cannot make a completed or cancelled transfer usable.
    }
    return true
  }

  const resolveSessionRoot = async (sessionId, requestType) => {
    const sessions = await proxyQuery(api, requestType, api.sessions.list.bind(api.sessions), {})
    if (sessions.kind === 'error') return sessions
    const item = Array.isArray(sessions.items)
      ? sessions.items.find((entry) => entry && String(entry.sessionId) === sessionId)
      : null
    if (!item) return fileTransferError('session-not-found', 'no such session', requestType, sessionId)
    if (typeof item.cwd !== 'string' || !item.cwd.trim()) {
      return fileTransferError('file-workspace-unavailable', 'the session has no working directory', requestType, sessionId)
    }
    try {
      const root = await fsp.realpath(item.cwd)
      const stat = await fsp.stat(root)
      if (!stat.isDirectory()) {
        return fileTransferError('file-workspace-unavailable', 'the session working directory is unavailable', requestType, sessionId)
      }
      return { root, inputRoot: path.resolve(item.cwd) }
    } catch {
      return fileTransferError('file-workspace-unavailable', 'the session working directory is unavailable', requestType, sessionId)
    }
  }

  const resolveWorkspaceTarget = async (sessionId, rawPath, requestType, inputOptions) => {
    // Only the resolver accepts native absolute paths from recorded deliveries
    // or Markdown links. Download requests remain workspace-relative.
    const absoluteInput = inputOptions?.allowAbsolute === true
      && typeof rawPath === 'string' && path.isAbsolute(rawPath.trim())
    const requested = absoluteInput
      ? (rawPath.includes('\0') || rawPath.trim().split(/[\\/]+/).includes('..') ? null : rawPath.trim())
      : normalizedWorkspaceInput(rawPath, inputOptions)
    if (!requested) {
      return fileTransferError('bad-request', `${requestType} requires a valid ${inputOptions?.allowAbsolute ? '' : 'relative '}workspace path`, requestType, sessionId)
    }
    const rootResult = await resolveSessionRoot(sessionId, requestType)
    if (rootResult.kind === 'error') return rootResult
    // macOS commonly exposes one workspace as both /var/... and /private/var/...
    // (and cwd itself may be a symlink). Map only the known cwd alias before
    // enforcing the canonical root, then still verify the target's realpath.
    const candidate = absoluteInput && isInsideWorkspace(rootResult.inputRoot, requested)
      ? path.resolve(rootResult.root, path.relative(rootResult.inputRoot, requested))
      : path.resolve(rootResult.root, requested)
    if (!isInsideWorkspace(rootResult.root, candidate)) {
      return fileTransferError('file-not-allowed', 'path must stay inside the session working directory', requestType, sessionId)
    }
    try {
      const target = await fsp.realpath(candidate)
      if (!isInsideWorkspace(rootResult.root, target)) {
        return fileTransferError('file-not-allowed', 'path must stay inside the session working directory', requestType, sessionId)
      }
      const stat = await fsp.stat(target)
      return { root: rootResult.root, target, stat }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return fileTransferError('file-not-found', 'file does not exist', requestType, sessionId)
      }
      return fileTransferError('file-unreadable', 'file cannot be read', requestType, sessionId)
    }
  }

  const resolveFile = async (msg) => {
    const session = requireSessionId(msg)
    if (session.error) return session.error
    if (typeof msg.requestId !== 'string' || !msg.requestId.trim()) {
      return fileTransferError('bad-request', 'file-resolve requires a requestId', 'file-resolve', session.value)
    }
    const resolved = await resolveWorkspaceTarget(session.value, msg.path, 'file-resolve', { allowAbsolute: true })
    if (resolved.kind === 'error') return resolved
    if (!resolved.stat.isFile()) {
      return fileTransferError('file-not-regular', 'only regular files can be previewed', 'file-resolve', session.value)
    }
    if (resolved.stat.size > options.fileDownloadMaxBytes) {
      return fileTransferError('file-too-large', 'file exceeds the configured download limit', 'file-resolve', session.value)
    }
    return {
      kind: 'file-resolved', requestId: msg.requestId, sessionId: session.value,
      path: workspaceRelativePath(resolved.root, resolved.target),
      name: path.basename(resolved.target), mediaType: fileMediaType(resolved.target),
      size: resolved.stat.size, modifiedAt: resolved.stat.mtimeMs,
    }
  }

  const fileList = async (msg) => {
    const session = requireSessionId(msg)
    if (session.error) return session.error
    const resolved = await resolveWorkspaceTarget(session.value, msg.path, 'file-list', { allowEmpty: true })
    if (resolved.kind === 'error') return resolved
    if (!resolved.stat.isDirectory()) {
      return fileTransferError('file-not-directory', 'path is not a directory', 'file-list', session.value)
    }
    try {
      const dirents = await fsp.readdir(resolved.target, { withFileTypes: true })
      const entries = []
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue
        const child = path.join(resolved.target, dirent.name)
        if (dirent.isDirectory()) {
          entries.push({ name: dirent.name, path: workspaceRelativePath(resolved.root, child), kind: 'directory' })
        } else if (dirent.isFile()) {
          const stat = await fsp.stat(child)
          entries.push({
            name: dirent.name,
            path: workspaceRelativePath(resolved.root, child),
            kind: 'file',
            bytes: stat.size,
            modifiedAt: stat.mtimeMs,
            mediaType: fileMediaType(child),
          })
        }
      }
      entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1))
      const requestId = typeof msg.requestId === 'string' && msg.requestId.trim() ? msg.requestId.trim() : null
      return {
        kind: 'file-list',
        ...(requestId ? { requestId } : {}),
        sessionId: session.value,
        path: workspaceRelativePath(resolved.root, resolved.target),
        entries,
      }
    } catch {
      return fileTransferError('file-unreadable', 'directory cannot be read', 'file-list', session.value)
    }
  }

  const open = async (client, msg) => {
    const requestId = typeof msg.requestId === 'string' && msg.requestId.trim() ? msg.requestId.trim() : null
    const session = requireSessionId(msg)
    if (!requestId) return fileTransferError('bad-request', 'file-download-open requires a requestId', 'file-download-open')
    if (session.error) return session.error
    if (transfers.size >= options.fileDownloadMaxTransfers) {
      return fileTransferError('file-transfer-limit', 'too many active file downloads', 'file-download-open', session.value)
    }
    const resolved = await resolveWorkspaceTarget(session.value, msg.path, 'file-download-open')
    if (resolved.kind === 'error') return resolved
    if (!resolved.stat.isFile()) {
      return fileTransferError('file-not-regular', 'only regular files can be downloaded', 'file-download-open', session.value)
    }
    if (resolved.stat.size > options.fileDownloadMaxBytes) {
      return fileTransferError('file-too-large', 'file exceeds the configured download limit', 'file-download-open', session.value)
    }

    let handle
    try {
      // Reject a last-moment leaf symlink replacement after the realpath
      // containment check above. macOS and Linux both support O_NOFOLLOW.
      handle = await fsp.open(resolved.target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size !== resolved.stat.size) {
        await handle.close()
        return fileTransferError('file-changed', 'file changed before download could start', 'file-download-open', session.value)
      }
    } catch {
      return fileTransferError('file-unreadable', 'file cannot be opened', 'file-download-open', session.value)
    }

    const transferId = crypto.randomUUID()
    const transfer = {
      client,
      handle,
      sessionId: session.value,
      path: workspaceRelativePath(resolved.root, resolved.target),
      name: path.basename(resolved.target),
      mediaType: fileMediaType(resolved.target),
      size: resolved.stat.size,
      offset: 0,
      hash: crypto.createHash('sha256'),
      reading: false,
      lastActiveAt: Date.now(),
    }
    transfers.set(transferId, transfer)
    log(`file download opened: transfer=${transferId} session=${transfer.sessionId} bytes=${transfer.size}`)
    return {
      kind: 'file-download-opened',
      requestId,
      transferId,
      sessionId: transfer.sessionId,
      path: transfer.path,
      name: transfer.name,
      mediaType: transfer.mediaType,
      size: transfer.size,
      chunkBytes: options.fileDownloadChunkBytes,
    }
  }

  const read = async (client, msg) => {
    const transferId = typeof msg.transferId === 'string' && msg.transferId.trim() ? msg.transferId.trim() : null
    if (!transferId) return fileTransferError('bad-request', 'file-download-read requires a transferId', 'file-download-read')
    const transfer = transfers.get(transferId)
    if (!transfer || transfer.client !== client) {
      return fileTransferError('file-transfer-not-found', 'file download is no longer active', 'file-download-read')
    }
    if (!Number.isSafeInteger(msg.offset) || msg.offset !== transfer.offset) {
      return fileTransferError('file-transfer-offset', 'offset must match the next unread byte', 'file-download-read', transfer.sessionId)
    }
    if (transfer.reading) {
      return fileTransferError('file-transfer-busy', 'a chunk read is already in progress', 'file-download-read', transfer.sessionId)
    }

    transfer.reading = true
    try {
      const remaining = transfer.size - transfer.offset
      const bytesToRead = Math.min(options.fileDownloadChunkBytes, remaining)
      const chunk = Buffer.allocUnsafe(bytesToRead)
      const { bytesRead } = bytesToRead === 0
        ? { bytesRead: 0 }
        : await transfer.handle.read(chunk, 0, bytesToRead, transfer.offset)
      if (bytesRead !== bytesToRead) {
        await closeTransfer(transferId)
        return fileTransferError('file-changed', 'file changed during download', 'file-download-read', transfer.sessionId)
      }
      const payload = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead)
      transfer.hash.update(payload)
      const offset = transfer.offset
      transfer.offset += bytesRead
      transfer.lastActiveAt = Date.now()
      const eof = transfer.offset === transfer.size
      const frame = {
        kind: 'file-download-chunk',
        transferId,
        offset,
        data: payload.toString('base64'),
        eof,
      }
      if (eof) {
        frame.sha256 = transfer.hash.digest('hex')
        await closeTransfer(transferId)
        log(`file download completed: transfer=${transferId} bytes=${transfer.size}`)
      }
      return frame
    } catch {
      await closeTransfer(transferId)
      return fileTransferError('file-unreadable', 'file cannot be read', 'file-download-read', transfer.sessionId)
    } finally {
      transfer.reading = false
    }
  }

  const cancel = async (client, msg) => {
    const transferId = typeof msg.transferId === 'string' && msg.transferId.trim() ? msg.transferId.trim() : null
    if (!transferId) return fileTransferError('bad-request', 'file-download-cancel requires a transferId', 'file-download-cancel')
    const transfer = transfers.get(transferId)
    if (!transfer || transfer.client !== client) {
      return fileTransferError('file-transfer-not-found', 'file download is no longer active', 'file-download-cancel')
    }
    await closeTransfer(transferId)
    log(`file download cancelled: transfer=${transferId}`)
    return { kind: 'file-download-cancelled', transferId }
  }

  const expire = async () => {
    const cutoff = Date.now() - options.fileDownloadIdleMs
    for (const [transferId, transfer] of transfers) {
      if (transfer.lastActiveAt < cutoff && !transfer.reading) {
        await closeTransfer(transferId)
        log(`file download expired: transfer=${transferId}`)
      }
    }
  }

  return {
    async handle(client, msg) {
      const correlation = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
      if (!options.fileDownloadsEnabled) {
        return { ...fileTransferError('file-download-disabled', 'file downloads are disabled by gateway configuration', msg.type), ...correlation }
      }
      if (msg.type === 'file-resolve') return { ...await resolveFile(msg), ...correlation }
      if (msg.type === 'file-list') return fileList(msg)
      if (msg.type === 'file-download-open') return open(client, msg)
      if (msg.type === 'file-download-read') return read(client, msg)
      if (msg.type === 'file-download-cancel') return cancel(client, msg)
      return null
    },
    async closeClient(client) {
      for (const [transferId, transfer] of transfers) {
        if (transfer.client === client) await closeTransfer(transferId)
      }
    },
    async dispose() {
      for (const transferId of [...transfers.keys()]) await closeTransfer(transferId)
    },
    expire,
  }
}

// List one directory level directly with node:fs, mirroring the official
// browse backend's semantics (crumbs + name-sorted child directories). Works
// on every deployment regardless of the composed picker capability, which
// `host.listDirectory` would otherwise gate behind the `browse` capability.
async function listServerDirectory(target) {
  try {
    const home = os.homedir()
    const requested = target ? path.resolve(target) : home
    const crumbs = []
    let cur = requested
    for (;;) {
      crumbs.unshift({ name: cur === path.parse(cur).root ? cur : path.basename(cur), path: cur, hidden: false })
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    const entries = []
    const dirents = await fsp.readdir(requested, { withFileTypes: true })
    for (const dirent of dirents) {
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
      entries.push({ name: dirent.name, path: path.join(requested, dirent.name), hidden: dirent.name.startsWith('.') })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    log(`query ok: directories (${requested}, ${entries.length} entries)`)
    return { kind: 'directories', path: requested, home, crumbs, entries, truncated: false }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    log(`query failed: directories -> ${message}`)
    return { kind: 'error', code: 'directory-unreadable', message, requestType: 'directories' }
  }
}

function directoryCreateError(code, message) {
  return { kind: 'error', code, message, requestType: 'directory-create' }
}

// Create one child directory directly on the host filesystem. This deliberately
// shares the same backend as `directories`: macOS native Directory Picker only
// exposes its system dialog and does not implement remote createDirectory RPCs.
async function createServerDirectory(parentPath, directoryName) {
  if (typeof parentPath !== 'string' || parentPath.trim() === '') {
    return directoryCreateError('bad-request', 'directory-create requires an absolute parent path')
  }
  const parent = path.resolve(parentPath.trim())
  if (!path.isAbsolute(parentPath.trim())) {
    return directoryCreateError('bad-request', 'directory-create path must be absolute')
  }

  if (typeof directoryName !== 'string') {
    return directoryCreateError('bad-request', 'directory-create requires a folder name')
  }
  const name = directoryName.trim()
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return directoryCreateError('bad-request', 'directory-create name must be a single non-empty folder name')
  }

  try {
    const stat = await fsp.stat(parent)
    if (!stat.isDirectory()) {
      return directoryCreateError('directory-create-failed', 'parent path is not a directory')
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    log(`query failed: directory-create -> ${message}`)
    return directoryCreateError('directory-create-failed', message)
  }

  const target = path.join(parent, name)
  try {
    await fsp.mkdir(target)
    log(`query ok: directory-create (${target})`)
    return { kind: 'directory-create', path: target }
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return directoryCreateError('directory-exists', 'directory already exists')
    }
    const message = error && error.message ? error.message : String(error)
    log(`query failed: directory-create -> ${message}`)
    return directoryCreateError('directory-create-failed', message)
  }
}

// Validate one sessionId field; returns { value } or { error }.
function requireSessionId(msg) {
  const sessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim() !== '' ? msg.sessionId.trim() : null
  if (!sessionId) {
    return { error: { kind: 'error', code: 'bad-request', message: 'this request requires a sessionId', requestType: typeof msg.type === 'string' ? msg.type : 'query' } }
  }
  return { value: sessionId }
}

// Goal mutations use DSH's compare-and-set reference. Returning a stale
// revision is intentionally rejected by DSH instead of overwriting a newer
// WebUI/mobile update.
function requireGoalRef(msg, sessionId) {
  const ref = msg.ref
  const id = ref && typeof ref.id === 'string' && ref.id.trim() !== '' ? ref.id.trim() : null
  const revision = ref && typeof ref.revision === 'number' && Number.isSafeInteger(ref.revision) && ref.revision > 0
    ? ref.revision
    : null
  if (!id || revision === null) {
    return {
      error: {
        kind: 'error',
        code: 'bad-request',
        message: `${typeof msg.type === 'string' ? msg.type : 'goal mutation'} requires ref.id and a positive integer ref.revision`,
        requestType: typeof msg.type === 'string' ? msg.type : 'goal',
        sessionId,
      },
    }
  }
  return { value: { id, revision } }
}

async function readSessionProjection(api, type, sessionId, key, target = { sessionId }) {
  const history = await proxyQuery(api, 'history', api.sessions.history.bind(api.sessions), { ...target, maxMessages: 1 })
  if (history.kind !== 'history') return { ...history, ...target, requestType: type }
  const values = (history.projections && history.projections.values) || {}
  return {
    kind: type,
    ...target,
    asOfSeq: history.projections ? history.projections.asOfSeq : undefined,
    [key]: Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null,
  }
}

async function mutateGoal(api, type, method, payload) {
  if (!api.goals || typeof api.goals[method] !== 'function') {
    return {
      kind: 'error',
      code: 'unsupported',
      message: 'goal management is unavailable in this DSH host',
      requestType: type,
      sessionId: payload.sessionId,
    }
  }
  return proxyQuery(api, type, api.goals[method].bind(api.goals), payload)
}

// ---------------------------------------------------------------------------
// History frame sizing: raw session logs can be huge (trajectory, tool output,
// context), so a single history response must never blow the client's
// WebSocket frame limit. We cap the serialized size per frame, keep the NEWEST
// suffix within the budget, and hand the client `hasMore` + `nextBeforeSeq` so
// it can page backward. An optional `view: "conversation"` trims events that
// are not needed for a chat page (token-level chunks, system-prompt headers)
// and truncates oversized tool-result text.
// ---------------------------------------------------------------------------
const HISTORY_DEFAULT_MAX_BYTES = 4 * 1024 * 1024 // 4 MiB per frame
// Opening snapshots should be readable before older history is requested.
// Keep the newest indivisible message even when it alone exceeds this budget.
const HISTORY_OPENING_MAX_BYTES = 256 * 1024
const HISTORY_TOOL_RESULT_MAX_CHARS = 2000 // per text block in conversation view

function eventBytes(event) {
  return Buffer.byteLength(JSON.stringify(event), 'utf8')
}

// Trim one event for the conversation page: null drops it, otherwise a shallow
// copy with oversized payloads truncated. The events come from the host RPC as
// plain JSON, so copying is safe.
function trimConversationEvent(event) {
  switch (event.type) {
    case 'assistant/chunk':
    case 'request/header':
    case 'request/context':
    case 'system/message':
      // token-level replay / system-prompt header: not rendered on the chat page
      return null
    case 'assistant/message':
    case 'assistant/attempt': {
      const { stream, ...data } = event.data || {}
      const finish = assistantFinish(event.data || {})
      return { ...event, data: { ...data, ...(finish ? { finish } : {}) } }
    }
    case 'tool/result': {
      const d = event.data || {}
      const message = d.message
      const images = toolImages(d)
      const details = { ...toolResultDetails(d), ...(images.length ? { images } : {}) }
      if (!message || !Array.isArray(message.content)) return { ...event, data: { ...d, ...details } }
      let changed = false
      const truncateBlock = (block) => {
        if (!block || typeof block !== 'object') return block
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > HISTORY_TOOL_RESULT_MAX_CHARS) {
          changed = true
          return { ...block, text: block.text.slice(0, HISTORY_TOOL_RESULT_MAX_CHARS) + '…' }
        }
        if (Array.isArray(block.content)) {
          return { ...block, content: block.content.map(truncateBlock) }
        }
        return block
      }
      const content = message.content.map(truncateBlock)
      return { ...event, data: { ...d, ...details, ...(changed ? { message: { ...message, content } } : {}) } }
    }
    case 'tool/ptc-dispatch':
    case 'tool/code-dispatch': {
      const d = event.data || {}
      const images = toolImages(d, event.type)
      return { ...event, data: { ...d, ...(images.length ? { images } : {}) } }
    }
    default:
      return event
  }
}

// Keep the newest suffix of `events` (ascending seq) within `maxBytes`.
// Always keeps the newest event even if it alone exceeds the budget (an event
// cannot be split); drops older events beyond the budget. Returns the kept
// events, their total serialized bytes, and whether anything was dropped.
function capHistoryEvents(events, maxBytes, trim) {
  const processed = trim ? events.map(trimConversationEvent).filter(Boolean) : events
  if (processed.length === 0) return { events: [], bytes: 0, dropped: 0 }
  let total = 0
  let keptStart = processed.length
  for (let i = processed.length - 1; i >= 0; i--) {
    const size = eventBytes(processed[i])
    if (keptStart === processed.length) {
      // always keep the newest event
      total = size
      keptStart = i
      continue
    }
    if (total + size > maxBytes) break
    total += size
    keptStart = i
  }
  return { events: processed.slice(keptStart), bytes: total, dropped: keptStart }
}

function validateHistoryCursor(msg, sessionId, field) {
  if (msg[field] === undefined && msg.historyFormatVersion === undefined) return null
  if (msg.historyFormatVersion !== SESSION_FORMAT_VERSION) {
    return { kind: 'error', code: 'history-format-mismatch', requestType: msg.type, sessionId,
      historyFormatVersion: SESSION_FORMAT_VERSION, resetRequired: true,
      message: `Reload the Session baseline before using a history or fork cursor; historyFormatVersion must be ${SESSION_FORMAT_VERSION}` }
  }
  if (msg[field] !== undefined && (!Number.isSafeInteger(msg[field]) || msg[field] < 0)) {
    return { kind: 'error', code: 'bad-request', requestType: msg.type, sessionId,
      message: `${field} must be a non-negative safe integer` }
  }
  return null
}

function historyPage(value, msg) {
  const rawEvents = value.events.map(entry => entry.event)
  const maxBytes = Number.isSafeInteger(msg.maxBytes) && msg.maxBytes > 0 ? msg.maxBytes : HISTORY_DEFAULT_MAX_BYTES
  const trim = msg.view === 'conversation'
  const capped = capHistoryEvents(rawEvents, maxBytes, trim)
  const hasMore = value.hasMore === true || capped.dropped > 0
  // An all-hidden page still needs a cursor so callers can reach older text.
  const oldest = capped.events[0]?.seq ?? rawEvents[0]?.seq
  return { ...value, kind: 'history', sessionId: msg.sessionId,
    events: capped.events, bytes: capped.bytes, hasMore,
    ...(trim ? { view: 'conversation' } : {}),
    ...(hasMore && oldest !== undefined ? { nextBeforeSeq: oldest } : {}),
  }
}

function resolveCommandCatalogCopy(locale) {
  return typeof locale === 'string' && !locale.toLowerCase().startsWith('zh')
    ? COMMAND_CATALOG_COPY.en
    : COMMAND_CATALOG_COPY.zh
}

// DSH 0.1.5-rc.2 command descriptors use input.attachments.
function commandAcceptsAttachments(command) {
  return command?.input?.attachments === true
}

function commandUiDescriptor(command, copy) {
  const override = COMMAND_UI_OVERRIDES[command.name]
  if (override) return { ...override, insertText: `/${command.name}` }
  if (command.input && typeof command.input.hint === 'string') {
    const displayHint = copy.hints[command.name]
    return {
      kind: 'input',
      insertText: `/${command.name} `,
      hint: command.input.hint,
      ...(displayHint ? { displayHint } : {}),
      images: commandAcceptsAttachments(command),
      submitRequest: 'command-execute',
    }
  }
  return { kind: 'immediate', submitRequest: 'command-execute', submitText: `/${command.name}` }
}

function skillUiDescriptor(skill) {
  return {
    kind: 'input',
    insertText: `/${skill.name} `,
    images: true,
    submitRequest: 'message',
  }
}

function modelCommandOptionId(provider, model) {
  return Buffer.from(JSON.stringify([provider, model]), 'utf8').toString('base64url')
}

function decodeModelCommandOptionId(optionId) {
  try {
    const value = JSON.parse(Buffer.from(optionId, 'base64url').toString('utf8'))
    if (!Array.isArray(value) || value.length !== 2 || value.some((part) => typeof part !== 'string' || part === '')) return null
    return { provider: value[0], model: value[1] }
  } catch {
    return null
  }
}

async function loadCommandOptions(api, command, sessionId) {
  if (command === 'model') {
    const frame = await proxyQuery(api, 'models', api.sessions.models.bind(api.sessions), { sessionId })
    if (frame.kind !== 'models') return frame
    const options = []
    for (const group of frame.groups || []) {
      for (const model of group.models || []) {
        options.push({
          id: modelCommandOptionId(String(group.id), String(model.id)),
          label: String(model.name || model.id),
          detail: String(group.name || group.id),
          ...(model.description ? { description: String(model.description) } : {}),
          selected: frame.current && frame.current.provider === group.id && frame.current.model === model.id,
        })
      }
    }
    return { kind: 'command-options', sessionId, command, options }
  }

  if (command === 'permission') {
    const history = await proxyQuery(api, 'history', api.sessions.history.bind(api.sessions), { sessionId })
    if (history.kind !== 'history') return history
    const permissions = history.projections && history.projections.values && history.projections.values.permissions
    const catalog = await proxyQuery(api, 'permission-catalog', api.permissionPresets.catalog.bind(api.permissionPresets), {})
    if (catalog.kind === 'error') return catalog
    if (!permissions || typeof permissions.currentValue !== 'string' || !Array.isArray(catalog.options)) {
      return {
        kind: 'error',
        code: 'command-options-unavailable',
        message: 'permission options are unavailable for this session',
        requestType: 'command-options',
        sessionId,
      }
    }
    return {
      kind: 'command-options',
      sessionId,
      command,
      options: catalog.options.map((option) => ({
        id: String(option.value),
        label: String(option.name || option.value),
        ...(option.description ? { description: String(option.description) } : {}),
        selected: option.value === permissions.currentValue,
      })),
    }
  }

  return {
    kind: 'error',
    code: 'bad-request',
    message: `command does not provide selectable options: ${command}`,
    requestType: 'command-options',
    sessionId,
  }
}

async function selectCommandOption(api, host, command, sessionId, optionId) {
  const catalog = await loadCommandOptions(api, command, sessionId)
  if (catalog.kind !== 'command-options') return catalog
  const option = catalog.options.find((candidate) => candidate.id === optionId)
  if (!option) {
    return {
      kind: 'error',
      code: 'bad-request',
      message: `unknown option for ${command}: ${optionId}`,
      requestType: 'command-select',
      sessionId,
    }
  }

  if (command === 'permission') {
    try {
      const execution = await host.commands.execute(
        sessionId,
        '/permission ' + optionId,
        [],
        new AbortController().signal,
      )
      if (!execution || !execution.result) throw new Error('permission command returned an invalid result')
      if (execution.result.kind === 'error') {
        return { kind: 'error', code: 'command-error', message: execution.result.text, requestType: 'command-select', sessionId }
      }
      return { kind: 'command-selected', sessionId, command, selected: { ...option, selected: true } }
    } catch (error) {
      const code = error && error.code ? error.code : 'internal'
      const message = error && error.message ? error.message : String(error)
      return { kind: 'error', code, message, requestType: 'command-select', sessionId }
    }
  }

  if (command === 'model') {
    const selection = decodeModelCommandOptionId(optionId)
    if (!selection) {
      return { kind: 'error', code: 'bad-request', message: 'invalid model option id', requestType: 'command-select', sessionId }
    }
    const models = await proxyQuery(api, 'models', api.sessions.models.bind(api.sessions), { sessionId })
    if (models.kind !== 'models') return models
    const group = (models.groups || []).find((candidate) => candidate.id === selection.provider)
    const model = group && (group.models || []).find((candidate) => candidate.id === selection.model)
    if (!model) {
      return { kind: 'error', code: 'bad-request', message: 'model option is no longer available', requestType: 'command-select', sessionId }
    }
    const payload = { sessionId, ...selection }
    const reasoningEffort = models.current && models.current.provider === selection.provider && models.current.model === selection.model
      ? models.current.reasoningEffort
      : model.reasoning && model.reasoning.defaultEffort
    if (reasoningEffort) payload.reasoningEffort = reasoningEffort
    const selected = await proxyQuery(api, 'select-model', api.sessions.selectModel.bind(api.sessions), payload)
    if (selected.kind !== 'select-model') return selected
    return {
      kind: 'command-selected',
      sessionId,
      command,
      selected: { ...option, selected: true },
      value: selected.selected,
    }
  }

  return { kind: 'error', code: 'bad-request', message: `command is not selectable: ${command}`, requestType: 'command-select', sessionId }
}

function parseAgentPreset(msg, requestType, required = false) {
  if (msg.agentPreset === undefined && !required) return {}
  if (typeof msg.agentPreset !== 'string' || !msg.agentPreset.trim()) {
    return { error: { kind: 'error', code: 'bad-request', requestType,
      message: 'agentPreset must be a non-empty preset ID' } }
  }
  return { value: msg.agentPreset.trim() }
}

// Dispatch one mobile query frame; returns the wire frame to send back.
async function handleQuery(api, host, agentDefaultModel, msg, pluginContext) {
  if (PLUGIN_REQUEST_TYPES.has(msg.type)) return handlePluginQuery(api, msg, pluginContext)
  if (msg.type === 'agent-team' || msg.type === 'subagents') {
    const session = requireSessionId(msg)
    const identity = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
    if (session.error) return { ...session.error, ...identity }
    const sessionId = session.value
    const key = msg.type === 'agent-team' ? 'agentTeam' : 'subagentCatalog'
    try {
      const snapshot = await api.sessions.projections({ sessionId })
      if (snapshot === null) throw Object.assign(new Error('session not found'), { code: 'session/not-found' })
      if (!['sequenced', 'migration-required'].includes(snapshot?.kind)
        || !snapshot.values || (snapshot.kind === 'sequenced' && !Number.isSafeInteger(snapshot.asOfSeq))) {
        throw new Error('invalid session projections')
      }
      const value = snapshot.values[key] ?? null
      if (value !== null && (key === 'subagentCatalog' ? !Array.isArray(value)
        : !Array.isArray(value.members) || !Array.isArray(value.tasks))) throw new Error('invalid team projection')
      return { kind: msg.type, sessionId, ...identity,
        projectionState: snapshot.kind === 'migration-required' ? 'migration-required'
          : value === null ? 'unavailable' : 'ready',
        ...(snapshot.kind === 'sequenced' ? { asOfSeq: snapshot.asOfSeq } : {}), [key]: value }
    } catch (error) {
      return { kind: 'error', code: error.code || 'internal', message: error.message,
        requestType: msg.type, sessionId, ...identity }
    }
  }
  if (msg.type === 'session-agent-preset' || msg.type === 'select-agent-preset') {
    const session = requireSessionId(msg)
    const preset = parseAgentPreset(msg, msg.type, msg.type === 'select-agent-preset')
    const requestId = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
    if (session.error || preset.error) return { ...(session.error || preset.error), ...requestId }
    const method = msg.type === 'session-agent-preset' ? 'session' : 'select'
    const frame = await proxyQuery(api, msg.type, api.agentPresets[method].bind(api.agentPresets), {
      sessionId: session.value, ...(preset.value === undefined ? {} : { agentPreset: preset.value }),
    })
    return { ...frame, sessionId: session.value, ...requestId }
  }
  if (msg.type === 'session-create') {
    if (typeof msg.requestId !== 'string' || !msg.requestId.trim()) {
      return { kind: 'error', code: 'bad-request', message: 'session-create requires a requestId', requestType: 'session-create' }
    }
    const payload = {}
    const preset = parseAgentPreset(msg, msg.type)
    if (preset.error) return { ...preset.error, requestId: msg.requestId }
    if (preset.value !== undefined) payload.agentPreset = preset.value
    if (typeof msg.workspaceId === 'string' && msg.workspaceId.trim()) {
      payload.workspaceId = msg.workspaceId.trim()
    } else if (typeof msg.cwd === 'string' && msg.cwd.trim()) {
      payload.cwd = msg.cwd.trim()
    }
    const frame = await proxyQuery(api, 'session-created', api.sessions.create.bind(api.sessions), payload)
    return { ...frame, ...(frame.kind === 'error' ? { requestType: 'session-create' } : {}), requestId: msg.requestId }
  }
  if (msg.type === 'workspaces') {
    return proxyQuery(api, 'workspaces', api.workspace.list.bind(api.workspace), {})
  }
  if (msg.type === 'sessions') {
    const frame = await proxyQuery(api, 'sessions', api.sessions.list.bind(api.sessions), {})
    if (frame.kind !== 'sessions' || !Array.isArray(frame.items)) return frame
    // Lists need only titles; full projections can make these frames many MiB.
    // Copy at the mobile boundary so Host data and history projections stay intact.
    return { ...frame, items: frame.items.map(item => {
      if (!item?.projections) return item
      const { asOfSeq, values } = item.projections
      return { ...item, projections: {
        ...(asOfSeq === undefined ? {} : { asOfSeq }),
        values: values && Object.hasOwn(values, 'title') ? { title: values.title } : {},
      } }
    }) }
  }
  if (msg.type === 'history') {
    const target = parseSessionTarget(msg)
    if (target.error) return target.error
    const { sessionId } = target.value
    const identity = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
    const cursorError = validateHistoryCursor(msg, sessionId, 'beforeSeq')
    if (cursorError) return { ...cursorError, ...target.value, ...identity }
    const payload = { ...target.value }
    if (typeof msg.beforeSeq === 'number' && Number.isFinite(msg.beforeSeq)) payload.beforeSeq = msg.beforeSeq
    if (typeof msg.maxMessages === 'number' && Number.isFinite(msg.maxMessages)) payload.maxMessages = msg.maxMessages
    const frame = await proxyQuery(api, 'history', api.sessions.history.bind(api.sessions), payload)
    if (frame.kind === 'history') return { ...historyPage(frame, { ...msg, sessionId }), ...target.value, ...identity }
    return { ...frame, ...target.value, ...identity }
  }
  if (msg.type === 'attachment') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const attachmentId = typeof msg.attachmentId === 'string' && msg.attachmentId.trim() !== '' ? msg.attachmentId.trim() : null
    if (!attachmentId) {
      return { kind: 'error', code: 'bad-request', message: 'attachment requires an attachmentId', requestType: 'attachment', sessionId: sessionId.value }
    }
    const frame = await proxyQuery(api, 'attachment', api.sessions.attachment.bind(api.sessions), {
      sessionId: sessionId.value,
      attachmentId,
    })
    if (frame.kind === 'attachment') frame.sessionId = sessionId.value
    return frame
  }
  if (msg.type === 'search') {
    const query = typeof msg.query === 'string' ? msg.query.trim() : ''
    if (!query) {
      return { kind: 'error', code: 'bad-request', message: 'search requires a query', requestType: 'search' }
    }
    return proxyQuery(api, 'search', api.sessions.search.bind(api.sessions), { query }, new AbortController().signal)
  }
  if (msg.type === 'host') {
    return proxyQuery(api, 'host', api.host.describe.bind(api.host), {})
  }
  if (msg.type === 'default-model') {
    try {
      const selection = agentDefaultModel.currentSelection()
      log(`default-model queried: ${selection.provider}/${selection.model}`)
      return { kind: 'default-model', selection }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      return { kind: 'error', code: 'internal', message, requestType: 'default-model' }
    }
  }
  if (msg.type === 'save-default-model') {
    const provider = typeof msg.provider === 'string' && msg.provider.trim() !== '' ? msg.provider.trim() : null
    const model = typeof msg.model === 'string' && msg.model.trim() !== '' ? msg.model.trim() : null
    if (!provider || !model) {
      return { kind: 'error', code: 'bad-request', message: 'save-default-model requires provider and model', requestType: 'save-default-model' }
    }
    const selection = { provider, model }
    if (typeof msg.reasoningEffort === 'string' && msg.reasoningEffort.trim() !== '') selection.reasoningEffort = msg.reasoningEffort.trim()
    try {
      await agentDefaultModel.saveSelection(selection)
      log(`default model saved: ${provider}/${model}${selection.reasoningEffort ? ' (effort=' + selection.reasoningEffort + ')' : ''}`)
      return { kind: 'save-default-model', saved: selection }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      log(`save-default-model failed: ${message}`)
      return { kind: 'error', code: 'internal', message, requestType: 'save-default-model' }
    }
  }
  if (msg.type === 'fork') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const cursorError = validateHistoryCursor(msg, sessionId.value, 'atSeq')
    if (cursorError) return cursorError
    const payload = { sessionId: sessionId.value }
    if (typeof msg.atSeq === 'number' && Number.isFinite(msg.atSeq)) payload.atSeq = Math.floor(msg.atSeq)
    const frame = await proxyQuery(api, 'fork', api.sessions.fork.bind(api.sessions), payload)
    if (frame.kind === 'fork') {
      log(`forked session ${sessionId.value} -> ${frame.sessionId}${payload.atSeq !== undefined ? ' at seq ' + payload.atSeq : ''}`)
    }
    return frame
  }
  if (msg.type === 'session-cancel') {
    const target = parseSessionTarget(msg)
    if (target.error) return target.error
    const identity = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
    const frame = await proxyQuery(
      api,
      'session-cancel',
      api.sessions.cancel.bind(api.sessions),
      target.value,
    )
    if (frame.kind === 'error') return { ...frame, ...target.value, ...identity }
    return { ...frame, kind: 'session-cancelled', ...target.value, ...identity }
  }
  if (msg.type === 'queue-update') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const itemId = typeof msg.itemId === 'string' && msg.itemId.trim() ? msg.itemId.trim() : null
    const actionKind = typeof msg.action === 'string' ? msg.action.trim() : ''
    if (!itemId || !['edit', 'remove', 'steer'].includes(actionKind)) {
      return {
        kind: 'error',
        code: 'bad-request',
        message: 'queue-update requires itemId and action edit, remove, or steer',
        requestType: 'queue-update',
        sessionId: sessionId.value,
      }
    }
    let action
    if (actionKind === 'edit') {
      let text = msg.text
      try {
        if (msg.textParts !== undefined) text = serializeMessageText(msg.text, msg.textParts)
        if (typeof text !== 'string' || !text.trim()) throw new Error('queue-update edit requires non-empty text')
      } catch (error) {
        return {
          kind: 'error',
          code: 'bad-request',
          message: error.message,
          requestType: 'queue-update',
          sessionId: sessionId.value,
          itemId,
        }
      }
      action = { kind: 'edit', content: [{ type: 'text', text }] }
    } else {
      action = { kind: actionKind }
    }
    const frame = await proxyQuery(
      api,
      'queue-update',
      api.sessions.updateQueue.bind(api.sessions),
      { sessionId: sessionId.value, itemId, action },
    )
    if (frame.kind === 'error') return { ...frame, sessionId: sessionId.value, itemId }
    return {
      ...frame,
      kind: 'queue-item-updated',
      sessionId: sessionId.value,
      itemId,
      action: actionKind,
    }
  }
  if (msg.type === 'session-archive') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const frame = await proxyQuery(
      api,
      'session-archive',
      api.workspace.archiveSession.bind(api.workspace),
      { sessionId: sessionId.value },
    )
    if (frame.kind === 'error') return { ...frame, sessionId: sessionId.value }
    return { ...frame, kind: 'session-archived', sessionId: sessionId.value }
  }
  if (msg.type === 'session-rename') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    if (typeof msg.title !== 'string' || !msg.title.trim()) {
      return {
        kind: 'error',
        code: 'bad-request',
        message: 'session-rename requires a non-empty title',
        requestType: 'session-rename',
        sessionId: sessionId.value,
      }
    }
    const frame = await proxyQuery(
      api,
      'session-rename',
      api.sessions.rename.bind(api.sessions),
      { sessionId: sessionId.value, title: msg.title },
    )
    if (frame.kind === 'error') return { ...frame, sessionId: sessionId.value }
    return { ...frame, kind: 'session-renamed', sessionId: sessionId.value }
  }
  if (msg.type === 'workspace-create') {
    const wsPath = typeof msg.path === 'string' && msg.path.trim() !== '' ? msg.path.trim() : null
    if (!wsPath) {
      return { kind: 'error', code: 'bad-request', message: 'workspace-create requires a path', requestType: 'workspace-create' }
    }
    return proxyQuery(api, 'workspace-create', api.workspace.create.bind(api.workspace), { path: wsPath })
  }
  if (msg.type === 'directories') {
    return listServerDirectory(typeof msg.path === 'string' && msg.path.trim() !== '' ? msg.path.trim() : undefined)
  }
  if (msg.type === 'directory-create') {
    return createServerDirectory(msg.path, msg.name)
  }
  if (msg.type === 'models') {
    const sessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim() !== '' ? msg.sessionId.trim() : null
    if (sessionId) {
      // per-session catalog: current selection + routable + full groups
      return proxyQuery(api, 'models', api.sessions.models.bind(api.sessions), { sessionId })
    }
    // global catalog: every provider route, no session needed
    return proxyQuery(api, 'models', api.llm.models.bind(api.llm), {})
  }
  if (msg.type === 'providers') {
    return proxyQuery(api, 'providers', api.llm.providers.bind(api.llm), {})
  }
  if (msg.type === 'command-execute') {
    return admitCommand(host, msg)
  }
  if (msg.type === 'commands') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const copy = resolveCommandCatalogCopy(msg.locale)
    try {
      // This is the same session-scoped catalog used by the official Web UI.
      // Copy only the stable descriptor fields so no live Typert object crosses
      // the mobile wire. The Web UI also contributes /model client-side; expose
      // the equivalent action here so mobile clients can render the same menu.
      const [listed, skillFrame] = await Promise.all([
        listHostCommands(host, sessionId.value),
        api.skills && typeof api.skills.list === 'function'
          ? proxyQuery(api, 'skills', api.skills.list.bind(api.skills), { sessionId: sessionId.value })
          : Promise.resolve({ kind: 'error', code: 'unsupported', message: 'skill catalog is unavailable', requestType: 'skills' }),
      ])
      if (!Array.isArray(listed)) throw new Error('commands/list returned an invalid catalog')
      const commands = listed
        .filter((command) => command && typeof command.name === 'string' && typeof command.description === 'string')
        .map((command) => ({
          id: `command:${command.name}`,
          name: command.name,
          description: command.description,
          source: 'host',
          action: 'execute',
          ui: commandUiDescriptor(command, copy),
          ...(command.input && typeof command.input.hint === 'string'
            ? { input: { hint: command.input.hint, ...(commandAcceptsAttachments(command) ? { images: true } : {}) } }
            : {}),
        }))
      if (!commands.some((command) => command.name === 'model')) {
        commands.push({
          id: 'command:model',
          name: 'model',
          description: copy.modelDescription,
          source: 'client',
          action: 'select-model',
          ui: commandUiDescriptor({ name: 'model' }, copy),
        })
      }
      const skills = skillFrame.kind === 'skills' && Array.isArray(skillFrame.skills)
        ? skillFrame.skills
          .filter((skill) => skill && typeof skill.name === 'string' && typeof skill.description === 'string')
          .map((skill) => ({
            id: `skill:${skill.name}`,
            name: skill.name,
            description: skill.modelInvocable === true ? skill.description : `${copy.userOnly} · ${skill.description}`,
            source: 'skill',
            action: 'insert',
            modelInvocable: skill.modelInvocable === true,
            ...(typeof skill.whenToUse === 'string' && skill.whenToUse !== '' ? { whenToUse: skill.whenToUse } : {}),
            ui: skillUiDescriptor(skill),
          }))
        : []
      const groups = [
        { id: 'commands', title: copy.commandsTitle, items: commands },
        ...(skills.length > 0 ? [{ id: 'skills', title: copy.skillsTitle, items: skills }] : []),
      ]
      const warnings = skillFrame.kind === 'error'
        ? [{ source: 'skills', code: skillFrame.code, message: skillFrame.message }]
        : []
      log(`command catalog queried: session=${sessionId.value} commands=${commands.length} skills=${skills.length}`)
      return {
        kind: 'commands',
        sessionId: sessionId.value,
        locale: copy.locale,
        groups,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    } catch (error) {
      const code = error && error.code ? error.code : 'internal'
      const message = error && error.message ? error.message : String(error)
      log(`command catalog failed: session=${sessionId.value} ${code}: ${message}`)
      return { kind: 'error', code, message, requestType: 'commands', sessionId: sessionId.value }
    }
  }
  if (msg.type === 'command-options') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const command = typeof msg.command === 'string' && msg.command.trim() !== '' ? msg.command.trim() : null
    if (!command) return { kind: 'error', code: 'bad-request', message: 'command-options requires a command', requestType: 'command-options', sessionId: sessionId.value }
    return loadCommandOptions(api, command, sessionId.value)
  }
  if (msg.type === 'command-select') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const command = typeof msg.command === 'string' && msg.command.trim() !== '' ? msg.command.trim() : null
    const optionId = typeof msg.optionId === 'string' && msg.optionId !== '' ? msg.optionId : null
    if (!command || !optionId) return { kind: 'error', code: 'bad-request', message: 'command-select requires command and optionId', requestType: 'command-select', sessionId: sessionId.value }
    return selectCommandOption(api, host, command, sessionId.value, optionId)
  }
  if (msg.type === 'select-model') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const provider = typeof msg.provider === 'string' && msg.provider.trim() !== '' ? msg.provider.trim() : null
    const model = typeof msg.model === 'string' && msg.model.trim() !== '' ? msg.model.trim() : null
    if (!provider || !model) {
      return { kind: 'error', code: 'bad-request', message: 'select-model requires provider and model', requestType: 'select-model' }
    }
    const payload = { sessionId: sessionId.value, provider, model }
    if (typeof msg.reasoningEffort === 'string' && msg.reasoningEffort.trim() !== '') payload.reasoningEffort = msg.reasoningEffort.trim()
    return proxyQuery(api, 'select-model', api.sessions.selectModel.bind(api.sessions), payload)
  }
  if (msg.type === 'permission-options') {
    const [frame, catalog] = await Promise.all([
      proxyQuery(api, 'permission-options', api.settings.describe.bind(api.settings), {}),
      proxyQuery(api, 'permission-catalog', api.permissionPresets.catalog.bind(api.permissionPresets), {}),
    ])
    if (frame.kind !== 'permission-options') return frame
    if (catalog.kind === 'error') return catalog
    const out = {
      kind: 'permission-options',
      namespace: (frame.namespaces || []).find((n) => n.ns === 'permission') || null,
      options: catalog.options,
      defaultOptions: catalog.defaultOptions,
      defaultPreset: catalog.defaultPreset,
    }
    const sessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim() !== '' ? msg.sessionId.trim() : null
    if (sessionId) {
      out.sessionId = sessionId
      const hist = await querySessionProjection(api, msg.type, sessionId)
      if (hist.kind === 'error') return hist
      if (hist.kind === 'history' && hist.projections && hist.projections.values) {
        const current = hist.projections.values.permissions
        out.sessionPermissions = current ? { ...current, options: catalog.options } : null
      }
    }
    return out
  }
  if (msg.type === 'permission') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const name = typeof msg.name === 'string' && msg.name.trim() !== '' ? msg.name.trim() : null
    if (!name) {
      return { kind: 'error', code: 'bad-request', message: 'permission requires a name', requestType: 'permission' }
    }
    // Execute the /permission command through the Typert Remote gateway — the
    // same endpoint the browser calls (remote.commands.execute). This runs the
    // command registry handler WITHOUT sending anything to the model, and the
    // api-remotes agent lookup resumes cold sessions just like prompt does.
    try {
      // commands/execute 的当前 Typert descriptor 要求 images 字段始终存在；
      // 权限斜杠命令没有附件，因此显式传空数组。
      const execution = await host.commands.execute(
        sessionId.value,
        '/permission ' + name,
        [],
        new AbortController().signal,
      )
      if (execution === undefined || execution === null) {
        return { kind: 'error', code: 'unknown-command', message: 'command not found: /permission', requestType: 'permission', sessionId: sessionId.value }
      }
      log(`permission switched: session=${sessionId.value} preset=${name} (commandId=${execution.commandId})`)
      return {
        kind: 'permission',
        sessionId: sessionId.value,
        set: name,
        commandId: execution.commandId,
        result: execution.result,
      }
    } catch (error) {
      const code = error && error.code ? error.code : 'internal'
      const message = error && error.message ? error.message : String(error)
      log(`permission rejected: ${code}: ${message}`)
      return { kind: 'error', code, message, requestType: 'permission', sessionId: sessionId.value }
    }
  }
  if (msg.type === 'context-usage') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const hist = await querySessionProjection(api, msg.type, sessionId.value)
    if (hist.kind !== 'history') return hist
    const values = (hist.projections && hist.projections.values) || {}
    return {
      kind: 'context-usage',
      sessionId: sessionId.value,
      asOfSeq: hist.projections ? hist.projections.asOfSeq : undefined,
      tokenUsage: values.tokenUsage || null,
      contextPressure: values.contextPressure || null,
    }
  }
  if (msg.type === 'session-stats') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const hist = await querySessionProjection(api, msg.type, sessionId.value)
    if (hist.kind !== 'history') return hist
    const values = (hist.projections && hist.projections.values) || {}
    return {
      kind: 'session-stats',
      sessionId: sessionId.value,
      asOfSeq: hist.projections ? hist.projections.asOfSeq : undefined,
      sessionStats: values.sessionStats || null,
      tokenUsage: values.tokenUsage || null,
      contextPressure: values.contextPressure || null,
    }
  }
  if (msg.type === 'tasks' || msg.type === 'goal') {
    const target = parseSessionTarget(msg)
    if (target.error) return target.error
    const frame = await readSessionProjection(api, msg.type, target.value.sessionId,
      msg.type === 'tasks' ? 'todos' : 'goal', target.value)
    return { ...frame, ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}) }
  }
  if (msg.type === 'goal-edit') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const ref = requireGoalRef(msg, sessionId.value)
    if (ref.error) return ref.error
    const payload = { sessionId: sessionId.value, ref: ref.value }
    if (typeof msg.objective === 'string' && msg.objective.trim() !== '') payload.objective = msg.objective.trim()
    if (typeof msg.maxGoalRounds === 'number' && Number.isSafeInteger(msg.maxGoalRounds) && msg.maxGoalRounds > 0) {
      payload.maxGoalRounds = msg.maxGoalRounds
    }
    if (payload.objective === undefined && payload.maxGoalRounds === undefined) {
      return { kind: 'error', code: 'bad-request', message: 'goal-edit requires a non-empty objective or a positive maxGoalRounds', requestType: 'goal-edit', sessionId: sessionId.value }
    }
    return mutateGoal(api, 'goal-edit', 'edit', payload)
  }
  if (msg.type === 'goal-pause' || msg.type === 'goal-resume' || msg.type === 'goal-clear') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const ref = requireGoalRef(msg, sessionId.value)
    if (ref.error) return ref.error
    const method = msg.type === 'goal-pause' ? 'pause' : msg.type === 'goal-resume' ? 'resume' : 'clear'
    return mutateGoal(api, msg.type, method, { sessionId: sessionId.value, ref: ref.value })
  }
  if (SCHEDULE_REQUEST_TYPES.has(msg.type)) return handleScheduleQuery(api, msg)
  if (msg.type === 'agent-presets') {
    return proxyQuery(api, 'agent-presets', api.agentPresets.list.bind(api.agentPresets), {})
  }
  if (msg.type === 'defaults') {
    const [presets, catalog] = await Promise.all([
      proxyQuery(api, 'agent-presets', api.agentPresets.list.bind(api.agentPresets), {}),
      proxyQuery(api, 'permission-catalog', api.permissionPresets.catalog.bind(api.permissionPresets), {}),
    ])
    if (presets.kind === 'error') return presets
    if (catalog.kind === 'error') return catalog
    return {
      kind: 'defaults',
      agentPresetDefault: presets.presets?.find((preset) => preset.isDefault)?.id ?? null,
      permissionDefault: catalog.defaultPreset ?? null,
      permissionDefaultOptions: catalog.defaultOptions ?? [],
      // rc.2 removed this roster flag; only an explicit older-host false disables selection.
      modeSelectionEnabled: presets.modeSelectionEnabled !== false,
    }
  }
  if (msg.type === 'set-default') {
    const target = typeof msg.target === 'string' && msg.target.trim() !== '' ? msg.target.trim() : null
    const value = typeof msg.value === 'string' && msg.value.trim() !== '' ? msg.value.trim() : null
    if (target !== 'agent-preset' && target !== 'permission') {
      return { kind: 'error', code: 'bad-request', message: 'set-default target must be "agent-preset" or "permission"', requestType: 'set-default' }
    }
    if (!value) {
      return { kind: 'error', code: 'bad-request', message: 'set-default requires a value', requestType: 'set-default' }
    }
    const catalog = target === 'agent-preset'
      ? await proxyQuery(api, 'agent-presets', api.agentPresets.list.bind(api.agentPresets), {})
      : await proxyQuery(api, 'permission-catalog', api.permissionPresets.catalog.bind(api.permissionPresets), {})
    if (catalog.kind === 'error') return catalog
    if (target === 'agent-preset' && catalog.modeSelectionEnabled === false) {
      return { kind: 'error', code: 'mode-selection-disabled', message: 'Agent mode selection is disabled', requestType: 'set-default' }
    }
    const choices = target === 'agent-preset'
      ? catalog.presets?.filter((preset) => !preset.broken).map((preset) => preset.id)
      : catalog.defaultOptions?.map((option) => option.value)
    if (!choices?.includes(value)) {
      return { kind: 'error', code: 'bad-request', message: 'default value is not available', requestType: 'set-default' }
    }
    const ns = target === 'agent-preset' ? 'agent-preset-registry' : 'permission'
    const patch = target === 'agent-preset' ? { selectedDefault: value } : { defaultPreset: value }
    const updated = await proxyQuery(api, 'set-default', api.settings.update.bind(api.settings), { ns, patch })
    if (updated.kind !== 'set-default') return updated
    log(`default updated: ${ns}.${Object.keys(patch)[0]} = ${value}`)
    return { kind: 'set-default', target, value, applied: true, namespace: updated }
  }
  return null
}

// ---------------------------------------------------------------------------
// Device auth: a QR carries a short-lived one-time pairing code. Claiming it
// over WebSocket yields a long-lived bearer token exactly once. The registry
// stores only the token digest. Management endpoints are local-machine only by
// default and mutating requests also require a same-origin browser context.
// ---------------------------------------------------------------------------
function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function parseProtocols(req) {
  const value = req.headers['sec-websocket-protocol']
  if (typeof value !== 'string') return []
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

// T020/T023 (FR-004, FR-007): credentials travel only in handshake headers or
// `dsh-pair.`/`dsh-auth.` subprotocols. A pairing code or device token in the
// URL query is never accepted on any listener — not even a valid one — because
// proxies, access logs and browser history record query strings.
const QUERY_CREDENTIAL_PARAMS = Object.freeze(['pairingCode', 'token', 'code'])

/** Query-parameter names used for a credential in this upgrade request. */
function queryCredentialParams(req) {
  try {
    const query = new URL(req.url || '/', 'http://localhost').searchParams
    return QUERY_CREDENTIAL_PARAMS.filter((name) => {
      const value = query.get(name)
      return typeof value === 'string' && value !== ''
    })
  } catch {
    return []
  }
}

function extractCredential(req) {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(authorization.trim())
    if (match) return { kind: 'token', value: match[1] }
  }

  for (const protocol of parseProtocols(req)) {
    if (protocol.startsWith('dsh-auth.')) return { kind: 'token', value: protocol.slice('dsh-auth.'.length) }
    if (protocol.startsWith('dsh-pair.')) return { kind: 'pairing', value: protocol.slice('dsh-pair.'.length) }
  }
  return undefined
}

const CLIENT_DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/
// A raw subprotocol must also be a valid RFC 6455 token. In particular, ':'
// is valid in the header form but cannot be constructed by browser clients.
const CLIENT_DEVICE_ID_SUBPROTOCOL_PATTERN = /^[A-Za-z0-9._-]{8,128}$/
const MAX_ENCODED_DEVICE_NAME_LENGTH = 512

// Contract §1: every companion request carries a `requestId` bounded to 64
// characters from a safe charset. One pattern, checked in one place, so no
// dispatch branch can serve an operation that skipped it.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
// Contract §1: a refusal echoes a `requestId` only when it is a well-formed id.
// Reflecting an out-of-bounds value (control characters, >64 chars, Unicode)
// cannot be attributed by the client and is itself a framing defect — so every
// refusal on the companion path takes its echo from this ONE predicate, and a
// branch cannot drift back to a bare `typeof === 'string'` check.
const requestIdEcho = (msg) => (typeof msg?.requestId === 'string' && REQUEST_ID_PATTERN.test(msg.requestId)
  ? { requestId: msg.requestId }
  : {})
// Bound on concurrently outstanding requestIds per socket: the duplicate rule
// must never turn into an unbounded set.
const MAX_INFLIGHT_REQUEST_IDS = 256
// Contract §3.6 + §5a: the client is ready only after the `client-hello`
// exchange. `client-hello` itself and the keep-alive may run before it; every
// other operation waits.
const PRE_NEGOTIATION_TYPES = new Set(['client-hello', 'ping'])

function extractClientDeviceId(req) {
  const header = req.headers['x-dsh-device-id']
  if (typeof header === 'string') {
    const normalized = header.trim()
    if (CLIENT_DEVICE_ID_PATTERN.test(normalized)) return normalized
  }
  // 浏览器等客户端无法设置自定义握手头，而子协议是浏览器唯一能自定义的握手元数据。
  // 让这类客户端把同一安装级设备 ID 放进 `dsh-device.<id>` 子协议即可完成配对。
  // 设备 ID 不是凭证：配对仍需要一次性配对码，长期 token 仍由 claimPairing() 签发。
  for (const protocol of parseProtocols(req)) {
    if (!protocol.startsWith('dsh-device.')) continue
    const normalized = protocol.slice('dsh-device.'.length).trim()
    if (CLIENT_DEVICE_ID_SUBPROTOCOL_PATTERN.test(normalized)) return normalized
  }
  return undefined
}

function extractClientDeviceName(req) {
  const value = req.headers['x-dsh-device-name']
  if (typeof value === 'string' && value.length <= MAX_ENCODED_DEVICE_NAME_LENGTH && /^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    const name = Buffer.from(value, 'base64').toString('utf8').trim()
    if (name && !/[\u0000-\u001f\u007f\ufffd]/.test(name)) return name.slice(0, 80)
  }
  // 浏览器无法设置 X-DSH-Device-Name 请求头，可把设备名（UTF-8 的 Base64URL）放进
  // `dsh-device-name.<value>` 子协议；设备名只用于展示，不参与鉴权。
  for (const protocol of parseProtocols(req)) {
    if (!protocol.startsWith('dsh-device-name.')) continue
    const encoded = protocol.slice('dsh-device-name.'.length)
    if (encoded.length > MAX_ENCODED_DEVICE_NAME_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) continue
    const name = Buffer.from(encoded, 'base64url').toString('utf8').trim()
    if (name && !/[\u0000-\u001f\u007f\ufffd]/.test(name)) return name.slice(0, 80)
  }
  return undefined
}

/**
 * Spec 005 FR5: a native companion sends no Origin and is allowed; any Origin
 * present must be in `allowedOrigins` (empty by default), otherwise the upgrade
 * is refused before the WebSocket handshake.
 */
function originAllowed(req, allowedOrigins) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  return allowedOrigins.includes(origin)
}

function rejectUpgrade(socket, status, message, probe) {
  const reason = 'Unauthorized'
  socket.write(`HTTP/1.1 ${status} ${reason}\r\n${gatewayProbeHeader(probe)}Connection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`)
  socket.destroy()
}

function privateLanAddresses() {
  const physical = []
  const fallback = []
  const virtualInterface = /^(?:docker|br-|veth|utun|awdl|llw|vmnet|vbox|virbr|tailscale|wg)/i
  for (const [name, records] of Object.entries(os.networkInterfaces())) {
    for (const record of records || []) {
      if (!record || record.internal || record.family !== 'IPv4' || !isPrivateNetworkHostname(record.address)) continue
      const target = virtualInterface.test(name) ? fallback : physical
      if (!target.includes(record.address)) target.push(record.address)
    }
  }
  return physical.length ? physical : fallback
}

// The listen targets the Devices page may pick (POST /mgw/listen).
const LISTEN_TARGETS = ['loopback', 'lan', 'tailscale']

/**
 * Resolve a Devices-page listen target to the one address the TLS listener
 * should bind, or `null` when this machine has no address for it. The interface
 * table is a parameter, not a lookup: the status report and the bind must agree
 * on which addresses exist, and a test injects its own table.
 * @param {string} target one of LISTEN_TARGETS
 * @param {object} interfaces an `os.networkInterfaces()` shaped table
 * @returns {string|null} the address to bind
 */
function resolveListenHost(target, interfaces) {
  if (target === 'loopback') return '127.0.0.1'
  if (target === 'tailscale') {
    // Reuse the detection the status reports, so a bound address always appears
    // in `status.tailscale.addresses`. IPv4 first: the companion reaches the
    // tailnet over IPv4, and the helper already sorts 100.64/10 ahead of fd7a:.
    const { addresses } = tailscaleInterfaceStatus({ listening: false, host: '', port: 0, wsPath: '' }, interfaces)
    return addresses.find((address) => net.isIP(address) === 4) ?? addresses[0] ?? null
  }
  if (target !== 'lan') return null
  // Interface order is the preference order — that is the order Node reports, so
  // it is the order this machine's routes are likely to prefer. A Tailscale
  // address is not a LAN address (it has its own target), and a link-local
  // 169.254 address only answers when nothing routable exists.
  const linkLocal = []
  for (const records of Object.values(interfaces || {})) {
    for (const record of records || []) {
      if (!record || record.internal || record.family !== 'IPv4' || net.isIP(record.address) !== 4) continue
      if (!isPrivateNetworkHostname(record.address) || isTailscaleIp(record.address)) continue
      if (record.address.startsWith('169.254.')) {
        if (!linkLocal.includes(record.address)) linkLocal.push(record.address)
        continue
      }
      return record.address
    }
  }
  return linkLocal[0] ?? null
}

function lanWebSocketUrls(options, wsPath, boundPort) {
  if (!options.lanEnabled) return []
  const advertised = typeof options.lanAdvertiseHost === 'string' ? options.lanAdvertiseHost.trim() : ''
  const hosts = advertised
    ? [advertised]
    : options.lanHost && options.lanHost !== '0.0.0.0' && options.lanHost !== '::'
      ? [options.lanHost]
      : privateLanAddresses()
  return hosts
    .filter((host) => isPrivateNetworkHostname(host))
    // T018 (FR-003): the plugin-owned listener is TLS only; there is no `ws://`
    // remote endpoint to advertise inside or outside the LAN.
    .map((host) => `wss://${host.includes(':') ? `[${host}]` : host}:${boundPort}${wsPath}`)
}

/** Hostnames/IPs the TLS certificate must cover: what either listener advertises. */
function tlsAdvertisedHosts(options, wsPath) {
  const hosts = new Set(['localhost', '127.0.0.1'])
  if (options.lanEnabled === true) {
    for (const url of lanWebSocketUrls(options, wsPath, options.lanPort || 30081)) {
      try { hosts.add(new URL(url).hostname.replace(/^\[|\]$/g, '')) } catch { /* ignore */ }
    }
  }
  const advertised = typeof options.lanAdvertiseHost === 'string' ? options.lanAdvertiseHost.trim() : ''
  if (advertised && isPrivateNetworkHostname(advertised)) hosts.add(advertised.replace(/^\[|\]$/g, ''))
  for (const endpoint of Array.isArray(options.endpoints) ? options.endpoints : []) {
    try {
      const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '')
      const numeric = net.isIP(host) !== 0
      if (numeric || isPrivateNetworkHostname(host)) hosts.add(host)
    } catch { /* invalid endpoints are rejected later */ }
  }
  return [...hosts]
}

const LOOPBACK_LISTEN_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

// T017 (FR-001): a non-loopback bind needs the owner's explicit `lanHost` and
// is TLS by construction (the listener is https). The helper is exported logic
// used by the status report and by the start-up validation.
function isLoopbackListenHost(host) {
  return LOOPBACK_LISTEN_HOSTS.has(String(host ?? '').toLowerCase())
}

// An unspecified address is never a listen address: binding it opens every
// adapter at once, which is the opposite of "nothing listens beyond 127.0.0.1
// unless the owner enables it" (A4).
const UNSPECIFIED_LISTEN_HOSTS = new Set(['0.0.0.0', '::'])

/**
 * The ONE rule for an address this plugin may bind or keep: loopback, or a
 * private LAN/Tailscale address. The route, the start-up re-adoption of the
 * saved choice, and a test-only bind alias all use it (Should-fix 4, review
 * 2026-11-10). Start-up used to accept any IP literal, so an owned PUBLIC
 * address was re-adopted on the next start even though this route would never
 * have chosen it.
 * @param {unknown} host the candidate listen host
 * @returns {boolean} true only for loopback and private LAN/Tailscale addresses
 */
function isBindableListenHost(host) {
  if (typeof host !== 'string') return false
  const value = host.trim().replace(/^\[|\]$/g, '')
  if (!value || UNSPECIFIED_LISTEN_HOSTS.has(value.toLowerCase())) return false
  return isLoopbackListenHost(value) || isPrivateNetworkHostname(value)
}

function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

// Refusal caused by the owner switch being off (T013). `code` is the stable
// contract string; `status` drives the HTTP answer (403 per the contract).
function remoteDisabledError(message = 'remote control is disabled by the owner') {
  const error = new Error(message)
  error.status = REMOTE_DISABLED_STATUS
  error.code = REMOTE_DISABLED
  return error
}

function normalizePublicUrl(value, req, wsPath) {
  let raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    const host = req.headers.host || `127.0.0.1`
    // FR-003: the plugin never offers a plaintext remote endpoint. Even the
    // fallback for a loopback request names the TLS listener.
    raw = `wss://${host}${wsPath}`
  }
  let url
  try { url = new URL(raw) } catch { throw badRequest('invalid WebSocket endpoint URL') }
  // A caller may hand us an http(s) spelling of the same TLS listener; every
  // emitted endpoint is `wss://` (contract §2, T018).
  if (url.protocol === 'https:' || url.protocol === 'http:') url.protocol = 'wss:'
  if (url.protocol !== 'wss:') throw badRequest('publicUrl must use wss://; plaintext ws:// is not a remote endpoint (FR-003)')
  if (url.username || url.password || url.search || url.hash) throw badRequest('publicUrl must not contain credentials, query parameters, or a fragment')
  if (['0.0.0.0', '[::]', '::'].includes(url.hostname)) throw badRequest('endpoint must not use an unspecified listen address')
  return url.toString()
}

function isSameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string' || typeof req.headers.host !== 'string') return false
  try {
    return new URL(origin).host === req.headers.host
  } catch (error) {
    return false
  }
}

// The authorities a loopback management request may name. The list is closed on
// purpose: exactly `127.0.0.1`, `localhost` and `[::1]`, each with an optional
// port. Deliberately NOT accepted, although a resolver may treat them as local:
// the trailing-dot `localhost.`, any other 127/8 address (`127.0.0.2`), the
// abbreviated `127.1`, and the IPv4-mapped `::ffff:127.0.0.1`. A suffix or
// loopback-range test would take all of them, so there is none here.
const TRUSTED_LOCAL_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i

/**
 * DNS-rebinding guard for the write that moves a remote surface (Blocker 1,
 * review 2026-11-10). `isSameOrigin` above compares two caller-supplied headers,
 * so a page served from `attacker.example` that resolves to 127.0.0.1 reaches
 * this listener with `Host`/`Origin` that agree with each other and passes it —
 * and a missing Origin is allowed outright. Requiring a Host header that names
 * THIS machine's loopback authority, plus an Origin that matches it exactly over
 * http(s), leaves no name under an attacker's control able to reach this route.
 *
 * The canonical accepted authorities are exactly `127.0.0.1`, `localhost` and
 * `[::1]`, each with an optional port (see TRUSTED_LOCAL_AUTHORITY above).
 * `localhost.`, other 127/8 addresses, `127.1` and `::ffff:127.0.0.1` are refused
 * on purpose; do not widen this into a permissive suffix check.
 * @param {object} req the management request
 * @throws {Error} 403 when the Host/Origin pair is not this machine's loopback
 */
function assertTrustedLocalAuthority(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim() : ''
  if (!TRUSTED_LOCAL_AUTHORITY.test(host)) {
    const error = new Error('listen address changes require a Host header naming this machine (127.0.0.1, localhost or [::1])')
    error.status = 403
    error.code = 'forbidden'
    throw error
  }
  const origin = req.headers.origin
  if (origin === undefined) return
  let url = null
  try { url = new URL(String(origin)) } catch { url = null }
  // `URL.host` keeps the port: the same loopback name on another port is still
  // a different (cross-origin) caller.
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.host !== host) {
    const error = new Error('listen address changes require an Origin that matches the Host header over http(s)')
    error.status = 403
    error.code = 'forbidden'
    throw error
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let bytes = 0
    let oversized = false
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_MANAGEMENT_BODY_BYTES) oversized = true
      else data += chunk
    })
    req.on('end', () => {
      if (oversized) {
        const error = new Error('request body is too large')
        error.status = 413
        reject(error)
        return
      }
      try {
        const body = data === '' ? {} : JSON.parse(data)
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('expected an object')
        resolve(body)
      } catch (cause) {
        const error = new Error('request body must be a JSON object', { cause })
        error.status = 400
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { ...securityHeaders('application/json; charset=utf-8'), 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * The Host's `typertGateway`, resolved late and without a hard dependency.
 *
 * `ctx.typertGateway` is only populated for a plugin that declares it in
 * `inject`; the gateway deliberately injects a narrow set, so the property is
 * `undefined` here and a remote `session/list` used to fail with
 * "Cannot read properties of null (reading 'dispatchRpc')" (measured on
 * 0.2.2-rc.1, spec 008 live run). `ctx.get(name, false)` reads a service the
 * plugin did not inject, which is how `plugins/devices` reaches the same object.
 * @param {object} ctx the plugin context
 * @returns {object|undefined} the carrier, or undefined when this Host has none
 */
function resolveHostGateway(ctx) {
  if (ctx.typertGateway) return ctx.typertGateway
  if (typeof ctx.get === 'function') {
    const service = ctx.get('typertGateway', false)
    if (service) return service
  }
  return undefined
}

/**
 * Test seams: the interface table and the bind aliases a test harness injects.
 *
 * They are NOT plugin configuration (Blocker 2, review 2026-11-10): `apply()`
 * spreads the profile config into `options`, so a config key named
 * `testListenAliases` used to become one — a measured
 * `{ '127.0.0.1': '0.0.0.0' }` bound the wildcard while the status still said
 * 127.0.0.1. Only `createMobileGatewayPlugin()` below accepts seams; a config
 * file, the bundle and the schema cannot reach it.
 *
 * There is no module state either (Blocker, round 2, review 2026-11-10): the old
 * `configureTestSeams()` kept the caller's objects by reference and `apply()`
 * only shallow-snapshotted them, so a second instance in the same process
 * inherited the previous harness's seams and an alias validated as loopback
 * could be mutated to `0.0.0.0` afterwards and bind the wildcard with no
 * revalidation. A seam value is now copied into fresh frozen plain data per
 * instance, and the alias `bindHost()` really uses is checked again at bind time.
 *
 *  - `networkInterfaces`: the `os.networkInterfaces()` shaped table the `lan` and
 *    `tailscale` targets resolve against, so a test does not depend on this
 *    machine's adapters (the status reports the same table).
 *  - `listenAliases`: `{ '<resolved host>': '<address the OS can bind>' }`. A test
 *    cannot add an adapter and `listen()` refuses a foreign address with
 *    EADDRNOTAVAIL, so the logical host keeps its name in the status while the
 *    socket binds the aliased one. A target must itself be a bindable listen
 *    address, so an alias can never map a loopback bind onto 0.0.0.0, :: or a
 *    public address.
 */
const NO_TEST_SEAMS = Object.freeze({ networkInterfaces: null, listenAliases: Object.freeze({}) })

// A frozen plain-data copy. The caller keeps ownership of its objects and may
// change them freely: nothing it does after this point is read by a bind.
function freezeSeamCopy(value, seen = new Set()) {
  // A function is neither `null` nor `'object'`, so it would fall through the
  // scalar branch below and survive by reference: reject it like a cycle rather
  // than let the "plain-data copy" contract quietly not hold.
  if (typeof value === 'function') throw new Error('mobile-gateway: a test seam must be plain data, not a function')
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) throw new Error('mobile-gateway: a test seam must not contain a cycle')
  seen.add(value)
  const copy = Array.isArray(value) ? [] : {}
  for (const key of Object.keys(value)) {
    // `defineProperty` rather than assignment, so a `__proto__` key from a caller
    // stays a plain key and cannot re-parent the copy.
    Object.defineProperty(copy, key, { value: freezeSeamCopy(value[key], seen), enumerable: true, writable: true, configurable: true })
  }
  seen.delete(value)
  return Object.freeze(copy)
}

/**
 * Seal a seam object into this instance's own frozen, validated copy.
 * @param {object|undefined} seams the harness's seam object, or nothing
 * @returns {{networkInterfaces: object|null, listenAliases: object}} frozen data
 * @throws {Error} when an alias names an address this plugin must not bind
 */
function sealTestSeams(seams) {
  if (!seams || typeof seams !== 'object' || seams === NO_TEST_SEAMS) return NO_TEST_SEAMS
  const networkInterfaces = seams.networkInterfaces && typeof seams.networkInterfaces === 'object'
    ? freezeSeamCopy(seams.networkInterfaces)
    : null
  const listenAliases = seams.listenAliases && typeof seams.listenAliases === 'object'
    ? freezeSeamCopy(seams.listenAliases)
    : Object.freeze({})
  // A bind alias is a seam, not a permission: it may only point at an address
  // this plugin would bind itself, so it can never turn a loopback bind into a
  // wildcard or a public one. Validated here AND again at bind time.
  for (const [from, to] of Object.entries(listenAliases)) {
    if (typeof to !== 'string' || !isBindableListenHost(to)) {
      throw new Error(`mobile-gateway: test listen alias ${from} -> ${String(to)} must be a loopback or private address`)
    }
  }
  return Object.freeze({ networkInterfaces, listenAliases })
}

const plugin = {
  name: 'mobile-gateway',
  Config,
  // Hard dependencies: the gateway registers on the host web server and
  // admits mobile messages through the Host Remote Gateway. Cordis must not
  // activate this row before either service exists.
  // T022a: `remoteAccess` is a hard dependency too — a paired device runs as a
  // non-owner Peer and DSH must be able to evaluate the policy. Without it the
  // plugin does not activate (fail closed), it never falls back to owner Peers.
  inject: ['webServer', 'typertGateway', 'connection', 'agentDefaultModel', 'remoteAccess'],
  // exported for local tests; Cordis ignores unknown plugin fields
  // The owner switch resolver: precedence of `remoteControl.enabled` over the
  // legacy `gatewayEnabled` alias lives in lib/remote-control.mjs; exported here
  // so tests exercise exactly the function apply() uses.
  remoteControlEnabled: resolveRemoteControl,
  admitMessage,
  handleQuery,
  // `testSeams` is the test-only third argument (Blocker, round 2): production
  // Cordis calls `apply(ctx, config)` and gets NO_TEST_SEAMS, while
  // `createMobileGatewayPlugin()` passes this instance's sealed copy.
  async apply(ctx, config, testSeams = NO_TEST_SEAMS) {
    const webServer = ctx.webServer
    if (typeof ctx.connection?.createPeer !== 'function') {
      throw new Error('mobile-gateway requires DSH 0.2.1-rc.2 or later with Connection.createPeer')
    }
    // 已配对设备沿用本机用户权限；身份只由 Host 创建，不能由移动端参数指定。
    // 问答与审批仍由本插件的 Host 监听器处理，无需另开 Remote 交互流。
    // T022a: DSH `remoteAccess.decide()` only evaluates non-owner Peers, so a
    // paired device must NOT run as the owner Peer. This shared owner Peer is
    // kept ONLY for the plugin's own internals (the loopback admin channel, the
    // owner-internal `workspace/follow` + `session/control` background streams,
    // and the spec 008 bridge); a device connection never receives it.
    const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
    const api = createDshHostAdapter(ctx.typertGateway, peer, ctx.connection)
    // T022a: a device connection gets its own non-owner Peer + adapter, built in
    // `startBusinessConnection`'s activation (see `deviceAccess` below). The
    // exact visible session ids come from the owner `api`, refreshed on session
    // changes, because DSH bindings cannot express a wildcard.
    let visibleSessionIds = []
    // Ids removed since the last ACCEPTED snapshot started (reviewer 36d9 #2): an
    // older in-flight `session/list` must not bring back a session the Host just
    // removed. Cleared when a refresh that began after the removal is accepted.
    const removedSessionIds = new Set()
    const deviceAccess = createDeviceAccess({
      ctx,
      getDevice: (deviceId) => registry.get(deviceId),
      getVisibleSessionIds: () => visibleSessionIds,
      log,
    })
    const host = api
    const agentDefaultModel = ctx.agentDefaultModel
    const options = {
      path: DEFAULT_WS_PATH,
      gatewayEnabled: false,
      remoteControl: { enabled: false },
      gatewayStateFile: '',
      gatewayName: '',
      endpoints: [],
      gatewayWaitTimeoutMs: DEFAULT_GATEWAY_WAIT_TIMEOUT_MS,
      maxPayloadBytes: DEFAULT_MAX_WS_PAYLOAD_BYTES,
      fileDownloadsEnabled: true,
      fileDownloadMaxBytes: DEFAULT_FILE_DOWNLOAD_MAX_BYTES,
      fileDownloadChunkBytes: DEFAULT_FILE_DOWNLOAD_CHUNK_BYTES,
      fileDownloadIdleMs: DEFAULT_FILE_DOWNLOAD_IDLE_MS,
      fileDownloadMaxTransfers: DEFAULT_FILE_DOWNLOAD_MAX_TRANSFERS,
      ...FILE_UPLOAD_DEFAULTS,
      adminLoopbackOnly: true,
      requireHostApproval: true,
      publicUrl: '',
      deviceFile: '',
      pairingTtlMs: DEFAULT_PAIRING_TTL_MS,
      lanEnabled: false,
      lanHost: '127.0.0.1',
      lanPort: 30081,
      tlsCertificateDir: '',
    // Test-only override (never set by the bundle): `true` serves admin-only
    // request types to the loopback listener as the owner's own web server has
    // always been able to. A device token never gets them (T022).
    legacyAdmin: false,
    // Test-only override (never set by the bundle): a function returning a
    // promise makes activation of a business connection wait for it, so a test
    // can land a re-pair or a revocation between authentication and activation
    // (T9, delayed activation).
    testActivationHold: null,
      lanAdvertiseHost: '',
      ...(config || {}),
    }
    // Blocker 2 (review 2026-11-10): `...(config || {})` spreads the profile
    // config, so a config key named after a test seam used to BECOME one. Seams
    // arrive only as the `apply()` argument, are sealed into this instance's own
    // frozen copy, and deleting the keys keeps them out of `options` for every
    // later reader too.
    delete options.testNetworkInterfaces
    delete options.testListenAliases
    const testSeamsInForce = sealTestSeams(testSeams)
    // Contract §2: a programmatic caller reaches apply() without the schema, so
    // the resolved TTL is clamped here too; `/mgw/status` and the registry then
    // agree on the value that is actually in force.
    options.pairingTtlMs = clampPairingTtlMs(options.pairingTtlMs)
    // One interface table for the whole plugin run: the listen targets, the
    // status report and the saved-address check must all agree on what this
    // machine has. A sealed test table replaces the real one.
    const interfaces = () => testSeamsInForce.networkInterfaces || os.networkInterfaces()
    const wsPath = options.path
    if (typeof wsPath !== 'string' || !wsPath.startsWith('/') || wsPath.endsWith('/') || wsPath.includes('?') || wsPath.includes('#')) {
      throw new Error('mobile-gateway: path must be an absolute pathname without a trailing slash, query, or fragment')
    }
    if (options.lanEnabled === true && (typeof options.lanHost !== 'string' || !options.lanHost.trim())) {
      throw new Error('mobile-gateway: lanHost must be a non-empty listen address')
    }
    if (options.lanEnabled === true && options.lanHost && !isLoopbackListenHost(options.lanHost)
        && !isPrivateNetworkHostname(options.lanHost) && net.isIP(options.lanHost) === 0) {
      throw new Error('mobile-gateway: lanHost must be loopback, a private LAN/Tailscale address, or an IP literal')
    }
    if (options.lanEnabled === true && options.lanAdvertiseHost && !isPrivateNetworkHostname(options.lanAdvertiseHost)) {
      throw new Error('mobile-gateway: lanAdvertiseHost must be localhost, a private LAN or Tailscale address')
    }
    // T011: the owner switch, resolved from the RAW config, before defaults are
    // merged below. Precedence (lib/remote-control.mjs): an explicit
    // `remoteControl.enabled` wins, otherwise the legacy `gatewayEnabled` alias
    // decides. Resolving after the merge would be wrong — the injected default
    // `remoteControl: { enabled: false }` would look "explicitly set" and the
    // alias could never turn the gateway on.
    const remoteControlConfigured = !!(config && config.remoteControl && typeof config.remoteControl === 'object'
      && config.remoteControl.enabled !== undefined)
    const remoteControlRequested = resolveRemoteControl(config || {})
    // T023 (FR-007): authentication is permanent — no route and no code path
    // serves an unauthenticated companion. `/mgw/status` still reports
    // `requireAuth: true` for the admin UI, which no longer offers a toggle.
    const adminLoopbackOnly = options.adminLoopbackOnly !== false
    const deviceFile = options.deviceFile || path.join(os.homedir(), '.dsh', 'mobile-gateway-devices.json')
    if (options.gatewayMode !== undefined && !GATEWAY_MODES.includes(options.gatewayMode)) throw new Error('invalid gatewayMode')
    if (typeof options.gatewayName !== 'string' || options.gatewayName.trim().length > 80) throw new Error('gatewayName must be at most 80 characters')
    const normalizeEndpoints = (values) => {
      // An empty list (the default, and what a QR without explicit endpoints
      // carries) is valid; only a present-but-malformed list is refused.
      if (Array.isArray(values) && values.length === 0) return []
      if (!Array.isArray(values) || values.length > 16 || values.some((value) => typeof value !== 'string' || !value.trim() || value.length > 2048)) {
        throw badRequest('endpoints must be an array of at most 16 nonempty URLs (2048 characters each)')
      }
      return [...new Set(values.map((value) => normalizePublicUrl(value, { headers: {} }, wsPath)))]
    }
    const configuredEndpoints = normalizeEndpoints(options.endpoints)
    const gatewayState = createGatewayState(options.gatewayStateFile || `${deviceFile}.gateway.json`)
    // A listen address picked on the Devices page outlives the process, exactly
    // like the saved gateway mode; the configured `lanHost` is the fallback.
    // A stale pick is dropped instead of leaving the TLS listener without an
    // address to bind — a laptop that moved networks no longer owns it, and
    // binding it would fail with EADDRNOTAVAIL on every start.
    //
    // The address rule is the route's own (Should-fix 4): an owned PUBLIC or
    // unspecified address is not re-adopted, because this route would never
    // choose one and the status would then advertise a surface the owner cannot
    // get back to from the Devices page.
    const savedListenHost = gatewayState.listenHost
    if (savedListenHost) {
      const owned = isLoopbackListenHost(savedListenHost)
        || Object.values(interfaces()).some((records) => (records || []).some((record) => record && record.address === savedListenHost))
      if (owned && isBindableListenHost(savedListenHost)) {
        options.lanHost = savedListenHost
      } else {
        log(`saved listen address ${savedListenHost} is not a loopback/private address this machine owns; keeping ${options.lanHost}`)
      }
    }
    let transportSettings = normalizeTransportConfig({ ...TRANSPORT_DEFAULTS, ...options.webrtc, ...gatewayState.webrtc,
      ...(gatewayState.webrtc?.stunServers !== undefined ? { stunServers: managedStunServers(gatewayState.webrtc.stunServers) } : {}),
    })
    let pairingRoute = gatewayState.pairingRoute ??
      (transportSettings.enabled && transportSettings.mode !== 'ws-only' ? 'p2p' : 'lan')
    const gatewayIdentity = { gatewayId: gatewayState.gatewayId, gatewayName: options.gatewayName.trim() || os.hostname().slice(0, 80) }
    const registry = createRegistry(deviceFile, { pairingTtlMs: options.pairingTtlMs })
    const allowedOrigins = [...new Set((Array.isArray(options.allowedOrigins) ? options.allowedOrigins : [])
      .map((origin) => typeof origin === 'string' ? origin.trim() : '')
      .filter(Boolean))]
    // T016 (R1): the Host certificate. Created on first use in the plugin data
    // directory; replaced only by the owner's explicit regenerate action.
    const tlsDirectory = options.tlsCertificateDir || path.join(path.dirname(deviceFile), 'mobile-gateway-tls')
    let tlsIdentity = await loadOrCreateTlsIdentity({ directory: tlsDirectory, advertised: tlsAdvertisedHosts(options, wsPath), log })
    if (!tlsIdentity) throw new Error('mobile-gateway: the TLS identity could not be loaded')
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayloadBytes,
      // Authentication data may ride in requested subprotocols, but a secret
      // must never be echoed as the negotiated protocol.
      handleProtocols(protocols) {
        return protocols.has('dsh-mobile-v1') ? 'dsh-mobile-v1' : false
      },
    })
    const clients = new Set()
    const networkDiagnostics = createNetworkDiagnostics({ clients, devices: () => registry.list() })
    const pluginInstallOwners = new Map()
    const pendingQuestions = new Map()
    const pendingApprovals = new Map()
    // Raw `tool/call` argument strings for approval content binding (FR-008,
    // research V1). The Host emits `tool/call` before the approval pipeline for a
    // batch that has a log, but the two events reach the plugin on different
    // streams, so neither order is guaranteed. Bounded by count, age and total
    // characters: a long Host session must not grow this map without limit, and a
    // stale entry is useless because the approval for it already happened.
    //
    // Keyed by (sessionId, callId), not by callId alone: a callId is only unique
    // inside one session, so two sessions that happen to use the same one would
    // otherwise exchange argument strings and the phone could be asked to approve
    // — and bind its hash to — content from another session.
    const toolCallArguments = new Map()
    const toolCallWaiters = new Map()
    // In-flight joins, cancelled on disposal: a teardown must not leave a timer
    // or a waiter behind that wakes up later and registers a card nobody can answer.
    const joinCancellers = new Set()
    let toolCallChars = 0
    let toolCallCount = 0
    let toolCallSeq = 0
    let disposed = false

    const forgetToolCall = (sessionId, entry) => {
      toolCallChars -= entry.rawArguments.length
      toolCallCount -= 1
      const calls = toolCallArguments.get(sessionId)
      if (calls === undefined) return
      for (const [callId, candidate] of calls) {
        if (candidate !== entry) continue
        calls.delete(callId)
        break
      }
      if (calls.size === 0) toolCallArguments.delete(sessionId)
    }

    // Oldest insertion first (FIFO), across sessions: one bound for the whole map
    // rather than one per session, so a burst of sessions cannot multiply it.
    const oldestToolCall = () => {
      let oldest = null
      for (const [sessionId, calls] of toolCallArguments) {
        for (const entry of calls.values()) {
          if (oldest === null || entry.seq < oldest.entry.seq) oldest = { sessionId, entry }
        }
      }
      return oldest
    }

    const pruneToolCalls = (now) => {
      for (const [sessionId, calls] of toolCallArguments) {
        for (const [callId, entry] of calls) {
          if (now - entry.at > APPROVAL_TOOL_CALL_TTL_MS) {
            toolCallChars -= entry.rawArguments.length
            toolCallCount -= 1
            calls.delete(callId)
          }
        }
        if (calls.size === 0) toolCallArguments.delete(sessionId)
      }
      while (toolCallCount > APPROVAL_TOOL_CALL_LIMIT
        || toolCallChars > APPROVAL_TOOL_CALL_MAX_TOTAL_CHARS) {
        const oldest = oldestToolCall()
        if (oldest === null) break
        forgetToolCall(oldest.sessionId, oldest.entry)
      }
    }

    const rememberToolCall = (sessionId, callId, name, rawArguments) => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (typeof callId !== 'string' || callId === '' || typeof rawArguments !== 'string') return
      const calls = toolCallArguments.get(sessionId)
      const previous = calls === undefined ? undefined : calls.get(callId)
      // Content that cannot fit the whole budget is never cached: evicting every
      // other binding to make room would turn one huge call into a wave of
      // desktop-only approvals. Its own approval is desktop-only instead, and a
      // stale entry for the same callId must not bind old content later.
      if (rawArguments.length > APPROVAL_TOOL_CALL_MAX_TOTAL_CHARS) {
        if (previous !== undefined) forgetToolCall(sessionId, previous)
        return
      }
      if (previous !== undefined) forgetToolCall(sessionId, previous)
      // Re-read: dropping the last entry of a session drops the whole session
      // map, and writing into that orphan would lose the refreshed content.
      let target = toolCallArguments.get(sessionId)
      if (target === undefined) {
        target = new Map()
        toolCallArguments.set(sessionId, target)
      }
      // Re-insert so refreshed content becomes the newest entry. Keeping the old
      // position would let the prune below evict the very call a waiter is about
      // to be woken for, turning a bindable approval desktop-only.
      target.set(callId, {
        // `null` when the Host event carried no name; a request then still binds.
        name: typeof name === 'string' && name !== '' ? name : null,
        rawArguments,
        at: Date.now(),
        seq: ++toolCallSeq,
      })
      toolCallChars += rawArguments.length
      toolCallCount += 1
      pruneToolCalls(Date.now())
      const waiters = toolCallWaiters.get(sessionId)
      const waiting = waiters === undefined ? undefined : waiters.get(callId)
      if (waiting === undefined) return
      waiters.delete(callId)
      if (waiters.size === 0) toolCallWaiters.delete(sessionId)
      for (const wake of waiting) wake()
    }

    const toolCallArgumentsFor = (sessionId, callId, toolName) => {
      const calls = toolCallArguments.get(sessionId)
      const entry = calls === undefined ? undefined : calls.get(callId)
      if (entry === undefined) return null
      if (Date.now() - entry.at > APPROVAL_TOOL_CALL_TTL_MS) {
        forgetToolCall(sessionId, entry)
        return null
      }
      // The hash binds (toolName, callId, arguments). When the Host published the
      // tool name with `tool/call`, it must be the very tool being approved: a
      // different name means the join found someone else's call, so the content
      // stays unbound and the desktop decides.
      if (entry.name !== null && entry.name !== toolName) return null
      return entry.rawArguments
    }

    // Resolves with the cached raw arguments or, when `approval/request` wins the
    // race by at most APPROVAL_TOOL_CALL_WAIT_MS, with the `tool/call` that lands
    // in between; `null` means the content cannot be bound (contract §5). The wait
    // is cancellable: an aborted request or a plugin disposal resolves it at once
    // instead of letting the handler wake up later into a gateway that may already
    // be switched off or torn down.
    const waitForToolCallArguments = (sessionId, callId, toolName, signal) => {
      const cached = toolCallArgumentsFor(sessionId, callId, toolName)
      if (cached !== null) return Promise.resolve(cached)
      if (disposed || signal?.aborted) return Promise.resolve(null)
      return new Promise((resolve) => {
        let settled = false
        let timer = null
        const finish = (value) => {
          if (settled) return
          settled = true
          if (timer !== null) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          joinCancellers.delete(onDisposed)
          const waiters = toolCallWaiters.get(sessionId)
          const waiting = waiters === undefined ? undefined : waiters.get(callId)
          if (waiting !== undefined) {
            waiting.delete(wake)
            if (waiting.size === 0) waiters.delete(callId)
            if (waiters.size === 0) toolCallWaiters.delete(sessionId)
          }
          resolve(value)
        }
        const wake = () => finish(toolCallArgumentsFor(sessionId, callId, toolName))
        const onAbort = () => finish(null)
        const onDisposed = () => finish(null)
        signal?.addEventListener('abort', onAbort, { once: true })
        joinCancellers.add(onDisposed)
        let waiters = toolCallWaiters.get(sessionId)
        if (waiters === undefined) {
          waiters = new Map()
          toolCallWaiters.set(sessionId, waiters)
        }
        const waiting = waiters.get(callId)
        if (waiting === undefined) waiters.set(callId, new Set([wake]))
        else waiting.add(wake)
        timer = setTimeout(() => finish(null), APPROVAL_TOOL_CALL_WAIT_MS)
        // A wait that outlives plugin disposal must not keep the process alive.
        timer.unref?.()
      })
    }

    // Never log or return `arguments`: the preview is the bounded text the phone
    // shows, and `log()` redacts `argsPreview`/`arguments` (FR-012) if one ever
    // reaches a log line. Always a string, even when nothing can be bound.
    // Truncation walks whole code points and stops before the next one would
    // cross the 2 KiB UTF-8 bound, so the frame never exceeds the contract limit
    // and multi-byte text (CJK, emoji) is never cut into an undecodable fragment.
    const approvalArgsPreview = (rawArguments) => {
      if (typeof rawArguments !== 'string') return ''
      if (Buffer.byteLength(rawArguments, 'utf8') <= APPROVAL_PREVIEW_MAX_BYTES) return rawArguments
      let preview = ''
      let bytes = 0
      for (const character of rawArguments) {
        const size = Buffer.byteLength(character, 'utf8')
        if (bytes + size > APPROVAL_PREVIEW_MAX_BYTES) break
        preview += character
        bytes += size
      }
      return preview
    }
    const fileTransfers = createFileTransferManager(api, options)
    const fileUploads = createFileUploadManager(api, options)
    const speechInput = createSpeechInputManager(api, options)
    const fileTransferExpiryTimer = setInterval(() => {
      fileTransfers.expire().catch((error) => {
        log(`file download expiry failed: ${error && error.message ? error.message : String(error)}`)
      })
      fileUploads.expire().catch(error => log(`file upload expiry failed: ${error.message}`))
    }, Math.min(options.fileDownloadIdleMs, options.fileUploadIdleMs, 30_000))
    const backgroundStreamAbort = new AbortController()
    let archivedSessionIds = null
    let sessionQueues = null
    let sessionProjectionBaselines = {}
    let counter = 0
    // The saved mode is only honoured when the owner switch permits remote
    // control at all; `remoteControl.enabled:false` starts (and stays) disabled.
    // The switch is a *permission*, not a start signal: which mode to start in
    // still comes from the saved/configured mode, defaulting to "off".
    let gatewayMode = remoteControlRequested
      ? (gatewayState.mode ?? options.gatewayMode ?? (options.gatewayEnabled === true ? 'persistent' : 'disabled'))
      : 'disabled'
    const gatewayInstanceId = crypto.randomUUID()
    let gatewayEnabled = gatewayMode !== 'disabled'
    let waitExpiresAt = null
    let waitTimer = null
    let connectedSinceEnabled = false
    let lastAuthRejectLogAt = 0
    let suppressedAuthRejects = 0
    let lanServer = null
    let lanListening = false
    let lanListenError = null
    let lanBoundPort = options.lanPort
    // Blocker 3 (review 2026-11-10): listener changes are serialized and every
    // listener carries a generation. Two overlapping POST /mgw/listen requests
    // used to close each other's listener and both report success, because both
    // waited on the same shared `lanListening` flag and an event from a
    // superseded listener still mutated it. A generation settle is now the only
    // thing a rebind waits on.
    let lanGeneration = 0
    let lanSettle = null
    let lanLane = Promise.resolve()
    const LAN_SETTLE_TIMEOUT_MS = 5_000
    // T017: the TLS listener is re-created when the certificate rotates; sockets
    // belonging to a retired listener are terminated so every client re-pins.
    const tlsSockets = new Set()
    // `clientMsgId` idempotency per device (contract §4): id → { frame, at }.
    const deviceClientMessages = new Map()
    let rtc = null
    // Assigned once the listener factory below is defined (T014 reuses it).
    let openLanListener = () => {}
    // Same reason: POST /mgw/listen closes the listener and re-opens it on
    // another address through the factory, so the slot exists before the route
    // can be reached (a route must never touch a TDZ binding).
    let rebindLanListener = async () => { throw new Error('listener factory is not ready') }
    let wedgeTimer = null
    // Sockets targeted by the kill switch, kept until they really close (T014).
    const closingSockets = new Set()
    // Runtime owner switch, settable while the plugin lives (POST /mgw/remote-control).
    // Starts from the config; `null` means "follow remoteControlRequested".
    let remoteControlLive = null
    const remoteControlEnabled = () => remoteControlLive ?? remoteControlRequested
    // An owner-set endpoint is the only public URL this gateway knows. The
    // `publicUrlFile` read is gone (T031): its only writer was the now-disabled
    // setup-ip helper, so nothing is read from disk any more.
    const configuredPublicUrl = () => (typeof options.publicUrl === 'string' ? options.publicUrl.trim() : '')

    const advertisedEndpoints = (primary, extra = []) => {
      const publicUrl = configuredPublicUrl()
      return normalizeEndpoints([...new Set([
        ...(primary ? [primary] : []),
        ...extra,
        ...configuredEndpoints,
        ...(publicUrl ? [publicUrl] : []),
        ...(lanListening ? lanWebSocketUrls(options, wsPath, lanBoundPort) : []),
      ])])
    }

    // T014 kill switch: close every live companion socket, hard-terminating the
    // ones that ignore the close handshake. `close(4004)` is graceful; anything
    // whose TCP socket is still open after CLOSE_GRACE_MS is `terminate()`d so a
    // phone that pins the connection cannot outlive the switch (SC-005: 5 s).
    //
    // `MobileConnection.close()` fires its close handler synchronously and the
    // handler drops the connection from `clients`, so the snapshot below is
    // taken first and liveness is re-checked on the underlying socket.
    const terminateWedgeSockets = () => {
      if (wedgeTimer) clearTimeout(wedgeTimer)
      wedgeTimer = null
      if (closingSockets.size === 0) return
      wedgeTimer = setTimeout(() => {
        wedgeTimer = null
        let killed = 0
        for (const entry of closingSockets) {
          if (!entry.isOpen()) continue
          try { entry.terminate(); killed += 1 } catch { /* already gone */ }
        }
        closingSockets.clear()
        if (killed > 0) log(`kill switch terminated ${killed} socket(s) that ignored close`)
      }, CLOSE_GRACE_MS)
      // Do not hold the event loop open just for the grace period.
      wedgeTimer.unref?.()
    }

    // A listener attempt's own settlement: the listener in force is
    // `lanSettle`, closing it settles it as superseded, and a waiter only ever
    // observes the generation it asked for.
    const beginLanAttempt = () => {
      lanGeneration += 1
      let resolve
      const promise = new Promise((done) => { resolve = done })
      const settle = { generation: lanGeneration, promise, resolve, settled: false }
      lanSettle = settle
      return settle
    }

    const settleLanAttempt = (settle, outcome) => {
      if (!settle || settle.settled) return
      settle.settled = true
      settle.resolve(outcome)
    }

    // Cancel a pending rebind/rollback without a replacement listener: disposal
    // and the owner switch both mean "the surface is gone", never "it failed".
    const abortLanAttempts = () => {
      lanGeneration += 1
      settleLanAttempt(lanSettle, { ok: false, aborted: true })
      lanSettle = null
    }

    // Close the plugin-owned TLS listener. The DSH web server route stays
    // registered (it is loopback and gated by the switch itself).
    const closeRemoteListeners = () => {
      // Whatever was waiting on this listener can never be settled by it any
      // more, so the attempt is superseded before the socket goes away.
      abortLanAttempts()
      if (!lanServer) return
      const listener = lanServer
      lanServer = null
      lanListening = false
      try { listener.close() } catch (error) {
        log(`TLS listener close failed: ${error && error.message ? error.message : String(error)}`)
      }
    }

    // Wait for exactly one attempt. `null` means the attempt was superseded
    // (disposal, the owner switch, or a later listener change), so the caller
    // must not roll back over a listener that is no longer its own.
    const awaitLanSettled = async (settle) => {
      if (!settle) return null
      let timer
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, timedOut: true }), LAN_SETTLE_TIMEOUT_MS)
        timer.unref?.()
      })
      const outcome = await Promise.race([settle.promise, timeout])
      clearTimeout(timer)
      if (settle.generation !== lanGeneration) return null
      return outcome
    }

    // Listener-changing operations run one at a time: a second POST /mgw/listen
    // waits for the first one and then applies (see PROTOCOL.md §15), so no
    // request ever closes the listener another request is using.
    const inLanLane = (operation) => {
      const run = lanLane.then(operation, operation)
      lanLane = run.then(() => {}, () => {})
      return run
    }

    const listenAbortedError = () => {
      const error = new Error('the listen change was cancelled: the mobile gateway is disabled or stopping')
      error.status = 409
      error.code = 'listen/aborted'
      return error
    }

    const setGatewayMode = (mode, reason, persist = true) => {
      if (!GATEWAY_MODES.includes(mode)) throw badRequest('mode must be disabled, temporary, or persistent')
      if (mode !== 'disabled' && !remoteControlEnabled()) {
        throw badRequest('remote control is disabled (remoteControl.enabled: false)')
      }
      // Commit before changing the live service, so a failed save never reports success.
      if (persist) gatewayState.setMode(mode)
      if (waitTimer) clearTimeout(waitTimer)
      waitTimer = null
      gatewayMode = mode
      gatewayEnabled = mode !== 'disabled' && remoteControlEnabled()
      waitExpiresAt = null
      connectedSinceEnabled = [...clients].some((client) => client.readyState === 1)
      if (mode === 'temporary' && !connectedSinceEnabled) {
        // T019: a v3 pairing code can only be redeemed on the TLS listener, so
        // that listener must be up before the phone is offered the code —
        // otherwise the first pair would wait on a connection that cannot
        // happen. The timeout still starts with the switch-on.
        if (gatewayEnabled) openLanListener()
        waitExpiresAt = Date.now() + options.gatewayWaitTimeoutMs
        waitTimer = setTimeout(() => {
          waitTimer = null
          if (!gatewayEnabled || connectedSinceEnabled || [...clients].some((client) => client.readyState === 1)) return
          gatewayEnabled = false
          gatewayMode = 'disabled'
          waitExpiresAt = null
          try { gatewayState.setMode('disabled') } catch (error) {
            log(`failed to persist automatic gateway disable: ${error.message}`)
          }
          log('mobile gateway automatically disabled: no device connected before timeout')
          applyDisabledState()
        }, options.gatewayWaitTimeoutMs)
      } else if (mode === 'disabled') {
        applyDisabledState()
      } else if (gatewayEnabled) {
        // Re-enabling may re-open the LAN listener that a previous switch-off closed.
        openLanListener()
      }
      log(`mobile gateway mode=${mode}${reason ? `: ${reason}` : ''}`)
    }

    // Everything that must happen when the gateway is (or becomes) off.
    // `pendingSockets` is declared with the pairing state machine further down;
    // a start-up call (setGatewayMode 'startup') runs before it exists.
    let endPendingPairings = () => {}
    const applyDisabledState = () => {
      endPendingPairings()
      rtc?.closeAll()
      // Snapshot first: each close() synchronously drops the client from `clients`.
      // `isOpen` re-reads the underlying TCP socket, which survives the graceful
      // close until the peer answers (or forever, if it never does).
      closingSockets.clear()
      for (const client of clients) {
        const socket = client.adapter?.socket
        closingSockets.add({
          isOpen: () => !!socket && socket.readyState !== 3,
          terminate: () => client.terminate(),
        })
      }
      for (const client of clients) client.close(4004, 'mobile gateway disabled')
      terminateWedgeSockets()
      closeRemoteListeners()
    }

    const logAuthRejected = (req) => {
      const now = Date.now()
      if (now - lastAuthRejectLogAt >= 30_000) {
        const suffix = suppressedAuthRejects ? ` (${suppressedAuthRejects} repeated attempts suppressed)` : ''
        const remote = (req.socket && req.socket.remoteAddress) || 'unknown'
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin.slice(0, 160) : '-'
        const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 160) : '-'
        log(`auth rejected: missing or invalid device credential; remote=${remote}; origin=${origin}; user-agent=${userAgent}${suffix}`)
        lastAuthRejectLogAt = now
        suppressedAuthRejects = 0
      } else {
        suppressedAuthRejects += 1
      }
    }

    const questionFrameFor = (rpcId, payload, replay = false) => ({
      kind: 'question-requested',
      rpcId: String(rpcId),
      sessionId: String(payload.sessionId),
      questions: payload.questions,
      // Spec 008: the tool-call id the Host's question service keys this question by
      // (rc.1 sets it on every `user-questions/request`: `askTimed` and the legacy
      // `ask` both pass `wait.callId`). A paired device cannot use the admin-only
      // `question-answer`; it answers through the bridge's `userQuestions/answer`,
      // whose rc.1 shape needs exactly this id.
      ...(typeof payload.callId === 'string' && payload.callId !== '' ? { callId: payload.callId } : {}),
      ...(replay ? { replay: true } : {}),
    })

    const approvalFrameFor = (rpcId, payload, replay = false) => ({
      kind: 'approval-requested',
      rpcId: String(rpcId),
      sessionId: String(payload.sessionId),
      approvalId: String(payload.approvalId),
      toolName: payload.toolName,
      ...(payload.callId !== undefined ? { callId: payload.callId } : {}),
      ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      ...(payload.displayReason !== undefined ? { displayReason: payload.displayReason } : {}),
      // Contract §5: 64 hex chars binding the exact request, or `null` when the
      // gateway could not bind content; §5a: the preview is always a string.
      argsHash: typeof payload.argsHash === 'string' ? payload.argsHash : null,
      argsPreview: typeof payload.argsPreview === 'string' ? payload.argsPreview : '',
      ...(replay ? { replay: true } : {}),
    })

    // Reviewer 36d9 #4/#5: ONE live per-recipient authorization, applied at SEND
    // time to every frame that is not addressed to a single requester. A
    // subscription filter (`filterSessionId`) is a routing hint, never an
    // authorization.
    //  - A socket without a `deviceId` is the loopback admin/legacy channel (the
    //    owner on the DSH listener, or the test-only `legacyAdmin`): unchanged.
    //  - A device socket must still speak for the LIVE credential (record present,
    //    same generation), and must hold `sessions:read` for anything about a
    //    session, plus `approval:respond` for approval cards. A scope change
    //    (re-pair) bumps the generation, so a stale grant gets nothing.
    //  - Session-keyed frames only reach a device whose visible set (the same
    //    snapshot the DSH policy is built from) contains that session; a frame
    //    for a session the Host never listed to the device is dropped. Frames
    //    with no session at all (`schedule-changed`, `plugins-changed`, ...) are
    //    owner-management notifications and need the owner: a device gets none.
    const deviceLive = (client) => {
      if (!client.deviceId || client.legacyAdminSocket === true) return undefined
      const device = registry.get(client.deviceId)
      if (!device || !credentialStillLive(client.deviceId, client.deviceGeneration)) return null
      return device
    }
    const deviceHasScope = (device, scope) => Array.isArray(device.scopes) && device.scopes.includes(scope)
    const deviceMaySeeSession = (device, sessionId) => (
      typeof sessionId === 'string' && sessionId.length > 0
      && deviceHasScope(device, 'sessions:read')
      && visibleSessionIds.includes(sessionId))
    /**
     * Whether `client` may be sent a session-keyed frame (`sessionId` of the frame)
     * of `scope` ('sessions:read' for metadata, 'approval:respond' for cards).
     * Admin/loopback sockets: always yes. Devices: live + scope + visible session.
     */
    const clientMayReceive = (client, sessionId, scope = 'sessions:read') => {
      const device = deviceLive(client)
      if (device === undefined) return true
      if (device === null) return false
      if (scope !== 'sessions:read' && !deviceHasScope(device, scope)) return false
      return deviceMaySeeSession(device, sessionId)
    }
    /** Global (non-session) owner notifications: admin sockets only, never a device. */
    const clientMayReceiveGlobal = (client) => deviceLive(client) === undefined
    // Questions: the protocol's SCOPE_BY_TYPE gives them NO scope and
    // `question-answer` / `question-cancel` are ADMIN_ONLY, so a question is the
    // owner's alone on this channel. NO device principal is sent a question push
    // or a replay, whatever scopes its record holds — a scope cannot widen a type
    // the contract reserves to the admin surface, and `question-answer` stays
    // unreachable for a device. Spec 008 gives a paired device its own path to the
    // same question (the remote bridge's `$events` stream plus
    // `userQuestions/answer`), which is separate from this channel and unchanged
    // here. A withheld card is audited with ids only — never the question text.
    const mayReceiveQuestion = (client) => deviceLive(client) === undefined
    const clientMayReceiveQuestion = (client, sessionId) => {
      if (mayReceiveQuestion(client)) return true
      log(`question card withheld: device=${client.deviceId} session=${typeof sessionId === 'string' && sessionId ? sessionId : '-'} reason=admin-only`)
      return false
    }

    const broadcastInteractionFrame = (frame, scope = 'approval:respond', mayReceive = null) => {
      const wire = stringifyWireFrame(frame)
      for (const client of clients) {
        if (client.mobileChannel === 'conversation') continue
        if (client.filterSessionId && client.filterSessionId !== frame.sessionId) continue
        if (mayReceive ? !mayReceive(client) : !clientMayReceive(client, frame.sessionId, scope)) continue
        if (client.readyState === 1) client.send(wire)
      }
    }
    /**
     * Question cards/resolutions: admin sockets only — the per-recipient
     * decision is `clientMayReceiveQuestion` (a device scope never widens it).
     */
    const broadcastQuestionFrame = (frame) =>
      broadcastInteractionFrame(frame, 'approval:respond', (client) => clientMayReceiveQuestion(client, frame.sessionId))

    // Session-list metadata must reach every connected client even when it is
    // subscribed to one conversation. Subscriptions only scope the heavier
    // conversation and interaction streams. "Every" now means every AUTHORIZED
    // one (see `clientMayReceive`): a frame with a `sessionId` goes only to
    // devices that may see that session; a frame without one goes to admin
    // sockets only.
    //
    // Reviewer 36d9 #4: the aggregate baselines (`session-archives`,
    // `session-queues`, `projection-baseline`) carry many sessions in one frame.
    // They are not dropped for a device but REDUCED to the recipient's own
    // authorized visible sessions (live `sessions:read` + visible set). A device
    // WITHOUT live `sessions:read` (empty scopes, stale generation) gets no frame
    // at all; one with the scope but no visible session yet gets the empty shape
    // (it carries no data and doubles as the connect sync marker). Admin sockets
    // get the full frame.
    const clientAuthorizedSessionIds = (client) => {
      const device = deviceLive(client)
      if (device === undefined) return undefined // admin: everything
      if (device === null || !deviceHasScope(device, 'sessions:read')) return null
      return new Set(visibleSessionIds)
    }
    /** The frame `client` may see for an aggregate baseline, or null when nothing. */
    const aggregateFrameFor = (client, frame) => {
      const allowed = clientAuthorizedSessionIds(client)
      if (allowed === undefined) return frame
      if (allowed === null) return null
      if (frame.kind === 'session-archives') {
        return { ...frame, archivedSessionIds: frame.archivedSessionIds.filter((id) => allowed.has(id)) }
      }
      if (frame.kind === 'session-queues') {
        return { ...frame, queues: Object.fromEntries(Object.entries(frame.queues).filter(([id]) => allowed.has(id))) }
      }
      if (frame.kind === 'projection-baseline') {
        return { ...frame, projections: Object.fromEntries(Object.entries(frame.projections).filter(([id]) => allowed.has(id))) }
      }
      return frame
    }
    const AGGREGATE_KINDS = new Set(['session-archives', 'session-queues', 'projection-baseline'])
    const broadcastSessionMetadataFrame = (frame) => {
      const aggregate = AGGREGATE_KINDS.has(frame.kind)
      const adminWire = stringifyWireFrame(frame)
      for (const client of clients) {
        if (client.mobileChannel === 'conversation') continue
        let wire = adminWire
        if (aggregate) {
          const reduced = aggregateFrameFor(client, frame)
          if (!reduced) continue
          if (reduced !== frame) wire = stringifyWireFrame(reduced)
        } else if (typeof frame.sessionId === 'string'
          ? !clientMayReceive(client, frame.sessionId)
          : !clientMayReceiveGlobal(client)) continue
        if (client.readyState === 1) client.send(wire)
      }
    }
    // Initial baseline for one connection: same reduction as the broadcast.
    const sendAggregateBaseline = (client, frame) => {
      const reduced = aggregateFrameFor(client, frame)
      if (reduced && client.readyState === 1) client.send(stringifyWireFrame(reduced))
    }

    const replayPendingInteractions = (ws, trigger) => {
      // In split-channel mode `subscribe` belongs to the conversation socket,
      // while interaction frames belong to the control socket. Bridge a
      // conversation subscription to every live control/legacy socket so
      // reopening a Session restores its still-pending cards. Reducers dedupe
      // by rpcId, so replaying to another trusted device is harmless and keeps
      // all active clients in sync.
      // The companion control socket already receives a full replay when it
      // connects, so a bare conversation connect must not duplicate it again.
      if (ws.mobileChannel === 'conversation' && trigger !== 'subscribe') {
        return { questionCount: 0, approvalCount: 0 }
      }
      const recipients = ws.mobileChannel === 'conversation'
        ? [...clients].filter((client) => client.readyState === 1 && client.mobileChannel !== 'conversation')
        : [ws]
      if (recipients.length === 0) return { questionCount: 0, approvalCount: 0 }
      const sessionId = ws.filterSessionId
      let questionCount = 0
      let approvalCount = 0
      // Reviewer 36d9 #5: the recipients list is built from subscription state, so
      // authorization is re-checked per recipient and per card, live, right here
      // (including the conversation-triggered fan-out to OTHER control sockets).
      // The counts are what was actually delivered to at least one recipient.
      for (const pending of pendingQuestions.values()) {
        if (sessionId && sessionId !== pending.sessionId) continue
        const wire = stringifyWireFrame(questionFrameFor(pending.rpcId, pending, true))
        let delivered = false
        for (const recipient of recipients) {
          if (recipient.filterSessionId && recipient.filterSessionId !== pending.sessionId) continue
          if (!clientMayReceiveQuestion(recipient, pending.sessionId)) continue
          recipient.send(wire)
          delivered = true
        }
        if (delivered) questionCount += 1
      }
      for (const pending of pendingApprovals.values()) {
        if (sessionId && sessionId !== pending.sessionId) continue
        const wire = stringifyWireFrame(approvalFrameFor(pending.rpcId, pending, true))
        let delivered = false
        for (const recipient of recipients) {
          if (recipient.filterSessionId && recipient.filterSessionId !== pending.sessionId) continue
          if (!clientMayReceive(recipient, pending.sessionId, 'approval:respond')) continue
          recipient.send(wire)
          delivered = true
        }
        if (delivered) approvalCount += 1
      }
      log(`interaction replay: trigger=${trigger} channel=${ws.mobileChannel} filtered=${Boolean(sessionId)} recipients=${recipients.length} questions=${questionCount} approvals=${approvalCount}`)
      return { questionCount, approvalCount }
    }

    const hasInteractionClient = (sessionId) => [...clients].some((client) => (
      client.readyState === 1
      && client.mobileChannel !== 'conversation'
      && (!client.filterSessionId || client.filterSessionId === sessionId)
    ))
    // A question may only be handed back to the desktop when no socket that can
    // actually RECEIVE it is connected. Since questions are admin-only, a
    // connected device must not count: otherwise it would suppress the owner's
    // own answer path while being sent nothing.
    const hasQuestionClient = (sessionId) => [...clients].some((client) => (
      client.readyState === 1
      && client.mobileChannel !== 'conversation'
      && (!client.filterSessionId || client.filterSessionId === sessionId)
      && mayReceiveQuestion(client)
    ))

    const abortDownstreamInteraction = (pending, kind) => {
      if (pending.downstreamAbort.signal.aborted) return
      // The Host API gateway fans this abort out to every WebUI delivery of
      // the same Remote event. Its existing cancel handling removes each
      // pending BottomSheet; Mobile peers receive the resolved frame below.
      pending.downstreamAbort.abort(new Error(`${kind} completed outside WebUI`))
    }

    const completeQuestion = (pending, action, answer, cancellationCode = 'ASK_CANCELLED', cancellationError, source = 'mobile') => {
      if (pendingQuestions.get(pending.rpcId) !== pending) return false
      pendingQuestions.delete(pending.rpcId)
      pending.cleanup()
      if (source !== 'downstream') abortDownstreamInteraction(pending, 'question')
      if (action === 'answer') pending.resolve(answer)
      else {
        const error = cancellationError ?? new Error('question cancelled by mobile user')
        if (!error.name || error.name === 'Error') error.name = 'UserQuestionError'
        if (!error.code) error.code = cancellationCode
        pending.reject(error)
      }
      broadcastQuestionFrame({
        kind: 'question-resolved',
        rpcId: pending.rpcId,
        sessionId: pending.sessionId,
        outcome: action === 'answer' ? 'answered' : 'cancelled',
      })
      return true
    }

    const normalizeQuestionAnswers = (pending, answers) => {
      if (answers.length !== pending.questions.length) return { error: 'answers must cover every question exactly once' }
      const normalized = []
      for (let index = 0; index < pending.questions.length; index += 1) {
        const question = pending.questions[index]
        const answer = answers[index]
        if (!answer || typeof answer !== 'object' || answer.id !== question.id || !Array.isArray(answer.selected)) {
          return { error: 'answers must preserve question order, ids, and selected arrays' }
        }
        if (answer.selected.some((label) => typeof label !== 'string')) return { error: 'selected values must be strings' }
        if (new Set(answer.selected).size !== answer.selected.length) return { error: 'selected values must not repeat' }
        const offered = new Set((question.options || []).map((option) => option.label))
        if (answer.selected.some((label) => !offered.has(label))) return { error: 'selected values must match offered option labels' }
        if (question.multiSelect !== true && answer.selected.length > 1) return { error: 'single-select questions accept at most one selection' }
        let custom
        if (answer.custom !== undefined) {
          if (typeof answer.custom !== 'string' || !answer.custom.trim()) return { error: 'custom answers must be non-empty strings' }
          custom = answer.custom.trim()
        }
        if (question.multiSelect !== true && custom !== undefined && answer.selected.length > 0) {
          return { error: 'single-select custom answers cannot accompany a selection' }
        }
        normalized.push({ id: answer.id, selected: [...answer.selected], ...(custom === undefined ? {} : { custom }) })
      }
      return { value: { answers: normalized } }
    }

    const completeApproval = (pending, outcome, source = 'mobile') => {
      if (pendingApprovals.get(pending.rpcId) !== pending) return false
      pendingApprovals.delete(pending.rpcId)
      pending.cleanup()
      if (source !== 'downstream') abortDownstreamInteraction(pending, 'approval')
      pending.resolve(outcome)
      broadcastInteractionFrame({
        kind: 'approval-resolved',
        rpcId: pending.rpcId,
        sessionId: pending.sessionId,
        approvalId: pending.approvalId,
        outcome,
      })
      return true
    }

    const startDownstreamQuestion = (pending) => {
      let downstream
      try {
        downstream = pending.next()
      } catch (error) {
        pending.downstream = { kind: 'rejected', error }
        return
      }
      pending.downstream = { kind: 'pending' }
      Promise.resolve(downstream).then((answer) => {
        if (pendingQuestions.get(pending.rpcId) !== pending) return
        if (answer && Array.isArray(answer.answers)) {
          completeQuestion(pending, 'answer', answer, undefined, undefined, 'downstream')
          log(`question resolved by downstream answerer: rpcId=${pending.rpcId} session=${pending.sessionId}`)
        } else {
          // A downstream answerer may report that no WebUI currently owns the
          // request. Keep the pending interaction active; the value is used only
          // once no socket that may actually receive it is connected (for a
          // question that means admin only, see `hasQuestionClient`).
          pending.downstream = { kind: 'unavailable', value: answer }
          if (!hasQuestionClient(pending.sessionId)) fallbackQuestion(pending)
        }
      }, (error) => {
        if (pendingQuestions.get(pending.rpcId) !== pending) return
        if (error?.code === 'ASK_CANCELLED' || error?.code === 'ASK_ABORTED') {
          completeQuestion(pending, 'cancel', undefined, error.code, error, 'downstream')
          log(`question cancelled by downstream answerer: rpcId=${pending.rpcId} session=${pending.sessionId}`)
        } else {
          pending.downstream = { kind: 'rejected', error }
          if (!hasQuestionClient(pending.sessionId)) fallbackQuestion(pending)
        }
      })
    }

    const startDownstreamApproval = (pending) => {
      let downstream
      try {
        downstream = pending.next()
      } catch (error) {
        pending.downstream = { kind: 'rejected', error }
        return
      }
      pending.downstream = { kind: 'pending' }
      Promise.resolve(downstream).then((outcome) => {
        if (pendingApprovals.get(pending.rpcId) !== pending) return
        if (outcome === 'allowed-once' || outcome === 'rejected') {
          completeApproval(pending, outcome, 'downstream')
          log(`approval resolved by downstream answerer: rpcId=${pending.rpcId} session=${pending.sessionId} outcome=${outcome}`)
        } else {
          pending.downstream = { kind: 'unavailable', value: outcome }
          if (!hasInteractionClient(pending.sessionId)) fallbackApproval(pending)
        }
      }, (error) => {
        if (pendingApprovals.get(pending.rpcId) !== pending) return
        pending.downstream = { kind: 'rejected', error }
        if (!hasInteractionClient(pending.sessionId)) fallbackApproval(pending)
      })
    }

    const fallbackQuestion = (pending) => {
      if (pendingQuestions.get(pending.rpcId) !== pending) return
      if (pending.downstream?.kind === 'pending') return
      pendingQuestions.delete(pending.rpcId)
      pending.cleanup()
      if (pending.downstream?.kind === 'rejected') pending.reject(pending.downstream.error)
      else pending.resolve(pending.downstream?.value)
    }

    const fallbackApproval = (pending) => {
      if (pendingApprovals.get(pending.rpcId) !== pending) return
      if (pending.downstream?.kind === 'pending') return
      pendingApprovals.delete(pending.rpcId)
      pending.cleanup()
      // Mobile does not decide (no client, a disconnect, or plugin shutdown):
      // hand the exact downstream result back to the waterfall. That is the
      // equivalent of returning `next()` for this request — `allowed-once`,
      // `rejected`, `cancelled`, `unavailable`, a throw and (with no other
      // handler) `undefined` all pass through unchanged, so DSH's own
      // fail-closed normalisation applies instead of a value invented here.
      if (pending.downstream?.kind === 'rejected') pending.reject(pending.downstream.error)
      else pending.resolve(pending.downstream?.value)
    }

    const releaseUnclaimedInteractions = () => {
      for (const pending of [...pendingQuestions.values()]) {
        if (!hasQuestionClient(pending.sessionId)) fallbackQuestion(pending)
      }
      for (const pending of [...pendingApprovals.values()]) {
        if (!hasInteractionClient(pending.sessionId)) fallbackApproval(pending)
      }
    }

    const respondToQuestion = async (msg, cancel = false) => {
      const rpcId = typeof msg.rpcId === 'string' && msg.rpcId.trim() ? msg.rpcId.trim() : null
      const sessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim() ? msg.sessionId.trim() : null
      if (!rpcId || !sessionId) {
        return { kind: 'error', code: 'bad-request', message: `${msg.type} requires rpcId and sessionId`, requestType: msg.type }
      }

      const pending = pendingQuestions.get(rpcId)
      if (!pending) {
        return { kind: 'question-response', rpcId, sessionId, action: cancel ? 'cancel' : 'answer', accepted: false, reason: 'not-pending' }
      }
      if (pending.sessionId !== sessionId) {
        return { kind: 'error', code: 'bad-request', message: 'sessionId does not match the pending question', requestType: msg.type, sessionId }
      }
      if (!cancel && !Array.isArray(msg.answers)) {
        return { kind: 'error', code: 'bad-request', message: 'question-answer requires an answers array', requestType: msg.type, sessionId }
      }
      const normalized = cancel ? null : normalizeQuestionAnswers(pending, msg.answers)
      if (normalized?.error) {
        return { kind: 'error', code: 'bad-response', message: normalized.error, requestType: msg.type, sessionId }
      }
      const answer = normalized?.value
      const accepted = completeQuestion(pending, cancel ? 'cancel' : 'answer', answer)
      log(`question response: rpcId=${rpcId} session=${sessionId} action=${cancel ? 'cancel' : 'answer'} accepted=${accepted}`)
      return {
        kind: 'question-response',
        rpcId,
        sessionId,
        action: cancel ? 'cancel' : 'answer',
        accepted,
        ...(!accepted ? { reason: 'not-pending' } : {}),
      }
    }

    const respondToApproval = async (msg) => {
      const rpcId = typeof msg.rpcId === 'string' && msg.rpcId.trim() ? msg.rpcId.trim() : null
      const sessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim() ? msg.sessionId.trim() : null
      const approvalId = typeof msg.approvalId === 'string' && msg.approvalId.trim() ? msg.approvalId.trim() : null
      const outcome = msg.outcome
      if (!rpcId || !sessionId || !approvalId) {
        return { kind: 'error', code: 'bad-request', message: 'approval-response requires rpcId, sessionId, and approvalId', requestType: msg.type }
      }
      if (outcome !== 'allowed-once' && outcome !== 'rejected') {
        return { kind: 'error', code: 'bad-request', message: 'approval-response outcome must be "allowed-once" or "rejected"', requestType: msg.type, sessionId }
      }

      const pending = pendingApprovals.get(rpcId)
      if (!pending) {
        return { kind: 'approval-response', rpcId, sessionId, approvalId, outcome, accepted: false, reason: 'not-pending' }
      }
      if (pending.sessionId !== sessionId || pending.approvalId !== approvalId) {
        return { kind: 'error', code: 'bad-request', message: 'approval-response does not match the pending approval', requestType: msg.type, sessionId }
      }
      // Contract §5 / constitution B3: the decision must bind the exact content
      // the user was shown. A mismatch is a normal receipt, not an error: the
      // request stays pending, nothing is applied, and the client re-reads the
      // card. An unbound request (argsHash null) was never offered for a remote
      // decision, so its decision stays with the desktop.
      if (pending.argsHash === null) {
        log(`approval response refused: rpcId=${rpcId} reason=desktop-only`)
        return { kind: 'approval-response', rpcId, sessionId, approvalId, outcome, accepted: false, reason: 'not-pending' }
      }
      const echoedArgsHash = typeof msg.argsHash === 'string' ? msg.argsHash : null
      if (echoedArgsHash !== pending.argsHash) {
        log(`approval response refused: rpcId=${rpcId} reason=hash-mismatch`)
        return { kind: 'approval-response', rpcId, sessionId, approvalId, outcome, accepted: false, reason: 'hash-mismatch' }
      }
      const accepted = completeApproval(pending, outcome)
      log(`approval response: rpcId=${rpcId} approvalId=${approvalId} session=${sessionId} outcome=${outcome} accepted=${accepted}`)
      return {
        kind: 'approval-response',
        rpcId,
        sessionId,
        approvalId,
        outcome,
        accepted,
        ...(!accepted ? { reason: 'not-pending' } : {}),
      }
    }

    // Spec 008: the remote-bridge channel. It reuses the Host's own typertGateway
    // (owner Peer per connection) and maps `$events/result` onto THIS file's
    // hash-bound approval decision — it never forwards that endpoint raw.
    const remoteBridge = createRemoteBridge({
      getGateway: () => resolveHostGateway(ctx),
      // rc.1 refuses the forwarded Remote-event stream (`$events`) and
      // `$events/result` for any Peer that did not declare `interactions: 'answer'`
      // (`requireInteractions`, dsh-api-gateway/lib/index.js:1484-1486, reached
      // from openWireStream:1012-1016 and dispatchRpc:993-1000). With 'none' the
      // bridge could never open `$events`, so a paired device never saw an
      // approval-requested card. Only a device that may actually answer (live
      // `approval:respond`, the same scope the bridge's `$events` endpoint needs)
      // gets 'answer'; every other bridge device keeps 'none'. The principal stays
      // the owner and the Peer stays per bridge connection.
      createPeer: (deviceId) => {
        const device = registry.get(deviceId)
        const mayAnswer = Array.isArray(device?.scopes) && device.scopes.includes('approval:respond')
        return ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: mayAnswer ? 'answer' : 'none' })
      },
      getDevice: (deviceId) => registry.get(deviceId),
      decideApproval: (request) => respondToApproval({ ...request, type: 'approval-response' }),
      maxPayloadBytes: options.maxPayloadBytes,
      // All 0 (unlimited) unless the owner configured `remoteBridgeLimits`.
      limits: options.remoteBridgeLimits,
      log,
    })

    // Saved user choice wins; a temporary startup gets a fresh first-connection window.
    setGatewayMode(gatewayMode, 'startup', false)

    // Secret-file restriction failures surface as redacted log warnings instead of crashing.
    setSecureFileLogger(log)

    log(`applying: version=${PLUGIN_VERSION} interactionProtocol=${INTERACTION_PROTOCOL_REVISION} path=${wsPath}, webServer.port=${webServer.port}, gatewayEnabled=${gatewayEnabled}, devices=${registry.count()}`)

    // ---- device management routes (loopback-gated admin surface) ----
    let restartPending = false
    const disposeMgmt = webServer.register({
      kind: 'prefix',
      path: '/mgw',
      handler: async (req, res) => {
        try {
          if (adminLoopbackOnly && !isLoopback(req)) {
            sendJson(res, 403, { error: 'forbidden', message: 'management API is loopback-only' })
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req)) {
            sendJson(res, 403, { error: 'forbidden', message: 'cross-origin management request rejected' })
            return
          }
          const url = new URL(req.url || '/', 'http://x')
          const p = url.pathname
          if (req.method === 'GET' && p === '/mgw/status') {
            const profile = ctx.get?.('profileContext')
            sendJson(res, 200, {
              version: PLUGIN_VERSION,
              // T023 (FR-007): authentication is permanent. Reported for the
              // admin UI, never switchable.
              requireAuth: true,
              gatewayEnabled,
              remoteControl: {
                // Master permission (config/owner switch) vs. the live runtime
                // state. `enabled` is what US1/SC-001 is about.
                configured: remoteControlConfigured ? remoteControlEnabled() : null,
                legacyGatewayEnabled: options.gatewayEnabled === true,
                enabled: remoteControlEnabled(),
                accepting: gatewayEnabled,
              },
              gatewayMode,
              ...gatewayIdentity,
              endpoints: advertisedEndpoints(),
              waitExpiresAt,
              connectedClients: clients.size,
              webPort: webServer.port,
              webPid: process.pid,
              gatewayInstanceId,
              wsPath,
              publicUrl: configuredPublicUrl() || null,
              platform: process.platform,
              // T031 (FR-011/R9): the tunnel wiring is removed from this file and
              // lib/cloudflare-tunnel.mjs refuses at call time. The shape stays
              // because the Devices page reads it for the connection plan.
              cloudflare: { supported: false, enabled: false, mode: null, state: 'disabled', publicReady: false, publicUrl: null, hardDisabled: true },
              webrtc: rtc.snapshot(),
              pairingRoute,
              p2pUrl: gatewayState.p2pUrl,
              tailscaleUrl: gatewayState.tailscaleUrl,
              // The same table the listen targets bind against, so an address
              // reported here is exactly the one POST /mgw/listen can apply.
              tailscale: tailscaleInterfaceStatus({ listening: lanListening, host: options.lanHost, port: lanBoundPort, wsPath }, interfaces()),
              lan: {
                enabled: options.lanEnabled === true,
                listening: lanListening,
                host: options.lanHost,
                port: lanBoundPort,
                // T013: advertise nothing that is not actually listening — with
                // the switch off (or the listener closed) this is empty, so a
                // client cannot be pointed at a dead non-loopback address.
                urls: lanListening ? lanWebSocketUrls(options, wsPath, lanBoundPort) : [],
                requireAuth: true,
                // T016/T018: the listener is TLS and pinning is the only trust
                // anchor, so the fingerprint is part of the status.
                tls: lanListening,
                certSha256: tlsIdentity?.fingerprint256 ?? null,
                certNotAfter: tlsIdentity?.notAfter ?? null,
                sans: tlsIdentity?.sans ?? [],
                error: lanListenError,
              },
              tls: {
                fingerprint256: tlsIdentity?.fingerprint256 ?? null,
                sans: tlsIdentity?.sans ?? [],
                notAfter: tlsIdentity?.notAfter ?? null,
                directory: tlsDirectory,
              },
              pairingTtlMs: options.pairingTtlMs,
              // Spec 008: the optional remote-bridge limits in force (0 = unlimited).
              // Read-only here: they are Host config, not an /mgw write.
              remoteBridgeLimits: remoteBridge.limits,
              // T020/T023 (FR-004, FR-007): credentials are never accepted in a
              // URL query, so nothing advertises a query-token option.
              queryTokenAllowed: false,
              tools: {
                restartWeb: webRestartAvailable(profile),
                stopWeb: webRestartAvailable(profile),
              },
            })
          } else if (req.method === 'POST' && p === '/mgw/tools/restart-web') {
            if (!isLoopback(req)) {
              sendJson(res, 403, { error: 'forbidden', message: 'Web restart is loopback-only' })
              return
            }
            if (!webRestartAvailable(ctx.get?.('profileContext'))) {
              sendJson(res, 409, { error: 'unavailable', message: '只能在通过 dsh web 启动的 Web profile 中重启' })
              return
            }
            if (restartPending) {
              sendJson(res, 409, { error: 'restart-pending', message: 'DSH Web 正在重启' })
              return
            }
            restartPending = true
            try {
              await prepareWebRestart()
            } catch (error) {
              restartPending = false
              throw error
            }
            res.once('finish', () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100))
            sendJson(res, 202, { restarting: true })
          } else if (req.method === 'POST' && p === '/mgw/tools/stop-web') {
            if (!isLoopback(req)) {
              sendJson(res, 403, { error: 'forbidden', message: 'Web shutdown is loopback-only' })
              return
            }
            if (!webRestartAvailable(ctx.get?.('profileContext'))) {
              sendJson(res, 409, { error: 'unavailable', message: '只能停止通过 dsh web 启动的 Web profile' })
              return
            }
            if (restartPending) {
              sendJson(res, 409, { error: 'restart-pending', message: 'DSH Web 正在重启或停止' })
              return
            }
            restartPending = true
            res.once('finish', () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100))
            sendJson(res, 202, { stopping: true })
          } else if (req.method === 'POST' && p === '/mgw/gateway') {
            const body = await readBody(req)
            if (body.mode !== undefined && body.enabled !== undefined) throw badRequest('provide mode or enabled, not both')
            if (body.mode === undefined && typeof body.enabled !== 'boolean') throw badRequest('mode or boolean enabled is required')
            setGatewayMode(body.mode !== undefined ? body.mode : (body.enabled ? 'temporary' : 'disabled'), 'changed from management UI')
            sendJson(res, 200, { gatewayEnabled, gatewayMode, waitExpiresAt, connectedClients: clients.size })
          } else if (req.method === 'POST' && p === '/mgw/remote-control') {
            // T014: the owner switch itself. Turning it off is a kill switch:
            // every live companion socket is closed (and hard-terminated after
            // the grace period) and the plugin-owned LAN listener closes.
            // Turning it back on does not auto-enable the runtime
            // mode — that stays an explicit gatewayMode choice.
            const body = await readBody(req)
            if (typeof body.enabled !== 'boolean') throw badRequest('enabled must be a boolean')
            remoteControlLive = body.enabled
            if (!body.enabled) {
              if (gatewayMode !== 'disabled') setGatewayMode('disabled', 'remote control turned off by the owner')
              else applyDisabledState()
            }
            log(`remote control ${body.enabled ? 'enabled' : 'disabled'} from management UI`)
            sendJson(res, 200, {
              remoteControl: { enabled: remoteControlEnabled(), accepting: gatewayEnabled },
              gatewayMode,
              connectedClients: clients.size,
              lan: { listening: lanListening },
            })
          } else if (req.method === 'POST' && p === '/mgw/network-test') {
            const abort = new AbortController()
            const cancel = () => abort.abort()
            res.once('close', cancel)
            try {
              const result = await networkDiagnostics.measure({ signal: abort.signal })
              if (!abort.signal.aborted) sendJson(res, 200, result)
            } finally { res.off('close', cancel) }
          } else if (req.method === 'POST' && p === '/mgw/connection') {
            const body = await readBody(req)
            if (!body || typeof body !== 'object' || Array.isArray(body) || !PAIRING_ROUTES.includes(body.route))
              throw badRequest('a supported connection route is required')
            if (Object.keys(body).some(key => !['route', 'stunServers', 'p2pUrl', 'tailscaleUrl'].includes(key)))
              throw badRequest('unsupported connection setting')
            let nextSettings
            try {
              nextSettings = normalizeTransportConfig({ ...transportSettings,
                enabled: body.route === 'p2p', mode: body.route === 'p2p' ? 'prefer-webrtc' : 'ws-only',
                stunServers: managedStunServers(body.stunServers === undefined ? transportSettings.stunServers : body.stunServers),
              })
            } catch (error) { throw badRequest(error.message) }
            if (body.p2pUrl !== undefined && typeof body.p2pUrl !== 'string') throw badRequest('P2P address must be a string')
            const nextUrl = body.p2pUrl === undefined ? gatewayState.p2pUrl :
              body.p2pUrl.trim() ? normalizePublicUrl(body.p2pUrl.trim(), req, wsPath) : ''
            if (body.tailscaleUrl !== undefined && typeof body.tailscaleUrl !== 'string') throw badRequest('Tailscale address must be a string')
            const nextTailscaleUrl = body.tailscaleUrl === undefined ? gatewayState.tailscaleUrl :
              body.tailscaleUrl.trim() ? normalizePublicUrl(body.tailscaleUrl.trim(), req, wsPath) : ''
            if (nextTailscaleUrl && (!nextTailscaleUrl.startsWith('wss://') || !isTailscaleIp(new URL(nextTailscaleUrl).hostname)))
              throw badRequest('Tailscale address must use wss:// with a Tailscale IPv4 or IPv6 address')
            gatewayState.setConnection(body.route, nextSettings, nextUrl, nextTailscaleUrl)
            transportSettings = nextSettings
            pairingRoute = body.route
            rtc.configure(transportSettings)
            log(`connection preference saved: route=${pairingRoute}; existing connections retained`)
            sendJson(res, 200, { pairingRoute, p2pUrl: gatewayState.p2pUrl, tailscaleUrl: gatewayState.tailscaleUrl, webrtc: rtc.snapshot() })
          } else if (req.method === 'POST' && p === '/mgw/listen') {
            // The Devices page binds the plugin-owned TLS listener to this
            // machine's LAN or Tailscale address instead of a static config
            // value. Loopback and same-origin are enforced above for every /mgw
            // write; the loopback check is repeated because this route moves a
            // remote surface, and the Host/Origin pair is checked as well: the
            // shared same-origin check above compares two caller-supplied
            // headers, which DNS rebinding satisfies (Blocker 1). Nothing about
            // the surface itself changes: the same
            // `https.createServer(tlsServerOptions(...))` template, the same
            // upgrade handler, private-source check, pin and "authentication
            // forced" — only the address it binds moves (the certificate is NOT
            // rotated, so every paired phone keeps its pin).
            if (!isLoopback(req)) {
              sendJson(res, 403, { error: 'forbidden', message: 'listen address changes are loopback-only' })
              return
            }
            assertTrustedLocalAuthority(req)
            const body = await readBody(req)
            if (!LISTEN_TARGETS.includes(body.target))
              throw badRequest(`target must be one of ${LISTEN_TARGETS.join(', ')}`)
            // Nothing can be re-bound while no listener may exist: "loopback by
            // default" is the owner's decision (A4), so this route never turns
            // the remote surface on by itself.
            if (options.lanEnabled !== true) {
              const error = new Error('enable LAN access (lanEnabled) before choosing a listen address')
              error.status = 409
              error.code = 'lan/disabled'
              throw error
            }
            if (!gatewayEnabled) {
              const error = new Error('enable the mobile gateway before choosing a listen address')
              error.status = 409
              error.code = 'lan/disabled'
              throw error
            }
            const table = interfaces()
            const host = resolveListenHost(body.target, table)
            if (!host) {
              const error = new Error(body.target === 'tailscale'
                ? 'no Tailscale address was detected on this machine'
                : 'no private LAN address was detected on this machine')
              error.status = 409
              error.code = body.target === 'tailscale' ? 'tailscale/not-detected' : 'lan/not-detected'
              throw error
            }
            // The same ONE rule start-up re-adopts a saved choice with
            // (Should-fix 4): a malformed interface table cannot smuggle an
            // unspecified or public listen address in either.
            if (!isBindableListenHost(host))
              throw badRequest('listen address must be loopback or a private LAN/Tailscale address')
            // The choice is persisted inside the lane, right after the
            // generation that confirmed the bind, so the saved address is always
            // the one the winning listener sits on (Blocker 3).
            const applied = await rebindLanListener(host)
            log(`TLS listener bound to ${applied.applied}:${applied.port}${wsPath} on request`)
            // The answer describes THIS request's listener, captured inside the
            // lane: a queued request may already have moved the live one, and the
            // reply must not report somebody else's state (Blocker 3).
            sendJson(res, 200, {
              applied: applied.applied,
              port: applied.port,
              persists: applied.persists,
              lan: {
                enabled: options.lanEnabled === true,
                listening: applied.listening,
                host: applied.applied,
                port: applied.port,
                urls: applied.urls,
                requireAuth: true,
                tls: applied.listening,
                certSha256: tlsIdentity?.fingerprint256 ?? null,
                error: null,
              },
              tailscale: tailscaleInterfaceStatus({ listening: applied.listening, host: applied.applied, port: applied.port, wsPath }, table),
            })
          } else if (req.method === 'POST' && p === '/mgw/tls/regenerate') {
            // T016 (R1): the certificate is replaced only by this explicit owner
            // action. Every paired phone pins the old fingerprint, so they all
            // have to pair again — the answer says so.
            if (!isLoopback(req)) {
              sendJson(res, 403, { error: 'forbidden', message: 'certificate regeneration is loopback-only' })
              return
            }
            if (!remoteControlEnabled()) throw remoteDisabledError('enable remote control before rotating the certificate')
            // Also a listener-changing operation, so it takes the same lane as
            // POST /mgw/listen: a rotation must never close the listener a
            // rebind is waiting on (Blocker 3).
            await inLanLane(async () => {
              const wasListening = lanListening
              closeRemoteListeners()
              for (const socket of tlsSockets) {
                try { socket.destroy() } catch { /* already gone */ }
              }
              tlsSockets.clear()
              for (const client of [...clients]) client.close(CLOSE_REVOKED, 'gateway certificate regenerated')
              tlsIdentity = await loadOrCreateTlsIdentity({
                directory: tlsDirectory,
                advertised: tlsAdvertisedHosts(options, wsPath),
                regenerate: true,
                log,
              })
              openLanListener()
              for (let attempt = 0; attempt < 100 && !lanListening; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
              log(`TLS certificate regenerated: certSha256=${tlsIdentity.fingerprint256}`)
              sendJson(res, 200, {
                regenerated: true,
                fingerprint256: tlsIdentity.fingerprint256,
                notAfter: tlsIdentity.notAfter,
                sans: tlsIdentity.sans,
                wasListening,
                listening: lanListening,
                rePairRequired: true,
              })
            })
          } else if (req.method === 'GET' && p === '/mgw/devices') {
            sendJson(res, 200, { devices: registry.list() })
          } else if (req.method === 'POST' && p === '/mgw/pair') {
            if (!remoteControlEnabled()) throw remoteDisabledError('enable remote control before creating a pairing code')
            if (!gatewayEnabled) {
              const error = new Error('enable the mobile gateway before creating a pairing code')
              error.status = 409
              throw error
            }
            const body = await readBody(req)
            // Spec 005 FR3/US1: the offer names the device kind and the scopes it
            // will hold; a desktop offer defaults to DESKTOP_DEFAULT_SCOPES.
            if (body.kind !== undefined && !DEVICE_KINDS.includes(body.kind))
              throw badRequest(`kind must be one of ${DEVICE_KINDS.join(', ')}`)
            const kind = body.kind === undefined ? 'mobile' : body.kind
            if (body.scopes !== undefined && (!Array.isArray(body.scopes) || body.scopes.some((scope) => !SCOPES.includes(scope))))
              throw badRequest(`scopes must be an array of ${SCOPES.join(', ')}`)
            // Spec 005 review: only an absent list takes the kind's default. An
            // explicit empty list is a grant of nothing and stays empty — it must
            // never be read as "no scopes chosen, so use the default".
            const scopes = Array.isArray(body.scopes) ? body.scopes : undefined
            if (body.mode !== undefined && body.mode !== 'otp' && body.mode !== 'string')
              throw badRequest("mode must be 'otp' or 'string'")
            if (body.mode === 'otp') {
              // Spec 008 P1b Window 1: an 8-digit single-use code. It carries no
              // endpoint or pin (the client reads the pin by TOFU and proves the
              // code over it), so the Host only returns the code, what it grants
              // and the addresses the client can type.
              const offerScopes = scopes ?? (kind === 'desktop' ? [...DESKTOP_DEFAULT_SCOPES] : SCOPES.filter((scope) => scope !== REMOTE_SCOPE))
              const created = pairingRequests.createOffer({ kind, scopes: offerScopes.filter((scope) => kind === 'desktop' || scope !== REMOTE_SCOPE) })
              log(`otp pairing offer created: kind=${kind}, scopes=${created.offer.scopes.join(', ')}, expires=${new Date(created.offer.expiresAt).toISOString()}`)
              sendJson(res, 201, {
                mode: 'otp',
                otp: created.otp,
                pairing: { id: created.offer.id, kind, scopes: [...created.offer.scopes], expiresAt: created.offer.expiresAt },
                certSha256: tlsIdentity.fingerprint256,
                addresses: lanListening ? lanWebSocketUrls(options, wsPath, lanBoundPort).map((url) => new URL(url).host) : [],
                ...gatewayIdentity,
              })
              return
            }
            const publicUrl = normalizePublicUrl(body.publicUrl || configuredPublicUrl(), req, wsPath)
            if (pairingRoute === 'tailscale' && !isTailscaleIp(new URL(publicUrl).hostname))
              throw badRequest('Tailscale pairing requires the host Tailscale IP address')
            const endpoints = advertisedEndpoints(publicUrl, normalizeEndpoints(body.endpoints ?? [])).filter(endpoint =>
              pairingRoute !== 'tailscale' || isTailscaleIp(new URL(endpoint).hostname))
            // T019: the offer remembers what the QR promises (data-model.md
            // PairingOffer); claimPairing() then refuses a redemption over a
            // different listener certificate.
            const pairing = registry.createPairing(undefined, { endpoint: publicUrl, certSha256: tlsIdentity.fingerprint256,
              kind, scopes })
            const payload = {
              version: PAIRING_QR_VERSION,
              publicUrl,
              pairingCode: pairing.code,
              expiresAt: pairing.expiresAt,
              // Contract §2: the pin, without which the QR cannot be trusted.
              certSha256: tlsIdentity.fingerprint256,
              ...gatewayIdentity,
              endpoints,
            }
            // A pairing connection never reports a certificate, so a payload
            // pinned to several endpoints that cannot all present `certSha256`,
            // or that a redeeming client cannot trust, makes the whole offer
            // unusable. The QR/pairing string is the primary channel; say so
            // instead of failing the desktop later. Only an explicit owner
            // `endpoints` can get here.
            if (endpoints.length > 1) {
              log(`pairing offer carries ${endpoints.length} endpoints but only one pinned certificate: ${endpoints.join(', ')}`)
            }
            // QR/manual pairing has one canonical wire representation: the
            // UTF-8 JSON payload encoded as unpadded Base64URL. Base64URL is
            // copy-safe and QR-safe (`+`, `/`, and `=` never appear), but is
            // encoding rather than encryption; secrecy still comes from the
            // short TTL and single-use pairing code. Spec 005 FR3: the same
            // string is the copy-paste pairing text for a desktop.
            const qrPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
            const svg = await QRCode.toString(qrPayload, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
            // The audit line for what the owner just granted (spec 005 US1).
            log(`pairing created: ${pairing.name} (${pairing.id}), kind=${pairing.kind}, scopes=${pairing.scopes.join(', ')}, expires=${new Date(pairing.expiresAt).toISOString()}`)
            sendJson(res, 201, {
              pairing: { id: pairing.id, name: pairing.name, kind: pairing.kind, scopes: [...pairing.scopes], expiresAt: pairing.expiresAt },
              payload,
              qrPayload,
              pairingString: qrPayload,
              svg,
            })
          } else if (req.method === 'GET' && p === '/mgw/pending') {
            // Spec 008 P1b Window 2. Loopback + (for writes) same-origin come from
            // the guards at the top of this handler; a remote device never gets here.
            // Reading is loopback-only as well: it lists who is asking to be paired.
            if (!isLoopback(req) || !isSameOrigin(req)) {
              sendJson(res, 403, { error: 'forbidden', message: 'pending requests are loopback and same-origin only' })
              return
            }
            sendJson(res, 200, { pending: pairingRequests.list(), offers: pairingRequests.offerCount() })
          } else if (req.method === 'POST' && /^\/mgw\/pending\/[^/]+\/(?:approve|reject)$/.test(p)) {
            if (!isLoopback(req) || !isSameOrigin(req)) {
              sendJson(res, 403, { error: 'forbidden', message: 'pending requests are loopback and same-origin only' })
              return
            }
            const [, , , rawId, action] = p.split('/')
            const id = decodeURIComponent(rawId)
            const waiting = pendingSockets.get(id)
            const request = pairingRequests.get(id)
            if (!request || !waiting) {
              sendJson(res, 404, { error: 'not-found', message: 'no such pending request (it may have expired or the client left)' })
              return
            }
            if (action === 'reject') {
              // Single winner, like approve: a request someone else already took is gone.
              if (!pairingRequests.take(id) || pendingSockets.get(id) !== waiting) {
                sendJson(res, 404, { error: 'not-found', message: 'no such pending request (it may have expired, been decided or the client left)' })
                return
              }
              pendingSockets.delete(id)
              waiting.end('pairing/rejected', CLOSE_PAIRING_REJECTED)
              log(`pairing rejected by the host user: ${id}`)
              sendJson(res, 200, { rejected: true })
              return
            }
            // The body may stall for any time; nothing below may rely on the
            // request/socket captured above. Read and validate first against the
            // offered scopes, then take the STILL-LIVE request atomically.
            const body = await readBody(req)
            // The Host user may only narrow what the offer allowed.
            let granted = [...request.requestedScopes]
            if (body.scopes !== undefined) {
              if (!Array.isArray(body.scopes) || body.scopes.some((scope) => typeof scope !== 'string'))
                throw badRequest('scopes must be an array of scope names')
              if (body.scopes.some((scope) => !request.requestedScopes.includes(scope)))
                throw badRequest('scopes must be a subset of the scopes the pairing offered')
              granted = request.requestedScopes.filter((scope) => body.scopes.includes(scope))
            }
            if (!remoteControlEnabled() || !gatewayEnabled) throw remoteDisabledError('remote control is off; the request cannot be approved')
            // `take` is the single-winner gate: a second approval, a reject, a
            // timeout or a disconnect that ran during the body wait already took it.
            const taken = pairingRequests.take(id)
            const stillWaiting = pendingSockets.get(id)
            if (!taken || taken !== request || !stillWaiting || stillWaiting !== waiting || !waiting.live()) {
              // We may have taken a request whose client is already gone; make sure
              // nothing stays behind, but never touch a socket entry that is not ours.
              if (taken && stillWaiting === waiting) { pendingSockets.delete(id); waiting.end('pairing/expired', CLOSE_PAIRING_EXPIRED) }
              sendJson(res, 404, { error: 'not-found', message: 'no such pending request (it may have expired, been decided or the client left)' })
              return
            }
            pendingSockets.delete(id)
            const claimed = waiting.claim(granted)
            const device = claimed && claimed.device
            if (!device) {
              waiting.end('pairing/expired', CLOSE_PAIRING_EXPIRED)
              sendJson(res, 409, { error: 'pairing/expired', message: 'the pairing could not be completed' })
              return
            }
            // A re-pair of an installation that is already paired drops what the
            // old grant opened, exactly as the direct claim path does.
            if (claimed.repaired) {
              rtc?.closeDevice(device.id)
              void deviceAccess.revoke(device.id)
              for (const client of clients) {
                if (client.deviceId === device.id) client.close(CLOSE_REVOKED, 'credential re-paired')
              }
              deviceClientMessages.delete(device.id)
              log(`device re-paired: ${device.id}, previous connections closed`)
            }
            // Hand the waiting socket to the normal business path: the same
            // `paired` + hello sequence a direct claim sends, under the new generation.
            waiting.finished = true
            waiting.release()
            startBusinessConnection(() => activateBusinessConnection(new WebSocketMobileTransport(waiting.socket), device, 'legacy',
              { ...waiting.transport, legacyAdmin: options.legacyAdmin === true }, claimed, claimed.generation),
            { deviceId: device.id, channel: 'legacy', paired: true })
            log(`pairing approved by the host user: ${id} -> ${device.id}, scopes=${device.scopes.join(', ')}`)
            sendJson(res, 200, { approved: true, device })
          } else if (req.method === 'POST' && p.startsWith('/mgw/devices/') && p.endsWith('/revoke')) {
            const id = decodeURIComponent(p.slice('/mgw/devices/'.length, -'/revoke'.length))
            const revoked = registry.revoke(id)
            if (revoked) {
              rtc.closeDevice(id)
              void deviceAccess.revoke(id)
              for (const client of clients) {
                // Contract §3/§6: close code 4401 tells the phone its credential
                // is gone and it must wipe it (4003 would mean "re-authenticate").
                if (client.deviceId === id) client.close(CLOSE_REVOKED, 'device revoked')
              }
              deviceClientMessages.delete(id)
              log(`device revoked: ${id}`)
            }
            sendJson(res, revoked ? 200 : 404, { revoked })
          } else if (req.method === 'GET' && p === '/mgw') {
            res.writeHead(302, { ...securityHeaders('text/plain; charset=utf-8'), Location: '/' })
            res.end('Open the device manager from the DSH sidebar.')
          } else {
            sendJson(res, 404, { error: 'not-found' })
          }
        } catch (error) {
          log(`mgmt route failed: ${error && error.message ? error.message : String(error)}`)
          const status = Number.isInteger(error && error.status) ? error.status : (error instanceof TypeError ? 400 : 500)
          sendJson(res, status, {
            error: error && error.code ? error.code : (status < 500 ? 'bad-request' : 'internal'),
            ...(error && error.code ? { code: error.code } : {}),
            message: error && error.message ? error.message : String(error),
          })
        }
      },
    })
    log(`management routes registered: /mgw (loopbackOnly=${adminLoopbackOnly})`)

    const markDeviceConnected = () => {
      if (!connectedSinceEnabled) {
        connectedSinceEnabled = true
        waitExpiresAt = null
        if (waitTimer) clearTimeout(waitTimer)
        waitTimer = null
        log('mobile gateway wait completed: device connected')
      }
    }
    // Contract §3.5: `hello` is what a companion reads first. Its capability
    // list is exactly the package CAPABILITIES (never the upstream admin list),
    // `companionProtocol`/`minClientVersion` drive `client-hello`, and
    // `certSha256` is the pin the TLS listener presents. Spec 005 FR4: the
    // device also learns its own `kind` and `scopes`.
    const helloFrame = (device, transport = {}) => ({
      kind: 'hello',
      ...gatewayIdentity,
      protocol: 3,
      companionProtocol: COMPANION_PROTOCOL_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
      dshVersion: api.dshVersion,
      historyFormatVersion: SESSION_FORMAT_VERSION,
      capabilities: [...COMPANION_CAPABILITIES],
      certSha256: tlsIdentity?.fingerprint256 ?? null,
      port: transport.port || webServer.port,
      clients: clients.size,
      authenticated: !!device,
      ...(device ? { device: { id: device.id, name: device.name, kind: device.kind, scopes: device.scopes } } : {}),
    })
    // Contract §4: `message` is idempotent per device by `clientMsgId`; a retry
    // within CLIENT_MSG_DEDUPE_MS gets the original `sent` frame.
    const SENT_FRAME_TTL_MS = CLIENT_MSG_DEDUPE_MS
    const sentCacheFor = (deviceId) => {
      let entries = deviceClientMessages.get(deviceId)
      if (!entries) {
        entries = new Map()
        deviceClientMessages.set(deviceId, entries)
      }
      return entries
    }
    const lookupSentFrame = (deviceId, clientMsgId) => {
      const entries = deviceClientMessages.get(deviceId)
      const entry = entries?.get(clientMsgId)
      if (!entry) return undefined
      if (Date.now() - entry.at > SENT_FRAME_TTL_MS) {
        entries.delete(clientMsgId)
        return undefined
      }
      return entry.frame
    }
    const rememberSentFrame = (deviceId, clientMsgId, frame) => {
      if (!deviceId || frame?.kind !== 'sent') return frame
      const entries = sentCacheFor(deviceId)
      entries.set(clientMsgId, { frame, at: Date.now() })
      while (entries.size > MAX_CLIENT_MSG_IDS_PER_DEVICE) entries.delete(entries.keys().next().value)
      return frame
    }
    // Contract §4 `client-hello`: a client whose companion protocol this gateway
    // does not speak is told so (`protocol/unsupported` + `minClientVersion`)
    // and the socket is closed — never left half-negotiated.
    const handleClientHello = (ws, msg) => {
      const requestId = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
      const version = msg.companionProtocol
      const unsupported = version !== COMPANION_PROTOCOL_VERSION
      if (unsupported) {
        ws.send(stringifyWireFrame({
          kind: 'error',
          code: PROTOCOL_UNSUPPORTED,
          requestType: 'client-hello',
          ...requestId,
          minClientVersion: MIN_CLIENT_VERSION,
          message: `companion protocol ${String(version)} is not supported; this gateway speaks ${COMPANION_PROTOCOL_VERSION}`,
        }))
        log(`client-hello refused: companionProtocol=${String(version)} platform=${String(msg.platform)}`)
        // Let the error frame reach the peer before the close frame (contract §3.6).
        setTimeout(() => { try { ws.close(4003, 'protocol/unsupported') } catch (error) { /* already closed */ } }, 20)
        return
      }
      const client = {
        accepted: true,
        companionProtocol: COMPANION_PROTOCOL_VERSION,
        ...(typeof msg.appVersion === 'string' ? { appVersion: msg.appVersion.slice(0, 64) } : {}),
        ...(msg.platform === 'ios' || msg.platform === 'android' ? { platform: msg.platform } : {}),
      }
      ws.clientHello = client
      ws.send(stringifyWireFrame({ kind: 'client-hello', ...requestId, ...client }))
    }
    // Contract §1: a companion request carries a `requestId` bounded to 64
    // characters from [A-Za-z0-9._-], and the same id may not be in flight
    // twice (its receipt could not be attributed, and a duplicate could fan the
    // operation out twice). Checked once, before any branch dispatches, so no
    // op can run without it; server pushes carry no requestId and are untouched.
    const requestIdRejection = (ws, msg) => {
      const id = msg.requestId
      // Contract §1: the echo requirement applies to VALID ids only. Reflecting an
      // out-of-bounds id (control characters, Unicode, whitespace) is a framing defect:
      // it can no longer be attributed by the client and must not travel back.
      const echo = requestIdEcho(msg)
      if (id === undefined) {
        // Contract §4 ops always carry one. The revision-4 stream frames
        // `remote-stream-open/-cancel/-credit` have no requestId by design.
        if (!isCompanionType(msg.type)) return undefined
        return { kind: 'error', code: 'bad-request', requestType: msg.type,
          message: 'requestId is required (1..64 characters from [A-Za-z0-9._-])' }
      }
      if (typeof id !== 'string' || !REQUEST_ID_PATTERN.test(id)) {
        return { kind: 'error', code: 'bad-request', requestType: msg.type, ...echo,
          message: 'requestId must be 1..64 characters from [A-Za-z0-9._-]' }
      }
      const inFlight = ws.inFlightRequestIds
      if (inFlight?.has(id)) {
        return { kind: 'error', code: 'bad-request', requestType: msg.type, requestId: id,
          message: 'this requestId is already in flight' }
      }
      if (inFlight && inFlight.size >= MAX_INFLIGHT_REQUEST_IDS) {
        return { kind: 'error', code: 'bad-request', requestType: msg.type, requestId: id,
          message: `too many requests in flight (limit ${MAX_INFLIGHT_REQUEST_IDS})` }
      }
      return undefined
    }
    // Contract §3.6/§5a: the client is ready only after the `client-hello`
    // exchange is acknowledged. A version mismatch still closes the socket
    // ~20 ms later, so without this fence a client could dispatch operations in
    // that window; the fence is what makes the window harmless.
    const negotiationRejection = (ws, msg) => {
      if (ws.clientHello || PRE_NEGOTIATION_TYPES.has(msg.type)) return undefined
      // Same reflection rule as `requestIdRejection`: only a well-formed id is echoed.
      const echo = requestIdEcho(msg)
      return { kind: 'error', code: 'bad-request', requestType: msg.type,
        ...echo,
        message: 'client-hello must be accepted before this operation (contract §3.6/§5a)' }
    }
    const frameFence = (ws, msg) => requestIdRejection(ws, msg) ?? negotiationRejection(ws, msg)
    // A requestId matters for the duplicate rule only while its request can still
    // settle, so it lives in the socket's set until the promise does.
    const trackInFlight = (ws, msg, promise) => {
      const id = msg.requestId
      if (typeof id !== 'string' || !promise || typeof promise.then !== 'function') return promise
      ws.inFlightRequestIds?.add(id)
      const release = () => { ws.inFlightRequestIds?.delete(id) }
      promise.then(release, release)
      return promise
    }
    // Spec 005 re-review: an activated channel must still speak for the live
    // credential. `generation()` answers `undefined` for a revoked or unknown
    // device, so a missing record can never pass as "the same generation".
    const credentialStillLive = (deviceId, generation) =>
      typeof generation === 'number' && registry.generation(deviceId) === generation
    // Test-only override (never set by the bundle): a function returning a
    // promise delays activation, so a test can land a re-pair or a revocation in
    // the window between authentication and activation deterministically.
    const activationHold = typeof options.testActivationHold === 'function' ? options.testActivationHold : null
    const startBusinessConnection = (start, details) => {
      if (!activationHold) { start(); return }
      let hold
      try { hold = activationHold(details) } catch (error) { hold = undefined }
      if (hold && typeof hold.then === 'function') hold.catch(() => {}).then(() => start())
      else start()
    }
    const activateBusinessConnection = (adapter, device, channel, transport = {}, paired = null, credentialGeneration) => {
      // Spec 005 re-review: activation is not authentication. An RTC business
      // channel is activated on the client's `transport-select`, long after the
      // upgrade authenticated, and the re-pair/revoke sweep can only close
      // sockets that are already registered — so this window has to be closed
      // right here. A credential that is gone gets the revoke code and nothing
      // more: no `paired` token, no hello, no archives/queues, no projection
      // baseline, no replayed interactions. The per-message generation check
      // below covers only what happens *after* activation.
      if (device && !credentialStillLive(device.id, credentialGeneration)) {
        log(`stale credential refused at activation: device=${device.id} channel=${channel}`)
        try { adapter.close(CLOSE_REVOKED, 'credential is no longer valid') } catch (error) { /* socket already gone */ }
        return undefined
      }
      // T022a: a device connection speaks to the Host through ITS OWN non-owner
      // Peer (principal `dsh-ext-mobile-device`, deviceId from the registry), so
      // DSH's `remoteAccess.decide()` is the Host-side wall behind the router and
      // adapter allowlists. If that Peer cannot be created (revoked in the gap,
      // plugin closing) the connection is closed, never served via the owner Peer.
      // The unauthenticated/admin socket (`device` undefined) is loopback-only.
      let devicePeer
      let connApi = api
      // `transport.legacyAdmin` is the never-bundled test switch that lets a
      // device-token socket speak the upstream admin surface (as the loopback
      // admin client could). Those sockets keep the owner adapter by design; a
      // production socket has `legacyAdmin` false and always gets its own Peer.
      if (device && transport.legacyAdmin !== true) {
        devicePeer = deviceAccess.open(device.id)
        if (!devicePeer) {
          log(`device peer unavailable at activation: device=${device.id} channel=${channel}`)
          try { adapter.close(CLOSE_REVOKED, 'credential is no longer valid') } catch (error) { /* socket already gone */ }
          return undefined
        }
        connApi = createDshHostAdapter(ctx.typertGateway, devicePeer.peer, ctx.connection, {
          guard: deviceAccess.guard,
          onDenied: (endpoint) => log(`device denied host endpoint: ${endpoint} device=${device.id}`),
        })
      }
      const ws = new MobileConnection(adapter, { deviceId: device?.id, channel })
      ws.hostApi = connApi
      // Test-only `legacyAdmin` device sockets speak the upstream admin surface
      // (they can answer questions), so the per-recipient authorization treats
      // them like the loopback admin channel. Never true in a bundle.
      ws.legacyAdminSocket = Boolean(device) && transport.legacyAdmin === true
      // The socket is bound to the credential generation it authenticated with,
      // so a re-pair or a revocation that lands after this activation is refused
      // by the per-message check before any exemption or dispatch.
      ws.deviceGeneration = credentialGeneration
      const id = ++counter
      ws.filterSessionId = undefined
      ws.clientHello = null
      // Contract §1 duplicate-in-flight bookkeeping for this socket.
      ws.inFlightRequestIds = new Set()
      clients.add(ws)
      if (device) registry.connected(device.id)
      markDeviceConnected()

      const sendFrame = frame => {
        if (ws.readyState === 1) ws.send(stringifyWireFrame(frame))
      }
      // Spec 008: per-connection remote-bridge state (one owner Peer, the open
      // streams). Created lazily; closed with the socket so no Host iterator
      // outlives it, and closed by revoke/re-pair because those close the socket.
      let remoteChannel = null
      const handleRemoteFrame = (socket, msg) => {
        // Same gates as every other frame, in the same order: the generation of
        // the credential first (a revoked or re-paired socket is closed 4401),
        // then the device's scopes for this type. The refusal echoes a
        // `requestId` only when it is a well-formed id (contract §1).
        const live = registry.get(socket.deviceId)
        if (!live || registry.generation(socket.deviceId) !== socket.deviceGeneration) {
          sendFrame({ kind: 'error', code: 'auth/revoked', requestType: msg.type, ...requestIdEcho(msg),
            message: 'this device credential is no longer valid' })
          log(`stale device connection closed: device=${socket.deviceId} type=${msg.type}`)
          socket.close(CLOSE_REVOKED, 'credential is no longer valid')
          return
        }
        // Same pre-dispatch fences as the companion channel (requestId + the
        // client-hello gate); a bridge frame is no less an operation. Ordering
        // matches the companion path: identity first, then framing, then scopes,
        // so a malformed or pre-negotiation frame gets the framing refusal the
        // contract specifies and never reflects an unvalidated id.
        const fence = frameFence(socket, msg)
        if (fence) {
          socket.send(stringifyWireFrame(fence))
          log(`bridge frame refused before dispatch: type=${msg.type} device=${socket.deviceId}`)
          return
        }
        const refusal = scopeDenial(live, msg.type)
        if (refusal || live.kind !== 'desktop') {
          // `kind` is checked as well as the scope: a mobile record that
          // somehow lists harness:remote still gets nothing.
          const echo = requestIdEcho(msg)
          socket.send(stringifyWireFrame(refusal
            ? { ...refusal, ...echo }
            : { kind: 'error', code: 'auth/forbidden-scope', requestType: msg.type, scope: REMOTE_SCOPE, ...echo,
              message: 'the remote bridge is only available to a desktop device' }))
          log(`scope refused: type=${msg.type} device=${socket.deviceId} scope=${REMOTE_SCOPE}`)
          return
        }
        remoteChannel ??= remoteBridge.attach(socket, socket.deviceId)
        if (msg.type === 'remote-call') trackInFlight(socket, msg, remoteChannel.call(msg))
        else if (msg.type === 'remote-stream-open') trackInFlight(socket, msg, remoteChannel.openStream(msg))
        else if (msg.type === 'remote-stream-credit') remoteChannel.credit(msg)
        else if (msg.type === 'remote-stream-cancel') remoteChannel.cancel(msg)
      }

      // T022a: the follower opens `session/follow` through this connection's
      // non-owner adapter, so DSH checks the session against the device's grants.
      ws.sessionFollower = createSessionFollower(connApi, {
        onFrame(frame, context) {
          if (frame.type === 'snapshot') {
            sendFrame({ ...historyPage(frame.history, { sessionId: context.sessionId, view: 'conversation', maxBytes: HISTORY_OPENING_MAX_BYTES }),
              kind: 'session-snapshot', ...context, assistantStream: frame.assistantStream, replace: true })
          } else if (frame.type === 'event') {
            sendFrame({ ...buildWireEvent({ id: context.sessionId }, frame.event), ...context })
          } else {
            sendFrame({ kind: 'assistant-stream', ...context, frame: frame.frame })
          }
        },
        onError(error, context) {
          sendFrame({ kind: 'session-stream-reset', ...context,
            code: error.code || 'stream-interrupted', message: error.message })
        },
      })

      ws.on('message', (data) => {
        let msg
        try {
          msg = JSON.parse(data.toString())
        } catch (error) {
          ws.send(stringifyWireFrame({ kind: 'error', message: 'invalid json' }))
          return
        }
        if (!msg || typeof msg.type !== 'string') return
        // T013: the switch can be turned off while a socket is still draining
        // its close handshake. Nothing but the switch-state answer is served.
        if (!remoteControlEnabled()) {
          ws.send(stringifyWireFrame({ kind: 'error', code: REMOTE_DISABLED, requestType: msg.type,
            ...requestIdEcho(msg),
            message: 'remote control is disabled by the owner' }))
          return
        }
        // T022 (FR-005/FR-006, SC-002): a paired device token — and any
        // unauthenticated socket the debug switch used to allow — may only use
        // the `companion-v1` operations. Everything else is refused here,
        // before any Host call, with an error frame echoing the requestId.
        const deviceTokenCaller = !!ws.deviceId
        // T022: the upstream admin surface is reachable only by a frame that
        // carries the test-only `legacyAdmin` marker on a socket whose transport
        // was opened with the (never bundled) `legacyAdmin` option.
        const adminCaller = deviceTokenCaller
          ? !!msg.legacyAdmin && transport.legacyAdmin === true
          : true
        if (!deviceTokenCaller && !isCompanionType(msg.type)) {
          // T023: with the debug auth switch gone there is no unauthenticated
          // caller at all; this stays as a closed backstop.
          ws.send(stringifyWireFrame({ kind: 'error', code: 'auth/required', requestType: msg.type,
            ...requestIdEcho(msg),
            message: 'a paired device credential is required' }))
          return
        }
        // Spec 008: the remote-bridge types are not companion-v1 ops, so they
        // are diverted here — BEFORE the op/forbidden refusal below — and then go
        // through the same generation check and scope gate as every other frame
        // (`handleRemoteFrame`). A mobile device can never reach this: the type
        // needs `harness:remote`, which only a desktop record can hold.
        if (REMOTE_CLIENT_TYPES.includes(msg.type)) {
          if (!deviceTokenCaller) {
            ws.send(stringifyWireFrame({ kind: 'error', code: 'auth/required', requestType: msg.type,
              ...requestIdEcho(msg),
              message: 'a paired device credential is required' }))
            return
          }
          handleRemoteFrame(ws, msg)
          return
        }
        if (!isCompanionType(msg.type) && !adminCaller) {
          ws.send(stringifyWireFrame({ kind: 'error', code: OP_FORBIDDEN, requestType: msg.type,
            ...requestIdEcho(msg),
            message: `${msg.type} is not part of the companion-v1 operations` }))
          log(`op forbidden for device token: type=${msg.type} device=${ws.deviceId}`)
          return
        }
        // Spec 005 review: a device-token socket speaks only for the credential
        // it opened with. No live record (revoked) or a newer grant (re-paired)
        // makes it stale: refuse and close with the revoke code here, before any
        // exemption or dispatch. A missing record is never "no scope limits", and
        // an old grant never outlives the grant that replaced it.
        const scopedDevice = ws.deviceId ? registry.get(ws.deviceId) : undefined
        if (deviceTokenCaller && (!scopedDevice || registry.generation(ws.deviceId) !== ws.deviceGeneration)) {
          sendFrame({ kind: 'error', code: 'auth/revoked', requestType: msg.type,
            ...requestIdEcho(msg),
            message: 'this device credential is no longer valid' })
          log(`stale device connection closed: device=${ws.deviceId} type=${msg.type}`)
          ws.close(CLOSE_REVOKED, 'credential is no longer valid')
          return
        }
        // Contract §1 + §3.6/§5a: one pre-dispatch fence for every companion
        // request — the bounded requestId rule and the negotiation gate. It runs
        // BEFORE the scope refusal so a frame that is not even well-formed (or
        // that arrives before negotiation) gets the framing answer the contract
        // specifies, instead of a scope-dependent refusal that would also reflect
        // an unvalidated id. Nothing below it (and no Host call) runs for a frame
        // that fails. Applied to companion peers only: the owner/admin channel
        // keeps the upstream, requestId-optional semantics it always had (a
        // production device token is never an admin caller).
        if (!adminCaller) {
          const fence = frameFence(ws, msg)
          if (fence) {
            ws.send(stringifyWireFrame(fence))
            log(`frame refused before dispatch: type=${msg.type} device=${ws.deviceId ?? '-'} code=${fence.code}`)
            return
          }
        }
        // Spec 005 FR2: the device's scopes decide what it may send. Refused
        // here, before any Host call or side effect, with the requestId echoed
        // (only when it is a well-formed id — contract §1).
        // `device-forget` (self-revocation) is exempt; the push ops are refused
        // by their own branch below, so the scope gate steps aside for them too.
        const pushOp = msg.type === 'push-register' || msg.type === 'push-remove'
        // The handshake is the exchange that *makes* a device ready (contract
        // §3.6/§5a), so it cannot be gated on a device scope: the contract's
        // SCOPE_BY_TYPE maps `client-hello` to sessions:read, which would leave a
        // device paired without that read scope (or without any scope at all)
        // unable to negotiate and therefore unable to do anything.
        const handshakeOp = msg.type === 'client-hello'
        const scopeRefusal = adminCaller || pushOp || handshakeOp ? undefined : scopeDenial(scopedDevice, msg.type)
        if (scopeRefusal) {
          ws.send(stringifyWireFrame({ ...scopeRefusal, ...requestIdEcho(msg) }))
          log(`scope refused: type=${msg.type} device=${ws.deviceId} scope=${scopeRefusal.scope ?? '-'}`)
          return
        }
        const conversationRequest = ['message', 'history', 'subscribe', 'unsubscribe'].includes(msg.type)
        // The handshake and the keep-alive are channel-neutral: without this, a
        // conversation channel could never negotiate at all, which the
        // pre-negotiation fence would turn into a permanent refusal.
        const channelNeutral = msg.type === 'ping' || msg.type === 'client-hello'
        if ((ws.mobileChannel === 'control' && conversationRequest) ||
            (ws.mobileChannel === 'conversation' && !conversationRequest && !channelNeutral)) {
          ws.send(stringifyWireFrame({ kind: 'error', code: 'wrong-channel', requestType: msg.type,
            ...requestIdEcho(msg), message: 'Request belongs to the other mobile channel' }))
          return
        }

        if (msg.type === 'client-hello') {
          handleClientHello(ws, msg)
        } else if (msg.type === 'device-info') {
          const requestId = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
          const device = scopedDevice
          if (!device) {
            sendFrame({ kind: 'error', code: 'auth/revoked', requestType: 'device-info', ...requestId,
              message: 'this device is no longer paired' })
            ws.close(CLOSE_REVOKED, 'device revoked')
            return
          }
          sendFrame({ kind: 'device-info', ...requestId,
            device: { id: device.id, name: device.name, kind: device.kind, scopes: device.scopes, createdAt: device.createdAt ?? null } })
        } else if (msg.type === 'device-forget') {
          // Contract §4: revoke *this* device. The token is dead from here on,
          // so the socket is closed with 4401 after the receipt is queued.
          const requestId = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
          const deviceId = ws.deviceId
          const revoked = deviceId ? registry.revoke(deviceId) : false
          if (revoked) {
            rtc?.closeDevice(deviceId)
            void deviceAccess.revoke(deviceId)
            deviceClientMessages.delete(deviceId)
            for (const client of clients) if (client.deviceId === deviceId) client.close(CLOSE_REVOKED, 'device forgot itself')
            log(`device removed itself: ${deviceId}`)
          }
          if (ws.readyState === 1) ws.send(stringifyWireFrame({ kind: 'device-forgotten', ...requestId, revoked }))
          ws.close(CLOSE_REVOKED, 'device forgotten')
        } else if (msg.type === 'push-register' || msg.type === 'push-remove') {
          // Contract §4: only when `push-v1` is advertised. Remote push is not
          // configured by this gateway, so both operations are refused as ops
          // outside the allowlist rather than silently accepted.
          sendFrame({ kind: 'error', code: OP_FORBIDDEN, requestType: msg.type,
            ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
            message: 'push-v1 is not advertised by this gateway' })
        } else if (msg.type === 'ping') {
          const requestId = typeof msg.requestId === 'string' && msg.requestId.length > 0 && msg.requestId.length <= 128
            ? { requestId: msg.requestId } : {}
          ws.send(stringifyWireFrame({ kind: 'pong', at: Date.now(), ...requestId }))
        } else if (!adminCaller && !isCompanionType(msg.type)) {
          // Unreachable: a companion type always has an entry above and the
          // allowlist refuses every non-companion type without an admin
          // channel. Kept as a closed backstop (fail closed).
          sendFrame({ kind: 'error', code: OP_FORBIDDEN, requestType: msg.type,
            ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
            message: `${msg.type} is not part of the companion-v1 operations` })
        } else if (msg.type === 'subscribe') {
          const target = parseSessionTarget(msg, { optional: true })
          if (target.error) { sendFrame(target.error); return }
          if (msg.assistantStream !== undefined && typeof msg.assistantStream !== 'boolean') {
            sendFrame({ kind: 'error', code: 'bad-request', requestType: 'subscribe',
              ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}), message: 'assistantStream must be a boolean' })
            return
          }
          const sessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim() ? msg.sessionId.trim() : undefined
          if (msg.assistantStream === true && !sessionId) {
            sendFrame({ kind: 'error', code: 'bad-request', requestType: 'subscribe',
              ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}), message: 'assistantStream requires a sessionId' })
            return
          }
          // Reviewer 537f M1: a subscription is a routing hint, never a grant. A
          // device may only filter its stream to a session the Host listed to it
          // (the same visible set its DSH policy is built from); otherwise the
          // filter would widen the raw fan-out past the policy. `session-not-found`
          // is the existing fail-closed vocabulary for an invisible session (the
          // file-transfer routes answer the same way) and reveals nothing more. A
          // refused subscribe is a no-op: it changes no filter and stops no follow.
          const subscriber = deviceLive(ws)
          if (sessionId && subscriber !== undefined
            && (subscriber === null || !deviceMaySeeSession(subscriber, sessionId))) {
            sendFrame({ kind: 'error', code: 'session-not-found', requestType: 'subscribe',
              ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
              message: 'no session with this ID is visible to this device' })
            log(`subscribe refused: session=${sessionId} device=${ws.deviceId} (session not visible to this device)`)
            return
          }
          ws.sessionFollower.stop()
          ws.filterSessionId = sessionId
          ws.sessionFollowerActive = msg.assistantStream === true
          const subscriptionId = crypto.randomUUID()
          // Contract §4: `subscribe` → `subscribed`; contract §1: the receipt
          // echoes the requestId.
          sendFrame({ kind: 'subscribed', ...target.value, sessionId: sessionId || null, subscriptionId,
            assistantStream: ws.sessionFollowerActive,
            ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}) })
          if (ws.sessionFollowerActive) {
            void ws.sessionFollower.start(sessionId, subscriptionId, target.value).catch(error => {
              log(`session follower failed: ${error.message}`)
              if (ws.readyState === 1) ws.close(1011, 'session follower failed')
            })
          }
          replayPendingInteractions(ws, 'subscribe')
        } else if (msg.type === 'unsubscribe' && adminCaller) {
          ws.sessionFollower.stop()
          ws.sessionFollowerActive = false
          ws.filterSessionId = undefined
          sendFrame({ kind: 'subscribed', sessionId: null, assistantStream: false })
        } else if (msg.type === 'unsubscribe') {
          ws.sessionFollower.stop()
          ws.sessionFollowerActive = false
          ws.filterSessionId = undefined
          // Contract §4: `unsubscribe` → `unsubscribed` (not the upstream
          // `subscribed` echo), echoing the requestId (contract §1).
          sendFrame({ kind: 'unsubscribed',
            ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}) })
        } else if (msg.type === 'question-answer' || msg.type === 'question-cancel') {
          trackInFlight(ws, msg, respondToQuestion(msg, msg.type === 'question-cancel')).then((frame) => {
            if (frame) sendFrame(frame)
          })
        } else if (msg.type === 'approval-response') {
          // `respondToApproval` answers an already-decided request with a
          // `not-pending` receipt; that is not a failure, so it is sent as-is
          // with this request's id.
          trackInFlight(ws, msg, respondToApproval(msg)).then((frame) => {
            if (frame) sendFrame({ ...frame, ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}) })
          })
        } else if (msg.type === 'file-list' || msg.type === 'file-resolve' || msg.type === 'file-download-open' ||
                   msg.type === 'file-download-read' || msg.type === 'file-download-cancel') {
          trackInFlight(ws, msg, fileTransfers.handle(ws, msg)).then((frame) => {
            if (frame) sendFrame(frame)
          })
        } else if (msg.type === 'message') {
          if (Array.isArray(msg.files) && msg.files.length > 0 && !options.fileUploadsEnabled) {
            sendFrame({ kind: 'error', code: 'file-upload-disabled', requestType: 'message',
              ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
              message: 'File attachments require paired-device file upload access' })
            return
          }
          if (!adminCaller) {
            // Contract §4: `sessionId` is required — a companion never creates a
            // session implicitly; it prompts an existing one, idempotently by
            // `clientMsgId`.
            const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined
            const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : ''
            if (!sessionId) {
              sendFrame({ kind: 'error', code: 'bad-request', requestType: 'message',
                ...(requestId ? { requestId } : {}), message: 'message requires an existing sessionId' })
              return
            }
            const clientMsgId = typeof msg.clientMsgId === 'string' ? msg.clientMsgId.trim() : ''
            if (!clientMsgId || clientMsgId.length > 128) {
              sendFrame({ kind: 'error', code: 'bad-request', requestType: 'message',
                ...(requestId ? { requestId } : {}), message: 'message requires a clientMsgId of 1..128 characters' })
              return
            }
            const duplicate = lookupSentFrame(ws.deviceId, clientMsgId)
            if (duplicate) {
              // Idempotent retry: the original `sent` frame, with this request's id.
              ws.send(stringifyWireFrame({ ...duplicate, ...(requestId ? { requestId } : {}) }))
              return
            }
            trackInFlight(ws, msg, admitMessage(connApi, msg)).then((frame) => {
              if (frame) ws.send(stringifyWireFrame(rememberSentFrame(ws.deviceId, clientMsgId, frame)))
            })
            return          }
          // Admin channel (loopback): upstream semantics, including creating a
          // session when `sessionId` is omitted. Owner Peer by design (T022a).
          admitMessage(api, msg).then((frame) => {
            if (frame) sendFrame(frame)
          })
        } else if (msg.type === 'sessions' || msg.type === 'search' || msg.type === 'history' || msg.type === 'session-cancel') {
          // The remaining contract §4 read/control operations, mapped onto the
          // upstream handlers. `sessions` returns the upstream list projection
          // (title in `projections.values.title`), `history` the upstream page,
          // `search` the upstream search frame and `session-cancel` the
          // `session-cancelled` receipt.
          const requestId = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
          // T022a: a device token reads and cancels through its own non-owner Peer.
          const queryApi = adminCaller ? api : connApi
          trackInFlight(ws, msg, handleQuery(queryApi, queryApi, agentDefaultModel, msg, {})).then((frame) => {
            sendFrame(frame
              ? { ...frame, ...requestId }
              : { kind: 'error', code: 'bad-request', requestType: msg.type, ...requestId, message: `${msg.type} could not be served` })
          })
        } else if (adminCaller && (PLUGIN_REQUEST_TYPES.has(msg.type) || SCHEDULE_REQUEST_TYPES.has(msg.type)
          || msg.type === 'agent-team' || msg.type === 'subagents' || msg.type === 'workspaces'
          || msg.type === 'attachment' || msg.type === 'host' || msg.type === 'directories'
          || msg.type === 'directory-create' || msg.type === 'workspace-create' || msg.type === 'session-create'
          || msg.type === 'models' || msg.type === 'commands' || msg.type === 'command-execute'
          || msg.type === 'command-options' || msg.type === 'command-select' || msg.type === 'select-model'
          || msg.type === 'permission-options' || msg.type === 'permission' || msg.type === 'context-usage'
          || msg.type === 'agent-presets' || msg.type === 'session-agent-preset' || msg.type === 'select-agent-preset'
          || msg.type === 'defaults' || msg.type === 'set-default' || msg.type === 'session-stats'
          || msg.type === 'default-model' || msg.type === 'save-default-model' || msg.type === 'fork'
          || msg.type === 'queue-update' || msg.type === 'session-archive' || msg.type === 'session-rename'
          || msg.type === 'providers' || msg.type === 'tasks' || msg.type === 'goal' || msg.type === 'goal-edit'
          || msg.type === 'goal-pause' || msg.type === 'goal-resume' || msg.type === 'goal-clear')) {
          // Admin channel only (owner on the DSH loopback listener): the upstream
          // management surface. A device token never reaches this branch (T022).
          handleQuery(api, host, agentDefaultModel, msg, {
            onInstallStart: (requestId) => pluginInstallOwners.set(requestId, ws),
            onInstallEnd: (requestId) => pluginInstallOwners.delete(requestId),
          }).then((frame) => {
            if (frame) sendFrame(frame)
          })
        } else {
          ws.send(stringifyWireFrame({ kind: 'error', code: OP_FORBIDDEN, requestType: msg.type,
            ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
            message: 'unknown message type: ' + msg.type }))
        }
      })

      ws.on('close', () => {
        remoteChannel?.close()
        speechInput.closeClient(ws)
        ws.sessionFollower.stop()
        // T022a: the device's Peer lives exactly as long as this connection;
        // disposing it makes the Gateway refuse any in-flight call and cancel
        // its open streams.
        void devicePeer?.release()
        clients.delete(ws)
        if (ws.deviceId) registry.disconnected(ws.deviceId)
        releaseUnclaimedInteractions()
        fileTransfers.closeClient(ws).catch((error) => {
          log(`file download cleanup failed: ${error && error.message ? error.message : String(error)}`)
        })
        fileUploads.closeClient(ws).catch(error => log(`file upload cleanup failed: ${error.message}`))
        log(`client disconnected (id=${id}, remaining=${clients.size})`)
      })

      log(`client connected (id=${id}, total=${clients.size})${device ? ' device=' + device.name : ''} channel=${channel}`)
      if (paired) {
        ws.send(stringifyWireFrame({
          kind: 'paired',
          token: paired.token,
          device: paired.device,
          ...gatewayIdentity,
        }))
      }
      sendFrame(helloFrame(device, transport))
      // Reviewer 36d9 #4: per-recipient reduction (see `aggregateFrameFor`).
      if (ws.mobileChannel !== 'conversation' && archivedSessionIds !== null) {
        sendAggregateBaseline(ws, { kind: 'session-archives', archivedSessionIds })
      }
      if (ws.mobileChannel !== 'conversation' && sessionQueues !== null) {
        sendAggregateBaseline(ws, { kind: 'session-queues', queues: Object.fromEntries(sessionQueues) })
      }
      if (ws.mobileChannel !== 'conversation') {
        sendAggregateBaseline(ws, { kind: 'projection-baseline', projections: sessionProjectionBaselines })
      }
      replayPendingInteractions(ws, 'connect')
      return ws
    }
    rtc = createTransportNegotiator({
      config: transportSettings, identity: gatewayIdentity,
      isAuthorized: deviceId => remoteControlEnabled() && gatewayEnabled && registry.list().some(device => device.id === deviceId),
      onBootstrapPresence(deviceId, online) {
        if (online) { registry.connected(deviceId); markDeviceConnected() }
        else registry.disconnected(deviceId)
      },
      log,
    })

    // ---- Spec 008 P1b: pairing with manual Host approval -------------------
    // A pairing socket is a restricted state machine, NOT a MobileConnection: it
    // never joins `clients`, never gets a message handler beyond the two frames
    // below, and holds no credential until the Host user approves. Everything
    // else a client sends on it is refused and counted; it is never dispatched.
    const pairingRequests = createPairingRequests({
      // Test-only override (never set by the bundle): shortens the 5-minute wait.
      pendingTtlMs: Number.isSafeInteger(options.testPendingTtlMs) && options.testPendingTtlMs > 0 ? options.testPendingTtlMs : undefined,
      // 5-minute timeout: tell the waiting client and drop the socket.
      onExpire: (request) => pendingSockets.get(request.id)?.end('pairing/expired', CLOSE_PAIRING_EXPIRED),
    })
    /** request id -> { socket, end(reason, code) }; the live socket of a pending request. */
    const pendingSockets = new Map()
    /** Long-pairing-string codes held by a pending request (one request per code). */
    const reservedLongCodes = new Set()
    const pendingSweep = setInterval(() => pairingRequests.prune(), 5_000)
    pendingSweep.unref?.()
    // The owner switch off (or gateway disabled): a waiting request is refused
    // and its OTP offers are dropped.
    endPendingPairings = () => {
      for (const waiting of [...pendingSockets.values()]) waiting.end('pairing/disabled', CLOSE_PAIRING_REJECTED)
      pairingRequests.clear()
    }

    const acceptPendingSocket = (socketClient, { req, clientDeviceId, deviceName, transport, longCode }) => {
      const certSha256 = transport.certSha256
      const clientIp = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
      const serverNonce = crypto.randomBytes(24).toString('base64url')
      let state = longCode !== undefined ? 'proof-long' : 'proof-otp'
      let request
      let clientNonce
      let finished = false
      let refused = 0
      const send = (frame) => { if (socketClient.readyState === 1) socketClient.send(stringifyWireFrame(frame)) }
      // Drop every listener this restricted state machine added, so the socket
      // can be handed to a MobileConnection (approve) without our handlers left on it.
      let detach = () => {}
      const finish = (reason, code) => {
        if (finished) return
        finished = true
        clearTimeout(handshakeTimer)
        if (request) {
          pairingRequests.take(request.id)
          pendingSockets.delete(request.id)
        }
        if (longCode !== undefined) reservedLongCodes.delete(longCode)
        if (reason) send({ kind: 'pairing-rejected', reason })
        try { socketClient.close(code ?? CLOSE_PAIRING_REJECTED, reason ?? 'pairing ended') } catch { /* already gone */ }
      }
      // A connection that never proves anything is dropped, so idle sockets
      // cannot pile up while holding no state at all.
      const handshakeTimer = setTimeout(() => { if (!request) finish('pairing/timeout', 4408) }, PAIRING_HANDSHAKE_MS)
      handshakeTimer.unref?.()
      const onError = () => {}
      const onClose = () => {
        // A client that goes away takes its pending request with it.
        if (finished) return
        finished = true
        clearTimeout(handshakeTimer)
        if (request) {
          pairingRequests.take(request.id)
          pendingSockets.delete(request.id)
          log(`pending pairing dropped: client disconnected (${request.id})`)
        }
        if (longCode !== undefined) reservedLongCodes.delete(longCode)
      }
      socketClient.on('error', onError)
      socketClient.on('close', onClose)

      const admit = (offer) => {
        request = pairingRequests.addPending({ offer, name: deviceName, clientIp, certSha256, clientNonce, serverNonce, deviceId: clientDeviceId })
        if (!request) { finish('pairing/busy', CLOSE_PAIRING_REJECTED); return }
        state = 'pending'
        pendingSockets.set(request.id, {
          socket: socketClient,
          transport,
          end: finish,
          // Approve re-checks this after its (possibly stalled) body read: the
          // state machine must be unfinished and the socket still OPEN.
          live: () => !finished && socketClient.readyState === 1,
          // Called by Approve, after the request left the table. Marks this
          // state machine done and removes its listeners; the socket is then the
          // caller's to activate.
          release() {
            finished = true
            clearTimeout(handshakeTimer)
            if (longCode !== undefined) reservedLongCodes.delete(longCode)
            detach()
          },
          // Issue the token through the existing claim path (single use,
          // cert-bound, a re-pair bumps the generation). The grant is the offer
          // narrowed by the Host user: a long string's own offer is claimed as is
          // when nothing was narrowed; otherwise it is spent and an equivalent
          // narrower offer is claimed in its place, so the string cannot be reused.
          claim(grantedScopes) {
            const same = grantedScopes.length === request.requestedScopes.length
            if (longCode !== undefined && same) return registry.claimPairing(longCode, clientDeviceId, request.name, { certSha256 })
            if (longCode !== undefined) registry.claimPairing(longCode, clientDeviceId, request.name, { certSha256 })
            const narrowed = registry.createPairing(request.name, { kind: request.kind, scopes: grantedScopes, certSha256 })
            return registry.claimPairing(narrowed.code, clientDeviceId, request.name, { certSha256 })
          },
        })
        log(`pairing pending: ${request.name} (${request.id}) from ${clientIp}, kind=${request.kind}, scopes=${request.requestedScopes.join(', ')}`)
        send({ kind: 'pairing-pending', verificationCode: request.verificationCode, requestId: request.id, expiresAt: request.expiresAt })
      }

      send({ kind: 'pairing-challenge', serverNonce, certSha256, otpRequired: longCode === undefined })

      const onMessage = (data) => {
        let msg
        try { msg = JSON.parse(data.toString()) } catch { msg = undefined }
        // Only the proof is accepted, and only once and only before a request exists.
        if (state === 'pending' || finished || !msg || msg.type !== 'pairing-proof' || state === 'proof-done') {
          refused += 1
          send({ kind: 'error', code: OP_FORBIDDEN, requestType: typeof msg?.type === 'string' ? msg.type : 'unknown',
            message: 'only the pairing proof is accepted before the Host approves' })
          if (refused >= 3) finish('pairing/refused', CLOSE_PAIRING_REJECTED)
          return
        }
        if (typeof msg.clientNonce !== 'string' || !PAIRING_NONCE.test(msg.clientNonce)) {
          finish('pairing/bad-nonce', CLOSE_PAIRING_REJECTED)
          return
        }
        clientNonce = msg.clientNonce
        if (!remoteControlEnabled() || !gatewayEnabled) { finish('pairing/disabled', CLOSE_PAIRING_REJECTED); return }
        if (longCode !== undefined) {
          // The long string is itself the secret (existing path). Reserve it so a
          // second connection cannot raise a second request with the same code.
          const offer = registry.pairingOffer(longCode)
          if (!offer || reservedLongCodes.has(longCode)) { finish('pairing/expired', CLOSE_PAIRING_EXPIRED); return }
          if (offer.certSha256 && offer.certSha256 !== String(certSha256).toLowerCase()) { finish('pairing/expired', CLOSE_PAIRING_EXPIRED); return }
          reservedLongCodes.add(longCode)
          state = 'proof-done'
          admit({ kind: offer.kind, scopes: offer.scopes })
          return
        }
        const result = pairingRequests.verifyProof({ proof: msg.otpProof, certSha256, clientNonce, serverNonce })
        if (!result.ok) {
          log('pairing proof rejected (wrong or expired one-time code)')
          // Wrong proof: one attempt spent. The code may be burned by now; either
          // way this socket is done, the client retries on a fresh connection.
          finish('pairing/expired', CLOSE_PAIRING_EXPIRED)
          return
        }
        state = 'proof-done'
        admit(result.offer)
      }
      socketClient.on('message', onMessage)
      detach = () => {
        socketClient.off('message', onMessage)
        socketClient.off('close', onClose)
        socketClient.off('error', onError)
      }
    }

    const handleMobileUpgrade = (req, socket, head, transport = {}) => {
        // T013: the owner switch gates every WebSocket entry point — the DSH
        // loopback route, the TLS listener and the rtc bootstrap all arrive
        // here. HTTP 403 + the contract error code, so
        // a companion can tell "off" apart from "bad credential" (401).
        if (!remoteControlEnabled()) {
          rejectUpgrade(socket, REMOTE_DISABLED_STATUS, `${REMOTE_DISABLED}: remote control is disabled by the owner`)
          return
        }
        // Spec 005 FR5: before `gatewayEnabled`, so a foreign Origin is refused
        // (403) even while the gateway is off, and it learns nothing about what
        // it presented.
        if (!originAllowed(req, allowedOrigins)) {
          log(`auth rejected: WebSocket upgrade from a foreign Origin (${String(req.headers.origin).slice(0, 200)})`)
          rejectUpgrade(socket, 403, 'Origin is not an allowed WebSocket origin')
          return
        }
        if (!gatewayEnabled) {
          rejectUpgrade(socket, 503, 'mobile gateway is disabled')
          return
        }
        // T020/T023 (FR-004, FR-007): a credential in the URL query is refused
        // on every listener, valid or not. The QR tells the client to use the
        // `dsh-pair.` subprotocol or the `Authorization` header.
        if (queryCredentialParams(req).length > 0) {
          log('auth rejected: credential in the URL query')
          rejectUpgrade(socket, 401, 'auth/required: credentials in the URL query are not accepted')
          return
        }
        // The pin is a client-side check against the certificate the plugin TLS
        // listener presents (contract §3.1). The plaintext DSH loopback route
        // presents none, so a device credential redeemed there would skip the
        // pin completely — a stolen token could then be replayed from anywhere
        // the loopback server answers. Fail closed: a companion credential is
        // accepted ONLY on the plugin-owned TLS listener, and a plaintext
        // listener that is not loopback serves nobody at all. The unauthenticated
        // branch below is untouched (it is the owner/admin path, and T023 refuses
        // it as well).
        const credential = extractCredential(req)
        // Contract §3: the credential is accepted only on the plugin's OWN TLS
        // listener. `req.socket.encrypted` alone is not enough — a shared web
        // server that happens to be encrypted would satisfy it without the pin,
        // and the pin exists only on the plugin listener. The plugin TLS call
        // site sets `transport.tls = true`; nothing else may claim it.
        const tlsListener = transport.tls === true
        if (!tlsListener) {
          if (!isLoopback(req)) {
            const source = String(req.socket?.remoteAddress ?? 'unknown')
            log(`auth rejected: plaintext WebSocket upgrade from a non-loopback source (${source})`)
            rejectUpgrade(socket, 403, 'plaintext WebSocket is loopback-only; remote control requires the gateway TLS listener')
            return
          }
          if (credential) {
            log('auth rejected: device credential presented on the plaintext loopback route')
            rejectUpgrade(socket, 401, 'auth/required: device credentials are accepted only on the gateway TLS listener')
            return
          }
        }
        let device
        let paired
        // Spec 005 review: the credential generation this upgrade authenticated
        // with, captured here and carried to the socket that gets activated.
        let credentialGeneration
        // Spec 008 P1b: the OTP flow and (with `requireHostApproval`) the long
        // pairing string never reach `claimPairing` here. They upgrade into a
        // restricted socket that can only prove the code and then wait for the
        // Host user (see `acceptPendingSocket`).
        const otpFlow = parseProtocols(req).includes(PAIR_OTP_PROTOCOL)
        if ((otpFlow || (credential && credential.kind === 'pairing' && options.requireHostApproval !== false))
            && !(credential && credential.kind === 'token')) {
          const clientDeviceId = extractClientDeviceId(req)
          if (!clientDeviceId) {
            log('pairing rejected: missing or invalid stable device ID')
            rejectUpgrade(socket, 400, 'pairing requires a stable device ID via X-DSH-Device-ID or dsh-device.<id>')
            return
          }
          if (!transport.certSha256) {
            log('pairing rejected: the redeeming listener presented no certificate to bind the proof to')
            rejectUpgrade(socket, 401, 'pairing/expired: pairing must be claimed over the gateway TLS listener')
            return
          }
          const longCode = !otpFlow && credential && credential.kind === 'pairing' ? credential.value : undefined
          if (longCode !== undefined && !registry.hasPairing(longCode)) {
            log('pairing rejected: invalid, expired, already-used code')
            rejectUpgrade(socket, 401, 'pairing/expired: invalid or expired pairing code')
            return
          }
          wss.handleUpgrade(req, socket, head, (socketClient) => acceptPendingSocket(socketClient, {
            req, clientDeviceId, deviceName: extractClientDeviceName(req), transport, longCode,
          }))
          return
        }
        if (credential && credential.kind === 'pairing') {
          const clientDeviceId = extractClientDeviceId(req)
          if (!clientDeviceId) {
            log('pairing rejected: missing or invalid stable device ID')
            rejectUpgrade(socket, 400, 'pairing requires a stable device ID via X-DSH-Device-ID or dsh-device.<id>')
            return
          }
          // T019: the offer remembers the certificate the QR pinned; a code
          // redeemed over another listener certificate is refused.
          paired = registry.claimPairing(credential.value, clientDeviceId, extractClientDeviceName(req),
            { certSha256: transport.certSha256 })
          device = paired && paired.device
          if (!device) {
            log('pairing rejected: invalid, expired, already-used, or certificate-mismatched code')
            rejectUpgrade(socket, 401, 'pairing/expired: invalid or expired pairing code')
            return
          }
          // Spec 005 review: a code claimed for an installation that is already
          // paired replaces that device's token AND scopes. Everything the old
          // grant opened is closed with the revoke code before this connection
          // exists, so a narrowing re-pair cannot leave a socket holding the
          // wider grant behind. A socket that authenticated in the meantime is
          // caught by the generation check in the message handler.
          if (paired.repaired) {
            rtc?.closeDevice(device.id)
            void deviceAccess.revoke(device.id)
            for (const client of clients) {
              if (client.deviceId === device.id) client.close(CLOSE_REVOKED, 'credential re-paired')
            }
            deviceClientMessages.delete(device.id)
            log(`device re-paired: ${device.id}, previous connections closed`)
          }
          credentialGeneration = paired.generation
        } else if (credential && credential.kind === 'token') {
          device = registry.authenticate(credential.value, extractClientDeviceId(req), extractClientDeviceName(req))
          if (device) credentialGeneration = registry.generation(device.id)
        }

        // T019: when the upgrade arrived without a listener transport hint it
        // carries no certificate to compare. The offer then binds the client to
        // the Host certificate it *will* pin on the `wss://` listener it was
        // issued for, so a shipped phone (which always reports it) matches and
        // a claim that cannot report it is refused.
        if (paired && !transport.certSha256) {
          log('pairing rejected: the redeeming listener presented no certificate to compare with the offer')
          rejectUpgrade(socket, 401, 'pairing/expired: pairing must be claimed over the gateway TLS listener')
          return
        }

        // T023 (FR-007): authentication is always required, on every listener.
        if (!device) {
          logAuthRejected(req)
          rejectUpgrade(socket, 401, 'auth/required: missing or invalid device credential', req.headers['x-dsh-gateway-probe'])
          return
        }

        wss.handleUpgrade(req, socket, head, socketClient => {
          const requestedChannel = req.headers['x-dsh-channel']
          const channel = ['control', 'conversation'].includes(requestedChannel) ? requestedChannel : 'legacy'
          if (!paired && device && channel === 'control' && req.headers['x-dsh-transport-intent'] === 'negotiate-v1' && rtc.available) {
            // Spec 005 re-review: `attach` answers with the transport hello before
            // any business channel is activated, so the credential is checked
            // again here — a stale generation must not even get the hello.
            if (!credentialStillLive(device.id, credentialGeneration)) {
              log(`stale credential refused before the transport hello: device=${device.id}`)
              try { socketClient.close(CLOSE_REVOKED, 'credential is no longer valid') } catch (error) { /* socket already gone */ }
              return
            }
            // T022: the RTC business channels get the same transport flags as a
            // plain WebSocket session (the test-only admin channel included).
            const businessTransport = { ...transport, legacyAdmin: options.legacyAdmin === true }
            rtc.attach({ socket: socketClient, device, hello: helloFrame(device, businessTransport),
              activate: (adapter, selectedChannel) => startBusinessConnection(
                () => activateBusinessConnection(adapter, device, selectedChannel, businessTransport, null, credentialGeneration),
                { deviceId: device.id, channel: selectedChannel, paired: false }) })
          } else {
            // `transport.tls` marks the plugin-owned TLS listener; the pin is
            // enforced by the client (contract §3.1, test/tls-pin.test.mjs), not
            // by a header, because a legitimate interception proxy may present
            // its own certificate to the phone.
            startBusinessConnection(() => activateBusinessConnection(new WebSocketMobileTransport(socketClient), device, channel,
              { ...transport, legacyAdmin: options.legacyAdmin === true }, paired, credentialGeneration),
              { deviceId: device.id, channel, paired: !!paired })
          }
        })
    }

    const disposeUpgrade = webServer.registerUpgrade({
      path: wsPath,
      handler(req, socket, head) {
        handleMobileUpgrade(req, socket, head, { port: webServer.port })
      },
    })
    log(`upgrade route registered: ${wsPath}`)

    // T017 (FR-001/FR-003, R2): the plugin owns a TLS listener for remote
    // clients. `lanEnabled: false` (the default) means no listener at all; the
    // loopback DSH route above keeps the admin UI and local clients working.
    // When the owner enables LAN access it is opened only while the switch is
    // on, and it serves nothing but the pinned mobile WebSocket over TLS.
    // T014: the same factory re-opens it after a switch-off/on cycle, and
    // POST /mgw/listen moves it to another local address through it.
    // The listen host is `options.lanHost` (mutated by a rebind); what the socket
    // really binds is `bindHost()`. The two differ only in a test, where a target
    // address this machine does not own is aliased onto one it does — `listen()`
    // refuses a foreign address with EADDRNOTAVAIL, and the status and advertised
    // URLs keep naming the logical host either way.
    const bindHost = () => {
      const aliases = testSeamsInForce.listenAliases
      // Own key only: a `lanHost` that happens to spell an Object.prototype
      // member must never resolve to something inherited.
      if (!Object.hasOwn(aliases, options.lanHost)) return options.lanHost
      const target = aliases[options.lanHost]
      // Re-checked at the bind, not only when the seam was sealed: the rule is
      // the security property, so a value that no longer passes is refused the
      // same way a bad real bind is — the attempt fails and nothing is bound.
      if (typeof target !== 'string' || !isBindableListenHost(target)) {
        throw new Error(`mobile-gateway: test listen alias ${options.lanHost} -> ${String(target)} must be a loopback or private address`)
      }
      return target
    }
    openLanListener = () => {
      if (options.lanEnabled !== true || gatewayEnabled !== true || lanServer) return null
      // Resolved and validated once, synchronously before this attempt binds, so
      // the alias that really reaches `listen()` passed the rule just now and
      // not merely when the seam was sealed (Blocker, round 2). A refused alias
      // fails the attempt and binds nothing, exactly like a real bind the OS
      // would refuse; the busy-port retry below reuses the same address.
      let bindAddress
      try {
        bindAddress = bindHost()
      } catch (error) {
        lanListening = false
        lanListenError = error && error.message ? error.message : String(error)
        log(`TLS listener failed: ${lanListenError}`)
        const refused = beginLanAttempt()
        settleLanAttempt(refused, { ok: false, error: lanListenError })
        return refused
      }
      const listener = https.createServer(tlsServerOptions(tlsIdentity), (req, res) => {
        // No management surface, no WebUI, no pairing endpoint on the TLS port.
        sendJson(res, 404, { error: 'not-found' })
      })
      // The generation this listener belongs to: only its own events may settle
      // it, and a rebind waits on exactly this attempt (Blocker 3).
      const attempt = beginLanAttempt()
      lanServer = listener
      listener.on('connection', (socket) => {
        tlsSockets.add(socket)
        socket.once('close', () => tlsSockets.delete(socket))
      })
      listener.on('tlsClientError', () => {
        // A client that rejects the pin never reaches HTTP; nothing to log.
      })
      listener.on('upgrade', (req, socket, head) => {
        let pathname
        try {
          pathname = new URL(req.url || '/', 'https://lan.invalid').pathname
        } catch (error) {
          rejectUpgrade(socket, 400, 'invalid WebSocket path')
          return
        }
        if (pathname !== wsPath) {
          rejectUpgrade(socket, 404, 'not found')
          return
        }
        if (!req.socket || !req.socket.remoteAddress || !isAllowedMobileSource(req.socket.remoteAddress)) {
          rejectUpgrade(socket, 403, 'remote listener accepts private-network clients only (FR-003)')
          return
        }
        // The pin this listener actually presents: a pairing code issued for a
        // different certificate cannot be redeemed here.
        handleMobileUpgrade(req, socket, head, { lan: true, port: lanBoundPort, tls: true, certSha256: tlsIdentity.fingerprint256 })
      })
      // A busy port must not be fatal: with a configured non-zero port the
      // listener shifts forward one port at a time (at most LAN_PORT_ATTEMPTS
      // ports) so one takeover cannot leave the gateway without its listener.
      // `0` still means "let the OS pick" and never shifts; any other listen
      // error (EACCES, EADDRNOTAVAIL, …) keeps the old give-up behaviour.
      const LAN_PORT_ATTEMPTS = 10
      const configuredPort = lanBoundPort
      // A shift must stay inside the 16-bit port range: `listen(65536)` throws
      // RangeError synchronously, which would escape this event handler.
      const lastAttemptPort = Math.min(configuredPort + LAN_PORT_ATTEMPTS - 1, 65_535)
      let attemptPort = configuredPort
      listener.on('error', (error) => {
        // An event from a listener a later attempt already replaced must not
        // touch the flags (or the settle) of the attempt in force (Blocker 3).
        if (attempt.generation !== lanGeneration) return
        // A retry after dispose (teardown closes `lanServer` without clearing
        // it) would bring the port back up and keep it: never shift then.
        const exhausted = error && error.code === 'EADDRINUSE' && configuredPort !== 0
          && listener === lanServer && !lanListening && !disposed
        if (exhausted && attemptPort < lastAttemptPort) {
          const busyPort = attemptPort
          attemptPort += 1
          log(`TLS listener port ${busyPort} is busy; trying ${attemptPort}`)
          // Node drops the handle of a failed bind, so the SAME server can
          // listen again: the upgrade handler, the TLS options and the
          // `lanServer` teardown reference keep pointing at the listener that
          // really binds, and no superseded server keeps a port.
          listener.listen(attemptPort, bindAddress)
          return
        }
        lanListening = false
        // Name the whole range that was tried, not just the last port.
        lanListenError = exhausted
          ? `EADDRINUSE: ports ${configuredPort}-${lastAttemptPort} are all in use`
          : error && error.message ? error.message : String(error)
        log(`TLS listener failed: ${lanListenError}`)
        settleLanAttempt(attempt, { ok: false, error: lanListenError })
      })
      listener.on('listening', () => {
        if (attempt.generation !== lanGeneration) return
        lanListening = true
        lanListenError = null
        const address = listener.address()
        if (address && typeof address === 'object') lanBoundPort = address.port
        const urls = lanWebSocketUrls(options, wsPath, lanBoundPort)
        const shiftNote = configuredPort !== 0 && lanBoundPort !== configuredPort ? `; configured ${configuredPort} was busy` : ''
        // The certificate covers the hostnames a phone may dial; a rotation
        // widens the SAN list only for a later explicit regeneration.
        log(`TLS listener ready: ${options.lanHost}:${lanBoundPort}${wsPath}${urls.length ? ` (${urls.join(', ')})` : ''}${shiftNote}; certSha256=${tlsIdentity.fingerprint256}; authentication forced`)
        settleLanAttempt(attempt, { ok: true })
      })
      listener.listen(configuredPort, bindAddress)
      return attempt
    }
    // POST /mgw/listen: move the listener to another local address. The close and
    // re-open go through the SAME factory, so the retry loop (a busy port shifts
    // forward) and every security property of the listener apply unchanged.
    //
    // Serialized (Blocker 3): a second request waits here for the first one and
    // then applies, so exactly one listener exists at a time, rollback never
    // closes somebody else's listener, and the saved address is the one the
    // winning generation confirmed.
    //
    // Two honest limits of a rebind (Should-fix 6, also stated in PROTOCOL.md §15):
    // 1. there IS a deaf interval — the old socket closes before the new bind, so
    //    for up to `LAN_SETTLE_TIMEOUT_MS` nothing answers on either address;
    // 2. `server.close()` does not terminate upgraded WebSockets, so connections
    //    already upgraded on the OLD address survive the move — they are not
    //    severed (that is the kill switch's job), while the new address accepts
    //    new ones.
    rebindLanListener = (host) => inLanLane(async () => {
      if (disposed || options.lanEnabled !== true || gatewayEnabled !== true) throw listenAbortedError()
      const previousHost = options.lanHost
      // Rollback restores the port too: the failed attempt may have been asked
      // for another one, and the previous port is the one phones already know.
      const previousPort = lanBoundPort
      closeRemoteListeners()
      options.lanHost = host
      // A previous failure must not fail the new attempt before it started.
      lanListenError = null
      const attempt = openLanListener()
      const outcome = await awaitLanSettled(attempt)
      // Superseded (disposal, the owner switch, a later change): this request no
      // longer owns the listener and must not roll anything back.
      if (outcome === null) throw listenAbortedError()
      if (outcome.ok) {
        // Persisted only after the bind the winning generation confirmed, so an
        // address this process could not bind never comes back on the next
        // start. A failed write leaves the address in force for this run and
        // reports `persists:false`.
        let persists = false
        try {
          gatewayState.setListenHost(host)
          persists = true
        } catch (error) {
          log(`listen address ${host} was not persisted: ${error.message}`)
        }
        return {
          applied: host,
          port: lanBoundPort,
          persists,
          listening: true,
          // Captured here, inside the lane: the advertised URLs belong to the
          // listener this generation confirmed, not to a later one.
          urls: lanWebSocketUrls(options, wsPath, lanBoundPort),
        }
      }
      const failure = outcome.error || lanListenError || 'the TLS listener did not come up'
      // A failed rebind must not leave the gateway without a listener: go back to
      // the address AND port it was reachable on before, so a phone that already
      // knows that endpoint keeps working.
      closeRemoteListeners()
      options.lanHost = previousHost
      lanBoundPort = previousPort
      lanListenError = null
      const rollback = openLanListener()
      const rolled = await awaitLanSettled(rollback)
      if (rolled === null) throw listenAbortedError()
      throw new Error(rolled.ok
        ? `the listener could not be rebound to ${host} (${failure}); it is back on ${previousHost}`
        : `the listener could not be rebound to ${host} (${failure}) and did not come back on ${previousHost} (${rolled.error || lanListenError || 'no listener'})`)
    })
    openLanListener()

    const disposeEvents = ctx.on('session/event', (session, event) => {
      // Approval binding (T026): every `tool/call` is cached before any client
      // filter, because the approval join must work even when no client is
      // subscribed and even when no client is connected at all (replay later).
      // The key carries the event's session: DSH guarantees `agent.id ===
      // session.id` (agent registry `enter()`), so this is the same identity the
      // `approval/request` lookup uses, and a callId stays scoped to its session.
      if (event?.type === 'tool/call') {
        rememberToolCall(session?.id === undefined ? null : String(session.id),
          event.data?.callId, event.data?.name, event.data?.arguments)
      }
      api.observeSessionEvent(String(session.id), event)
      if (clients.size === 0) return
      const wire = buildWireEvent(session, event)
      if (!wire) return
      if (event.type === 'session/title' && typeof event.data?.title === 'string') {
        broadcastSessionMetadataFrame({
          kind: 'session-title-changed',
          sessionId: String(session.id),
          title: event.data.title,
          seq: event.seq,
          time: event.time,
          ...(event.data.source ? { source: event.data.source } : {}),
        })
      }
      if (event.type === 'agent-preset/selected' || event.type === 'turn/start') {
        broadcastSessionMetadataFrame({
          kind: 'session-agent-preset-updated', sessionId: String(session.id), seq: event.seq, time: event.time,
          ...(event.type === 'turn/start' ? { locked: true } : { agentPreset: event.data.agentPreset }),
        })
      }
      const payload = stringifyWireFrame(wire)
      for (const client of clients) {
        if (client.mobileChannel === 'control' || client.sessionFollowerActive) continue
        if (client.filterSessionId && client.filterSessionId !== String(session.id)) continue
        // Reviewer 537f M1: this raw stream is the same session READ data as the
        // subscription stream, so it takes the same per-recipient decision. An
        // unsubscribed legacy/conversation socket used to receive EVERY Host
        // session here (only the channel and the routing filter were checked),
        // including sessions the Host never listed to the device and devices
        // without `sessions:read`.
        if (!clientMayReceive(client, String(session.id))) continue
        if (client.readyState === 1) client.send(payload)
      }
    })
    log('session/event listener attached')

    // The Host notification has no payload: readers refetch the task catalog.
    const disposeScheduleChanged = ctx.on('schedule/changed', () => {
      if (clients.size > 0) broadcastSessionMetadataFrame({ kind: 'schedule-changed' })
    })
    // T022a: the EXACT session ids a device may see (DSH bindings take no
    // wildcard). Source: the owner adapter's `session/list`, the same rows the
    // owner sees. Refreshed on startup and on every session added/removed, and
    // the devices' DSH snapshots are invalidated after each refresh. A failed
    // refresh KEEPS the last good list and reports it: a stale id costs at most a
    // session that was just removed (the Host then answers not-found), never a
    // session that was never visible; and nothing is added on failure.
    //
    // Reviewer 36d9 #1/#2: the refresh is bounded (abort + timeout per
    // `session/list`), coalesced (at most ONE in flight plus ONE pending, however
    // many session events arrive), cancelled on teardown, and versioned. A
    // removal records a tombstone and bumps `removalVersion`; a response whose
    // refresh STARTED before that removal is stale for the removed id, so it
    // cannot bring it back. The tombstones are dropped only when a snapshot that
    // started after them is ACCEPTED (it reflects the removal itself); a failed,
    // aborted, timed-out or invalid refresh changes nothing.
    const VISIBLE_REFRESH_TIMEOUT_MS = Number.isSafeInteger(options.testVisibleRefreshTimeoutMs) && options.testVisibleRefreshTimeoutMs > 0
      ? options.testVisibleRefreshTimeoutMs : 10_000
    let removalVersion = 0
    const removedAtVersion = new Map() // sessionId -> removalVersion at removal
    let refreshInFlight = null // Promise of the running refresh
    let refreshPending = false // one more refresh requested while one was running
    let refreshAbort = null
    const runVisibleRefresh = async () => {
      const startedAtVersion = removalVersion
      const abort = new AbortController()
      refreshAbort = abort
      const timer = setTimeout(() => abort.abort(new Error('session/list timed out')), VISIBLE_REFRESH_TIMEOUT_MS)
      try {
        const listed = await api.sessions.list({}, abort.signal)
        abort.signal.throwIfAborted()
        if (disposed) return
        const ids = Array.isArray(listed?.items)
          ? listed.items.map((item) => item?.sessionId).filter((id) => typeof id === 'string' && id.length > 0)
          : null
        if (ids === null) throw new Error('session/list returned an invalid list')
        // An id removed after this refresh started is not in the answer's
        // authority: the removal event is newer than the data.
        const fresh = ids.filter((id) => !((removedAtVersion.get(id) ?? 0) > startedAtVersion))
        visibleSessionIds = [...new Set(fresh)]
        // Accepted: tombstones at or before this refresh's start are reflected in
        // the Host's own list (it started after the removal) and can go.
        for (const [id, version] of removedAtVersion) if (version <= startedAtVersion) removedAtVersion.delete(id)
        deviceAccess.invalidate()
      } catch (error) {
        log(`visible session refresh failed (keeping the previous list): ${error && error.message ? error.message : String(error)}`)
      } finally {
        clearTimeout(timer)
        if (refreshAbort === abort) refreshAbort = null
      }
    }
    const refreshVisibleSessions = () => {
      if (disposed) return Promise.resolve()
      if (refreshInFlight) {
        refreshPending = true
        return refreshInFlight
      }
      refreshInFlight = (async () => {
        try {
          do {
            refreshPending = false
            await runVisibleRefresh()
          } while (refreshPending && !disposed)
        } finally {
          refreshInFlight = null
        }
      })()
      return refreshInFlight
    }
    const cancelVisibleRefresh = () => {
      refreshPending = false
      refreshAbort?.abort(new Error('plugin stopped'))
    }
    const disposeSessionStatus = ctx.on('api-session/status', (sessionId, running) => {
      broadcastSessionMetadataFrame({ kind: 'session-status', sessionId: String(sessionId), running })
    })
    const disposeSessionAdded = ctx.on('api-session/added', summary => {
      broadcastSessionMetadataFrame({ kind: 'session-status', sessionId: String(summary.sessionId), running: summary.running })
      void refreshVisibleSessions()
    })
    const disposeSessionRemoved = ctx.on('api-session/removed', sessionId => {
      broadcastSessionMetadataFrame({ kind: 'session-status', sessionId: String(sessionId), running: false })
      // Drop the id right away (no await): a removed session must not stay
      // grantable while the refreshed list is on its way.
      // The tombstone stores the version AFTER the bump: any refresh that started
      // before this point has `startedAtVersion < tombstone` and must ignore the id.
      removalVersion += 1
      removedAtVersion.set(String(sessionId), removalVersion)
      visibleSessionIds = visibleSessionIds.filter((id) => id !== String(sessionId))
      deviceAccess.invalidate()
      void refreshVisibleSessions()
    })
    void refreshVisibleSessions()

    const disposePluginsChanged = ctx.on('plugin-manager/changed', (change) => {
      if (clients.size > 0) broadcastSessionMetadataFrame({ kind: 'plugins-changed', reason: change?.reason })
    })
    const disposePluginSettingsChanged = ctx.on('settings/document-updated', (ns, revision) => {
      if (clients.size > 0) broadcastSessionMetadataFrame({ kind: 'plugin-settings-changed', ns, revision })
    })
    const sendPluginInstallEvent = (kind, event) => {
      const owner = pluginInstallOwners.get(event?.requestId)
      if (owner?.readyState === 1) owner.send(stringifyWireFrame({ kind, ...event }))
    }
    const disposePluginInstallState = ctx.on('plugin-manager/install-state', (progress) => {
      sendPluginInstallEvent('plugin-install-state', progress)
    })
    const disposePluginUpdateState = ctx.on('plugin-manager/update-state', progress => sendPluginInstallEvent('plugin-update-state', progress))
    const disposePluginInstallLog = ctx.on('plugin-manager/install-log', (chunk) => {
      if (!chunk?.requestId) return
      const { requestId, jobId, stream, text, exitCode } = chunk
      sendPluginInstallEvent('plugin-install-log', { requestId, jobId, stream, text,
        ...(exitCode === undefined ? {} : { exitCode }) })
    })

    const disposeQuestions = ctx.on('user-questions/request', (request, next) => {
      const sessionId = request?.agent?.id === undefined ? null : String(request.agent.id)
      // 与审批一致：网关开启时登记所有待答提问，让稍后连接或切换会话的设备也能接收重放。
      // 是否向某个连接实时广播仍由 broadcastInteractionFrame 的 sessionId 过滤器决定。
      if (!sessionId || !Array.isArray(request.questions) || !remoteControlEnabled() || !gatewayEnabled) return next()
      const rpcId = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const requestSignal = request.signal
        const downstreamAbort = new AbortController()
        request.signal = requestSignal
          ? AbortSignal.any([requestSignal, downstreamAbort.signal])
          : downstreamAbort.signal
        const onAbort = () => {
          const pending = pendingQuestions.get(rpcId)
          if (pending) completeQuestion(pending, 'cancel', undefined, 'ASK_ABORTED')
        }
        requestSignal?.addEventListener('abort', onAbort, { once: true })
        const pending = {
          rpcId,
          sessionId,
          questions: request.questions,
          // The tool-call id, when the caller named one (rc.1 `wait.callId`): it is
          // what a device answers with through `userQuestions/answer` (spec 008).
          ...(typeof request.wait?.callId === 'string' && request.wait.callId !== '' ? { callId: request.wait.callId } : {}),
          next,
          downstreamAbort,
          resolve,
          reject,
          cleanup: () => requestSignal?.removeEventListener('abort', onAbort),
        }
        pendingQuestions.set(rpcId, pending)
        broadcastQuestionFrame(questionFrameFor(rpcId, pending))
        startDownstreamQuestion(pending)
        log(`question requested: rpcId=${rpcId} session=${sessionId} questions=${request.questions.length}`)
      })
    }, { prepend: true })

    const disposeApprovals = ctx.on('approval/request', async (request, next) => {
      const sessionId = request?.agent?.id === undefined ? null : String(request.agent.id)
      if (!sessionId || typeof request.toolName !== 'string' || !remoteControlEnabled() || !gatewayEnabled) return next()
      // Content binding (T024/T026, FR-008): without a callId there is nothing to
      // join the arguments to, and without the raw arguments there is no hash the
      // phone could echo. `argsHash` is then `null` and the request is
      // desktop-only — delegate with `next()`, never create a remotely
      // decidable request (research V2: returning `undefined` rejects).
      const callId = typeof request.callId === 'string' && request.callId.trim() ? request.callId.trim() : null
      if (!callId) return next()
      const rawArguments = await waitForToolCallArguments(sessionId, callId, request.toolName, request.signal)
      // Everything below runs after an await, so the world may have changed while
      // the join waited: the owner may have switched remote control off, the
      // gateway may have been disabled, or the plugin may have been disposed. A
      // card created now would be unanswerable (nobody is there to decide it and
      // nothing would ever release it), so those cases delegate exactly like the
      // gate before the join. An aborted request keeps the outcome DSH itself
      // reports for one.
      if (request.signal?.aborted) return 'cancelled'
      if (disposed || !remoteControlEnabled() || !gatewayEnabled) return next()
      const argsHash = rawArguments === null
        ? null
        : approvalArgsHash({ toolName: request.toolName, callId, rawArguments })
      if (argsHash === null) return next()
      const rpcId = crypto.randomUUID()
      const approvalId = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const requestSignal = request.signal
        const downstreamAbort = new AbortController()
        request.signal = requestSignal
          ? AbortSignal.any([requestSignal, downstreamAbort.signal])
          : downstreamAbort.signal
        const onAbort = () => {
          const pending = pendingApprovals.get(rpcId)
          if (pending) completeApproval(pending, 'cancelled')
        }
        requestSignal?.addEventListener('abort', onAbort, { once: true })
        const pending = {
          rpcId,
          sessionId,
          approvalId,
          toolName: request.toolName,
          ...(request.callId !== undefined ? { callId: request.callId } : {}),
          ...(request.reason !== undefined ? { reason: request.reason } : {}),
          ...(request.displayReason !== undefined ? { displayReason: request.displayReason } : {}),
          argsHash,
          argsPreview: approvalArgsPreview(rawArguments),
          next,
          downstreamAbort,
          resolve,
          reject,
          cleanup: () => requestSignal?.removeEventListener('abort', onAbort),
        }
        pendingApprovals.set(rpcId, pending)
        broadcastInteractionFrame(approvalFrameFor(rpcId, pending))
        // 控制连接重连期间仍登记待审批，桌面端继续处理同一个请求。
        // 若桌面端仍在等待，后续连接可以重放；无可用答复时保持原有回退行为。
        startDownstreamApproval(pending)
        if (!hasInteractionClient(sessionId)) fallbackApproval(pending)
        log(`approval requested: rpcId=${rpcId} approvalId=${approvalId} session=${sessionId} tool=${request.toolName}`)
      })
    }, { prepend: true })

    const waitForBackgroundRetry = () => new Promise((resolve) => {
      if (backgroundStreamAbort.signal.aborted) {
        resolve()
        return
      }
      const finish = () => {
        clearTimeout(timer)
        backgroundStreamAbort.signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, 1_000)
      backgroundStreamAbort.signal.addEventListener('abort', finish, { once: true })
    })

    const installArchivedSessionIds = (value) => {
      if (!Array.isArray(value)) throw new Error('workspace/follow returned invalid archivedSessionIds')
      const next = value.map((sessionId) => String(sessionId))
      if (archivedSessionIds !== null
        && archivedSessionIds.length === next.length
        && archivedSessionIds.every((sessionId, index) => sessionId === next[index])) return
      archivedSessionIds = next
      broadcastSessionMetadataFrame({ kind: 'session-archives', archivedSessionIds: next })
      log(`session archive state forwarded: count=${next.length}`)
    }

    // DSH rc.1 carries pending messages in the durable inbox projection.
    // session/control no longer emits a separate queues baseline or queue frames.
    const queueItemsFromInbox = (value, endpoint) => {
      if (value == null) return []
      if (typeof value !== 'object' || Array.isArray(value)
        || !Array.isArray(value['next-turn']) || !Array.isArray(value['next-step'])) {
        throw new Error(`${endpoint} returned an invalid inbox projection`)
      }
      const convert = (messages, target) => messages.map((message) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)
          || typeof message.id !== 'string' || !message.id
          || !Array.isArray(message.content)
          || !message.source || typeof message.source.kind !== 'string'
          || (message.source.rpcId !== undefined && typeof message.source.rpcId !== 'string')) {
          throw new Error(`${endpoint} returned an invalid inbox message`)
        }
        const textParts = userMessageTextParts(message.content)
        return {
          id: message.id,
          placement: target === 'next-turn' ? 'queued' : message.source.kind === 'user' ? 'steering' : 'context',
          ...(message.source.rpcId === undefined ? {} : { rpcId: message.source.rpcId }),
          message: { id: message.id, content: message.content, ...(textParts ? { textParts } : {}) },
        }
      })
      return [...convert(value['next-turn'], 'next-turn'), ...convert(value['next-step'], 'next-step')]
    }

    const installSessionQueueBaseline = (projections) => {
      if (!projections || typeof projections !== 'object' || Array.isArray(projections)) {
        throw new Error('session/control baseline returned invalid projections')
      }
      const next = new Map()
      for (const [sessionId, baseline] of Object.entries(projections)) {
        const items = queueItemsFromInbox(baseline?.values?.inbox, 'session/control baseline')
        if (items.length > 0) next.set(sessionId, items)
      }
      sessionQueues = next
      broadcastSessionMetadataFrame({ kind: 'session-queues', queues: Object.fromEntries(next) })
      log(`session queue baseline forwarded: sessions=${next.size}`)
    }

    const installSessionQueue = (sessionIdValue, inboxValue) => {
      const sessionId = typeof sessionIdValue === 'string' && sessionIdValue ? sessionIdValue : null
      if (!sessionId) throw new Error('session/control returned an invalid queue sessionId')
      const items = queueItemsFromInbox(inboxValue, 'session/control inbox')
      if (sessionQueues === null) sessionQueues = new Map()
      if (items.length > 0) sessionQueues.set(sessionId, items)
      else sessionQueues.delete(sessionId)
      broadcastSessionMetadataFrame({ kind: 'session-queue', sessionId, items })
      log(`session queue forwarded: session=${sessionId} items=${items.length}`)
    }

    const projectionKinds = {
      todos: 'tasks-updated',
      goal: 'goal-updated',
      turnOutline: 'turn-outline-updated',
      ...TEAM_PROJECTION_KINDS,
    }
    const projectionValues = (values = {}) => Object.fromEntries(
      Object.keys(projectionKinds).map(key => [key, values[key] ?? null]),
    )
    const projectionFrame = (sessionId, key, value, seq) => ({
      kind: projectionKinds[key], sessionId, asOfSeq: seq,
      [key]: value,
    })
    const broadcastProjection = (sessionId, key, value, seq) => {
      const frame = projectionFrame(sessionId, key, value, seq)
      if (key === 'turnOutline' || Object.hasOwn(TEAM_PROJECTION_KINDS, key)) broadcastSessionMetadataFrame(frame)
      // todos/goal follow the subscription filter, but they are session READ
      // data, so the authorization is `sessions:read` + visible session, not the
      // approval scope the interaction default would demand.
      else broadcastInteractionFrame(frame, 'sessions:read')
    }

    const installProjectionBaseline = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid projection baseline')
      const next = {}
      for (const [sessionId, baseline] of Object.entries(value)) {
        if (!Number.isSafeInteger(baseline?.asOfSeq) || !baseline.values || typeof baseline.values !== 'object' || Array.isArray(baseline.values)) {
          throw new Error('invalid session projection baseline')
        }
        Object.defineProperty(next, sessionId, { enumerable: true, configurable: true, writable: true,
          value: { asOfSeq: baseline.asOfSeq,
            values: projectionValues(baseline.values) } })
      }
      const previous = sessionProjectionBaselines
      sessionProjectionBaselines = next
      broadcastSessionMetadataFrame({ kind: 'projection-baseline', projections: next })
      for (const sessionId of new Set([...Object.keys(previous), ...Object.keys(next)])) {
        const baseline = Object.hasOwn(next, sessionId) ? next[sessionId] : null
        for (const key of Object.keys(projectionKinds)) {
          broadcastProjection(sessionId, key, baseline?.values[key] ?? null,
            baseline?.asOfSeq ?? previous[sessionId].asOfSeq)
        }
      }
    }

    const workspaceTask = (async () => {
      while (!backgroundStreamAbort.signal.aborted) {
        try {
          const stream = await api.openWorkspaceStream(backgroundStreamAbort.signal)
          for await (const frame of stream) {
            if (frame?.type === 'baseline') {
              installArchivedSessionIds(frame.value?.archivedSessionIds)
            } else if (frame?.type === 'archived') {
              installArchivedSessionIds(frame.archivedSessionIds)
            }
          }
          if (!backgroundStreamAbort.signal.aborted) log('workspace stream ended; retrying')
        } catch (error) {
          if (!backgroundStreamAbort.signal.aborted) {
            log(`workspace stream failed; retrying: ${error && error.message ? error.message : String(error)}`)
          }
        }
        if (!backgroundStreamAbort.signal.aborted) await waitForBackgroundRetry()
      }
    })()
    void workspaceTask

    const controlTask = (async () => {
      while (!backgroundStreamAbort.signal.aborted) {
        try {
          const stream = await api.openControlStream(backgroundStreamAbort.signal)
          for await (const frame of stream) {
            if (frame?.type === 'baseline') {
              installProjectionBaseline(frame.value?.projections)
              installSessionQueueBaseline(frame.value?.projections)
            } else if (frame?.type === 'projection' && frame.key === 'inbox') {
              installSessionQueue(frame.sessionId, frame.value)
            } else if (frame?.type === 'projection' && Object.hasOwn(projectionKinds, frame.key)) {
              const sessionId = String(frame.sessionId)
              const previous = Object.hasOwn(sessionProjectionBaselines, sessionId) ? sessionProjectionBaselines[sessionId] : null
              const value = frame.value ?? null
              Object.defineProperty(sessionProjectionBaselines, sessionId, { enumerable: true, configurable: true, writable: true,
                value: { asOfSeq: frame.seq, values: { ...projectionValues(previous?.values), [frame.key]: value } } })
              broadcastProjection(sessionId, frame.key, value, frame.seq)
              log(`projection forwarded: key=${frame.key} session=${sessionId} seq=${frame.seq}`)
            }
          }
          if (!backgroundStreamAbort.signal.aborted) log('session control stream ended; retrying')
        } catch (error) {
          if (!backgroundStreamAbort.signal.aborted) {
            log(`session control stream failed; retrying: ${error && error.message ? error.message : String(error)}`)
          }
        }
        if (!backgroundStreamAbort.signal.aborted) await waitForBackgroundRetry()
      }
    })()
    void controlTask
    log('Host waterfall interaction listeners, workspace stream, and session control stream attached')

    ctx.effect(() => () => {
      // Disposal first, before anything else is torn down: an approval handler
      // parked in the ≤ 1 s argument join must not resume into a plugin that
      // looks alive and register a card, a broadcast or a waiter after teardown.
      // Cancelling the joins also drops their timers, so nothing keeps running.
      disposed = true
      // Blocker 3: a rebind or rollback parked on a listener must not outlive
      // the plugin — it is superseded here and answers 409 instead of touching a
      // listener that teardown is about to close.
      abortLanAttempts()
      cancelVisibleRefresh()
      for (const cancel of [...joinCancellers]) cancel()
      joinCancellers.clear()
      toolCallArguments.clear()
      toolCallWaiters.clear()
      toolCallChars = 0
      toolCallCount = 0
      clearInterval(pendingSweep)
      for (const waiting of [...pendingSockets.values()]) waiting.end('pairing/disabled', CLOSE_PAIRING_REJECTED)
      pairingRequests.clear()
      networkDiagnostics.dispose()
      if (waitTimer) clearTimeout(waitTimer)
      clearInterval(fileTransferExpiryTimer)
      backgroundStreamAbort.abort()
      deviceAccess.close().catch((error) => {
        log(`device peer teardown failed: ${error && error.message ? error.message : String(error)}`)
      })
      peer.dispose().catch((error) => {
        log(`Host peer disposal failed: ${error && error.message ? error.message : String(error)}`)
      })
      void rtc.dispose()
      speechInput.dispose()
      for (const pending of [...pendingQuestions.values()]) fallbackQuestion(pending)
      for (const pending of [...pendingApprovals.values()]) fallbackApproval(pending)
      fileTransfers.dispose().catch((error) => {
        log(`file download disposal failed: ${error && error.message ? error.message : String(error)}`)
      })
      fileUploads.dispose().catch(error => log(`file upload disposal failed: ${error.message}`))
      disposeUpgrade()
      disposeMgmt()
      disposeEvents()
      disposeScheduleChanged()
      disposeSessionStatus()
      disposeSessionAdded()
      disposeSessionRemoved()
      disposePluginsChanged()
      disposePluginSettingsChanged()
      disposePluginInstallState()
      disposePluginUpdateState()
      disposePluginInstallLog()
      disposeQuestions()
      disposeApprovals()
      if (lanServer) lanServer.close()
      for (const client of clients) {
        client.sessionFollower?.stop()
        client.terminate()
      }
      clients.clear()
      pluginInstallOwners.clear()
      wss.close()
      log('plugin stopped, all sockets closed')
    })
  },
}

/**
 * Build a plugin instance whose listener seams are `seams` — tests only.
 *
 * The production export is exported directly, not built with seams: its `apply()`
 * only defaults the third parameter to NO_TEST_SEAMS, and there is no module
 * state for seams, so a second instance in the same process can never inherit
 * the first harness's interface table or aliases. Each call seals its own frozen
 * copy; changing the supplied objects afterwards changes nothing (Blocker,
 * round 2, review 2026-11-10).
 * @param {object} [seams] `{ networkInterfaces, listenAliases }`, or nothing
 * @returns {object} a plugin with the same `Config`/`inject`/`apply` surface
 */
function createMobileGatewayPlugin(seams) {
  const sealedSeams = sealTestSeams(seams)
  return { ...plugin, apply: (ctx, config) => plugin.apply(ctx, config, sealedSeams) }
}

export { Config, admitMessage, createMobileGatewayPlugin, handleQuery, isLoopbackListenHost }
export default plugin
