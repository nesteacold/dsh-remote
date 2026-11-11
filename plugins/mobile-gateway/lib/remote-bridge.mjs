// Spec 008 P1 — the remote-bridge channel.
//
// A `desktop` device holding the explicit scope `harness:remote` may tunnel DSH
// Gateway wire calls (`namespace/method`, `$events`) to THIS Host over the same
// pinned, per-device-authenticated WebSocket the companion uses. The bridge is
// an authorization boundary, not a pipe:
//
//   - DENY BY DEFAULT. Only endpoints in ENDPOINT_SCOPE / FAMILY_SCOPE are
//     forwarded; anything else (including every name that is not listed, and the
//     explicit DENY_* families) is refused before the Host sees it.
//   - Each allowed endpoint maps to ONE device scope (sessions:read, prompt:send,
//     approval:respond, files:read, and the spec 008 "full control" scopes
//     commands:execute, workspace:manage, settings:write, credentials:write,
//     plugins:manage, schedule:write, terminal). The device needs that scope on
//     top of `harness:remote`; the router checks the latter, this module the
//     former. Nothing is blocked by design: the Host owner grants each family
//     per device. The argument constraints below apply only to a device that
//     LACKS the scope that would make the argument legitimate.
//   - `$events/result` is NEVER forwarded raw. It would let a client resolve any
//     pending Host event (an approval) without seeing its content. It is mapped
//     onto the hash-bound approval decision of the gateway (`decideApproval`):
//     the client must echo the argsHash the Host computed for that very pending
//     request; a wrong/missing hash is a normal refusal and the request stays
//     pending, an accepted decision applies at most once.
//   - Execution is on the Host's own typertGateway through an owner Peer
//     (`dispatchRpc` / `openWireStream`, the private carrier, same seam as the
//     upstream ds-harness-remote plugin, MIT). If the carrier is missing the
//     bridge refuses with a clear error instead of guessing (self-test). The Peer
//     declares `interactions: 'answer'` for a device holding `approval:respond`
//     (and only there): rc.1 refuses `$events` / `$events/result` otherwise.
//   - Streams are credit-based: the client grants frames with
//     `remote-stream-credit`, the Host never sends more than it was granted, and
//     it also pauses while the socket's `bufferedAmount` is above a quarter of
//     `maxPayloadBytes`. Closing the socket, revoking the device or cancelling
//     the stream aborts the Host-side iterator.
//
// Audit: every call logs `endpoint`, device id and the scope decision; arguments
// and results are never logged. That covers credentials/set|unset (their values
// are neither logged nor echoed back) and terminal/* streams (frames carry the
// shell's input/output and are only ever forwarded, never logged).
//
// Origin: the allowlist shape and the framing idea are adapted from
// liguobao/ds-harness-remote (MIT) `harness-remote-bridge.ts` /
// `remote-typert-gateway.ts`; see plugins/mobile-gateway/NOTICE-ds-harness-remote.

// Generated copy of the contract (see scripts/sync-mobile-protocol.mjs): the
// bare package specifier would not resolve in an installed tarball.
import * as contract from './vendor/mobile-protocol.mjs'

export const REMOTE_SCOPE = 'harness:remote'

// -- allowlist --------------------------------------------------------------

/** Endpoint → the device scope it needs. The complete forwarding allowlist. */
const SESSIONS_READ = [
  'session/list', 'session/follow', 'session/events', 'session/page', 'session/search',
  'session/projections', 'session/attachment',
  'session/workspacePathApplications', 'session/canOpenWorkspacePath',
  // Spec 008 audit: the read stream of session control state; it carries no
  // argument that selects a path or a command.
  'session/control',
  'workspace/follow',
  'subagents/list',
  'job/list', 'job/follow',
  'skills/list',
  'agentPresets/list', 'agentPresets/read',
  'commands/list',
  'llm/listProviders', 'llm/listConfigurableProviders', 'llm/discoverModels',
  'permissionPresets/catalog',
  'messageFeedback/list',
  'schedule/list', 'schedule/catalog', 'schedule/history', 'schedule/deliveryLimits',
  'toolResults/watch',
]
const PROMPT_SEND = [
  'session/prompt', 'session/create', 'session/fork', 'session/cancel', 'session/rename',
  'session/updateQueue',
  // Owner decision (models for remote sessions): the model list for a remote
  // session lives on the Host and needs only prompt:send. selectModel and
  // initializeDefaultModel are NOT here: both write the Host's GLOBAL default
  // model (session-controller lib/index.js:716 and :3945, `saveSelection`), so
  // they sit under settings:write (SETTINGS_WRITE below).
  'session/modelCatalog',
  'subagents/interruptByParent', 'subagents/prompt',
  'messageFeedback/put', 'messageFeedback/delete',
  'job/kill',
  // Goals: a goal is a prompt in a different shape; maxGoalRounds is capped below.
  'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/clear', 'goals/complete',
  'workspace/rename', 'workspace/archiveSession',
]
const APPROVAL_RESPOND = [
  'userQuestions/answer', 'userQuestions/attachWait',
  '$events', // the follow stream of pending approvals/questions
  '$events/result', // never forwarded raw, see `decideApproval`
]
// Read-only file access. Absolute / parent-relative paths are refused unless the
// device also holds workspace:manage (see `checkArguments`).
const FILES_READ = [
  'workspaceFiles/list', 'workspaceFiles/stat', 'workspaceFiles/read', 'workspaceFiles/readBytes',
  'workspaceFiles/changes',
  'officeToPdf/render', 'officeToPdf/generation',
  'fileReferences/list', 'sessionReferenceResolver/candidates',
]
// Spec 008 full control: one scope per capability family, granted per device.
const COMMANDS_EXECUTE = ['commands/execute']
const WORKSPACE_MANAGE = [
  'workspace/create', 'workspace/delete',
  'directoryPicker/list', 'directoryPicker/pick', 'directoryPicker/browse',
]
// settings/* is matched by prefix (see FAMILY_SCOPE): every method of the namespace.
const SETTINGS_WRITE = ['agentPresets/select', 'session/selectModel', 'session/initializeDefaultModel']
// credentials/set|unset are WRITE-ONLY. There is deliberately no read endpoint
// here: a credentials method that returns a value must never be forwarded.
const CREDENTIALS_WRITE = ['credentials/set', 'credentials/unset']
const SCHEDULE_WRITE = [
  'schedule/create', 'schedule/update', 'schedule/delete', 'schedule/deleteInactive', 'schedule/run', 'schedule/edit',
]

