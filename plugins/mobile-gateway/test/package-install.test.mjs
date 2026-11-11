// End-to-end packaging gate for this plugin (`npm run test:package`).
//
// WHY this test exists: the gateway's runtime is self-contained. The wire contract
// `@dsh-ext/mobile-protocol` is `private: true` and linked with a `file:` dependency,
// which resolves only inside this checkout, so the package ships a generated copy at
// `lib/vendor/mobile-protocol.mjs` (scripts/sync-mobile-protocol.mjs) and the five
// runtime consumers import that copy. Only a real `npm pack` + install proves the
// tarball carries everything it needs; every other test runs against the checkout,
// where the `file:` link still exists and would hide a missing dependency.
//
// Hermetic by design: no registry, no pnpm, no network. `npm pack` only archives the
// working tree, and the fixture installs the tarball with `--offline` from the local
// npm cache. Because of that cache dependency this gate is opt-in (`test:package`)
// and deliberately NOT part of `npm test`: it must be the machine's own npm cache
// that decides, and a cold cache would fail the default chain for a reason that has
// nothing to do with the code.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

const NAME = '@dsh-ext/mobile-gateway'
/** The private contract package: a `file:` dev link, never a shipped dependency. */
const PROTOCOL = '@dsh-ext/mobile-protocol'
/** Rendered by scripts/sync-mobile-protocol.mjs; `lib` ships it via package.json `files`. */
const VENDOR = 'lib/vendor/mobile-protocol.mjs'

/** The CLI entry of the npm that ships with the running Node, so no PATH lookup is needed. */
function npmCli() {
  const candidate = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(candidate) ? candidate : null
}

/**
 * On Windows `npm` is `npm.cmd`, which `execFile` cannot launch (ENOENT) and which a
 * shell would need quoted paths for. Prefer the npm CLI script next to the node binary
 * (same npm, no shell); fall back to the platform command for other layouts.
 */
function npm(args, options) {
  const cli = npmCli()
  if (cli) return run(process.execPath, [cli, ...args], options)
  if (process.platform !== 'win32') return run('npm', args, options)
  return run('npm.cmd', args, { ...options, shell: true })
}

/** `npm run` injects its own npm_config_*; the fixture must use its own configuration. */
function cleanEnv() {
  const env = { ...process.env }
  delete env.NODE_PATH
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith('npm_config_')) delete env[key]
  }
  return env
}

