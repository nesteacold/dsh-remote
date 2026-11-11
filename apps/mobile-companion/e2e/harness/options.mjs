// Option parsing for the two device-validation entry points (`run-e2e.mjs`,
// `harness/gateway.mjs`).
//
// WHY THIS IS A MODULE OF ITS OWN
//   * The default here *is* the security boundary: both entries bind and advertise `127.0.0.1`,
//     so an accidental run on a shared or untrusted machine exposes nothing beyond loopback. A
//     phone on the LAN is an explicit opt-in (`--bind <hostIP|0.0.0.0> --lan-host <hostIP>`).
//   * The parsers have no listeners and no side effects, so the defaults and the opt-in can be
//     tested without a fixture, a device or a Maestro run (`node --test e2e/harness/options.test.mjs`).
//   * The control API is *not* an option: it always binds `127.0.0.1` in `gateway.mjs`, whatever
//     `--bind` says, and every mutation needs `x-fixture-token`.
//
// Style: `--lan-host auto` still exists for the operator who wants the first non-internal IPv4,
// but it is no longer a default: it advertises an address the phone may reach, which is exactly
// the decision the operator must make explicitly.

import { PAIRING_TTL_MS } from './pairing.mjs'

/** The only address either entry point listens on / advertises unless told otherwise. */
export const LOOPBACK = '127.0.0.1'

/** True for the loopback spellings the fixture treats as "not exposed". */
export function isLoopbackHost (host) {
  const value = String(host).trim().toLowerCase()
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]'
}

/**
 * The warning a run must tell the operator when it listens beyond loopback (or advertises an
 * address it resolved itself). `null` for the loopback-only default: nothing to warn about.
 *
 * A non-loopback `--lan-host` with a loopback `--bind` is quiet on purpose: the listener is still
 * loopback-only, which is what an Android emulator needs (`--lan-host 10.0.2.2` is its alias for
 * the host's loopback).
 */
export function exposureWarning ({ bind, lanHost }) {
  const externallyBound = !isLoopbackHost(bind)
  const autoAdvertised = String(lanHost).trim().toLowerCase() === 'auto'
  if (!externallyBound && !autoAdvertised) return null

  const listen = externallyBound
    ? `warning: the fixture's TLS/WSS port is bound to ${bind} — reachable from other machines on this network`
    : `warning: the fixture's TLS/WSS port stays on ${LOOPBACK}`
  const advertise = autoAdvertised
    ? 'the pairing QR advertises the first non-internal IPv4 (`--lan-host auto`)'
    : `the pairing QR advertises ${lanHost}`
  return `${listen}; ${advertise}. Opt in only for a device run on a network you trust. ` +
    `The control API always stays on ${LOOPBACK} and requires x-fixture-token.`
}

/** Defaults for `node e2e/harness/gateway.mjs` (standalone fixture). */
export function defaultFixtureOptions () {
  return {
    /** Interface the fixture's TLS/WSS port binds; loopback unless the operator opts in. */
    bind: LOOPBACK,
    port: 3443,
    controlPort: 3444,
    certMode: 'ok',
    /** Host the QR tells the phone to dial; loopback unless the operator opts in. */
    lanHost: LOOPBACK,
    name: 'dsh-e2e',
    printJson: false,
    quiet: false,
    ttlMs: PAIRING_TTL_MS - 60_000,
    /** Optional: also accept this fixed pairing code (repeatable runs without a control call). */
    fixedPairingCode: null,
  }
}

/** Parse `gateway.mjs` arguments. Throws on an unknown flag or a missing value. */
export function parseFixtureArgs (argv) {
  const options = defaultFixtureOptions()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} needs a value`)
      return argv[index]
    }
    switch (arg) {
      case '--bind': options.bind = next(); break
      case '--port': options.port = Number(next()); break
      case '--control-port': options.controlPort = Number(next()); break
      case '--cert-mode': options.certMode = next(); break
      case '--lan-host': options.lanHost = next(); break
      case '--name': options.name = next(); break
      case '--fixed-pairing-code': options.fixedPairingCode = next(); break
      case '--print-json': options.printJson = true; break
      case '--quiet': options.quiet = true; break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/** Defaults for `node e2e/run-e2e.mjs` (orchestrator). */
export function defaultRunOptions () {
  return {
    platform: process.platform === 'win32' ? 'android' : 'ios',
    only: null,
    dryRun: null,
    certMode: 'ok',
    port: 3443,
    controlPort: 3444,
    /** Interface the fixture's TLS/WSS port binds; loopback unless the operator opts in. */
    bind: LOOPBACK,
    /** Host written into the pairing QR; loopback unless the operator opts in. */
    lanHost: LOOPBACK,
    out: null,
    verbose: false,
  }
}

/** Parse `run-e2e.mjs` arguments. Throws on an unknown flag or a missing value. */
export function parseRunArgs (argv) {
  const options = defaultRunOptions()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} needs a value`)
      return argv[index]
    }
    switch (arg) {
      case '--platform': options.platform = next(); break
      case '--only': options.only = next(); break
      case '--dry-run': options.dryRun = true; break
      case '--run': options.dryRun = false; break
      case '--cert-mode': options.certMode = next(); break
      case '--port': options.port = Number(next()); break
      case '--control-port': options.controlPort = Number(next()); break
      case '--bind': options.bind = next(); break
      case '--lan-host': options.lanHost = next(); break
      case '--out': options.out = next(); break
      case '--verbose': options.verbose = true; break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}