/**
 * Whole namespaces gated by one scope (every method, including ones a later DSH
 * adds). `terminal` is streamed; its frames are never logged (see the audit line).
 */
const FAMILY_SCOPE = Object.freeze({
  settings: 'settings:write',
  pluginManager: 'plugins:manage',
  terminal: 'terminal',
})

export const ENDPOINT_SCOPE = Object.freeze(Object.fromEntries([
  ...SESSIONS_READ.map((endpoint) => [endpoint, 'sessions:read']),
  ...PROMPT_SEND.map((endpoint) => [endpoint, 'prompt:send']),
  ...APPROVAL_RESPOND.map((endpoint) => [endpoint, 'approval:respond']),
  ...FILES_READ.map((endpoint) => [endpoint, 'files:read']),
  ...COMMANDS_EXECUTE.map((endpoint) => [endpoint, 'commands:execute']),
  ...WORKSPACE_MANAGE.map((endpoint) => [endpoint, 'workspace:manage']),
  ...SETTINGS_WRITE.map((endpoint) => [endpoint, 'settings:write']),
  ...CREDENTIALS_WRITE.map((endpoint) => [endpoint, 'credentials:write']),
  ...SCHEDULE_WRITE.map((endpoint) => [endpoint, 'schedule:write']),
]))

/**
 * Families refused whatever the scope list says. They are absent from
 * ENDPOINT_SCOPE / FAMILY_SCOPE (deny by default); the explicit list exists so a
 * future edit that adds one is caught by `denyReason` and by the tests.
 * Patterns are `namespace/method` with `*` for "any method".
 */
export const DENY_PATTERNS = Object.freeze([
  // credentials/set|unset are the only credentials endpoints; the rest (describe,
  // resolve, anything that could return a secret) stays closed.
  'credentials/describe', 'credentials/resolve', 'credentials/get', 'credentials/read', 'credentials/list',
  'credentials/export',
  // Not part of any scope: plugin inventory, reorder/pin bookkeeping, private channels.
  'pluginInventory/*',
  'workspace/insertBefore', 'workspace/insertSessionBefore',
  'workspace/unarchiveSession', 'workspace/initializeDefault', 'workspace/pinSession', 'workspace/unpinSession',
  'claudeCodeMods/*', 'remoteAccess/*',
])

const ENDPOINT_SHAPE = /^(?:\$events(?:\/result)?|[A-Za-z0-9_$.-]{1,64}\/[A-Za-z0-9_$.-]{1,64})$/

function matches(pattern, endpoint) {
  const [namespace, method] = pattern.split('/')
  const [endpointNamespace, endpointMethod] = endpoint.split('/')
  return (namespace === '*' || namespace === endpointNamespace)
    && (method === '*' || method === endpointMethod)
}

/** The deny pattern an endpoint falls under, or `undefined`. */
export function denyReason(endpoint) {
  return DENY_PATTERNS.find((pattern) => matches(pattern, endpoint))
}

/**
 * The device scope an endpoint needs, or `undefined` when it is not forwardable.
 * Exact endpoint entries win over whole-namespace families. `credentials/*` is
 * NOT a family: only set/unset exist, and any other credentials method is
 * unknown here, hence refused.
 */
export function scopeForEndpoint(endpoint) {
  if (Object.hasOwn(ENDPOINT_SCOPE, endpoint)) return ENDPOINT_SCOPE[endpoint]
  const namespace = endpoint.split('/')[0]
  return Object.hasOwn(FAMILY_SCOPE, namespace) ? FAMILY_SCOPE[namespace] : undefined
}

/**
 * Authorisation of one endpoint for a device.
 * @returns {{ ok: true, scope: string } | { ok: false, code: string, message: string, scope?: string }}
 */
export function authorizeEndpoint(device, endpoint) {
  if (typeof endpoint !== 'string' || !ENDPOINT_SHAPE.test(endpoint)) {
    return { ok: false, code: 'bad-request', message: 'endpoint must be namespace/method' }
  }
  const deny = denyReason(endpoint)
  if (deny) return { ok: false, code: 'op/forbidden', message: `${endpoint} is never available over the remote bridge` }
  const scope = scopeForEndpoint(endpoint)
  if (!scope) return { ok: false, code: 'op/forbidden', message: `${endpoint} is not on the remote-bridge allowlist` }
  const scopes = Array.isArray(device?.scopes) ? device.scopes : []
  // `kind` is re-checked here (not only at pair time) so a record that lists
  // harness:remote without being a desktop still gets nothing.
  if (device?.kind !== 'desktop' || !scopes.includes(REMOTE_SCOPE)) {
    return { ok: false, code: 'auth/forbidden-scope', scope: REMOTE_SCOPE,
      message: `this device was not paired with ${REMOTE_SCOPE}` }
  }
  if (!scopes.includes(scope)) {
    return { ok: false, code: 'auth/forbidden-scope', scope,
      message: `this device was not paired with ${scope}` }
  }
  return { ok: true, scope }
}

// -- argument constraints (spec 008 endpoint argument audit) ------------------
//
// Owner peers bypass the Host's remoteAccess, so every constraint lives here.
// They apply ONLY when the device lacks the scope that would make the argument
// legitimate; a device holding it gets the Host's own behaviour.

const hasScope = (device, scope) => Array.isArray(device?.scopes) && device.scopes.includes(scope)

/** Goals: without settings:write a device may not raise the round budget past this. */
export const MAX_GOAL_ROUNDS = 50

const refusal = (message, code = 'remote/argument-denied') => ({ code, message })

/**
 * A workspace-relative path: no NUL, no ':' (drive letter or URL scheme), no
 * leading '/' or '\\', no '..' segment on either separator. Empty is allowed
 * (the workspace root) only where the caller says so.
 */
