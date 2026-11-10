// @dsh-ext/devices — server half (spec 008). Adds the `/devices` route prefix to
// the DSH web server. It listens on nothing new (FR1): the browser reaches it
// through the Host's own loopback web server, and it dials OUT, pinned, to the
// remote hosts the user pairs (FR2).
//
// State on disk (plugin data dir, default ~/.dsh/devices-page):
//   remotes.json          remote records, no secrets (id, name, pin, endpoint, ...)
//   tokens/<id>.token     one owner-only (0600 / user-only ACL) file per remote
// The token never reaches the browser, a log line or an error message (FR3).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CLOSE_REVOKED, PinMismatchError, RemoteConnection, RemoteInputError,
  claimPairing, claimWithOtp, decodePairingString, formatVerificationCode, normalizeOtp, otpDialUrl, resolveDialUrl,
} from './remote-client.mjs'
import { assertCleanCard, createHostRouter } from './host-router.mjs'
import { resolveDshRuntimeVersion } from './dsh-runtime-version.mjs'
import { createSessionCache } from './session-cache.mjs'
import {
  ensureOwnerOnlyDirectory, restrictToOwnerSync, setSecureFileLogger, writeSecretFile,
} from './secure-file.mjs'

const MAX_BODY_BYTES = 64 * 1024
const MAX_REMOTES = 32
const MAX_APPROVALS_PER_REMOTE = 64
const REMOTE_ID = /^[a-f0-9-]{36}$/
const CLIENT_DEVICE_ID = /^[A-Za-z0-9._-]{8,128}$/
// A session id a cached transcript may belong to (spec 008 P2c). The id is only
// validated here; lib/session-cache.mjs hashes it before it becomes a file name,
// so the alphabet (including `:` and `.`) cannot alias another file.
const SESSION_COPY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
// A subagent session is addressable only through its durable parent. DSH accepts
// these three modes and `unknown` skips its mode check, so a history read never has
// to guess the mode; `continuable`/`one-shot` are what a caller may name instead.
const SUBAGENT_MODES = new Set(['continuable', 'one-shot', 'unknown'])
// How long one remote's session list is reused for the parent lookup below. Short on
// purpose: a session opened later than this re-reads the list, so a child created in
// the meantime is still found.
const SESSION_LIST_TTL_MS = 5000

// --- request guards: copied from plugins/mobile-gateway/lib/index.mjs (isLoopback, isSameOrigin) ---
export function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

export function isSameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string' || typeof req.headers.host !== 'string') return false
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let bytes = 0
    let oversized = false
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) oversized = true
      else data += chunk
    })
    req.on('end', () => {
      if (oversized) { reject(new RemoteInputError('request body is too large', 413, 'too-large')); return }
      try {
        const body = data === '' ? {} : JSON.parse(data)
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('expected an object')
        resolve(body)
      } catch {
        reject(new RemoteInputError('request body must be a JSON object'))
      }
    })
    req.on('error', reject)
  })
}

/** Remote records on disk; tokens live in separate per-remote files. */
function createStore(dataDir, log) {
  const remotesFile = path.join(dataDir, 'remotes.json')
  const tokensDir = path.join(dataDir, 'tokens')
  ensureOwnerOnlyDirectory(dataDir)
  ensureOwnerOnlyDirectory(tokensDir)
  let data = { version: 1, clientDeviceId: '', remotes: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(remotesFile, 'utf8'))
    if (parsed && Array.isArray(parsed.remotes)) data = { version: 1, clientDeviceId: '', ...parsed }
  } catch (error) {
    if (error && error.code !== 'ENOENT') log(`remotes.json unreadable, starting empty: ${error.code ?? 'parse error'}`)
  }
  // An install-scoped id: re-pairing the same remote reuses its device row (and
  // makes the gateway close the old sockets) instead of piling up duplicates.
  if (!CLIENT_DEVICE_ID.test(data.clientDeviceId)) data.clientDeviceId = `dshdev-${crypto.randomUUID()}`
  data.remotes = data.remotes.filter((remote) => remote && REMOTE_ID.test(remote.id) && typeof remote.publicUrl === 'string')

  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true })
    writeSecretFile(remotesFile, JSON.stringify(data, null, 2))
  }
  save()
  const tokenFile = (id) => {
    if (!REMOTE_ID.test(id)) throw new RemoteInputError('invalid device id', 404, 'not-found')
    return path.join(tokensDir, `${id}.token`)
  }
  return {
    clientDeviceId: data.clientDeviceId,
    list: () => data.remotes.map((remote) => ({ ...remote })),
    get: (id) => data.remotes.find((remote) => remote.id === id),
    add(remote) { data.remotes.push(remote); save() },
    update(id, patch) {
      const remote = data.remotes.find((candidate) => candidate.id === id)
      if (!remote) return undefined
      Object.assign(remote, patch)
      save()
      return remote
    },
    remove(id) {
      const index = data.remotes.findIndex((remote) => remote.id === id)
      if (index < 0) return false
      data.remotes.splice(index, 1)
      save()
      this.wipeToken(id)
      return true
    },
    writeToken(id, token) { writeSecretFile(tokenFile(id), token) },
    readToken(id) {
      try { return fs.readFileSync(tokenFile(id), 'utf8').trim() || null } catch { return null }
    },
    hasToken(id) { return fs.existsSync(tokenFile(id)) },
    /** Overwrite then delete: a wiped credential must not linger in a recoverable file. */
    wipeToken(id) {
      const file = tokenFile(id)
      try { fs.writeFileSync(file, crypto.randomBytes(48).toString('base64url')) } catch { /* nothing to overwrite */ }
      try { fs.rmSync(file, { force: true }) } catch (error) { log(`could not delete a token file [${error.code ?? 'error'}]`) }
    },
    tokenFile,
  }
}

