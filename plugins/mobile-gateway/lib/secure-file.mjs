// Platform-aware restriction of secret files and their directories (T002a).
//
// POSIX: the filesystem enforces the mode — 0600 for files, 0700 for directories.
// Windows: NTFS ignores POSIX modes (Node reports 0666/0777), so the owner-only
// guarantee comes from the ACL instead: inheritance is removed and the current
// user gets full control (`icacls <path> /inheritance:r /grant:r <user>:F`).
//
// Restriction is best-effort and never throws: it is called on persistence paths
// where a hard failure would disable the gateway. On failure the configured
// logger gets a warning that names the file only — never its contents.
//
// A secret that can be SERVED (the TLS identity key: its reader can impersonate
// the pinned listener) cannot live with best-effort. `assertOwnerOnly` reads the
// real DACL and throws a typed error instead of letting the caller serve the key.
// The exit code of `icacls /grant:r` is not evidence — it does not remove a
// pre-existing EXPLICIT grant to another principal — so the DACL is inspected.
// On Windows that inspection is structural, never textual: one non-interactive
// PowerShell child process reports every ACE as `AccessControlType|SID|IsInherited`
// and the verdict compares SIDs, because a display name is localized and
// `HOST\neste`, `DOMAIN\neste` and a look-alike of `\SYSTEM` are not one principal.
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SECRET_FILE_MODE = 0o600
const SECRET_DIRECTORY_MODE = 0o700
const ICACLS_TIMEOUT_MS = 10_000
const DACL_TIMEOUT_MS = 10_000

// One ACE line of the DACL probe: `AccessControlType|SID|IsInherited`.
const SID_SOURCE = 'S-\\d+-\\d+(?:-\\d+)*'
const SID_PATTERN = new RegExp(`^${SID_SOURCE}$`)
const ACE_LINE_PATTERN = new RegExp(`^(Allow|Deny)\\|(${SID_SOURCE})\\|(True|False)$`)
// The SIDs that may hold an Allow ACE besides the current user's own (policy in
// `windowsAclViolation`).
const TRUSTED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544'])
// Any PowerShell error inside a probe is a non-zero exit, never a partial answer.
const STRICT_POWERSHELL = "$ErrorActionPreference = 'Stop'; "

let logger
const defaultLogger = (message) => { globalThis.console?.error?.(`mobile-gateway: ${message}`) }

/** Route restriction warnings through the plugin logger (already redacted by `logging.mjs`). */
export function setSecureFileLogger(next) {
  logger = typeof next === 'function' ? next : undefined
}

function emit(message) {
  try {
    ;(logger || defaultLogger)(message)
  } catch {
    // A failing logger must not turn a best-effort restriction into an exception.
  }
}

function warn(operation, target, error) {
  const code = error && error.code ? ` [${error.code}]` : ''
  emit(`warning: cannot restrict access to ${path.basename(target)} during ${operation}${code}; it may be readable by other users`)
}

function currentUser() {
  const info = os.userInfo()
  const username = typeof info?.username === 'string' ? info.username.trim() : ''
  if (!username) throw new Error('the current Windows user cannot be resolved')
  return username
}

// Arguments always go through as an array; no shell string is ever built.
function icaclsArgs(target, kind) {
  const user = currentUser()
  return [target, '/inheritance:r', '/grant:r', `${user}:${kind === 'directory' ? '(OI)(CI)F' : 'F'}`, '/c']
}

/**
 * POSIX verdict: no group/other bits and the caller owns the path.
 * @returns {string|null} refusal reason, `null` when it is owner-only
 */
function posixViolation(target) {
  const stat = fs.statSync(target)
  const mode = stat.mode & 0o777
  if (mode & 0o077) return `mode 0${mode.toString(8)} is accessible to group or other users`
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return 'it is owned by another user'
  return null
}