export function isRelativeWorkspacePath(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return false
  if (value.length === 0) return allowEmpty
  if (value.length > 4096 || value.includes('\0') || value.includes(':')) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  return !value.split(/[\\/]/).some((segment) => segment === '..')
}

// The walkers below inspect a bounded part of the tree, but the WHOLE tree is
// forwarded to the Host. So exceeding a bound must refuse, never skip: padding
// (64+ keys/items before the interesting key) or deep nesting would otherwise
// hide a path/cwd/agentPreset from the guards. A refusal is a thrown
// `ArgumentsTooComplex`, turned into `remote/arguments-too-complex` by the
// public checks (which a device holding the matching scope never reaches).
export const MAX_ARG_DEPTH = 6
export const MAX_ARG_BREADTH = 64
class ArgumentsTooComplex extends Error {}
const tooComplex = () => refusal('arguments are too deeply nested or too wide to be checked for this device', 'remote/arguments-too-complex')

/** Entries of a container, refusing (not truncating) one wider than the bound. */
function boundedEntries(value) {
  const entries = Array.isArray(value) ? value : Object.keys(value)
  if (entries.length > MAX_ARG_BREADTH) throw new ArgumentsTooComplex()
  return entries
}

/** Every string the argument tree holds under the given keys (any depth, bounded; over a bound it throws). */
function collectStrings(value, keys, depth = 0, out = []) {
  if (value === null || typeof value !== 'object') return out
  if (depth > MAX_ARG_DEPTH) throw new ArgumentsTooComplex()
  if (Array.isArray(value)) {
    for (const item of boundedEntries(value)) collectStrings(item, keys, depth + 1, out)
    return out
  }
  for (const key of boundedEntries(value)) {
    const item = value[key]
    if (keys.has(key)) {
      if (typeof item === 'string') out.push({ key, value: item })
      else if (item !== undefined && item !== null && typeof item !== 'object') out.push({ key, value: String(item), nonString: true })
      else if (Array.isArray(item)) for (const entry of boundedEntries(item)) out.push({ key, value: typeof entry === 'string' ? entry : '\0nonstring' })
    }
    collectStrings(item, keys, depth + 1, out)
  }
  return out
}

/** First value stored under `key` at any depth (bounded), or `undefined`; over a bound it throws. */
function findValue(value, key, depth = 0) {
  if (value === null || typeof value !== 'object') return undefined
  if (depth > MAX_ARG_DEPTH) throw new ArgumentsTooComplex()
  if (!Array.isArray(value) && Object.hasOwn(value, key)) return value[key]
  const children = Array.isArray(value) ? boundedEntries(value) : boundedEntries(value).map((k) => value[k])
  for (const child of children) {
    const found = findValue(child, key, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** Run a guard; a bound exceeded inside it is a refusal, not a pass. */
function guarded(check) {
  try { return check() } catch (error) {
    if (error instanceof ArgumentsTooComplex) return tooComplex()
    throw error
  }
}

/** The documented argument slots: the arguments object itself and its `request` wrapper. */
const argumentSlots = (args) => [args, ...(isRecordValue(args?.request) ? [args.request] : [])]
const isRecordValue = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
/** A key read directly from the known slots (no traversal, so no padding can hide it). */
const directValue = (args, key) => {
  for (const slot of argumentSlots(args)) if (Object.hasOwn(slot, key)) return slot[key]
  return undefined
}

const PATH_KEYS = new Set(['path', 'baseFile', 'query', 'file', 'filePath', 'relativePath', 'paths'])
const FILE_ENDPOINTS = new Set([
  'workspaceFiles/list', 'workspaceFiles/stat', 'workspaceFiles/read', 'workspaceFiles/readBytes',
  'workspaceFiles/changes', 'officeToPdf/render', 'fileReferences/list',
])

/**
 * Argument constraints that need no Host knowledge (pure, synchronous).
 * @returns {{ code: string, message: string } | undefined}  a refusal, or undefined when fine
 */
export function checkArguments(device, endpoint, args) {
  const workspaceManage = hasScope(device, 'workspace:manage')
  const settingsWrite = hasScope(device, 'settings:write')

  if (FILE_ENDPOINTS.has(endpoint) && !workspaceManage) {
    const pathRefusal = (key, value, nonString) => {
      // fileReferences/list takes a free-text query; an empty one is a plain "list".
      const allowEmpty = key === 'path' || key === 'query'
      return nonString || !isRelativeWorkspacePath(value, { allowEmpty })
        ? refusal(`${endpoint}: only relative workspace paths are allowed for this device (needs workspace:manage)`, 'remote/path-denied')
        : undefined
    }
    // The known locations first, read directly: no padding can push them out of reach.
    for (const key of PATH_KEYS) {
      const value = directValue(args, key)
      if (value === undefined || value === null) continue
      const entries = Array.isArray(value) ? value : [value]
      for (const entry of entries) {
        const r = typeof entry === 'string' ? pathRefusal(key, entry, false) : pathRefusal(key, '', true)
        if (r) return r
      }
    }
    // Then the whole tree (nested `options.baseFile` and the like); over a bound it refuses.
    const swept = guarded(() => {
      for (const { key, value, nonString } of collectStrings(args, PATH_KEYS)) {
        const r = pathRefusal(key, value, nonString)
        if (r) return r
      }
      return undefined
    })
    if (swept) return swept
  }

  if (endpoint === 'session/create' && !workspaceManage) {
    // cwd / agentPreset pick an arbitrary directory or agent composition on the Host.
    for (const key of ['cwd', 'agentPreset']) {
      if (directValue(args, key) !== undefined) {
        return refusal(`session/create: ${key} needs workspace:manage; pass a workspaceId of an existing workspace`, 'remote/argument-denied')
      }
    }
    const nested = guarded(() => {
      for (const key of ['cwd', 'agentPreset']) {
        if (findValue(args, key) !== undefined) {
          return refusal(`session/create: ${key} needs workspace:manage; pass a workspaceId of an existing workspace`, 'remote/argument-denied')
        }
      }
      return undefined
    })
    if (nested) return nested
  }

  if (endpoint === 'agentPresets/select' && !settingsWrite) {
    return refusal('agentPresets/select needs settings:write', 'auth/forbidden-scope')
  }

  if (endpoint.startsWith('goals/') && !settingsWrite) {
    const badRounds = (rounds) => rounds !== undefined && !(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= MAX_GOAL_ROUNDS)
    const tooMany = () => refusal(`goals: maxGoalRounds must be 1..${MAX_GOAL_ROUNDS} for this device (more needs settings:write)`)
    if (badRounds(directValue(args, 'maxGoalRounds'))) return tooMany()
    const swept = guarded(() => (badRounds(findValue(args, 'maxGoalRounds')) ? tooMany() : undefined))
    if (swept) return swept
  }
  return undefined
}

/**
 * Argument constraints that need the Host's own lists (the workspace list).
 * `host.workspaceIds()` reads through the same Host gateway the call would use;
 * a failure to read refuses (fail closed).
 * @returns {Promise<{ code: string, message: string } | undefined>}
 */
export async function checkArgumentsWithHost(device, endpoint, args, host) {
  if (endpoint === 'session/create' && !hasScope(device, 'workspace:manage')) {
    let workspaceId
    // The tree is forwarded whole, so a bound exceeded here refuses (never skips).
    try { workspaceId = directValue(args, 'workspaceId') ?? findValue(args, 'workspaceId') } catch (error) {
      if (error instanceof ArgumentsTooComplex) return tooComplex()
      throw error
    }
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      return refusal('session/create: a workspaceId of an existing workspace is required for this device')
    }
    let ids
    try { ids = await host.workspaceIds() } catch { ids = undefined }
    if (!ids) return refusal('session/create: the Host workspace list is unavailable', 'remote/unavailable')
    if (!ids.has(workspaceId)) return refusal('session/create: workspaceId is not a workspace of this Host')
  }
  // session/selectModel needs settings:write outright (it saves the Host's global
  // default), so no catalog pair check is left for a device that lacks it.
  return undefined
}

// -- helpers ----------------------------------------------------------------

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Wire-safe failure: a stable code and a short message, never a stack. */
export function remoteError(error, fallbackCode = 'internal') {
  const code = typeof error?.code === 'string' && error.code.length <= 64 ? error.code : fallbackCode
  const message = typeof error?.message === 'string' ? error.message.slice(0, 500) : 'the Host rejected the request'
  return { code, message }
}

/**
 * Binary values (`Uint8Array`) cannot ride in JSON. The upstream carrier hands
 * them over as base64; the bridge does the same, in chunks of at most
 * REMOTE_BINARY_CHUNK_BYTES so one frame never carries more than that. A value
 * is replaced by `{ $binary: { base64, offset, total, last } }` markers: the
 * caller gets one frame per chunk.
 */
export function splitBinary(bytes, chunkBytes = contract.REMOTE_BINARY_CHUNK_BYTES) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (view.byteLength === 0) return [{ $binary: { base64: '', offset: 0, total: 0, last: true } }]
  const chunks = []
  for (let offset = 0; offset < view.byteLength; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, view.byteLength)
    chunks.push({ $binary: {
      base64: Buffer.from(view.subarray(offset, end)).toString('base64'),
      offset, total: view.byteLength, last: end === view.byteLength,
    } })
  }
  return chunks
}

