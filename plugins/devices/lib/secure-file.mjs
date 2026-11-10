// Owner-only files for the per-remote tokens (spec 008 FR3).
//
// Same approach as plugins/mobile-gateway/lib/secure-file.mjs (kept as a small
// private copy so this plugin does not import another package's internals):
// POSIX gets mode 0600 at creation and again after the write; NTFS ignores
// POSIX modes, so Windows removes ACL inheritance and grants only the current
// user (`icacls <file> /inheritance:r /grant:r <user>:F`). The command runner
// is injectable so a test can assert the exact icacls arguments even where the
// sandbox forbids spawning processes.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SECRET_FILE_MODE = 0o600
export const SECRET_DIRECTORY_MODE = 0o700
const ICACLS_TIMEOUT_MS = 10_000

let runner = (file, args) => execFileSync(file, args, { windowsHide: true, timeout: ICACLS_TIMEOUT_MS, stdio: 'pipe' })
let platform = process.platform
let logger = () => {}

/** Test seam: replace the process runner and/or the platform. Returns a restore function. */
export function setSecureFileTestHooks({ run, platform: forcedPlatform } = {}) {
  const previous = { runner, platform }
  if (typeof run === 'function') runner = run
  if (typeof forcedPlatform === 'string') platform = forcedPlatform
  return () => { runner = previous.runner; platform = previous.platform }
}

/** Route restriction warnings through the plugin logger. They name the file, never its contents. */
export function setSecureFileLogger(next) {
  logger = typeof next === 'function' ? next : () => {}
}

function warn(operation, target, error) {
  const code = error && error.code ? ` [${error.code}]` : ''
  try {
    logger(`warning: cannot restrict access to ${path.basename(target)} during ${operation}${code}; it may be readable by other users`)
  } catch { /* a failing logger must not turn best-effort restriction into an exception */ }
}

/** Arguments always travel as an array; no shell string is ever built. */
export function icaclsArgs(target, kind, user = os.userInfo().username) {
  if (typeof user !== 'string' || !user.trim()) throw new Error('the current Windows user cannot be resolved')
  return [target, '/inheritance:r', '/grant:r', `${user.trim()}:${kind === 'directory' ? '(OI)(CI)F' : 'F'}`, '/c']
}

/** Restrict a path to its owner. Never throws; @returns {boolean} whether it succeeded. */
export function restrictToOwnerSync(target, kind = 'file') {
  try {
    if (platform === 'win32') runner('icacls', icaclsArgs(target, kind))
    else fs.chmodSync(target, kind === 'directory' ? SECRET_DIRECTORY_MODE : SECRET_FILE_MODE)
    return true
  } catch (error) {
    warn(`restrictToOwnerSync(${kind})`, target, error)
    return false
  }
}

/** Create `target` as an owner-only directory (only that directory, not its existing parents). */
export function ensureOwnerOnlyDirectory(target) {
  try {
    fs.mkdirSync(target, { recursive: true, mode: SECRET_DIRECTORY_MODE })
  } catch (error) {
    warn('ensureOwnerOnlyDirectory(mkdir)', target, error)
    return false
  }
  return restrictToOwnerSync(target, 'directory')
}

/** Write a secret file owner-only at creation, re-apply the mode/ACL afterwards, rename into place. */
export function writeSecretFile(target, data) {
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, data, { mode: SECRET_FILE_MODE })
  restrictToOwnerSync(temporary, 'file')
  fs.renameSync(temporary, target)
  // The ACL/mode travels with the file across a rename; re-applying on the final
  // name keeps the guarantee independent of that and is what the test asserts.
  restrictToOwnerSync(target, 'file')
}