test('the packed tarball is self-contained: it installs and loads with no @dsh-ext/mobile-protocol',
  { timeout: 300_000 }, async (t) => {
    const env = cleanEnv()

    let npmVersion
    try {
      npmVersion = (await npm(['--version'], { env, timeout: 30_000 })).stdout.trim()
    } catch (error) {
      // No npm on this machine: the gate cannot run, but that is not a failure of the package.
      t.skip(`npm is not available (${error.code ?? error.message}); this packaging gate needs npm to pack and install`)
      return
    }

    // Packing must not regenerate the vendored copy: the gate proves the artifact that
    // is committed now is fresh, so `npm pack` runs with --ignore-scripts and the drift
    // check below is what guarantees lib/vendor matches the protocol source.
    const drift = await run(process.execPath, ['scripts/sync-mobile-protocol.mjs', '--check'],
      { cwd: root, env, timeout: 60_000 })
    console.log(drift.stdout.trim())

    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mgw-package-'))
    t.after(async () => { await fs.rm(temp, { recursive: true, force: true }) })

    // 1. Pack the working tree into a tarball; nothing is fetched from a registry.
    const packed = JSON.parse((await npm(
      ['pack', '--json', '--pack-destination', temp, '--ignore-scripts', '--offline'],
      { cwd: root, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
    )).stdout)[0]
    assert.equal(packed.name, NAME, 'the tarball must carry the real package name')
    const shipped = packed.files.map((entry) => entry.path)
    // `npm pack --json` reports paths relative to the package root.
    for (const file of ['lib/index.mjs', 'lib/devices.js', VENDOR, 'package.json', 'cordis.patch.yml']) {
      assert.ok(shipped.includes(file), `the tarball must ship ${file} — an installed copy cannot reach the checkout`)
    }
    const tarball = path.join(temp, packed.filename)
    console.log(`npm pack --offline: ${packed.filename} (${shipped.length} files, includes ${VENDOR})`)

    // The repository manifest keeps the protocol as a development-only link; that is
    // exactly why the packed runtime must not depend on it.
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies?.[PROTOCOL], undefined, `${PROTOCOL} must not be a runtime dependency`)
    assert.equal(manifest.devDependencies?.[PROTOCOL], 'file:../../packages/mobile-protocol',
      `${PROTOCOL} stays a development-only file: link`)

    // 2. Install the tarball into a project that has nothing but its own package.json.
    const fixture = path.join(temp, 'fixture')
    await fs.mkdir(fixture)
    await fs.writeFile(path.join(fixture, 'package.json'),
      JSON.stringify({ name: 'gateway-install-fixture', version: '1.0.0', private: true }, null, 2))
    await npm(['install', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball],
      { cwd: fixture, env, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 })

    // 3. The installed tree itself must be free of the private protocol package.
    const installed = path.join(fixture, 'node_modules', ...NAME.split('/'))
    const installedManifest = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'))
    assert.equal(installedManifest.name, NAME)
    const dependencies = Object.entries(installedManifest.dependencies ?? {})
    assert.ok(dependencies.length > 0, 'the packaged manifest must still declare its runtime dependencies')
    for (const [dependency, specifier] of dependencies) {
      assert.notEqual(dependency, PROTOCOL, `${PROTOCOL} must not be installed as a dependency`)
      assert.ok(!String(specifier).startsWith('file:'),
        `${dependency} ships a file: specifier (${specifier}), which cannot resolve outside this checkout`)
    }
    assert.deepEqual((await fs.readdir(path.join(fixture, 'node_modules', '@dsh-ext'))).sort(), ['mobile-gateway'],
      'the only @dsh-ext package in the fixture may be the gateway itself')
    await assert.rejects(fs.access(path.join(fixture, 'node_modules', ...PROTOCOL.split('/'))),
      { code: 'ENOENT' }, `${PROTOCOL} must not be installed`)
    // The shipped contract copy is the same generated file this checkout verified above.
    assert.deepEqual(await fs.readFile(path.join(installed, VENDOR)), await fs.readFile(path.join(root, VENDOR)),
      `${VENDOR} must ship byte for byte`)
    console.log(`npm install --omit=dev --ignore-scripts --offline: ${dependencies.length} dependencies, `
      + `${PROTOCOL} absent, no file: specifier`)

    // 4. Load the installed entry the way a consumer would: bare specifier, no checkout.
    await fs.writeFile(path.join(fixture, 'check.mjs'), `
import assert from 'node:assert/strict'

const api = await import(${JSON.stringify(NAME)})
for (const name of ['Config', 'admitMessage', 'createMobileGatewayPlugin', 'devicesPluginActive', 'handleQuery', 'isLoopbackListenHost']) {
  assert.equal(typeof api[name], 'function', 'the installed package must export ' + name)
}
assert.equal(typeof api.default.apply, 'function', 'the default export must be the usable plugin')
assert.equal(typeof api.default.name, 'string')

// The packaged Schemastery dependency really runs, it does not merely resolve.
assert.equal(api.Config({}).remoteControl.enabled, false, 'remote control must stay off by default')
assert.equal(api.Config({ remoteControl: { enabled: true } }).remoteControl.enabled, true)
assert.throws(() => api.Config({ remoteControl: { enabled: 'yes' } }), /expected boolean/)

// The wire contract is loaded from the copy that travels inside this package.
const vendor = await import(new URL('./node_modules/${NAME}/${VENDOR}', import.meta.url))
assert.equal(typeof vendor.PROTOCOL_SUBPROTOCOL, 'string')
assert.ok(Array.isArray(vendor.SCOPES) && vendor.SCOPES.length > 0, 'the vendored contract must export its scopes')
assert.ok(Object.keys(vendor.SCOPE_BY_TYPE).length > 0, 'the vendored contract must export the scope map')

// ...and the private protocol package is genuinely unreachable from here.
await assert.rejects(import(${JSON.stringify(PROTOCOL)}),
  (error) => error.code === 'ERR_MODULE_NOT_FOUND',
  'the installed gateway must not resolve ${PROTOCOL}')

console.log('self-contained: the installed gateway loaded its vendored contract; no '
  + ${JSON.stringify(PROTOCOL)} + ' was installed')
`)
    const checked = await run(process.execPath, [path.join(fixture, 'check.mjs')], { cwd: fixture, env, timeout: 60_000 })
    assert.match(checked.stdout, /self-contained: the installed gateway loaded its vendored contract/)
    console.log(`npm ${npmVersion}: ${checked.stdout.trim()}`)
  })