/**
 * Lazy form of `splitBinary`: yields one marker at a time so a stream never
 * holds every base64 chunk in memory at once.
 */
export function* iterateBinary(bytes, chunkBytes = contract.REMOTE_BINARY_CHUNK_BYTES) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (view.byteLength === 0) { yield { $binary: { base64: '', offset: 0, total: 0, last: true } }; return }
  for (let offset = 0; offset < view.byteLength; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, view.byteLength)
    yield { $binary: {
      base64: Buffer.from(view.subarray(offset, end)).toString('base64'),
      offset, total: view.byteLength, last: end === view.byteLength,
    } }
  }
}

const hasBinary = (value) => value instanceof Uint8Array || value instanceof ArrayBuffer
const binaryLength = (value) => value.byteLength

/**
 * Describe a result value WITHOUT materializing chunks: either a plain `value`
 * or a lazy `frames()` generator (one frame per binary chunk, `data` replaced
 * by the marker, other fields repeated) plus the raw byte length.
 */
function describeResultValue(value) {
  if (hasBinary(value)) {
    return { binaryBytes: binaryLength(value), frames: () => iterateBinary(value) }
  }
  if (isRecord(value) && hasBinary(value.data)) {
    const { data, ...rest } = value
    return {
      binaryBytes: binaryLength(data),
      frames: function* frames() { for (const chunk of iterateBinary(data)) yield { ...rest, data: chunk } },
    }
  }
  return { value }
}

/**
 * Chunk size of a JSON result delivered as a stream (characters of the JSON
 * text, never split inside a surrogate pair). Small enough that one frame stays
 * far below any WS payload cap, large enough to keep the frame count low.
 */
export const REMOTE_JSON_CHUNK_CHARS = 256 * 1024

/**
 * A result that does not fit one frame is delivered as `{ $json: { text, offset,
 * total, last } }` frames: consecutive slices of its JSON text. `offset`/`total`
 * count UTF-16 code units of the text; the receiver concatenates in order and
 * parses once at `last`, which reproduces the value byte-exact.
 */
export function* iterateJsonText(text, chunkChars = REMOTE_JSON_CHUNK_CHARS) {
  if (text.length === 0) { yield { $json: { text: '', offset: 0, total: 0, last: true } }; return }
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + chunkChars, text.length)
    // Never cut between the two halves of a surrogate pair.
    if (end < text.length) {
      const code = text.charCodeAt(end - 1)
      if (code >= 0xD800 && code <= 0xDBFF) end -= 1
    }
    yield { $json: { text: text.slice(offset, end), offset, total: text.length, last: end === text.length } }
    offset = end
  }
}

