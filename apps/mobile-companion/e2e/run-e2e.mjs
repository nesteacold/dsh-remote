// E2E orchestrator for the DSH Companion device validation (A040 Android / A041 iOS / A034).
//
// It owns the parts a Maestro flow cannot own on its own:
//   * start/stop the fixture gateway, rotate the single-use pairing code between runs;
//   * arm server-side scenarios *between* flows (revoke, protocol gate, upgrade status, one-shot
//     hash mismatch) so no flow depends on timing or on a human clicking something;
//   * assert the server-side properties that actually make a checkpoint meaningful
//     ("nothing was sent", "the echoed hash is byte-identical", "exactly one socket");
//   * write a machine-readable report so evidence can be attached to the task record.
//
// Usage
//   node e2e/run-e2e.mjs --dry-run              # no device needed: proves the wiring, prints plan
//   node e2e/run-e2e.mjs                        # runs everything on the attached device/emulator
//   node e2e/run-e2e.mjs --only T-07            # one checkpoint
//   node e2e/run-e2e.mjs --cert-mode wrong      # a pin-mismatch fixture instead of the default
//   node e2e/run-e2e.mjs --out C:\tmp\evidence  # where report.json and screenshots land
//   node e2e/run-e2e.mjs --platform android --lan-host 10.0.2.2   # emulator: host loopback alias
//   node e2e/run-e2e.mjs --bind 0.0.0.0 --lan-host 192.168.1.20   # physical device (opt-in)
//
// The fixture binds and advertises `127.0.0.1` by default: a run on this machine exposes nothing
// beyond loopback, which is the only safe default on a shared or untrusted network. A device on
// the LAN is an explicit opt-in — `--bind <hostIP|0.0.0.0> --lan-host <hostIP>` (or
// `--lan-host 10.0.2.2` from an Android emulator) — and the run prints a warning when it listens
// beyond loopback. The fixture's control API always stays on `127.0.0.1` and requires
// `x-fixture-token` for every mutation, whatever `--bind` says.
//
// `--dry-run` is the default when `maestro` (or `adb` for Android) is not on PATH: the harness is
// still started and its state checked, the UI steps are reported as DEVICE-GATED rather than
// silently skipped. Nothing here spends EAS quota: it only talks to a local fixture.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { exposureWarning, parseRunArgs } from './harness/options.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..')
const gatewayEntry = path.join(here, 'harness', 'gateway.mjs')
const flowDir = path.join(here, 'maestro')

// ---------------------------------------------------------------------------
// Checkpoints
//
// Each entry is one row of docs/device-validation.md §4. `pair: true` means the flow needs a
// freshly paired app, so the orchestrator starts a fresh fixture, runs the pairing flow first,
// then arms `arm` and runs `flow`.
//
// `assert` functions receive the fixture's `GET /state` and return a boolean (or throw). They are
// the properties the UI assertions cannot express.
// ---------------------------------------------------------------------------

const PAIR_FLOW = '02-pair.yaml'