// A listing line echoed in a refusal stays short and free of control characters:
// it is a DACL entry, never file contents.
function preview(line) {
  const text = String(line).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

/**
 * A PowerShell single-quoted literal for `target`. An embedded `'` is doubled —
 * the only escape a single-quoted string has — so a file name containing `'`,
 * `$`, a backtick or `;` cannot end the literal early and inject a command.
 */
export function powerShellLiteral(target) {
  return `'${String(target).replaceAll("'", "''")}'`
}

/**
 * The DACL probe: one line per ACE, `AccessControlType|SID|IsInherited`, every
 * principal translated to its SID. `-ErrorAction Stop` turns an unreadable path
 * into a non-zero exit instead of an empty (and clean-looking) listing, and
 * `$ErrorActionPreference = 'Stop'` turns a failure INSIDE the pipeline (an
 * identity that cannot be translated) into a non-zero exit as well, so a partial
 * listing can never be mistaken for the whole DACL.
 */
function daclScript(target) {
  const acl = `(Get-Acl -LiteralPath ${powerShellLiteral(target)} -ErrorAction Stop).Access`
  const ace = "'{0}|{1}|{2}' -f $_.AccessControlType, $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value, $_.IsInherited"
  return `${STRICT_POWERSHELL}${acl} | ForEach-Object { ${ace} }`
}

// Arguments always go through as an array; no shell string is ever built.
function runPowerShell(script) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: DACL_TIMEOUT_MS, stdio: 'pipe', encoding: 'utf8',
  })
}

let cachedUserSid = null

/**
 * The SID of the account this process runs as, resolved once and never by name:
 * `HOST\neste` and `DOMAIN\neste` are different principals, and a bare `SYSTEM`
 * is not LOCAL SYSTEM. A failure here is a refusal at every call site.
 * @throws when it cannot be resolved
 */
function currentUserSid() {
  if (cachedUserSid) return cachedUserSid
  const output = String(runPowerShell(`${STRICT_POWERSHELL}[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`))
  // The shell may prepend a byte-order mark; it is not an ACE.
  const sid = output.replace(/^\uFEFF/, '').trim()
  if (!SID_PATTERN.test(sid)) throw new Error(`the current user SID could not be resolved (${preview(sid) || 'no output'})`)
  cachedUserSid = sid
  return sid
}

/**
 * Owner-only verdict for the structured DACL listing read by the Windows probe.
 *
 * POLICY — the path is acceptable only if EVERY parsed ACE is either a `Deny`,
 * or an `Allow` whose SID is one of:
 *   - the current user's own SID,
 *   - `S-1-5-18` (LOCAL SYSTEM),
 *   - `S-1-5-32-544` (BUILTIN\Administrators).
 * Administrators is allowed on purpose: an administrator can take ownership of
 * anything on this machine anyway, so a grant to it adds no exposure a local
 * administrator does not already have — and the user-writable directories real
 * secrets live in (the DSH data/profile root) inherit that ACE, so refusing it
 * would make this check unusable.
 * Everything else is a refusal, never a pass: an `Allow` for any other SID, a
 * line that is not exactly `AccessControlType|SID|IsInherited`, or an empty
 * listing (`ownerOnlyViolation` turns a failed probe into the same refusal).
 * `IsInherited` is parsed and validated but not itself refused — an inherited
 * ACE of one of those three grants nothing extra. An unrecognized entry is never
 * skipped, so one trusted ACE cannot mask a permissive entry beside it.
 * @param {string} listing one line per ACE, as produced by the probe
 * @param {string} currentSid this process's SID — names are never compared
 * @returns {string|null} refusal reason, `null` when it is owner-only
 */
export function windowsAclViolation(listing, currentSid) {
  const text = String(listing ?? '').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  // Only the terminator of the last line is dropped: a blank line INSIDE the
  // listing is an unrecognized entry and therefore a refusal.
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) return 'its access control list is empty'
  for (const [index, line] of lines.entries()) {
    const ace = line.match(ACE_LINE_PATTERN)
    if (!ace) {
      return `its access control list has an unrecognized entry (line ${index + 1}: ${preview(line) || 'blank'})`
    }
    const [, accessType, sid] = ace
    // A deny entry grants nothing; only allowed principals are checked.
    if (accessType === 'Deny') continue
    if (sid === currentSid) continue
    if (TRUSTED_SIDS.has(sid)) continue
    return `access is granted to ${sid} (line ${index + 1})`
  }
  return null
}

function failureDetail(error) {
  if (error?.code) return error.code
  if (error?.signal) return `signal ${error.signal}`
  if (typeof error?.status === 'number') return `exit ${error.status}`
  return error?.message ?? 'error'
}

