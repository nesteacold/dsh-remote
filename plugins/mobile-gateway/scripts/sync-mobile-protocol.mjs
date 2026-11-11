#!/usr/bin/env node
/**
 * Vendors the wire contract into this package: generates
 * `lib/vendor/mobile-protocol.mjs` from `packages/mobile-protocol/src/index.mjs`.
 *
 * WHY this file exists: `@dsh-ext/mobile-protocol` is `private: true` and linked
 * with a `file:` dependency, which resolves only inside this checkout. A packed
 * tarball carries neither the protocol sources nor a resolvable `file:` path, so
 * an installed gateway could not load its own contract. Copying the one-module
 * contract into `lib/vendor/` (shipped through the existing `lib` entry in
 * package `files`) makes the tarball self-contained without publishing anything.
 *
 * The copy is GENERATED, never forked: the body is the source file byte for byte
 * (normalized to LF) and only a header comment is prepended. `npm test` and
 * `npm pack` both run this script, so a stale copy fails loudly instead of
 * silently drifting from the source of truth.
 *
 * Usage:
 *   node scripts/sync-mobile-protocol.mjs           # regenerate (also: prepack)
 *   node scripts/sync-mobile-protocol.mjs --check   # verify; exit 1 on drift
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.dirname(SCRIPT_DIR)

/** Repo-relative source of truth, also the path named in the generated header. */
const SOURCE_RELATIVE = 'packages/mobile-protocol/src/index.mjs'
const SOURCE_PATH = path.join(PLUGIN_ROOT, '..', '..', SOURCE_RELATIVE)
/** Package-relative generated copy; `lib` is already in package.json `files`. */
const VENDOR_RELATIVE = 'lib/vendor/mobile-protocol.mjs'
const VENDOR_PATH = path.join(PLUGIN_ROOT, VENDOR_RELATIVE)
const VENDOR_SPECIFIER = './vendor/mobile-protocol.mjs'
const BARE_SPECIFIER = '@dsh-ext/mobile-protocol'

/**
 * The five runtime files that consume the contract. They must import the
 * vendored copy: a bare specifier does not resolve in an installed tarball.
 * Tests are deliberately not listed — they are dev-only and keep the bare
 * specifier, which is why the drift check below matters.
 */
const RUNTIME_CONSUMERS = [
  'lib/allowlist.mjs',
  'lib/companion-access.mjs',
  'lib/index.mjs',
  'lib/remote-bridge.mjs',
  'lib/devices.js',
]

