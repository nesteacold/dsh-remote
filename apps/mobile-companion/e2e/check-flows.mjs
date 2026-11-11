// Static check of the Maestro flows — runs without Maestro, adb or a device.
//
// It cannot know whether a selector will match on a real screen; it checks the things that are
// cheap to get wrong and expensive to discover on a device:
//
//   1. every flow has an `appId` and a `---` command separator (a missing separator turns the
//      header into commands and fails on the device with an unhelpful parse error);
//   2. every `runFlow:`/`subflows/x.yaml` target exists;
//   3. every `- tapOn: <shorthand>` shorthand is anchored or clearly unique: an unanchored word
//      that also appears in a heading on the same screen is the most common tap-the-wrong-thing
//      failure in this app (e.g. "Pair" vs "Pair your computer");
//   4. every interaction on a locale-dependent string offers both `vi` and `en` alternatives —
//      the app falls back to Vietnamese for any device locale that is not vi/en, so an English-only
//      matcher passes on an English emulator and fails on a Vietnamese phone;
//   5. `assertVisible`/`tapOn` that reference an env var are paired with a default in `env:` or are
//      documented as orchestrator-provided;
//   6. every hook selector (`id:`) names a `testID` the app really renders — read out of
//      `app/**/*.tsx` (`testID="pair-submit"` / `` testID={`session-row-${id}`} `` → a known prefix).
//      A typo in `session-row-sess-alpha` is otherwise a device-only failure that looks like an app
//      bug; here it is a static failure with the known ids printed;
//   7. a dynamic segment interpolated into an `id:` must be regex-safe (`[A-Za-z0-9._-]`), because
//      Maestro matches `id` as a regex: fixture ids (`sess-alpha`, `apv-hash`, `apv-null`, `running`)
//      need no escaping, anything else does;
//   8. an **opaque** runtime value (pairing code, expected args hash) is never interpolated into a
//      text matcher: unescaped it is a broken regex, and it also echoes a credential-shaped value
//      into Maestro's selector log (FR-011). Assert a hook or the submit button's enabled state.
//
// Run: node e2e/check-flows.mjs [--verbose]

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const flowDir = path.join(here, 'maestro')
const appDir = path.join(here, '..', 'app')
const verbose = process.argv.includes('--verbose')

/** Vietnamese characters that only appear in the `vi` table (rough but sufficient). */
const VI_CHARS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i

/**
 * Strings that legitimately have no `vi` alternative:
 *   * brand names — identical in both message tables (`unlock.title` is "DSH Companion" in vi too);
 *   * fixture/user data — a session title, a history line or a prompt is whatever the host sent,
 *     not app copy, so localising it would be wrong.
 */
const LOCALE_INDEPENDENT = [
  'DSH Companion',
  // fixture session titles (e2e/harness/gateway.mjs BASE_SESSIONS)
  'Refactor gateway TLS',
  'Release notes draft',
  'Old spike',
  // fixture history rows (the `history` handler)
  'Please refactor the TLS listener',
  // Spec 011 authoring: the served workspace name and the title of a session the fixture created
  // through `session-create`. Host data, not app copy — it must never be localised.
  'DiskTree',
  'Created from phone',
]

/**
 * Env values that are opaque at runtime (a pairing code, a hash). They must never appear inside a
 * text matcher: they are not regex-escaped, and they are the one thing a selector log must not
 * contain (the pairing code is a single-use credential, FR-011).
 */
const OPAQUE_ENV = new Set([
  'PAIR_QR',
  'EXPIRED_QR',
  'PAIRING_CODE',
  'ARGS_HASH',
  'APPROVAL_HASH',
])

/** Values a flow may interpolate into an `id:` without regex escaping (fixture ids, tab names). */
const REGEX_SAFE_ID_SEGMENT = /^[A-Za-z0-9._-]+$/

function isLocaleIndependent (value) {
  return LOCALE_INDEPENDENT.some((allowed) => value.includes(allowed))
}

/** A matcher that covers the whole element on purpose: `^x$`/`^x$|^y$` or `.*x.*`. */
function isDeliberatelyWholeMatch (value) {
  const trimmed = value.trim()
  const anchored = trimmed.includes('^') || trimmed.includes('$')
  const fullyWrapped = trimmed.startsWith('.*') && trimmed.endsWith('.*')
  return anchored || fullyWrapped
}

