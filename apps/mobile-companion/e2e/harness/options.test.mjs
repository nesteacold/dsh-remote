// Tests for the two entry points' option parsing (run-e2e.mjs and harness/gateway.mjs).
//
// The default is the security boundary: both entries listen on and advertise `127.0.0.1`, so a run
// on this machine exposes nothing beyond loopback. A device on the LAN is an explicit opt-in and
// must produce a warning. None of this needs a listener, a fixture, a device or Maestro:
//
//   node --test e2e/harness/options.test.mjs
//
// (The parsers themselves live in `harness/options.mjs` precisely so this file can import them
// without executing either entry point.)

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  exposureWarning,
  isLoopbackHost,
  parseFixtureArgs,
  parseRunArgs,
} from './options.mjs'

const LAN_IP = '192.168.1.20'
const escaped = (value) => value.replaceAll('.', '\\.')

test('fixture defaults listen on and advertise loopback only', () => {
  const options = parseFixtureArgs([])
  assert.equal(options.bind, '127.0.0.1')
  assert.equal(options.lanHost, '127.0.0.1')
  assert.equal(options.certMode, 'ok')
  assert.equal(exposureWarning(options), null)
})

test('orchestrator defaults listen on and advertise loopback only', () => {
  const options = parseRunArgs([])
  assert.equal(options.bind, '127.0.0.1')
  assert.equal(options.lanHost, '127.0.0.1')
  assert.match(options.platform, /^(android|ios)$/)
  assert.equal(exposureWarning(options), null)
})

test('a physical-device LAN run must opt in with bind + lan-host and is warned about', () => {
  const wildcard = parseRunArgs(['--bind', '0.0.0.0', '--lan-host', LAN_IP])
  assert.equal(wildcard.bind, '0.0.0.0')
  assert.equal(wildcard.lanHost, LAN_IP)
  const warning = exposureWarning(wildcard)
  assert.match(warning, /0\.0\.0\.0/)
  assert.match(warning, new RegExp(escaped(LAN_IP)))
  // The control API is not an option: the warning states it stays on loopback with a token.
  assert.match(warning, /127\.0\.0\.1/)
  assert.match(warning, /x-fixture-token/)

  const hostIp = parseFixtureArgs(['--bind', LAN_IP, '--lan-host', LAN_IP])
  assert.equal(hostIp.bind, LAN_IP)
  assert.match(exposureWarning(hostIp), new RegExp(escaped(LAN_IP)))
})

test('an Android emulator advertises 10.0.2.2 while the listener stays loopback', () => {
  // 10.0.2.2 is the emulator's alias for the host loopback, so binding loopback is enough and
  // there is nothing externally reachable to warn about.
  const options = parseRunArgs(['--platform', 'android', '--lan-host', '10.0.2.2'])
  assert.equal(options.bind, '127.0.0.1')
  assert.equal(options.lanHost, '10.0.2.2')
  assert.equal(exposureWarning(options), null)
})

test('`--lan-host auto` is opt-in and warns: it advertises a LAN address', () => {
  const options = parseRunArgs(['--lan-host', 'auto'])
  assert.equal(options.lanHost, 'auto')
  assert.match(exposureWarning(options), /auto/)
  assert.equal(parseFixtureArgs(['--lan-host', 'auto']).lanHost, 'auto')
})

test('explicit loopback values are accepted and stay quiet', () => {
  const options = parseRunArgs(['--bind', '127.0.0.1', '--lan-host', '127.0.0.1'])
  assert.equal(exposureWarning(options), null)
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('[::1]'), true)
  assert.equal(isLoopbackHost(LAN_IP), false)
})

test('unknown or incomplete options fail instead of silently falling back', () => {
  assert.throws(() => parseRunArgs(['--bind']), /needs a value/)
  assert.throws(() => parseRunArgs(['--nope']), /unknown argument/)
  assert.throws(() => parseFixtureArgs(['--lan-host']), /needs a value/)
  assert.throws(() => parseFixtureArgs(['--nope']), /unknown argument/)
})

test('both parsers still accept the documented flags', () => {
  const run = parseRunArgs([
    '--platform', 'ios', '--only', 'T-12', '--dry-run', '--cert-mode', 'wrong',
    '--port', '3443', '--control-port', '3444', '--out', 'C:\\tmp\\e2e', '--verbose',
  ])
  assert.equal(run.platform, 'ios')
  assert.equal(run.only, 'T-12')
  assert.equal(run.dryRun, true)
  assert.equal(run.certMode, 'wrong')
  assert.equal(run.port, 3443)
  assert.equal(run.controlPort, 3444)
  assert.equal(run.out, 'C:\\tmp\\e2e')
  assert.equal(run.verbose, true)

  const fixture = parseFixtureArgs([
    '--name', 'dsh-e2e', '--fixed-pairing-code', 'fixed-code', '--print-json', '--quiet',
    '--port', '0', '--control-port', '0',
  ])
  assert.equal(fixture.name, 'dsh-e2e')
  assert.equal(fixture.fixedPairingCode, 'fixed-code')
  assert.equal(fixture.printJson, true)
  assert.equal(fixture.quiet, true)
  assert.equal(fixture.port, 0)
  assert.equal(fixture.controlPort, 0)
})

test('--help is parsed, not treated as a listener option', () => {
  assert.equal(parseRunArgs(['--help']).help, true)
  assert.equal(parseRunArgs(['-h']).help, true)
  assert.equal(parseFixtureArgs(['--help']).help, true)
})