/**
 * Why `target` is not restricted to its owner, or `null` when it is. Never
 * throws: a path that cannot be inspected is a refusal reason, not an exception,
 * so the caller can refuse instead of serving the secret.
 * @returns {string|null}
 */
export function ownerOnlyViolation(target) {
  try {
    const resolved = path.resolve(target)
    if (process.platform !== 'win32') return posixViolation(resolved)
    return windowsAclViolation(runPowerShell(daclScript(resolved)), currentUserSid())
  } catch (error) {
    return `its access control list could not be read [${failureDetail(error)}]`
  }
}

/** A secret path that cannot be proven owner-only. Fail closed: never serve the secret. */
export class SecretFilePermissionError extends Error {
  constructor(target, reason) {
    super(`refusing to use ${target}: it is not restricted to the current user (${reason})`)
    this.name = 'SecretFilePermissionError'
    this.code = 'secret-file/not-owner-only'
    this.path = target
    this.reason = reason
  }
}

/**
 * Throw unless `target` is provably owner-only. Unlike the best-effort helpers
 * below this never degrades to a warning: the caller is about to serve the file.
 * @param {string} target path to verify
 * @param {(target: string) => (string|null)} [check] test-only override returning
 *   a refusal reason (a thrown error refuses too); the bundle never passes one
 * @returns {true}
 */
export function assertOwnerOnly(target, check = ownerOnlyViolation) {
  let reason
  try {
    reason = check(target)
  } catch (error) {
    // A probe that throws (a failed child process, an unreadable path) is the
    // same refusal as a reported reason — never a raw error the caller might miss.
    reason = `its access control list could not be read [${failureDetail(error)}]`
  }
  if (reason) throw new SecretFilePermissionError(target, reason)
  return true
}

/**
 * Restrict a path to its owner. `kind` selects the permission set:
 * `'file'` (0600 / `user:F`) or `'directory'` (0700 / `user:(OI)(CI)F`).
 * Never throws; failures are logged (redacted) through the configured logger.
 * @returns {Promise<boolean>} whether the restriction succeeded
 */
export async function restrictToOwner(target, kind = 'file') {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('icacls', icaclsArgs(target, kind), { windowsHide: true, timeout: ICACLS_TIMEOUT_MS })
    } else {
      await fs.promises.chmod(target, kind === 'directory' ? SECRET_DIRECTORY_MODE : SECRET_FILE_MODE)
    }
    return true
  } catch (error) {
    warn(`restrictToOwner(${kind})`, target, error)
    return false
  }
}

/** Synchronous variant for module-loading and persistence paths. Never throws on restriction failure. @returns {boolean} */
export function restrictToOwnerSync(target, kind = 'file') {
  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(target, kind === 'directory' ? SECRET_DIRECTORY_MODE : SECRET_FILE_MODE)
    } else {
      execFileSync('icacls', icaclsArgs(target, kind), { windowsHide: true, timeout: ICACLS_TIMEOUT_MS, stdio: 'pipe' })
    }
    return true
  } catch (error) {
    warn(`restrictToOwnerSync(${kind})`, target, error)
    return false
  }
}

/**
 * Create `target` as an owner-only directory. Only the requested directory is
 * restricted — `recursive: true` must not tighten the permissions of parents
 * that already existed (e.g. the DSH data root). Never throws on restriction.
 * @returns {boolean} whether the restriction succeeded
 */
export function ensureOwnerOnlyDirectory(target) {
  try {
    fs.mkdirSync(target, { recursive: true, mode: SECRET_DIRECTORY_MODE })
  } catch (error) {
    warn('ensureOwnerOnlyDirectory(mkdir)', target, error)
    return false
  }
  return restrictToOwnerSync(target, 'directory')
}

/**
 * Write a secret file with an owner-only mode at creation and the mode/ACL
 * re-applied afterwards. Layer-only restriction: a secret that is SERVED must
 * also pass `assertOwnerOnly` before use (a pre-existing explicit grant survives
 * `icacls /grant:r`).
 */
export function writeSecretFile(target, data, options = {}) {
  fs.writeFileSync(target, data, { ...options, mode: SECRET_FILE_MODE })
  restrictToOwnerSync(target, 'file')
}