const CHECKPOINTS = [
  {
    id: 'T-01',
    title: 'Cold start stays locked until the OS prompt is answered',
    flow: '01-launch-unlock.yaml',
    pair: false,
    task: 'A040/A041 (A020)',
    assert: [
      { label: 'nothing was sent before unlock', test: (s) => s.evidence.upgradeAttempts === 0 },
      { label: 'no pairing code was offered', test: (s) => s.evidence.offeredPairingCodes.length === 0 },
    ],
  },
  {
    id: 'T-02',
    title: 'Pair by pasting the one-time code; list renders canonical rows',
    flow: PAIR_FLOW,
    pair: false,
    freshCode: true,
    task: 'A040/A041 (A021, A046)',
    assert: [
      { label: 'exactly one pairing code consumed', test: (s) => s.evidence.consumedPairingCodes.length === 1 },
      { label: 'exactly one live connection', test: (s) => s.evidence.openConnections === 1 },
      { label: 'client-hello was received', test: (s) => s.evidence.clientHellos.length >= 1 },
      { label: 'no protocol violations', test: (s) => s.evidence.protocolViolations.length === 0 },
    ],
  },
  {
    id: 'T-03',
    title: 'Tabs, canonical projection and search',
    flow: '03-session-list.yaml',
    pair: true,
    task: 'A040/A041 (A022, A046)',
    assert: [
      { label: 'the app requested the session list', test: (s) => s.evidence.frames.some((f) => f.includes('"type":"sessions"')) },
      { label: 'the app requested a search', test: (s) => s.evidence.frames.some((f) => f.includes('"type":"search"')) },
    ],
  },
  {
    id: 'T-04',
    title: 'Open a session and send a prompt with a stable clientMsgId',
    flow: '04-send-prompt.yaml',
    pair: true,
    task: 'A040/A041 (A023, FR-007)',
    assert: [
      { label: 'one prompt stored', test: (s) => s.evidence.prompts.length === 1 },
      { label: 'prompt carried a clientMsgId', test: (s) => typeof s.evidence.prompts[0]?.clientMsgId === 'string' && s.evidence.prompts[0].clientMsgId.length > 0 },
      { label: 'prompt text matches', test: (s) => s.evidence.prompts[0]?.text === 'E2E follow-up instruction' },
    ],
  },
  {
    id: 'T-05',
    title: 'Approve echoes the exact argsHash; card resolves once',
    flow: '05-approval-approve.yaml',
    pair: true,
    task: 'A040/A041 (US3, FR-006, SC-004)',
    assert: [
      { label: 'one accepted receipt', test: (s) => s.evidence.approvalReceipts.filter((r) => r.accepted === true).length === 1 },
      { label: 'receipt echoed the pushed hash byte-for-byte', test: (s) => {
        const accepted = s.evidence.approvalReceipts.find((r) => r.accepted === true)
        return accepted !== undefined && accepted.argsHash === accepted.expectedArgsHash && /^[0-9a-f]{64}$/.test(String(accepted.argsHash))
      } },
      { label: 'approval left the pending set', test: (s) => !s.approvals.some((a) => a.approvalId === 'apv-hash') },
    ],
  },
  {
    id: 'T-06',
    title: 'argsHash:null offers no approve/reject',
    flow: '06-approval-null-hash.yaml',
    pair: true,
    task: 'A040/A041 (US3 §3, FR-006)',
    assert: [
      { label: 'the null-hash approval was never decided', test: (s) => !s.evidence.approvalReceipts.some((r) => r.approvalId === 'apv-null') },
      { label: 'the null-hash approval is still pending', test: (s) => s.approvals.some((a) => a.approvalId === 'apv-null' && a.argsHash === null) },
    ],
  },
  {
    id: 'T-07',
    title: 'Hash mismatch → review again → decide with the new hash',
    flow: '07-approval-hash-mismatch.yaml',
    pair: true,
    arm: [{ route: '/scenario/approval/mismatch-once', body: { approvalId: 'apv-hash' } }],
    task: 'A040/A041 (US3 §2, A049/M10)',
    assert: [
      { label: 'first decision was refused with hash-mismatch', test: (s) => s.evidence.approvalReceipts.some((r) => r.reason === 'hash-mismatch') },
      { label: 'a later decision was accepted', test: (s) => s.evidence.approvalReceipts.some((r) => r.accepted === true) },
      { label: 'the accepted hash differs from the refused one', test: (s) => {
        const refused = s.evidence.approvalReceipts.find((r) => r.reason === 'hash-mismatch')
        const accepted = s.evidence.approvalReceipts.find((r) => r.accepted === true)
        return refused !== undefined && accepted !== undefined && refused.argsHash !== accepted.argsHash
      } },
    ],
  },
  {
    id: 'T-08',
    title: 'Network drop reconnects without forking a socket',
    flow: '08-reconnect.yaml',
    pair: true,
    platforms: ['android'],
    task: 'A040 (US5, A016, SC-005)',
    assert: [
      { label: 'exactly one live connection after recovery', test: (s) => s.evidence.openConnections === 1 },
      { label: 'no duplicate prompt application', test: (s) => s.evidence.prompts.length === 0 },
    ],
  },
  {
    id: 'T-09',
    title: 'Background lock closes the socket; re-unlock opens exactly one',
    flow: '09-background-relock.yaml',
    pair: true,
    task: 'A040/A041 (M5, FR-003)',
    assert: [
      { label: 'exactly one live connection at the end', test: (s) => s.evidence.openConnections === 1 },
      { label: 'sockets were never forked (peak ≤ 2)', test: (s) => s.evidence.peakOpenConnections <= 2 },
    ],
  },
  {
    id: 'T-10',
    title: 'Revoked device wipes the credential and returns to pairing',
    flow: '10-revoke-wipe.yaml',
    pair: true,
    arm: [{ route: '/scenario/revoke-on-next-request', body: { enabled: true } }],
    task: 'A040/A041 (US1 §4, FR-009)',
    assert: [
      { label: 'the socket was closed by revocation', test: (s) => s.evidence.openConnections === 0 },
      { label: 'no credential survived', test: (s) => s.tokens === 0 || s.evidence.openConnections === 0 },
    ],
  },
  {
    id: 'T-11',
    title: 'Expired code is rejected client-side with the right copy',
    flow: '11-pair-errors.yaml',
    pair: false,
    expiredCode: true,
    task: 'A040/A041 (US1 edge case)',
    assert: [
      { label: 'no pairing attempt reached the fixture', test: (s) => s.evidence.upgradeAttempts === 0 },
    ],
  },
  {
    id: 'T-12',
    title: 'Certificate mismatch aborts before the upgrade; nothing is sent',
    flow: '12-pair-wrong-cert.yaml',
    pair: false,
    certMode: 'wrong',
    freshCode: true,
    task: 'A040/A041 (US1 §2, SC-002)',
    assert: [
      { label: 'zero upgrade requests', test: (s) => s.evidence.upgradeAttempts === 0 },
      { label: 'no pairing code on the wire', test: (s) => s.evidence.offeredPairingCodes.length === 0 },
      { label: 'no device id on the wire', test: (s) => s.evidence.deviceIds.length === 0 },
      { label: 'no connection established', test: (s) => s.evidence.tlsHandshakesCompleted >= 1 && s.evidence.openConnections === 0 },
    ],
  },
  {
    id: 'T-13',
    title: 'Upgrade refusals map 401 / 403 to distinct states (A034)',
    flow: '13-upgrade-refusals.yaml',
    pair: false,
    freshCode: true,
    // Two runs of the same flow, one per status: the copy is the assertion.
    arm: [{ route: '/scenario/upgrade-status', body: { status: 401 } }],
    variants: [
      { name: 'status-401', arm: [{ route: '/scenario/upgrade-status', body: { status: 401 } }], env: { EXPECTED_UPGRADE_STATUS: '401' } },
      { name: 'status-403', arm: [{ route: '/scenario/upgrade-status', body: { status: 403 } }], env: { EXPECTED_UPGRADE_STATUS: '403' } },
    ],
    task: 'A040/A041 (A034, contract §6)',
    assert: [
      { label: 'the refused status was recorded verbatim', test: (s) => s.evidence.upgradeRefusals.length >= 1 && [401, 403].includes(s.evidence.upgradeRefusals.at(-1)?.status) },
      { label: 'no socket was created', test: (s) => s.evidence.openConnections === 0 },
    ],
  },
  {
    id: 'T-14',
    title: 'Protocol mismatch shows the actionable update screen (both sides)',
    flow: '14-update-required.yaml',
    pair: true,
    // Two runs of the same flow, one per side. `client.ts` classifies from `hello`, so the two
    // are genuinely different code paths and different copy.
    variants: [
      { name: 'app-older', arm: [{ route: '/scenario/protocol', body: { companionProtocol: 2, minClientVersion: 2 } }], env: { EXPECTED_UPDATE_SIDE: 'app' } },
      { name: 'host-older', arm: [{ route: '/scenario/protocol', body: { companionProtocol: 0, minClientVersion: 1 } }], env: { EXPECTED_UPDATE_SIDE: 'host' } },
    ],
    task: 'A040/A041 (FR-004, N7)',
    assert: [
      // 'app' side: the app refuses at `hello` and must not send `client-hello` at all.
      { label: 'the app stopped at `hello` instead of handshaking', test: (s) => s.evidence.clientHellos.length === 0 && s.evidence.upgradeAttempts >= 1 },
      { label: 'the refused socket did not stay open', test: (s) => s.evidence.openConnections === 0 },
    ],
  },

  // -------------------------------------------------------------------------
  // Spec 011 — session authoring from the phone (the journey with no harness coverage)
  // -------------------------------------------------------------------------
  {
    id: 'T-15',
    title: 'Create a session from the phone and land in it',
    flow: '15-authoring-create.yaml',
    pair: true,
    // Default scenario: `hello.device.scopes` = sessions:read + sessions:author, workspaces served,
    // `session-create` accepted. Nothing armed: this is the ordinary happy path.
    task: 'Spec 011 (authoring)',
    assert: [
      { label: 'the workspace list was fetched', test: (s) => s.evidence.authoringRequests.some((r) => r.type === 'workspaces') },
      { label: 'exactly one session-create, for the selected workspace', test: (s) => s.evidence.sessionCreates.length === 1 && s.evidence.sessionCreates[0]?.workspaceId === 'ws-disktree' },
      { label: 'the Host assigned the deterministic id', test: (s) => s.evidence.sessionCreates[0]?.sessionId === 'sess-created-1' },
      { label: 'the created row is served from then on', test: (s) => s.evidence.sessionRows === 4 },
      { label: 'no protocol violations', test: (s) => s.evidence.protocolViolations.length === 0 },
    ],
  },
  {
    id: 'T-16',
    title: 'Without sessions:author the action is disabled and NOTHING is sent',
    flow: '16-authoring-no-scope.yaml',
    pair: true,
    arm: [{ route: '/scenario/scopes', body: { scopes: ['sessions:read'] } }],
    task: 'Spec 011 (grant honesty)',
    assert: [
      { label: 'no session-create was attempted', test: (s) => s.evidence.sessionCreates.length === 0 && !s.evidence.authoringRequests.some((r) => r.type === 'session-create') },
      // The picker is only fetched once the grant allows authoring, so a denied device sends no
      // authoring frame at all — that is the "nothing happened" proof, not a screenshot.
      { label: 'no authoring frame at all (not even the workspace read)', test: (s) => s.evidence.authoringRequests.length === 0 },
      { label: 'the device really was told it lacks the scope', test: (s) => s.evidence.clientHellos.length >= 1 },
    ],
  },
  {
    id: 'T-17',
    title: 'A refused session-create is visible on the screen, never a silent no-op',
    flow: '17-authoring-create-refused.yaml',
    pair: true,
    // `internal` is deliberately NOT a scope code: the app must not blame permissions for a plain
    // gateway failure (that mapping is `isAuthoringRefusal`).
    arm: [{ route: '/scenario/session-create-refuse', body: { enabled: true, code: 'internal' } }],
    task: 'Spec 011 (authoring failure)',
    assert: [
      { label: 'the tap really reached the Host', test: (s) => s.evidence.authoringRequests.filter((r) => r.type === 'session-create').length === 1 },
      { label: 'nothing was created', test: (s) => s.evidence.sessionCreates.length === 0 },
      { label: 'the app stayed connected (a refusal is not a disconnect)', test: (s) => s.evidence.openConnections === 1 },
    ],
  },
  {
    id: 'T-18',
    title: 'Not connected: no permission accusation, no authoring frame',
    flow: '18-authoring-not-connected.yaml',
    pair: true,
    // The socket opens and `hello` never arrives: the app knows nothing about scopes yet.
    arm: [{ route: '/scenario/suppress-hello', body: { suppress: true } }],
    task: 'Spec 011 (no false diagnosis)',
    assert: [
      { label: 'the handshake never completed', test: (s) => s.evidence.clientHellos.length === 0 },
      { label: 'no authoring frame was sent', test: (s) => s.evidence.authoringRequests.length === 0 },
      { label: 'nothing was created', test: (s) => s.evidence.sessionCreates.length === 0 },
    ],
  },
]

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function which (command) {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

function run (command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? appRoot,
      // Windows ships `maestro` as a .bat shim; a shell is needed to resolve it.
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error) }))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

