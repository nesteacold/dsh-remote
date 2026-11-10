import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CLOUDFLARED_DISABLED,
  CLOUDFLARED_DISABLED_STATUS,
  CLOUDFLARED_ENABLED,
  cloudflaredAsset,
  cloudflaredDisabledError,
  ensureCloudflared,
} from '../lib/cloudflared-binary.mjs'
import * as binaryModule from '../lib/cloudflared-binary.mjs'

// FR-011 / R9 (T031): v1 must not download cloudflared or execute a binary.
// This file used to drive the whole GitHub-Releases pipeline (HTTP fetch,
// checksum, tar extraction, cache reuse). That pipeline is now unreachable by
// design, so the coverage is replaced by the refusal: no network call, no
// cache directory, no executable — for the default AND for an owner-configured
// external path. The asset mapping below stays asserted because that code is
// kept in the tree behind the flag for a later spec.
assert.equal(CLOUDFLARED_ENABLED, false)
assert.equal(CLOUDFLARED_DISABLED, 'cloudflare/disabled')
assert.equal(CLOUDFLARED_DISABLED_STATUS, 403)
// The downloader must have no exported back door that bypasses the refusal.
assert.deepEqual(
  ['installCloudflared', 'downloadCloudflared', 'prepareCloudflared'].filter((name) => name in binaryModule),
  [],
)

assert.equal(cloudflaredAsset('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz')
assert.equal(cloudflaredAsset('darwin', 'x64'), 'cloudflared-darwin-amd64.tgz')
assert.equal(cloudflaredAsset('win32', 'x64'), 'cloudflared-windows-amd64.exe')
assert.equal(cloudflaredAsset('linux', 'x64'), 'cloudflared-linux-amd64')
assert.equal(cloudflaredAsset('linux', 'arm64'), 'cloudflared-linux-arm64')
// `cloudflaredPath` is the actual spelling in the message; the previous copy of
// this assertion matched `cloudflarePath` and could never pass.
assert.throws(() => cloudflaredAsset('linux', 'riscv64'), /unsupported.*cloudflaredPath/)

function assertDisabledRefusal(error) {
  assert.equal(error.code, CLOUDFLARED_DISABLED)
  assert.equal(error.status, CLOUDFLARED_DISABLED_STATUS)
  assert.equal(error.security, true)
  assert.match(error.message, /disabled in this release \(FR-011\/R9\)/)
  return true
}

// The shared factory is what the tunnel module throws, so the code/status/
// message a caller sees are the same on both paths.
assert.equal(assertDisabledRefusal(cloudflaredDisabledError()), true)

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cloudflared-disabled-'))
try {
  const cacheDir = path.join(temp, 'never-created')
  const externalBinary = path.join(temp, 'cloudflared.exe')
  let fetches = 0
  const fetchImpl = async () => {
    fetches += 1
    throw new Error('network access must not happen')
  }
  const cases = [
    ['default executable', { cacheDir, fetchImpl }],
    ['linux x64', { cacheDir, fetchImpl, platform: 'linux', arch: 'x64' }],
    ['darwin arm64 archive', { cacheDir, fetchImpl, platform: 'darwin', arch: 'arm64' }],
    ['win32 x64', { cacheDir, fetchImpl, platform: 'win32', arch: 'x64' }],
    // R9: an explicit `cloudflaredPath` is not a way around the disable.
    ['owner-configured external executable', { cacheDir, fetchImpl, executable: externalBinary }],
    ['digest overrides', {
      cacheDir,
      fetchImpl,
      releaseDigests: { 'cloudflared-linux-amd64': '0'.repeat(64) },
      binaryDigests: { 'cloudflared-linux-amd64': '0'.repeat(64) },
    }],
  ]
  const messages = new Set()
  for (const [label, options] of cases) {
    await assert.rejects(
      ensureCloudflared(options),
      (error) => {
        assertDisabledRefusal(error)
        messages.add(error.message)
        return true
      },
      label,
    )
  }
  // Deterministic: the same refusal every time, and no request was attempted.
  assert.equal(messages.size, 1)
  assert.equal(fetches, 0)
  // Nothing was prepared on disk: the refusal precedes the cache directory.
  await assert.rejects(fs.access(cacheDir), /ENOENT/)
  assert.deepEqual(await fs.readdir(temp), [])

  // A second call is refused identically (no cached binary, no state).
  await assert.rejects(ensureCloudflared({ cacheDir, fetchImpl }), (error) => error.code === CLOUDFLARED_DISABLED)
  assert.equal(fetches, 0)
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
console.log('CLOUDFLARED BINARY TESTS PASSED (hard-disabled refusal)')