// ---------------------------------------------------------------------------
// Hooks the app actually renders (`app/**/*.tsx` → `testID=`)
// ---------------------------------------------------------------------------

/** Every `.tsx` under `app/`, recursively. */
function collectSources (dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectSources(full))
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * Read `testID="x"` (static) and `` testID={`prefix-${...}`} `` (templated) out of the app source.
 * The templated form is what the screens use for per-row/per-card hooks, so a flow may only rely on
 * its literal prefix — this is the contract instead of a hardcoded list drifting from the app.
 */
function collectHookIds () {
  const staticIds = new Map()
  const templatePrefixes = new Map()
  for (const file of collectSources(appDir)) {
    const rel = path.relative(path.join(here, '..'), file).replaceAll('\\', '/')
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/testID=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const literal = match[1] ?? match[2]
      if (!literal.includes('${')) {
        staticIds.set(literal, rel)
        continue
      }
      const prefix = literal.slice(0, literal.indexOf('${'))
      if (prefix !== '') templatePrefixes.set(prefix, rel)
    }
  }
  return { staticIds, templatePrefixes }
}

const { staticIds, templatePrefixes } = collectHookIds()

/**
 * The finite sets a hook *tail* may come from, read out of the code that produces it:
 *   * `SESSION_ID` / `APPROVAL_ID` — the fixture ids in `harness/gateway.mjs` (BASE_SESSIONS /
 *     BASE_APPROVALS); a typo here is a device-only "row never appears";
 *   * `SESSION_TAB` — the tab enum in `app/index.tsx` (`sessions-tab-<tab>`).
 * Any other env name is left to the prefix check only (it may be a real host id at run time).
 */
function fixtureIdSets () {
  const gateway = readFileSync(path.join(here, 'harness', 'gateway.mjs'), 'utf8')
  // Spec 011 P1-A: the list (and its `{ tab, key }` TABS array) moved to the Conversations tab.
  const index = readFileSync(path.join(appDir, '(tabs)', 'conversations.tsx'), 'utf8')
  return new Map([
    ['SESSION_ID', {
      values: new Set([...gateway.matchAll(/sessionId:\s*'([\w-]+)'/g)].map((match) => match[1])),
      source: 'e2e/harness/gateway.mjs BASE_SESSIONS',
    }],
    ['APPROVAL_ID', {
      values: new Set([...gateway.matchAll(/approvalId:\s*'([\w-]+)'/g)].map((match) => match[1])),
      source: 'e2e/harness/gateway.mjs BASE_APPROVALS',
    }],
    ['SESSION_TAB', {
      values: new Set([...index.matchAll(/\{\s*tab:\s*'(\w+)',\s*key:/g)].map((match) => match[1])),
      source: "app/(tabs)/conversations.tsx TABS (SessionTab enum)",
    }],
  ])
}

const fixtureIds = fixtureIdSets()

/** Exact hook, or a known template prefix (`approval-approve-` + `apv-hash`). */
function knownHook (value) {
  if (staticIds.has(value)) return staticIds.get(value)
  for (const [prefix, where] of templatePrefixes) {
    if (value.startsWith(prefix) && value.length > prefix.length) return where
  }
  return null
}

function knownHookList () {
  return [
    ...[...staticIds.keys()].sort(),
    ...[...templatePrefixes.keys()].sort().map((prefix) => `${prefix}<...>`),
  ].join(', ')
}

// ---------------------------------------------------------------------------
// Flow parsing helpers
// ---------------------------------------------------------------------------

/** The flow header's `env:` defaults (only the ones a selector could interpolate). */
function envDefaults (text) {
  const values = new Map()
  let inEnv = false
  for (const line of text.split(/\r?\n/)) {
    if (/^---\s*$/.test(line)) break
    if (/^env:\s*$/.test(line)) {
      inEnv = true
      continue
    }
    if (/^\S/.test(line)) {
      inEnv = false
      continue
    }
    if (!inEnv) continue
    const match = /^\s+(\w+):\s*(.*)$/.exec(line)
    if (match !== null) values.set(match[1], match[2].trim())
  }
  return values
}

/** Substitute `${NAME}` from the flow's own defaults; report names it cannot resolve. */
function resolveInterpolations (raw, env) {
  const unresolved = []
  let value = raw
  for (const match of raw.matchAll(/\$\{(\w+)\}/g)) {
    const name = match[1]
    if (!env.has(name)) {
      unresolved.push(name)
      continue
    }
    value = value.replaceAll(`\${${name}}`, env.get(name))
  }
  return { value, unresolved, interpolated: raw.includes('${') }
}

const problems = []
const notes = []
let checked = 0
let checkedHooks = 0

function fail (file, message) {
  problems.push(`${file}: ${message}`)
}

function collect (dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collect(full))
    else if (entry.name.endsWith('.yaml')) out.push(full)
  }
  return out
}