const publicRemote = (remote, live, approvals) => ({
  id: remote.id,
  name: remote.name,
  address: remote.address,
  gatewayId: remote.gatewayId ?? null,
  createdAt: remote.createdAt,
  certSha256: remote.certSha256,
  device: remote.device ?? null,
  // `revoked` is persisted (the token file is gone); the others describe the live socket.
  status: remote.revoked ? 'revoked' : (live?.state ?? 'offline'),
  detail: remote.revoked ? 'the remote revoked this device; pair it again' : (live?.detail ?? null),
  approvals,
})

/** Per-context internals of an applied plugin (see the note at the end of `apply`). */
const internals = new WeakMap()

export const plugin = {
  name: 'devices',
  inject: ['webServer'],
  async apply(ctx, config = {}) {
    const webServer = ctx.webServer
    const options = { dataDir: '', allowPublicRemotes: false, remoteSessions: true, ...config }
    // Messages here never include tokens, pairing codes or request headers.
    const sink = typeof options.log === 'function' ? options.log : (line) => console.log('devices:', line)
    const log = (message) => { try { sink(`[${new Date().toISOString()}] ${message}`) } catch { /* logging must not throw */ } }
    setSecureFileLogger(log)
    const dataDir = options.dataDir || path.join(os.homedir(), '.dsh', 'devices-page')
    const store = createStore(dataDir, log)
    // Spec 008 P2c: the offline copy of a remote session's transcript, one JSONL
    // file per (host, session) under sessions/. The session follower in
    // lib/host-router.mjs writes it; the router and `…/history` replay it read-only
    // while that host is offline; "Remove local copy" deletes it.
    const sessionCache = createSessionCache({
      dir: path.join(dataDir, 'sessions'),
      log,
      maxBytes: options.sessionCacheMaxBytes,
      rotations: options.sessionCacheRotations,
    })
    /** @type {Map<string, {connection: RemoteConnection, state: string, detail: string|null, approvals: Map<string, object>}>} */
    const live = new Map()
    // Multi-host routing (spec 008 P2a) subscribes here: a merged workspace/follow
    // has to republish when a remote connects or drops.
    const hostListeners = new Set()
    const notifyHosts = () => {
      for (const listener of [...hostListeners]) {
        try { listener() } catch { /* routing must never break a socket */ }
      }
    }

    const attach = (remote) => {
      let entry = live.get(remote.id)
      if (entry) return entry
      const connection = new RemoteConnection({
        remote: { ...remote, clientDeviceId: store.clientDeviceId },
        readToken: () => store.readToken(remote.id),
        log,
        WebSocketImpl: options.WebSocketImpl,
        requestTimeoutMs: options.requestTimeoutMs,
      })
      entry = { connection, state: 'offline', detail: null, approvals: new Map() }
      connection.on('state', (state, detail) => { entry.state = state; entry.detail = detail ?? null; notifyHosts() })
      connection.on('approval', (frame) => {
        if (typeof frame.rpcId !== 'string') return
        // The card's ids are remote data: the WHOLE frame is validated before it
        // is buffered, so a hostile `approvalId` can never be echoed back on a
        // decision or reach the native UI through `view()`/`pending()`.
        try { assertCleanCard(remote.id, frame) } catch (error) {
          log(`approval card from ${remote.id} refused: ${error?.code ?? 'error'}`)
          return
        }
        entry.approvals.set(frame.rpcId, frame)
        while (entry.approvals.size > MAX_APPROVALS_PER_REMOTE) entry.approvals.delete(entry.approvals.keys().next().value)
      })
      connection.on('resolved', (frame) => entry.approvals.delete(frame.rpcId))
      connection.on('revoked', () => {
        // Contract §3/§6: 4401 = the credential is gone. Wipe it and say so; never auto-retry.
        store.wipeToken(remote.id)
        store.update(remote.id, { revoked: true })
        entry.approvals.clear()
        log(`remote ${remote.id} revoked this device (4401); token wiped`)
      })
      live.set(remote.id, entry)
      return entry
    }

    const view = (remote) => {
      const entry = live.get(remote.id)
      // A call this Host refused (e.g. `auth/forbidden-scope` for `harness:remote`)
      // is shown on that remote's row: a failing host contributes no merged rows,
      // which is otherwise indistinguishable from a host that simply has none.
      const hostError = hostRouter?.status().hosts.find((host) => host.hostId === remote.id)?.error ?? null
      return { ...publicRemote(remote, entry, entry ? [...entry.approvals.values()] : []), hostError }
    }

    const requireRemote = (id) => {
      const remote = REMOTE_ID.test(id) ? store.get(id) : undefined
      if (!remote) throw new RemoteInputError('unknown remote device', 404, 'not-found')
      return remote
    }
    const connected = async (remote) => {
      if (remote.revoked) throw new RemoteInputError('the remote revoked this device; pair it again', 401, 'auth/revoked')
      const entry = attach(remote)
      await entry.connection.connect()
      return entry
    }
    const unwrap = (frame, kind) => {
      if (frame?.kind === 'error') {
        const error = new RemoteInputError(`the remote refused ${frame.requestType ?? 'the request'}: ${frame.code ?? 'error'}`,
          frame.code === 'auth/forbidden-scope' ? 403 : 502, frame.code ?? 'remote-error')
        throw error
      }
      if (frame?.kind !== kind) throw new RemoteInputError(`unexpected answer from the remote (${String(frame?.kind)})`, 502, 'remote-error')
      return frame
    }
    /** A dead or unreachable host is not a 502: the UI needs the offline banner. */
    const remoteOffline = (remote, action) => new RemoteInputError(
      `${remote.name} is offline; ${action}`, 409, 'remote/host-offline')
    /**
     * The subagent address a history read carries, as the CALLER sent it: both
     * history routes accept `parentSessionId` (and an optional `subagentMode`).
     * Validated here, before anything is dialled — a malformed id or mode must be a
     * 400, never a request carrying garbage.
     */
    const subagentParam = (url, sessionId) => {
      const parentSessionId = url.searchParams.get('parentSessionId')
      if (parentSessionId === null) {
        // A mode without a parent is exactly what the gateway refuses; refuse it here,
        // before a dial, so the caller sees why.
        if (url.searchParams.has('subagentMode')) throw new RemoteInputError('subagentMode needs a parentSessionId')
        return null
      }
      if (!SESSION_COPY_ID.test(parentSessionId)) throw new RemoteInputError('invalid parentSessionId')
      if (parentSessionId === sessionId) throw new RemoteInputError('parentSessionId must name a different session')
      const subagentMode = url.searchParams.get('subagentMode') ?? 'unknown'
      if (!SUBAGENT_MODES.has(subagentMode)) throw new RemoteInputError('invalid subagentMode')
      return { parentSessionId, subagentMode }
    }
    /** remote id -> the rows of its last `{ type: 'sessions' }` answer. */
    const sessionListCache = new Map()
    /**
     * Why this lookup exists: DSH's session-history `validateAddress` refuses an
     * address of `kind:'session'` with `session/agent-busy` ("subagent Sessions
     * require their durable parent address") for every header whose `origin` is
     * `subagent` — running or not. The row in that Host's OWN session list carries the
     * durable parent, so the plain route stays readable for any caller.
     * Reuses the same `{ type: 'sessions' }` request the `…/sessions` route makes and
     * keeps its rows for SESSION_LIST_TTL_MS: several hundred rows (491 of 517 on the
     * reference Host are subagent children) must not be re-listed per session opened.
     */
    const sessionRowOf = async (remote, entry, sessionId) => {
      let cached = sessionListCache.get(remote.id)
      if (!cached || Date.now() - cached.at > SESSION_LIST_TTL_MS) {
        const frame = await entry.connection.request({ type: 'sessions' })
        if (frame?.kind !== 'sessions' || !Array.isArray(frame.items)) return null
        const rows = new Map()
        for (const item of frame.items) {
          if (typeof item?.sessionId === 'string' && !rows.has(item.sessionId)) rows.set(item.sessionId, item)
        }
        // Bounded like the remote list itself: one entry per paired remote at most.
        if (sessionListCache.size >= MAX_REMOTES) sessionListCache.delete(sessionListCache.keys().next().value)
        cached = { at: Date.now(), rows }
        sessionListCache.set(remote.id, cached)
      }
      return cached.rows.get(sessionId) ?? null
    }
    /**
     * `GET …/history`: the live page when the host answers, else the local copy
     * (spec 008 P2c). Never dials for a session that is already cached and offline.
     * `beforeSeq` is forwarded only when the caller actually sent it (`Number(null)`
     * would be 0, which is not a valid cursor).
     * A subagent child travels with its durable parent address, from the caller when
     * given and from this Host's own list otherwise; a Host that still refuses
     * surfaces its code verbatim (`session/agent-busy` is not translated).
     */
    const serveHistory = async (remote, sessionId, beforeSeq, subagent) => {
      let entry
      try {
        entry = await connected(remote)
      } catch (error) {
        if (error instanceof RemoteInputError) throw error
        const cached = sessionCache.history(remote.id, sessionId)
        if (cached) return cached
        throw remoteOffline(remote, 'this session has no cached copy to read')
      }
      let address = subagent
      if (!address) {
        try {
          const row = await sessionRowOf(remote, entry, sessionId)
          // Never guess: a row that is not a subagent child, or names no parent, keeps
          // the plain request (a Host that cannot list leaves exactly the old behaviour).
          if (row?.origin === 'subagent' && typeof row.parentSessionId === 'string'
            && row.parentSessionId !== sessionId && SESSION_COPY_ID.test(row.parentSessionId)) {
            address = { parentSessionId: row.parentSessionId, subagentMode: 'unknown' }
          }
        } catch { /* the lookup is an optimisation: the plain request below is the old behaviour */ }
      }
      // `subagentMode` never travels without a parent (the gateway refuses that).
      const request = { type: 'history', sessionId,
        ...(address ? { parentSessionId: address.parentSessionId, subagentMode: address.subagentMode } : {}) }
      if (beforeSeq !== null && beforeSeq !== undefined && Number.isFinite(beforeSeq)) request.beforeSeq = beforeSeq
      return unwrap(await entry.connection.request(request), 'history')
    }
    /**
     * Delete the single-page copy an older build (spec 008 P2b) wrote at
     * `sessions/<remoteId>/<sessionId>.json`, before the cache kept one JSONL file
     * per (host, session). "Remove local copy" has to take that file too, or a
     * transcript stays readable on disk after the button was pressed.
     *
     * The path is built from the raw ids, which is safe only because both are
     * validated before this runs: the remote id is a UUID (`requireRemote`) and the
     * session id is `SESSION_COPY_ID` (no separator, no leading dot, no `..`), so
     * the join cannot leave the cache directory.
     */
    const removeLegacyCopy = (remoteId, sessionId) => {
      try {
        fs.rmSync(path.join(dataDir, 'sessions', remoteId, `${sessionId}.json`))
        return true
      } catch (error) {
        if (error?.code !== 'ENOENT') log(`an old single-page copy could not be removed [${error.code ?? 'error'}]`)
        return false
      }
    }

    // Spec 008 P2a: the native UI talks to ONE typertGateway, so remote Hosts are
    // addressed by tagging their ids (`h:<hostId>:<id>`, lib/host-router.mjs). The
    // router patches the gateway in place; on a carrier mismatch it patches
    // nothing and reports why, and the UI keeps working locally.
    const hostRouter = options.remoteSessions === false ? null : createHostRouter({
      gateway: typeof ctx.get === 'function' ? ctx.get('typertGateway', false) : undefined,
      // Only a live connection can serve a routed call; an offline or unknown id
      // is `remote/host-offline`, never a silent Local fallback.
      hosts: () => {
        const hosts = []
        for (const [id, entry] of live) {
          if (entry.connection.state !== 'online') continue
          hosts.push({ hostId: id, hostName: store.get(id)?.name ?? id, connection: entry.connection, online: true })
        }
        return hosts
      },
      onHostsChanged: (listener) => {
        hostListeners.add(listener)
        return () => hostListeners.delete(listener)
      },
      // A remote `$events/result` must echo the argsHash of the card the Host
      // issued (the bridge refuses an unbound decision); the buffered card is it.
      approvals: {
        card(hostId, ids) {
          const entry = live.get(hostId)
          if (!entry) return undefined
          for (const key of [ids?.rpcId, ids?.eventId, ids?.approvalId]) {
            if (typeof key === 'string' && entry.approvals.has(key)) return entry.approvals.get(key)
          }
          return undefined
        },
        // Cards buffered while no `$events` stream was open (a reload, a second
        // window) are seeded into the merged stream so they stay answerable.
        pending(hostId) {
          const entry = live.get(hostId)
          return entry ? [...entry.approvals.values()] : []
        },
      },
      // Every remote `session/follow` frame lands here (spec 008 P2c).
      cache: sessionCache,
      // Constitution A1.1: the wrapper is enabled only on the pinned `engines.dsh`
      // the self-test was written for; an unknown or different version means no
      // wrap and a reason the Devices page shows. `testDshVersion` is the same kind
      // of seam as the gateway's `testActivationHold`: test-only, never a config key.
      dshVersion: typeof options.testDshVersion === 'string' ? options.testDshVersion : resolveDshRuntimeVersion(),
      log,
    })
    hostRouter?.install()
    if (hostRouter) log(`multi-host routing: ${hostRouter.status().remote ? 'active' : `off (${hostRouter.status().reason})`}`)

    for (const remote of store.list()) if (!remote.revoked) attach(remote)

    // Spec 008 P1b: pairing waits for the Host user's Approve (up to ~5 min), so
    // it runs as a server-side session the page polls and can cancel. Nothing
    // secret (OTP, token) is ever part of a session's public view.
    /** @type {Map<string, {id: string, state: string, verificationCode: string|null, error: string|null, code: string|null, remoteId: string|null, address: string, controller: AbortController, createdAt: number}>} */
    const pairings = new Map()
    const MAX_PAIRINGS = 8
    const pairingView = (session) => ({
      id: session.id, state: session.state, address: session.address,
      verificationCode: session.verificationCode ? formatVerificationCode(session.verificationCode) : null,
      error: session.error, code: session.code, remoteId: session.remoteId,
    })
    const prunePairings = () => {
      const now = Date.now()
      for (const [id, session] of pairings) {
        if (session.state !== 'pending' && session.state !== 'connecting' && now - session.createdAt > 10 * 60_000) pairings.delete(id)
      }
    }

    const startPairing = (body) => {
      prunePairings()
      if (store.list().length >= MAX_REMOTES) throw new RemoteInputError('too many remote devices', 409, 'limit')
      if ([...pairings.values()].filter((s) => s.state === 'connecting' || s.state === 'pending').length >= MAX_PAIRINGS) {
        throw new RemoteInputError('too many pairings in progress', 429, 'limit')
      }
      const hasOtp = body.otp !== undefined && body.otp !== ''
      const hasString = typeof body.pairingString === 'string' && body.pairingString.trim() !== ''
      if (hasOtp === hasString) throw new RemoteInputError('give either the 8-digit pairing code or an advanced pairing string')
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : ''
      let run
      let url
      if (hasOtp) {
        url = otpDialUrl(body.address, { allowPublic: options.allowPublicRemotes === true })
        // Validated here, not inside the async run, so a typo is a 400 and nothing is dialled.
        const otp = normalizeOtp(body.otp)
        run = (hooks) => claimWithOtp({ url, otp, clientDeviceId: store.clientDeviceId, deviceName: options.deviceName || os.hostname(),
          WebSocketImpl: options.WebSocketImpl, ...hooks }).then((claimed) => ({ claimed, certSha256: claimed.certSha256, payload: {} }))
      } else {
        const payload = decodePairingString(body.pairingString)
        url = resolveDialUrl(body.address, payload, { allowPublic: options.allowPublicRemotes === true })
        run = (hooks) => claimPairing({ url, payload, clientDeviceId: store.clientDeviceId, deviceName: options.deviceName || os.hostname(),
          WebSocketImpl: options.WebSocketImpl, ...hooks }).then((claimed) => ({ claimed, certSha256: payload.certSha256, payload }))
      }
      const session = { id: crypto.randomUUID(), state: 'connecting', verificationCode: null, error: null, code: null, remoteId: null,
        address: new URL(url).host, controller: new AbortController(), createdAt: Date.now() }
      pairings.set(session.id, session)
      run({ signal: session.controller.signal, onPending: (code) => { session.state = 'pending'; session.verificationCode = code } })
        .then(({ claimed, certSha256, payload }) => {
          if (session.state === 'cancelled') return // the user gave up; the token is simply dropped
          const record = commitRemote({ url, name, claimed, certSha256, payload })
          session.remoteId = record.id
          session.state = 'approved'
        })
        .catch((error) => {
          if (session.state === 'cancelled') return
          session.state = error?.code === 'pairing/rejected' ? 'rejected' : 'failed'
          session.error = error instanceof RemoteInputError ? error.message : 'the remote device could not be reached'
          session.code = error?.code ?? null
          log(`pairing with ${session.address} ended: ${error instanceof PinMismatchError ? 'pin mismatch' : (error?.code ?? 'error')}`)
        })
      return session
    }

    /** Persist a freshly paired remote (token file + record) and start its live connection. */
    const commitRemote = ({ url, name: typedName, claimed, certSha256, payload }) => {
      const gatewayId = payload.gatewayId ?? claimed.gatewayId ?? null
      const name = typedName || String(payload.gatewayName || claimed.gatewayName || 'Remote host').slice(0, 80)
      // Same installation + same gateway = re-pair in place (the gateway closes the old sockets).
      const existing = store.list().find((remote) => remote.gatewayId && remote.gatewayId === gatewayId)
      const id = existing?.id ?? crypto.randomUUID()
      store.writeToken(id, claimed.token)
      const record = {
        id, name, address: new URL(url).host, publicUrl: url, certSha256,
        gatewayId, createdAt: existing?.createdAt ?? Date.now(),
        device: claimed.device ? { id: claimed.device.id, kind: claimed.device.kind, scopes: claimed.device.scopes } : null,
        revoked: false,
      }
      if (existing) {
        live.get(id)?.connection.close()
        live.delete(id)
        store.update(id, record)
      } else store.add(record)
      log(`paired with ${record.address} as ${record.device?.kind ?? 'device'} (scopes: ${(record.device?.scopes ?? []).join(', ')})`)
      const entry = attach(store.get(id))
      entry.connection.connect().catch(() => { /* status shows the failure; the user can retry */ })
      return store.get(id)
    }

    const addRemote = async (body) => {
      if (store.list().length >= MAX_REMOTES) throw new RemoteInputError('too many remote devices', 409, 'limit')
      const payload = decodePairingString(body.pairingString)
      const url = resolveDialUrl(body.address, payload, { allowPublic: options.allowPublicRemotes === true })
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80)
        : String(payload.gatewayName || 'Remote host').slice(0, 80)
      // Same installation + same gateway = re-pair in place (the gateway closes the old sockets).
      const existing = store.list().find((remote) => remote.gatewayId && remote.gatewayId === payload.gatewayId)
      let claimed
      try {
        claimed = await claimPairing({
          url, payload, clientDeviceId: store.clientDeviceId, deviceName: options.deviceName || os.hostname(),
          WebSocketImpl: options.WebSocketImpl,
        })
      } catch (error) {
        log(`pairing with ${new URL(url).host} failed: ${error instanceof PinMismatchError ? 'pin mismatch' : (error.code ?? 'error')}`)
        throw error
      }
      const id = existing?.id ?? crypto.randomUUID()
      store.writeToken(id, claimed.token)
      const record = {
        id, name, address: new URL(url).host, publicUrl: url, certSha256: payload.certSha256,
        gatewayId: payload.gatewayId ?? claimed.gatewayId ?? null, createdAt: existing?.createdAt ?? Date.now(),
        device: claimed.device ? { id: claimed.device.id, kind: claimed.device.kind, scopes: claimed.device.scopes } : null,
        revoked: false,
      }
      if (existing) {
        live.get(id)?.connection.close()
        live.delete(id)
        store.update(id, record)
      } else store.add(record)
      log(`paired with ${record.address} as ${record.device?.kind ?? 'device'} (scopes: ${(record.device?.scopes ?? []).join(', ')})`)
      const entry = attach(store.get(id))
      entry.connection.connect().catch(() => { /* status shows the failure; the user can retry */ })
      return view(store.get(id))
    }

    const handler = async (req, res) => {
      try {
        // FR5: every request, read or write, comes from this machine. The
        // plugin itself never opens a listener, but the Host web server may
        // be bound wider; a remote device must not reach these routes.
        if (!isLoopback(req)) {
          sendJson(res, 403, { error: 'forbidden', message: 'devices API is loopback-only' })
          return
        }
        // Same-origin on EVERY request (stricter than /mgw, which exempts GET):
        // the list exposes remote hosts and pending approvals to the page.
        if (!isSameOrigin(req)) {
          sendJson(res, 403, { error: 'forbidden', message: 'cross-origin devices request rejected' })
          return
        }
        // A path segment of `.`/`..` is refused BEFORE the URL parser folds it into a
        // different route: `…/remotes/<id>/sessions/..` would otherwise become
        // `…/remotes/<id>` and delete the host. Percent-encoded dots are folded too.
        const rawPath = String(req.url || '/').split('?')[0]
        let decodedPath = rawPath
        try { decodedPath = decodeURIComponent(rawPath) } catch { decodedPath = rawPath }
        if (decodedPath.split('/').some((segment) => segment === '.' || segment === '..')) {
          sendJson(res, 400, { error: 'bad-request', message: 'invalid path segment' })
          return
        }
        const url = new URL(req.url || '/', 'http://x')
        const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean) // ['devices', 'remotes', id, action]
        // Spec 008 P1b: pairing sessions. POST starts one (OTP or advanced string),
        // GET polls it, DELETE cancels it. Same loopback + same-origin guards as above.
        if (parts[0] === 'devices' && parts[1] === 'pairings') {
          if (parts.length === 2 && req.method === 'POST') {
            sendJson(res, 201, { pairing: pairingView(startPairing(await readBody(req))) })
            return
          }
          const session = parts.length === 3 && /^[a-f0-9-]{36}$/.test(parts[2]) ? pairings.get(parts[2]) : undefined
          if (!session) { sendJson(res, 404, { error: 'not-found', message: 'unknown pairing' }); return }
          if (req.method === 'GET') { sendJson(res, 200, { pairing: pairingView(session) }); return }
          if (req.method === 'DELETE') {
            if (session.state === 'connecting' || session.state === 'pending') {
              session.state = 'cancelled'
              session.controller.abort()
            }
            sendJson(res, 200, { pairing: pairingView(session) })
            return
          }
          sendJson(res, 404, { error: 'not-found' })
          return
        }
        if (parts[0] !== 'devices' || parts[1] !== 'remotes') { sendJson(res, 404, { error: 'not-found' }); return }
        const id = parts[2]
        const action = parts[3]

        if (parts.length === 2) {
          if (req.method === 'GET') {
            // `routing` tells the page whether remote sessions are live (and why not).
            sendJson(res, 200, {
              remotes: store.list().map(view),
              routing: hostRouter ? hostRouter.status() : { remote: false, reason: 'disabled', hosts: [], merged: [] },
            })
            return
          }
          if (req.method === 'POST') { sendJson(res, 201, { remote: await addRemote(await readBody(req)) }); return }
        } else if (parts.length === 3) {
          if (req.method === 'GET') { sendJson(res, 200, { remote: view(requireRemote(id)) }); return }
          if (req.method === 'DELETE') {
            requireRemote(id)
            live.get(id)?.connection.close()
            live.delete(id)
            store.remove(id)
            log(`removed remote ${id}`)
            sendJson(res, 200, { removed: true })
            return
          }
        } else if (parts.length === 4) {
          const remote = requireRemote(id)
          // The composer chip's "Reconnect": dial again through the same guarded
          // path the session list uses, then answer with the fresh view.
          if (req.method === 'POST' && action === 'connect') {
            const entry = await connected(remote)
            sendJson(res, 200, { remote: view(store.get(id)), state: entry.connection.state })
            return
          }
          if (req.method === 'GET' && action === 'sessions') {
            const entry = await connected(remote)
            const frame = unwrap(await entry.connection.request({ type: 'sessions' }), 'sessions')
            sendJson(res, 200, { sessions: frame.items ?? [], approvals: [...entry.approvals.values()] })
            return
          }
          if (req.method === 'GET' && action === 'history') {
            const sessionId = url.searchParams.get('sessionId')
            if (!sessionId || sessionId.length > 256) throw new RemoteInputError('sessionId is required')
            const before = url.searchParams.has('beforeSeq') ? Number(url.searchParams.get('beforeSeq')) : null
            // Parsed before the call so a bad address is a 400 and nothing is dialled.
            const subagent = subagentParam(url, sessionId)
            sendJson(res, 200, { history: await serveHistory(remote, sessionId, before, subagent) })
            return
          }
          if (req.method === 'POST' && action === 'prompt') {
            const body = await readBody(req)
            if (typeof body.sessionId !== 'string' || !body.sessionId || typeof body.text !== 'string' || !body.text.trim()) {
              throw new RemoteInputError('sessionId and text are required')
            }
            if (body.text.length > 32_000) throw new RemoteInputError('text is too long', 413, 'too-large')
            let entry
            try {
              entry = await connected(remote)
            } catch (error) {
              if (error instanceof RemoteInputError) throw error
              // A prompt is a write: it is never queued against the local copy.
              throw remoteOffline(remote, 'the prompt was not sent')
            }
            const sent = unwrap(await entry.connection.request({
              type: 'message', sessionId: body.sessionId, text: body.text,
              clientMsgId: typeof body.clientMsgId === 'string' && body.clientMsgId.length <= 128 ? body.clientMsgId : crypto.randomUUID(),
            }), 'sent')
            sendJson(res, 200, { sent })
            return
          }
          if (req.method === 'POST' && action === 'approval') {
            const body = await readBody(req)
            for (const key of ['rpcId', 'sessionId', 'approvalId']) {
              if (typeof body[key] !== 'string' || !body[key]) throw new RemoteInputError(`${key} is required`)
            }
            if (body.outcome !== 'allowed-once' && body.outcome !== 'rejected') throw new RemoteInputError('outcome must be allowed-once or rejected')
            const entry = await connected(remote)
            // The decision binds the exact content shown: echo the hash we buffered,
            // never one supplied only by the page. A null hash is desktop-only.
            const pending = entry.approvals.get(body.rpcId)
            if (!pending) throw new RemoteInputError('that approval is no longer pending', 409, 'not-pending')
            if (typeof pending.argsHash !== 'string') throw new RemoteInputError('this approval cannot be decided remotely (no content hash)', 409, 'desktop-only')
            if (typeof body.argsHash === 'string' && body.argsHash !== pending.argsHash) {
              throw new RemoteInputError('the approval content changed; reload and review it again', 409, 'hash-mismatch')
            }
            const receipt = unwrap(await entry.connection.request({
              type: 'approval-response', rpcId: pending.rpcId, sessionId: pending.sessionId,
              approvalId: pending.approvalId, argsHash: pending.argsHash, outcome: body.outcome,
            }), 'approval-response')
            if (receipt.accepted) entry.approvals.delete(pending.rpcId)
            sendJson(res, 200, { receipt })
            return
          }
        } else if (parts.length === 5 && parts[3] === 'sessions' && req.method === 'DELETE') {
          // "Remove local copy" (spec 008 P2b): delete OUR cache of that remote
          // session. It never talks to the remote — the host may be offline or gone,
          // which is exactly when the banner shows — and it is an idempotent no-op
          // when nothing is cached.
          const remote = requireRemote(id)
          let sessionId
          try { sessionId = decodeURIComponent(parts[4]) } catch { sessionId = '' }
          if (!SESSION_COPY_ID.test(sessionId)) throw new RemoteInputError('invalid session id', 400, 'bad-request')
          // Every copy this plugin wrote for the session goes: the hashed JSONL
          // cache (live file + rotations) and the single-page `.json` older builds
          // left behind. Anything less would make the button's promise false.
          const cached = sessionCache.remove(remote.id, sessionId)
          const removed = removeLegacyCopy(remote.id, sessionId) || cached
          log(`local copy of a ${remote.name} session ${removed ? 'removed' : 'was not cached'}`)
          sendJson(res, 200, { removed, sessionId })
          return
        } else if (parts.length === 6 && parts[3] === 'sessions' && parts[5] === 'history' && req.method === 'GET') {
          // The path form of the route above (`…/sessions/:sid/history`), same
          // answer: live when the host is up, the local copy when it is not.
          const remote = requireRemote(id)
          let sessionId
          try { sessionId = decodeURIComponent(parts[4]) } catch { sessionId = '' }
          if (!SESSION_COPY_ID.test(sessionId)) throw new RemoteInputError('invalid session id', 400, 'bad-request')
          const before = url.searchParams.has('beforeSeq') ? Number(url.searchParams.get('beforeSeq')) : null
          // Same explicit address as the query-string route above (validated pre-dial).
          const subagent = subagentParam(url, sessionId)
          sendJson(res, 200, { history: await serveHistory(remote, sessionId, before, subagent) })
          return
        }
        sendJson(res, 404, { error: 'not-found' })
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500
        // Only our own typed errors carry user-safe text; anything else is generic.
        const safe = error instanceof RemoteInputError || error?.closeCode !== undefined
        if (status >= 500 || !safe) log(`route failed: ${error?.code ?? error?.name ?? 'error'}`)
        sendJson(res, safe ? status : 502, {
          error: error?.code ?? (status < 500 ? 'bad-request' : 'internal'),
          message: safe ? error.message : 'the remote device could not be reached',
          ...(error?.closeCode === CLOSE_REVOKED ? { revoked: true } : {}),
        })
      }
    }

    const dispose = webServer.register({ kind: 'prefix', path: '/devices', handler })
    log(`routes registered: /devices (loopback-only, same-origin); data=${path.basename(dataDir)}; remotes=${store.list().length}`)

    const teardown = () => {
      // First: stop routing, so no merged stream or remote call starts against
      // connections that are about to be closed.
      hostRouter?.uninstall()
      hostListeners.clear()
      dispose?.()
      for (const session of pairings.values()) {
        if (session.state === 'connecting' || session.state === 'pending') { session.state = 'cancelled'; session.controller.abort() }
      }
      for (const entry of live.values()) entry.connection.close()
      live.clear()
    }
    ctx.effect(() => teardown)
    // Cordis collects an `apply` result as a disposer: an async apply that
    // resolves to a plain object is rejected with `TypeError: Invalid effect`
    // (cordis lib/index.js `_execute` -> `safeCollect`). So the plugin exposes
    // its internals through this WeakMap instead of returning them, and the
    // teardown is registered exactly once, through the effect above.
    internals.set(ctx, { store, live, handler, teardown, router: hostRouter })
  },
}

/**
 * The internals an `apply` produced for a given plugin context. Exists because
 * an async `apply` may not resolve to an object (see the note above); tests and
 * the live profile read the same values through it.
 * @param {object} ctx the context `apply` was called with
 * @returns {{store: object, live: Map<string, object>, handler: Function,
 *   teardown: Function, router: object|undefined}|undefined}
 */
export function internalsFor(ctx) {
  return internals.get(ctx)
}

export { restrictToOwnerSync }
export default plugin