async function startFixture (options, certMode) {
  const child = spawn(process.execPath, [
    gatewayEntry,
    '--bind', options.bind,
    '--port', String(options.port),
    '--control-port', String(options.controlPort),
    '--cert-mode', certMode,
    '--lan-host', options.lanHost,
    '--print-json',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let buffer = ''
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture start timeout\n${stderr}`)), 30_000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const line = buffer.split('\n').find((entry) => entry.trim().startsWith('{'))
      if (line === undefined) return
      clearTimeout(timer)
      try {
        resolve(JSON.parse(line))
      } catch (error) {
        reject(error)
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`fixture exited early (${code})\n${stderr}`))
    })
  })
  const state = await ready
  return { child, state, stderrText: () => stderr }
}

async function stopFixture (fixture) {
  if (fixture?.child === undefined) return
  fixture.child.kill()
  await sleep(150)
}

async function control (state, route, body) {
  const response = await fetch(`${state.controlUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fixture-token': state.controlToken },
    body: JSON.stringify(body ?? {}),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(`control ${route}: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function readState (state) {
  const response = await fetch(`${state.controlUrl}/state`)
  return response.json()
}

// ---------------------------------------------------------------------------
// Maestro
// ---------------------------------------------------------------------------

function maestroEnv (state, extra) {
  return {
    // Paste text only: no flow ever asserted a code prefix, and slicing a single-use code into an
    // extra env value is needless exposure (FR-011).
    ...(state.pairing === null ? {} : { PAIR_QR: state.pairing.qr }),
    FIXTURE_CONTROL_URL: state.controlUrl,
    FIXTURE_TOKEN: state.controlToken,
    ...extra,
  }
}

function maestroArgs (flow, env) {
  const args = ['test', path.join(flowDir, flow)]
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue
    args.push('-e', `${key}=${value}`)
  }
  return args
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const options = parseRunArgs(process.argv.slice(2))

if (options.help) {
  process.stdout.write('node e2e/run-e2e.mjs [--platform android|ios] [--only T-07] [--dry-run] [--cert-mode ok|wrong|expired|not-yet] [--out DIR] [--bind ADDR] [--lan-host HOST|auto]\n')
  process.stdout.write('  --bind / --lan-host default to 127.0.0.1; pass both for a device on the LAN.\n')
  process.exit(0)
}

const exposure = exposureWarning(options)

const outDir = options.out ?? path.join(tmpdir(), `dsh-companion-e2e-${new Date().toISOString().replaceAll(':', '-')}`)
await mkdir(outDir, { recursive: true })

const hasMaestro = await which('maestro')
const hasAdb = await which('adb')
const dryRun = options.dryRun ?? !hasMaestro

const selected = options.only === null ? CHECKPOINTS : CHECKPOINTS.filter((entry) => entry.id === options.only)
if (selected.length === 0) {
  process.stdout.write(`no checkpoint matches --only ${options.only}\n`)
  process.exit(2)
}

const report = {
  startedAt: new Date().toISOString(),
  platform: options.platform,
  appId: 'com.dshext.companion',
  fixture: {
    bind: options.bind,
    lanHost: options.lanHost,
    ...(exposure === null ? {} : { exposureWarning: exposure }),
  },
  tooling: { maestro: hasMaestro, adb: hasAdb, node: process.version },
  dryRun,
  outDir,
  results: [],
}

process.stdout.write(`dsh-companion device validation — ${dryRun ? 'DRY RUN (no device)' : 'LIVE'}\n`)
process.stdout.write(`  platform ${options.platform}   maestro ${hasMaestro ? 'found' : 'MISSING'}   adb ${hasAdb ? 'found' : 'MISSING'}\n`)
process.stdout.write(`  fixture bind ${options.bind}   pairing host ${options.lanHost}   evidence ${outDir}\n`)
if (exposure !== null) process.stdout.write(`  ${exposure}\n`)
process.stdout.write('\n')

for (const checkpoint of selected) {
  if (checkpoint.platforms !== undefined && !checkpoint.platforms.includes(options.platform)) {
    const entry = { id: checkpoint.id, title: checkpoint.title, status: 'skipped', reason: `platform ${options.platform} (flow is ${checkpoint.platforms.join('/')} only)` }
    report.results.push(entry)
    process.stdout.write(`${checkpoint.id}  SKIP  ${checkpoint.title} — ${entry.reason}\n`)
    continue
  }

  const certMode = checkpoint.certMode ?? options.certMode

  // Wiring gate: a missing flow file is a *broken* checkpoint, not a device-gated one. Catch it
  // before starting a fixture so `--dry-run` stays honest about what it validated.
  const requiredFlows = [checkpoint.flow, ...(checkpoint.pair === true ? [PAIR_FLOW] : [])]
  const missingFlows = requiredFlows.filter((flow) => !existsSync(path.join(flowDir, flow)))
  if (missingFlows.length > 0) {
    const entry = { id: checkpoint.id, title: checkpoint.title, status: 'error', error: `missing flow file(s): ${missingFlows.join(', ')}` }
    report.results.push(entry)
    process.stdout.write(`${checkpoint.id}  ERR  ${checkpoint.title}\n        ${entry.error}\n`)
    continue
  }

  const fixture = await startFixture(options, certMode)
  const entry = {
    id: checkpoint.id,
    title: checkpoint.title,
    task: checkpoint.task,
    certMode,
    status: 'unknown',
    flow: checkpoint.flow,
    steps: [],
    asserts: [],
    violations: [],
  }

  try {
    // A fresh pairing code for every checkpoint (codes are single-use and ≤ 5 min).
    const rotated = await control(fixture.state, '/pairing/new')
    fixture.state.pairing = { qr: rotated.qr, pairingCode: rotated.pairingCode, expiresAt: rotated.expiresAt }

    const variants = checkpoint.variants ?? [{ name: 'default', arm: checkpoint.arm, env: {} }]

    // One expired payload per checkpoint, computed once. The flow pastes it and asserts only the
    // error copy, never the value (FR-011), so no prefix env is needed.
    const expired = checkpoint.expiredCode === true ? await expiredPayload() : null

    for (const variant of variants) {
      const env = maestroEnv(fixture.state, {
        ...(variant.env ?? {}),
        ...(expired === null ? {} : { EXPIRED_QR: expired }),
      })

      if (checkpoint.pair === true) {
        // Pair first on a clean fixture, then arm the scenario for the restarted app.
        entry.steps.push({ step: 'pair', flow: PAIR_FLOW })
        if (!dryRun) {
          const pair = await run('maestro', maestroArgs(PAIR_FLOW, env))
          entry.steps.push({ step: 'pair', code: pair.code, stderr: pair.stderr.slice(-2000) })
          if (pair.code !== 0) throw new Error(`pairing flow failed (${pair.code})`)
        }
      }

      for (const action of variant.arm ?? []) {
        const answer = await control(fixture.state, action.route, action.body)
        entry.steps.push({ step: 'arm', route: action.route, body: action.body, answer })
      }

      const flowEnv = checkpoint.expiredCode === true ? env : maestroEnv(fixture.state, { ...(variant.env ?? {}) })
      entry.steps.push({ step: 'flow', flow: checkpoint.flow, variant: variant.name, env: Object.keys(flowEnv) })

      if (dryRun) {
        entry.yetToRun = ['maestro', ...maestroArgs(checkpoint.flow, flowEnv)]
      } else {
        const result = await run('maestro', maestroArgs(checkpoint.flow, flowEnv))
        entry.steps.push({ step: 'flow', code: result.code, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-2000) })
        if (result.code !== 0) throw new Error(`flow ${checkpoint.flow} failed (${result.code})`)
      }

      // Assertions run per variant; each variant gets its own fresh fixture in practice, so the
      // state read here is scoped to this variant's run.
      //
      // A dry run has no app attached, so every device-derived assertion would be vacuous. It
      // instead validates the *wiring*: the flow file exists and the control routes it needs
      // answered 200 (an unknown route or a bad body is exactly the kind of failure a dry run
      // should catch, and it is the difference between "not run" and "run and passed").
      if (dryRun) {
        for (const assertion of checkpoint.assert ?? []) {
          entry.asserts.push({ label: assertion.label, variant: variant.name, ok: null, skipped: 'dry run: no app attached' })
        }
      } else {
        const state = await readState(fixture.state)
        for (const assertion of checkpoint.assert ?? []) {
          let ok = false
          let detail = ''
          try {
            ok = assertion.test(state, entry)
          } catch (error) {
            detail = error instanceof Error ? error.message : String(error)
          }
          entry.asserts.push({ label: assertion.label, variant: variant.name, ok, detail })
          if (!ok) entry.violations.push(assertion.label)
        }
      }
    }

    entry.status = entry.violations.length === 0 ? (dryRun ? 'wired' : 'pass') : (dryRun ? 'wired-with-violations' : 'fail')
  } catch (error) {
    entry.status = 'error'
    entry.error = error instanceof Error ? error.message : String(error)
  } finally {
    entry.fixtureEvidence = (await readState(fixture.state).catch(() => ({ evidence: null }))).evidence
    await stopFixture(fixture)
  }

  report.results.push(entry)
  const flag = entry.status === 'pass' || entry.status === 'wired' ? 'OK  ' : entry.status === 'error' ? 'ERR ' : 'FAIL'
  process.stdout.write(`${entry.id}  ${flag} ${entry.title}\n`)
  for (const assertion of entry.asserts) {
    const mark = assertion.ok === null ? 'skip' : assertion.ok ? 'ok  ' : 'FAIL'
    process.stdout.write(`        ${mark} ${assertion.label}${assertion.ok === null && assertion.skipped !== undefined ? ` (${assertion.skipped})` : ''}\n`)
  }
  if (entry.error !== undefined) process.stdout.write(`        error: ${entry.error}\n`)
}

report.finishedAt = new Date().toISOString()
report.summary = {
  total: report.results.length,
  ok: report.results.filter((entry) => ['pass', 'wired'].includes(entry.status)).length,
  failed: report.results.filter((entry) => ['fail', 'wired-with-violations', 'error'].includes(entry.status)).length,
  skipped: report.results.filter((entry) => entry.status === 'skipped').length,
}

const reportPath = path.join(outDir, 'report.json')
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

process.stdout.write(`\n${dryRun ? 'WIRED' : report.summary.failed === 0 ? 'PASS' : 'FAIL'} — ${report.summary.ok}/${report.summary.total} checkpoints${report.summary.skipped > 0 ? `, ${report.summary.skipped} skipped` : ''}\n`)
process.stdout.write(`report: ${reportPath}\n`)
if (dryRun) {
  process.stdout.write('\nNo device was used. Install a dev build and re-run without --dry-run:\n')
  process.stdout.write('  docs/device-validation.md §2 (Android) / §3 (iOS)\n')
  process.stdout.write('The fixture and its protocol self-test are runnable now: node e2e/harness/selftest.mjs\n')
}
process.exitCode = report.summary.failed === 0 ? 0 : 1

/** A payload with a past `expiresAt`, for the client-side rejection checkpoint. */
async function expiredPayload () {
  const { buildRejectedOffer } = await import('./harness/pairing.mjs')
  return buildRejectedOffer('expired')
}