const files = collect(flowDir).filter((file) => !file.endsWith('config.yaml'))
const fileNames = new Set(files.map((file) => path.basename(file)))

for (const file of files) {
  checked += 1
  const rel = path.relative(here, file).replaceAll('\\', '/')
  // A UTF-8 BOM would hide the `appId:` header from the checks below (and from a strict YAML reader).
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  const env = envDefaults(text)

  if (!/^appId:\s*\S+/m.test(text)) fail(rel, 'missing `appId:` header')
  if (!/^---\s*$/m.test(text)) fail(rel, 'missing `---` separator between header and commands')

  // 2. referenced subflows exist
  for (const match of text.matchAll(/(?:file:\s*|-\s*runFlow:\s*)([\w./-]+\.yaml)/g)) {
    const target = match[1]
    if (target.includes('/') && !fileNames.has(path.basename(target))) {
      fail(rel, `runFlow target does not exist: ${target}`)
    }
  }

  let inCommands = false
  let envBlock = false
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trimEnd()
    if (/^---\s*$/.test(line)) {
      inCommands = true
      envBlock = false
      continue
    }
    if (!inCommands) {
      if (/^env:\s*$/.test(line)) envBlock = true
      else if (/^\S/.test(line)) envBlock = false
      continue
    }

    // 4. locale coverage on matchers
    const matcher = /(?:assertVisible|assertNotVisible|tapOn|extendedWaitUntil)\s*:/.test(line)
      ? line
      : null
    if (matcher !== null && /['"]/.test(line)) {
      const quoted = [...line.matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]).join(' ')
      if (quoted.length > 0 && !quoted.includes('|') && !quoted.includes('${')) {
        const hasVi = VI_CHARS.test(quoted)
        const looksLikeCopy = /[a-zA-Z]{3,}/.test(quoted) && !/^[A-Za-z0-9._-]+$/.test(quoted)
        if (looksLikeCopy && !hasVi && !isLocaleIndependent(quoted)) {
          fail(rel, `matcher has no Vietnamese alternative (line ${index + 1}): ${quoted}`)
        }
      }
    }

    // 3. unanchored shorthand taps
    const shorthand = /^-\s*tapOn:\s*([^:{].*)$/.exec(line)
    if (shorthand !== null) {
      const value = shorthand[1].trim().replace(/^["']|["']$/g, '')
      if (value !== '' && !value.includes('${') && !isDeliberatelyWholeMatch(value)) {
        fail(rel, `tapOn shorthand could match a heading too (line ${index + 1}): ${value}`)
      }
    }

    // 8. opaque runtime values never go into a text matcher
    if (matcher !== null) {
      for (const match of line.matchAll(/\$\{(\w+)\}/g)) {
        if (OPAQUE_ENV.has(match[1])) {
          fail(rel, `opaque value \${${match[1]}} interpolated into a text matcher (line ${index + 1}): assert a hook (id:) or the submit button's enabled state instead`)
        }
      }
    }

    // 6 + 7. hook selectors must reference real testIDs, with regex-safe dynamic segments
    for (const match of line.matchAll(/(?:^|[\s{,-])id:\s*("([^"]*)"|'([^']*)'|\S+)/g)) {
      const raw = match[2] ?? match[3] ?? match[4]
      const value = raw.trim()
      if (value === '') continue
      checkedHooks += 1
      const resolved = resolveInterpolations(value, env)
      if (resolved.unresolved.length > 0) {
        notes.push(`${rel}: id "${value}" uses ${resolved.unresolved.map((name) => `\${${name}}`).join(', ')} with no default in this flow's env: (line ${index + 1}) — cannot be checked against the app`)
        continue
      }
      if (resolved.interpolated) {
        // Only the *substituted* values are regex-unsafe by nature: the literal part of the hook
        // (`session-row-`) is written by us, the tail is fixture data (`sess-alpha`) or a tab name.
        for (const [name, declaredValue] of env) {
          if (!value.includes(`\${${name}}`)) continue
          if (!REGEX_SAFE_ID_SEGMENT.test(declaredValue)) {
            fail(rel, `id "${value}" interpolates ${name}="${declaredValue}", which is not [A-Za-z0-9._-] and would need regex escaping (line ${index + 1})`)
          }
          const known = fixtureIds.get(name)
          if (known !== undefined && !known.values.has(declaredValue)) {
            fail(rel, `id "${value}" interpolates ${name}="${declaredValue}", which is not one of the ids ${known.source} serves (${[...known.values].sort().join(', ')}) (line ${index + 1})`)
          }
        }
      }
      const where = knownHook(resolved.value)
      if (where === null) {
        fail(rel, `id "${resolved.value}" is not a testID the app renders (line ${index + 1}). Known: ${knownHookList()}`)
      }
    }

    // 5. env references must be provided by the flow or the orchestrator
    for (const match of line.matchAll(/\$\{(\w+)/g)) {
      const name = match[1]
      if (['output', 'MAESTRO_'].some((prefix) => name.startsWith(prefix))) continue
      const declared = new RegExp(`^\\s+${name}:`, 'm').test(text)
      const orchestrator = ['PAIR_QR', 'EXPIRED_QR', 'EXPECTED_UPGRADE_STATUS', 'EXPECTED_UPDATE_SIDE', 'SESSION_ID', 'SESSION_TITLE', 'SESSION_TAB', 'PROMPT_TEXT', 'APPROVAL_ID']
      if (!declared && !orchestrator.includes(name)) {
        notes.push(`${rel}: env ${name} is neither declared in this flow nor a known orchestrator variable (line ${index + 1})`)
      }
    }
    if (envBlock && verbose) notes.push(`${rel}: env block opened`)
  }
}

// The orchestrator's checkpoint table must reference files that exist.
const runnerPath = path.join(here, 'run-e2e.mjs')
const runner = readFileSync(runnerPath, 'utf8')
for (const match of runner.matchAll(/'(\d{2}-[\w-]+\.yaml)'/g)) {
  if (!fileNames.has(match[1])) problems.push(`run-e2e.mjs: checkpoint references missing flow ${match[1]}`)
}
if (!fileNames.has('02-pair.yaml')) problems.push('run-e2e.mjs: PAIR_FLOW 02-pair.yaml is missing')

// `config.yaml` must list every numbered flow: a file that exists but is unlisted silently never
// runs in `maestro test e2e/maestro` (T-14 was missing before this check).
const configText = readFileSync(path.join(flowDir, 'config.yaml'), 'utf8')
for (const name of fileNames) {
  if (!/^\d{2}-/.test(name)) continue
  const listed = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(configText) ||
    new RegExp(`"${name.slice(0, 2)}-\\*\\.yaml"`).test(configText)
  if (!listed) problems.push(`config.yaml: flow ${name} is not in the flow set`)
}

process.stdout.write(`checked ${checked} flow files + ${checkedHooks} hook selectors + run-e2e.mjs checkpoint references\n`)
process.stdout.write(`hooks known from app/: ${staticIds.size} static, ${templatePrefixes.size} templated\n`)
if (verbose) for (const note of notes) process.stdout.write(`  note ${note}\n`)

if (problems.length === 0) {
  process.stdout.write(`PASS — ${checked} flows structurally valid (appId, separator, subflow targets, locale coverage, anchoring, hook ids, no opaque matchers)\n`)
} else {
  process.stdout.write(`FAIL — ${problems.length} problem(s)\n`)
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`)
  process.exitCode = 1
}
