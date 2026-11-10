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
// real ACL and throws a typed error instead of letting the caller serve the key.
// The exit code of `icacls /grant:r` is not evidence — it does not remove a
// pre-existing EXPLICIT grant to another principal — so the DACL is inspected.
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SECRET_FILE_MODE = 0o600
const SECRET_DIRECTORY_MODE = 0o700
const ICACLS_TIMEOUT_MS = 10_000

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

/**
 * The access-control entries of an `icacls <path>` listing: one
 * `{ principal, flags }` per ACE line. The first line repeats the target path
 * before the principal, so it is stripped; the localized summary line matches no
 * `:(...)` suffix and is ignored.
 */
function aclEntries(output, target) {
  const entries = []
  const prefixes = [target, target.replace(/[\\/]+$/, '')].filter(Boolean)
  for (const line of String(output).split(/\r?\n/)) {
    const trimmed = line.trim()
    const flags = trimmed.match(/:((?:\([^)]*\))+)\s*$/)
    if (!flags) continue
    let principal = trimmed.slice(0, flags.index).trim()
    for (const prefix of prefixes) {
      if (principal.toLowerCase().startsWith(prefix.toLowerCase())) {
        principal = principal.slice(prefix.length).replace(/^[\\/]+/, '').trim()
        break
      }
    }
    entries.push({ principal, flags: flags[1] })
  }
  return entries
}

/**
 * Owner-only verdict for an `icacls <path>` listing (Windows). Every entry must
 * belong to the current user (or SYSTEM) and no inherited entry may remain.
 * Principals are compared by their short name because the display name is
 * localized; a localized SYSTEM name is therefore refused rather than guessed
 * (fail closed, never fail open).
 * @returns {string|null} refusal reason, `null` when it is owner-only
 */
export function windowsAclViolation(output, target, user = currentUser()) {
  const entries = aclEntries(output, target)
  if (entries.length === 0) return 'its access control list could not be read'
  for (const entry of entries) {
    if (/\(I\)/i.test(entry.flags)) return `an inherited entry for ${entry.principal} remains`
    // A deny entry grants nothing; only allowed principals are checked.
    if (/\(DENY\)/i.test(entry.flags)) continue
    // A mandatory-integrity label restricts access, it never grants any: printing
    // one must not turn a correctly restricted secret into a refusal.
    if (/^mandatory label\\/i.test(entry.principal)) continue
    const name = entry.principal.split('\\').pop() || entry.principal
    if (name.toLowerCase() === user.toLowerCase()) continue
    if (name.toLowerCase() === 'system') continue
    return `access is granted to ${entry.principal}`
  }
  return null
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
    const listing = execFileSync('icacls', [resolved], {
      windowsHide: true, timeout: ICACLS_TIMEOUT_MS, stdio: 'pipe', encoding: 'utf8',
    })
    return windowsAclViolation(listing, resolved)
  } catch (error) {
    return `its access control list could not be read [${error?.code ?? error?.message ?? 'error'}]`
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
 *   a refusal reason; the bundle never passes one
 * @returns {true}
 */
export function assertOwnerOnly(target, check = ownerOnlyViolation) {
  const reason = check(target)
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