/** Async-iterable adapters so a one-shot result rides the same `pump` as a Host stream. */
const jsonSource = (text) => ({
  [Symbol.asyncIterator]() {
    const chunks = iterateJsonText(text)
    return { async next() { const step = chunks.next(); return step.done ? { done: true, value: undefined } : { done: false, value: step.value } },
      async return() { return { done: true, value: undefined } } }
  },
})
const binarySource = (described) => ({
  [Symbol.asyncIterator]() {
    const frames = described.frames()
    // `data` is already a `$binary` marker here: describeResultValue leaves it alone.
    return { async next() { const step = frames.next(); return step.done ? { done: true, value: undefined } : { done: false, value: step.value } },
      async return() { return { done: true, value: undefined } } }
  },
})

let resultStreamSeq = 0

// Owner decision 2026-11-09 (spec 008): no limits by default. 0 = unlimited for
// every knob; a positive integer turns that one limit on (gateway config
// `remoteBridgeLimits`). Large results are not "limited" either: they travel as
// a credit-controlled stream (see `call`).
export const DEFAULT_LIMITS = Object.freeze({
  maxConnectionsPerDevice: 0,
  maxStreamsPerDevice: 0,
  maxInflightPerDevice: 0,
  callsPerSecond: 0,
  maxResultBytes: 0,
})

/** A configured limit: a positive integer, else 0 (= unlimited). */
const limitOf = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0)

/** `limit` is on (> 0) and `used` has reached it. 0 never refuses. */
const reached = (used, limit) => limit > 0 && used >= limit

const PROMPT_KEYS = new Set(['text', 'prompt', 'content', 'message', 'input', 'body', 'value'])

/** True when any prompt-like string field (any depth, bounded) starts with '/' after trimming. */
function hasSlashPrompt(value, depth = 0, inPromptKey = false) {
  if (typeof value === 'string') return inPromptKey && value.trim().startsWith('/')
  if (depth > 6 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.slice(0, 64).some((item) => hasSlashPrompt(item, depth + 1, inPromptKey))
  return Object.keys(value).slice(0, 64).some((key) => hasSlashPrompt(value[key], depth + 1, inPromptKey || PROMPT_KEYS.has(key)))
}

/**
 * `session/prompt` is allowed, but a leading `/` could run a Host slash command
 * (the same surface as `commands/execute`). Defence in depth: refused before the
 * Host unless the device holds commands:execute, which opens that surface anyway.
 */
function slashCommandRefusal(device, endpoint, args) {
  if (endpoint !== 'session/prompt' || hasScope(device, 'commands:execute') || !hasSlashPrompt(args)) return undefined
  return { code: 'remote/slash-command-denied', message: 'a prompt starting with "/" is not available over the remote bridge' }
}

/** UTF-8 size of the JSON form; Infinity when it cannot be serialized (cycles, BigInt). */
function serializedBytes(value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? 0 : Buffer.byteLength(text, 'utf8')
  } catch { return Number.POSITIVE_INFINITY }
}

// -- the bridge -------------------------------------------------------------

/**
 * @param {object} deps
 * @param {() => any} deps.getGateway  resolves the Host `typertGateway` (late, so a late service still works)
 * @param {(deviceId: string) => any} deps.createPeer  creates an owner Peer for ONE bridge
 *        connection; the id lets the caller decide `interactions` from the live grant
 *        (rc.1 refuses `$events` unless the Peer declared `interactions: 'answer'`)
 * @param {(deviceId: string) => any} deps.getDevice  live registry record (scopes/kind)
 * @param {(request: object) => Promise<object>} deps.decideApproval
 *        hash-bound approval decision of the gateway (same path as `approval-response`)
 * @param {(line: string) => void} deps.log
 * @param {number} [deps.maxPayloadBytes]
 * @param {number} [deps.defaultCredit]
 * @param {object} [deps.limits]  OPTIONAL per-DEVICE limits (all connections together);
 *        every value defaults to 0 = unlimited (owner decision 2026-11-09):
 *        maxConnectionsPerDevice, maxStreamsPerDevice, maxInflightPerDevice,
 *        callsPerSecond (token bucket), maxResultBytes (refuse a result above it)
 */