/** LF-normalized text: keeps the generated copy deterministic across checkouts (`eol=lf`). */
function normalize(text) {
  return text.replace(/\r\n/g, '\n')
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * A copied module is only self-contained while the source has no imports of its
 * own. If that ever changes, copying one file would produce a package that
 * cannot load, so refuse to generate and let a human pick a bundling step.
 */
function moduleImports(text) {
  return text
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /^import\s/.test(line) || /^import\(/.test(line)
      || /^export\s[^=]*\bfrom\s/.test(line) || /\brequire\(/.test(line))
}

function renderHeader(sourceHash) {
  return `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Vendored copy of \`${SOURCE_RELATIVE}\` (package \`${BARE_SPECIFIER}\`).
 * The gateway ships this copy so an installed tarball resolves the wire contract
 * from inside its own package: the \`file:\` dependency in package.json is a
 * development-only link and cannot be resolved outside this checkout.
 *
 * Source:     ${SOURCE_RELATIVE}
 * Regenerate: node scripts/sync-mobile-protocol.mjs   (npm run sync:protocol)
 * Verify:     node scripts/sync-mobile-protocol.mjs --check   (npm run check:protocol)
 * Source sha256: ${sourceHash}
 *
 * Everything below this header is the source file unchanged (byte for byte, LF):
 * the contract logic is never forked, only copied.
 */
`
}

/** Expected vendored content for a given source text. */
function renderVendor(sourceText) {
  return renderHeader(sha256(sourceText)) + sourceText
}

function readIfPresent(file) {
  try {
    return normalize(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Every runtime consumer must import the vendored copy and no bare specifier. */
function checkConsumers() {
  const problems = []
  for (const relative of RUNTIME_CONSUMERS) {
    const file = path.join(PLUGIN_ROOT, relative)
    const text = readIfPresent(file)
    if (text === null) {
      problems.push(`${relative}: missing`)
      continue
    }
    if (!text.includes(VENDOR_SPECIFIER)) {
      problems.push(`${relative}: does not import '${VENDOR_SPECIFIER}'`)
    }
    // Only statements count: several files mention the package name in prose.
    const bareImport = new RegExp(`(?:\\bfrom\\s*|\\brequire\\()\\s*['"]${BARE_SPECIFIER.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]`)
    if (bareImport.test(text)) {
      problems.push(`${relative}: still imports the bare specifier '${BARE_SPECIFIER}' (breaks an installed tarball)`)
    }
  }
  return problems
}

/** Loads the generated copy the way its consumers do (ESM namespace + CJS require). */
async function checkArtifactLoads(sourceText) {
  const namespace = await import(`${pathToFileURL(VENDOR_PATH).href}?sync=${Date.now()}`)
  const required = createRequire(import.meta.url)(VENDOR_PATH)
  const source = await import(pathToFileURL(SOURCE_PATH).href)
  const vendorExports = Object.keys(namespace).sort()
  const sourceExports = Object.keys(source).sort()
  if (vendorExports.join(',') !== sourceExports.join(',')) {
    throw new Error(`exported names differ from the source: vendor=[${vendorExports}] source=[${sourceExports}]`)
  }
  for (const name of vendorExports) {
    if (required[name] === undefined && typeof namespace[name] !== 'undefined') {
      throw new Error(`require() of the vendored copy does not expose '${name}'`)
    }
  }
  // Cheap value equivalence on contract constants that both sides publish.
  for (const name of ['PROTOCOL_SUBPROTOCOL', 'COMPANION_PROTOCOL_VERSION', 'MIN_CLIENT_VERSION', 'PAIRING_QR_VERSION', 'ERROR_CODES', 'SCOPES', 'DEVICE_KINDS']) {
    if (name in source && JSON.stringify(source[name]) !== JSON.stringify(namespace[name])) {
      throw new Error(`'${name}' differs between the source and the vendored copy`)
    }
  }
  return { exports: vendorExports.length, sourceHash: sha256(sourceText) }
}

async function main() {
  const checkOnly = process.argv.includes('--check')
  const sourceText = readIfPresent(SOURCE_PATH)

  // An installed tarball has no repo layout: nothing to verify against, and the
  // shipped copy is already in place. Skip instead of failing a consumer's run.
  if (sourceText === null) {
    console.log(`[sync-mobile-protocol] ${SOURCE_RELATIVE} not present (installed copy) — skipping`)
    process.exitCode = checkOnly ? 0 : 1
    if (!checkOnly) console.error('[sync-mobile-protocol] cannot regenerate: source of truth is missing')
    return
  }

  const imports = moduleImports(sourceText)
  if (imports.length > 0) {
    const list = imports.map(({ number, line }) => `  ${SOURCE_RELATIVE}:${number}: ${line}`).join('\n')
    console.error(`[sync-mobile-protocol] the source is no longer a single dependency-free module:\n${list}`)
    console.error('[sync-mobile-protocol] a plain copy would not load — bundling would be required; refusing to write a broken package')
    process.exitCode = 1
    return
  }

  const expected = renderVendor(sourceText)
  const current = readIfPresent(VENDOR_PATH)
  const consumers = checkConsumers()

  if (checkOnly) {
    let failed = false
    if (current === null) {
      console.error(`[sync-mobile-protocol] ${VENDOR_RELATIVE} is missing — run: node scripts/sync-mobile-protocol.mjs`)
      failed = true
    } else if (current !== expected) {
      console.error(`[sync-mobile-protocol] ${VENDOR_RELATIVE} is stale against ${SOURCE_RELATIVE}`)
      console.error('[sync-mobile-protocol] regenerate with: node scripts/sync-mobile-protocol.mjs')
      failed = true
    }
    for (const problem of consumers) console.error(`[sync-mobile-protocol] ${problem}`)
    if (consumers.length > 0) failed = true
    if (failed) {
      process.exitCode = 1
      return
    }
    const loaded = await checkArtifactLoads(sourceText)
    console.log(`[sync-mobile-protocol] OK — ${VENDOR_RELATIVE} matches ${SOURCE_RELATIVE} (sha256 ${loaded.sourceHash}, ${loaded.exports} exports), ${RUNTIME_CONSUMERS.length} runtime consumers import the vendored copy`)
    return
  }

  fs.mkdirSync(path.dirname(VENDOR_PATH), { recursive: true })
  fs.writeFileSync(VENDOR_PATH, expected, 'utf8')
  const bytes = Buffer.byteLength(expected, 'utf8')
  console.log(`[sync-mobile-protocol] wrote ${VENDOR_RELATIVE} (${bytes} bytes) from ${SOURCE_RELATIVE} (sha256 ${sha256(sourceText)})`)

  for (const problem of consumers) console.error(`[sync-mobile-protocol] ${problem}`)
  if (consumers.length > 0) {
    console.error('[sync-mobile-protocol] WARNING: the vendored copy is written but a runtime consumer does not use it')
    process.exitCode = 1
    return
  }

  const loaded = await checkArtifactLoads(sourceText)
  console.log(`[sync-mobile-protocol] verified: ${loaded.exports} exports match the source; import() and require() both load the vendored copy`)
}

await main()
