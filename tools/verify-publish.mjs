#!/usr/bin/env node
/**
 * Check that this published tree is actually complete.
 *
 * It was written after a real failure: several Host-side gateway modules were
 * never committed upstream at the time this repo was assembled, so the publish
 * step copied only tracked files and silently shipped a gateway that could not
 * start. Import resolution is the cheap, decisive test — if a relative import
 * has no target here, an install of this repo is broken.
 *
 *   node tools/verify-publish.mjs
 *
 * Two checks:
 *   1. every relative import/require inside the shipped packages resolves here;
 *   2. every test file named by a package's `npm test` script exists here.
 *
 * Bare specifiers (and imports that deliberately reach into a sibling package's
 * node_modules) are not this script's business: they resolve after `npm install`.
 * Exit code 1 means this tree is incomplete and must not be published as-is.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PACKAGES = ['plugins/mobile-gateway', 'plugins/devices', 'packages/mobile-protocol']
const SOURCE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx'])
const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, found)
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) found.push(path)
  }
  return found
}

function resolves(specifier, fromFile) {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.mjs`, `${base}.cjs`, `${base}.js`, `${base}.ts`, `${base}.tsx`,
    join(base, 'index.mjs'), join(base, 'index.js'), join(base, 'index.ts'),
  ]
  return candidates.some((candidate) => existsSync(candidate) && statSync(candidate).isFile())
}

// A relative specifier that points into a sibling package's node_modules is a
// dependency, not a source file: it appears only after npm install.
const isDependencySpecifier = (specifier) => specifier.includes('node_modules/')

let checked = 0
const broken = []
for (const pkg of PACKAGES) {
  const dir = join(ROOT, pkg)
  if (!existsSync(dir)) continue
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1]
      if (isDependencySpecifier(specifier)) continue
      checked += 1
      if (!resolves(specifier, file)) broken.push({ file, specifier })
    }
  }
}

for (const { file, specifier } of broken) {
  console.log(`BROKEN  ${file.slice(ROOT.length + 1)}  ->  ${specifier}`)
}

const missingTests = []
for (const pkg of ['plugins/mobile-gateway', 'plugins/devices']) {
  const manifest = join(ROOT, pkg, 'package.json')
  if (!existsSync(manifest)) continue
  const script = JSON.parse(readFileSync(manifest, 'utf8')).scripts?.test ?? ''
  for (const token of script.split(/\s+/)) {
    if (/^test\/.+\.(mjs|cjs)$/.test(token) && !existsSync(join(ROOT, pkg, token))) {
      missingTests.push(`${pkg}/${token}`)
    }
  }
}

for (const test of missingTests) console.log(`MISSING TEST  ${test}`)

const failed = broken.length + missingTests.length
console.log(
  `\nrelative imports resolved: ${checked - broken.length}/${checked}` +
  `\ntest files named by npm test: ${missingTests.length} missing` +
  `\n${failed === 0 ? 'OK - this tree is complete' : `INCOMPLETE - ${failed} problem(s)`}`,
)
process.exit(failed === 0 ? 0 : 1)