export function createRemoteBridge(deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const defaultCredit = Number.isSafeInteger(deps.defaultCredit) && deps.defaultCredit > 0
    ? deps.defaultCredit : contract.REMOTE_STREAM_DEFAULT_CREDIT
  const maxPayloadBytes = Number.isSafeInteger(deps.maxPayloadBytes) && deps.maxPayloadBytes > 0
    ? deps.maxPayloadBytes : 16 * 1024 * 1024
  const limits = {
    maxConnectionsPerDevice: limitOf(deps.limits?.maxConnectionsPerDevice),
    maxStreamsPerDevice: limitOf(deps.limits?.maxStreamsPerDevice),
    maxInflightPerDevice: limitOf(deps.limits?.maxInflightPerDevice),
    callsPerSecond: limitOf(deps.limits?.callsPerSecond),
    maxResultBytes: limitOf(deps.limits?.maxResultBytes),
  }
  // A one-shot reply must fit one WS frame; leave headroom for the envelope.
  const singleFrameBudget = Math.max(1024, maxPayloadBytes - 4096)
  const MAX_CREDIT = 4096

  // Shared per DEVICE, not per connection: opening more sockets must not
  // multiply the budget. Entries are dropped when the last connection closes.
  /** @type {Map<string, { connections: number, streams: number, inflight: number, tokens: number, refilledAt: number }>} */
  const devices = new Map()
  const deviceState = (deviceId) => {
    let state = devices.get(deviceId)
    if (!state) {
      state = { connections: 0, streams: 0, inflight: 0, tokens: limits.callsPerSecond, refilledAt: Date.now() }
      devices.set(deviceId, state)
    }
    return state
  }
  const releaseDevice = (deviceId) => {
    const state = devices.get(deviceId)
    if (state && state.connections <= 0 && state.streams <= 0 && state.inflight <= 0) devices.delete(deviceId)
  }
  /** Token bucket: `callsPerSecond` tokens refilled continuously, burst = one second. */
  const takeToken = (state) => {
    if (limits.callsPerSecond <= 0) return true
    const now = Date.now()
    state.tokens = Math.min(limits.callsPerSecond, state.tokens + ((now - state.refilledAt) / 1000) * limits.callsPerSecond)
    state.refilledAt = now
    if (state.tokens < 1) return false
    state.tokens -= 1
    return true
  }

  /** @returns {{ gateway: any, error?: undefined } | { gateway?: undefined, error: object }} */
  function carrier() {
    let gateway
    try { gateway = deps.getGateway() } catch { gateway = undefined }
    const ok = gateway && typeof gateway.dispatchRpc === 'function' && typeof gateway.openWireStream === 'function'
    if (!ok) {
      return { error: { code: 'remote/unavailable',
        message: 'this Host does not expose the Gateway carrier (dispatchRpc/openWireStream); the remote bridge is unavailable' } }
    }
    return { gateway }
  }

  /** Per-connection state: one owner Peer, the open streams. */
  function attach(ws, deviceId) {
    const streams = new Map()
    let peer
    let closed = false
    const abortAll = new AbortController()
    const shared = deviceState(deviceId)
    // Over the per-device connection cap: this channel is inert. It never creates
    // a Peer or touches the Host; every frame is answered `remote/busy`.
    const overCap = reached(shared.connections, limits.maxConnectionsPerDevice)
    if (!overCap) shared.connections += 1
    else log(`remote-bridge busy: device=${deviceId} reason=connections`)
    const busy = (what) => ({ code: 'remote/busy', message: `too many ${what} for this device` })
    const refuseBusy = (what) => {
      log(`remote-bridge busy: device=${deviceId} reason=${what}`)
      return busy(what)
    }

    const ownerPeer = () => {
      // Created once per connection from the LIVE record: the gateway turns the
      // device's `approval:respond` into `interactions: 'answer'`, without which
      // rc.1 refuses `$events` (so no approval card could ever arrive).
      if (!peer) peer = deps.createPeer(deviceId)
      return peer
    }
    const send = (frame) => {
      if (ws.readyState !== 1) return false
      ws.send(JSON.stringify(frame))
      return true
    }
    const backpressured = () => (ws.bufferedAmount ?? 0) > maxPayloadBytes / 4

    /**
     * The Host's own lists the argument constraints compare against, read through
     * the same gateway and owner Peer the call itself would use. Never cached:
     * a workspace or model that appeared a second ago must be usable, and one
     * that vanished must not be. Any failure is `undefined` (the caller refuses).
     */
    const hostReader = {
      async workspaceIds() {
        const { gateway, error } = carrier()
        if (error) return undefined
        const control = new AbortController()
        const signal = AbortSignal.any([control.signal, abortAll.signal, AbortSignal.timeout(10_000)])
        let iterator
        try {
          const source = await openWireStream(gateway, 'workspace/follow', { args: {} }, ownerPeer(), signal, control)
          iterator = source[Symbol.asyncIterator]()
          const first = await iterator.next()
          const items = first.done ? undefined : first.value?.value?.items
          if (!Array.isArray(items)) return undefined
          return new Set(items.map((item) => item?.workspaceId).filter((id) => typeof id === 'string'))
        } catch { return undefined } finally {
          control.abort()
          try { await iterator?.return?.() } catch { /* the Host closes its own side */ }
        }
      },
    }

    /**
     * Drop a stream from the map. Only the owning object may delete its id: a
     * late settle of an old opener must not remove a newer stream that reused
     * the id. The per-device slot is released exactly once per stream object.
     */
    function releaseStream(stream) {
      if (streams.get(stream.id) === stream) streams.delete(stream.id)
      if (!stream.released) {
        stream.released = true
        shared.streams = Math.max(0, shared.streams - 1)
        releaseDevice(deviceId)
      }
    }

    function closeStream(streamId, error, notify = true) {
      const stream = streams.get(streamId)
      if (!stream) return
      stream.controller.abort()
      stream.wake?.()
      // The id stays reserved while the opener is still pending (`opening`); the
      // opener releases it when it settles. Otherwise free it now.
      if (!stream.opening) releaseStream(stream)
      if (notify) send({ kind: 'remote-stream-closed', streamId, ...(error ? { error } : {}) })
    }

    async function pump(stream, source) {
      let failure
      try {
        const iterator = source[Symbol.asyncIterator]()
        stream.iterator = iterator
        for (;;) {
          // Wait for credit and for the socket to drain: the Host holds its
          // iterator instead of buffering frames the peer cannot absorb.
          while (!stream.controller.signal.aborted && (stream.credit <= 0 || backpressured())) {
            await new Promise((resolve) => {
              stream.wake = resolve
              setTimeout(resolve, 25)
            })
          }
          if (stream.controller.signal.aborted) break
          const step = await iterator.next()
          if (step.done || stream.controller.signal.aborted) break
          const described = describeResultValue(step.value)
          // Optional cap (off by default): a non-binary value above it would still
          // be one oversized frame.
          if (!stream.fromResult && limits.maxResultBytes > 0 && !described.frames && serializedBytes(described.value) > limits.maxResultBytes) {
            failure = { code: 'remote/result-too-large', message: `a stream frame exceeds ${limits.maxResultBytes} bytes` }
            break
          }
          for (const item of described.frames ? described.frames() : [described.value]) {
            if (stream.controller.signal.aborted) break
            // Binary chunks of one value are separate frames, each paying credit.
            while (!stream.controller.signal.aborted && (stream.credit <= 0 || backpressured())) {
              await new Promise((resolve) => { stream.wake = resolve; setTimeout(resolve, 25) })
            }
            if (stream.controller.signal.aborted) break
            stream.credit -= 1
            if (!send({ kind: 'remote-frame', streamId: stream.id, seq: stream.seq, value: item })) {
              stream.controller.abort()
              break
            }
            stream.seq += 1
          }
        }
      } catch (error) {
        if (!stream.controller.signal.aborted) failure = remoteError(error)
      } finally {
        try { await stream.iterator?.return?.() } catch { /* the Host closes its own side */ }
        // closeStream notifies once and releases; a stream already closed/replaced
        // (cancel, socket close) is left alone.
        if (streams.get(stream.id) === stream) closeStream(stream.id, failure)
        else releaseStream(stream)
      }
    }

    return {
      get openStreams() { return streams.size },

      async call(msg) {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined
        const reply = (body) => send({ kind: 'remote-result', ...(requestId ? { requestId } : {}), ...body })
        const device = deps.getDevice(deviceId)
        const verdict = authorizeEndpoint(device, msg.endpoint)
        // Audit: endpoint + device + decision, never the arguments. The endpoint
        // text is logged only after its shape validated; anything else is a
        // fixed marker so attacker-controlled text never reaches the log.
        const shapeOk = typeof msg.endpoint === 'string' && ENDPOINT_SHAPE.test(msg.endpoint)
        log(`remote-bridge call: endpoint=${shapeOk ? msg.endpoint : 'invalid-endpoint'} device=${deviceId} allowed=${verdict.ok}`)
        if (!verdict.ok) { reply({ ok: false, error: { code: verdict.code, message: verdict.message,
          ...(verdict.scope ? { scope: verdict.scope } : {}) } }); return }
        if (msg.endpoint === '$events') {
          reply({ ok: false, error: { code: 'bad-request', message: '$events is a stream: use remote-stream-open' } })
          return
        }
        const args = msg.args === undefined ? {} : msg.args
        if (!isRecord(args)) { reply({ ok: false, error: { code: 'bad-request', message: 'args must be an object' } }); return }
        const promptRefusal = slashCommandRefusal(device, msg.endpoint, args)
        if (promptRefusal) { reply({ ok: false, error: promptRefusal }); return }
        const argumentRefusal = checkArguments(device, msg.endpoint, args)
        if (argumentRefusal) { reply({ ok: false, error: argumentRefusal }); return }
        // Per-device budget BEFORE any Peer exists or the Host is touched.
        if (overCap) { reply({ ok: false, error: refuseBusy('connections') }); return }
        if (!takeToken(shared)) { reply({ ok: false, error: refuseBusy('calls per second') }); return }
        if (msg.endpoint === '$events/result') {
          // Never forwarded: mapped onto the hash-bound approval decision.
          try { reply(await this.decide(args)) } catch (error) { reply({ ok: false, error: remoteError(error) }) }
          return
        }
        if (reached(shared.inflight, limits.maxInflightPerDevice)) { reply({ ok: false, error: refuseBusy('in-flight calls') }); return }
        const { gateway, error } = carrier()
        if (error) { reply({ ok: false, error }); return }
        shared.inflight += 1
        const timeout = AbortSignal.timeout(60_000)
        try {
          // Constraints that compare against the Host's own lists run inside the
          // in-flight slot, so they cannot be used to read the Host for free.
          const hostRefusal = await checkArgumentsWithHost(device, msg.endpoint, args, hostReader)
          if (hostRefusal) { reply({ ok: false, error: hostRefusal }); return }
          const result = await gateway.dispatchRpc(msg.endpoint, { args }, AbortSignal.any([timeout, abortAll.signal]), ownerPeer())
          if (!isRecord(result) || typeof result.ok !== 'boolean') {
            reply({ ok: false, error: { code: 'internal', message: 'the Host returned an invalid Gateway result' } })
            return
          }
          if (msg.endpoint.startsWith('credentials/')) {
            // Write-only: neither a value nor a Host message (which could quote the
            // argument) goes back. The outcome is just ok / a stable code.
            reply(result.ok ? { ok: true, value: {} }
              : { ok: false, error: { code: remoteError(result.error).code, message: 'the Host refused the credential change' } })
            return
          }
          if (!result.ok) { reply({ ok: false, error: remoteError(result.error) }); return }
          const described = describeResultValue(result.value)
          // Transport, not a limit: a result that cannot ride one WS frame (binary,
          // or serialized above the single-frame budget) is delivered through the
          // stream path instead of being refused. The reply only names the stream;
          // the value arrives as credit-controlled `remote-frame`s followed by
          // `remote-stream-closed` (the client reassembles, see `iterateJsonText`).
          let text
          if (!described.frames) {
            // One serialization, reused as the stream payload when it does not fit.
            try { text = JSON.stringify(described.value) } catch { text = null }
            if (text === null) {
              reply({ ok: false, error: { code: 'remote/result-too-large', message: 'the result cannot be serialized' } })
              return
            }
          }
          const bytes = text === undefined ? 0 : Buffer.byteLength(text ?? '', 'utf8')
          // `maxResultBytes` (optional, off by default) refuses instead of streaming.
          if (limits.maxResultBytes > 0 && (described.frames ? described.binaryBytes : bytes) > limits.maxResultBytes) {
            reply({ ok: false, error: { code: 'remote/result-too-large', message: `the result exceeds ${limits.maxResultBytes} bytes` } })
            return
          }
          if (!described.frames && bytes <= singleFrameBudget) { reply({ ok: true, value: described.value }); return }
          // The upgraded result stream is a stream like any other: it takes a slot
          // of the per-device stream budget (0 = unlimited, unchanged) or is refused.
          if (reached(shared.streams, limits.maxStreamsPerDevice)) { reply({ ok: false, error: refuseBusy('open streams') }); return }
          resultStreamSeq += 1
          // `res.` is reserved for these ids: openStream refuses a client id with it.
          const streamId = `res.${resultStreamSeq}`
          const stream = { id: streamId, controller: new AbortController(), credit: defaultCredit, seq: 0, wake: null,
            iterator: null, opening: false, released: false, fromResult: true }
          streams.set(streamId, stream)
          shared.streams += 1
          // The reply goes first so the client registers the stream before frames land.
          reply({ ok: true, streamed: true, streamId })
          void pump(stream, described.frames ? binarySource(described) : jsonSource(text))
        } catch (thrown) {
          reply({ ok: false, error: msg.endpoint.startsWith('credentials/')
            ? { code: remoteError(thrown).code, message: 'the Host refused the credential change' }
            : remoteError(thrown) })
        } finally {
          shared.inflight = Math.max(0, shared.inflight - 1)
          releaseDevice(deviceId)
        }
      },

      /**
       * `$events/result` → the existing hash-bound approval decision. The client
       * supplies the same fields as an `approval-response`; `argsHash` must equal
       * the one the Host computed for that pending request.
       */
      async decide(args) {
        const outcome = isRecord(args.outcome) ? args.outcome : undefined
        const value = outcome?.kind === 'result' ? outcome.value : args.outcome
        const receipt = await deps.decideApproval({
          rpcId: args.rpcId ?? args.eventId,
          sessionId: args.sessionId,
          approvalId: args.approvalId ?? args.eventId,
          argsHash: args.argsHash,
          outcome: value,
        })
        if (receipt?.kind === 'error') {
          return { ok: false, error: { code: receipt.code ?? 'bad-request', message: String(receipt.message ?? 'refused') } }
        }
        // A refusal is a normal result: ok:true carrying `accepted:false` (the
        // request stays pending), exactly like the companion receipt.
        return { ok: true, value: {
          accepted: receipt?.accepted === true,
          ...(receipt?.accepted === true ? {} : { reason: receipt?.reason ?? 'not-pending' }),
          outcome: receipt?.outcome,
        } }
      },

      async openStream(msg) {
        const requestId = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
        const streamId = typeof msg.streamId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(msg.streamId)
          && !msg.streamId.startsWith('res.') ? msg.streamId : undefined
        const refuse = (error) => {
          if (streamId) send({ kind: 'remote-stream-closed', streamId, error })
          else send({ kind: 'remote-result', ...requestId, ok: false, error })
        }
        const device = deps.getDevice(deviceId)
        const verdict = authorizeEndpoint(device, msg.endpoint)
        const shapeOk = typeof msg.endpoint === 'string' && ENDPOINT_SHAPE.test(msg.endpoint)
        log(`remote-bridge stream-open: endpoint=${shapeOk ? msg.endpoint : 'invalid-endpoint'} device=${deviceId} allowed=${verdict.ok}`)
        if (!streamId) { refuse({ code: 'bad-request', message: 'streamId must be 1..64 of [A-Za-z0-9._-]' }); return }
        if (!verdict.ok) { refuse({ code: verdict.code, message: verdict.message, ...(verdict.scope ? { scope: verdict.scope } : {}) }); return }
        if (msg.endpoint === '$events/result') { refuse({ code: 'bad-request', message: '$events/result is a call, not a stream' }); return }
        if (streams.has(streamId)) { refuse({ code: 'bad-request', message: 'streamId is already open' }); return }
        const args = msg.args === undefined ? {} : msg.args
        if (!isRecord(args)) { refuse({ code: 'bad-request', message: 'args must be an object' }); return }
        // Same synchronous argument constraints as a call: a stream such as
        // workspaceFiles/changes takes a path too.
        const argumentRefusal = checkArguments(device, msg.endpoint, args)
        if (argumentRefusal) { refuse(argumentRefusal); return }
        // Per-device budget BEFORE the Peer is created or the Host is touched.
        if (overCap) { refuse(refuseBusy('connections')); return }
        if (!takeToken(shared)) { refuse(refuseBusy('calls per second')); return }
        if (reached(shared.streams, limits.maxStreamsPerDevice)) { refuse(refuseBusy('open streams')); return }
        const { gateway, error } = carrier()
        if (error) { refuse(error); return }
        if (closed) return
        const controller = new AbortController()
        const stream = { id: streamId, controller, credit: defaultCredit, seq: 0, wake: null, iterator: null,
          opening: true, released: false }
        streams.set(streamId, stream)
        shared.streams += 1
        let source
        try {
          // A stream may also need a Host-list check (none today; kept symmetrical
          // with `call` so a future streamed endpoint cannot skip it).
          const hostRefusal = await checkArgumentsWithHost(device, msg.endpoint, args, hostReader)
          if (hostRefusal) throw Object.assign(new Error(hostRefusal.message), { code: hostRefusal.code })
          // rc.1 carrier signature: (endpoint, payload, uplink, peer, signal, control).
          source = await openWireStream(gateway, msg.endpoint, { args }, ownerPeer(),
            AbortSignal.any([controller.signal, abortAll.signal]), controller)
        } catch (thrown) {
          stream.opening = false
          const wasOurs = streams.get(streamId) === stream
          controller.abort()
          releaseStream(stream)
          // A cancelled opener already told the client; only an owned id reports the failure.
          if (wasOurs) refuse(remoteError(thrown))
          return
        }
        stream.opening = false
        if (controller.signal.aborted || closed) {
          // Cancelled (or socket closed) while the opener was pending. The id was
          // reserved until now; release only THIS stream object, never a newer
          // stream that reused the id.
          releaseStream(stream)
          try { await source?.[Symbol.asyncIterator]?.().return?.() } catch { /* ignore */ }
          return
        }
        void pump(stream, source)
      },

      credit(msg) {
        const stream = typeof msg.streamId === 'string' ? streams.get(msg.streamId) : undefined
        if (!stream) return
        const n = Number.isSafeInteger(msg.n) && msg.n > 0 ? msg.n : 0
        // Capped so a client cannot turn "credit" into an unbounded send window.
        stream.credit = Math.min(MAX_CREDIT, stream.credit + n)
        stream.wake?.()
      },

      cancel(msg) {
        if (typeof msg.streamId === 'string') closeStream(msg.streamId, undefined)
      },

      /** Socket closed, or the device was revoked/re-paired: nothing may keep running. */
      close() {
        if (closed) return
        closed = true
        abortAll.abort()
        for (const streamId of [...streams.keys()]) closeStream(streamId, undefined, false)
        try { peer?.dispose?.() } catch { /* the Host drops it anyway */ }
        if (!overCap) shared.connections = Math.max(0, shared.connections - 1)
        releaseDevice(deviceId)
      },
    }
  }

  return { attach, authorizeEndpoint, carrier, limits: Object.freeze({ ...limits }) }
}

/**
 * The private carrier opener. rc.1 takes `(endpoint, payload, uplink, peer,
 * signal, control)`; the older 3-argument form is `(endpoint, payload, signal)`.
 * Same arity probe as the upstream gateway switch.
 */
function openWireStream(gateway, endpoint, payload, peer, signal, control) {
  const open = gateway.openWireStream
  if (open.length >= 5) {
    const ended = { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) }
    return open.call(gateway, endpoint, payload, ended, peer, signal, control)
  }
  return open.call(gateway, endpoint, payload, signal)
}
