// The running DSH version, for the A1.1 self-test (constitution v1.2.0).
//
// A1.1 lets this plugin wrap `typertGateway.dispatchRpc` / `openWireStream` on a
// live instance, but only while the self-test matches the pinned `engines.dsh`;
// on a mismatch it must not wrap and must say why. The pin alone cannot answer
// "which DSH is running", so this resolves the boot package of the process the
// Host started (`process.argv[1]`), never a dependency of the plugin and never
// another DSH on PATH — the same probe the gateway uses for `hello.dshVersion`.
//
// An undetectable version is NOT treated as the pinned one: the caller then gets
// `undefined` and the router refuses to wrap (`dsh-version-unknown`).
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/**
 * @param {string} [entrypoint] the Host process entry (defaults to `process.argv[1]`)
 * @returns {string|undefined} the semver of `@deepseek-ai/dsh-app-boot`, or undefined
 */
export function resolveDshRuntimeVersion(entrypoint = process.argv[1]) {
  if (!entrypoint) return undefined
  try {
    const entry = fs.realpathSync(path.resolve(entrypoint))
    const require = createRequire(entry)
    const filename = require.resolve('@deepseek-ai/dsh-app-boot/package.json')
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const version = manifest.version
    return manifest.name === '@deepseek-ai/dsh-app-boot'
      && typeof version === 'string'
      && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
      ? version : undefined
  } catch {
    return undefined
  }
}

export default resolveDshRuntimeVersion
