// v1 browser-admin boundary (spec 001 FR-011 / R9): the client bundle must not
// contact author or third-party endpoints, and must not offer the v1-disabled
// Cloudflare tunnel / public-setup admin actions. These are static checks on the
// shipped bundle so they need no browser or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '../lib/client.js'), 'utf8')

test('client bundle contains no external URL literals or release/update polling', () => {
  const urls = [...source.matchAll(/['"`](https?:\/\/[^'"`\s]+)['"`]/g)].map((match) => match[1])
  assert.deepEqual(urls, [], `external URL literals found: ${urls.join(', ')}`)
  assert.doesNotMatch(source, /api\.github\.com/)
  assert.doesNotMatch(source, /RELEASES_LATEST|TESTFLIGHT|INSTALL_SHOTS|InstallGuide/)
  assert.doesNotMatch(source, /installRelease|installLoading|installPlatform|setInstall/)
  assert.doesNotMatch(source, /mobile-gateway-latest-release/)
  assert.doesNotMatch(source, /activeSection !== 'install'/)
})

test('client makes exactly one same-origin fetch and only /mgw admin requests', () => {
  const fetches = [...source.matchAll(/\bfetch\s*\(([^)]*)\)/g)].map((match) => match[1])
  assert.equal(fetches.length, 1, 'only the shared request() helper may call fetch')
  assert.match(fetches[0], /\btarget\b/)
  assert.match(source, /path\.startsWith\('\/mgw\/'\)/)
  assert.doesNotMatch(source, /XMLHttpRequest|sendBeacon|EventSource|new WebSocket/)

  const requestPaths = [...source.matchAll(/\brequest\(\s*(?:`|'|")(\/[^`'"]*)/g)].map((match) => match[1])
  assert.ok(requestPaths.length >= 10, `expected the admin routes, found ${requestPaths.length}`)
  for (const requestPath of requestPaths) {
    assert.match(requestPath, /^\/mgw\//, `non-loopback admin request: ${requestPath}`)
  }
})

test('v1 has no Cloudflare tunnel or public-setup UI actions', () => {
  assert.doesNotMatch(source, /\/mgw\/public-setup/)
  assert.doesNotMatch(source, /\/mgw\/cloudflare/)
  assert.doesNotMatch(source, /configurePublicAccess|configureCloudflare|checkCloudflare|restartCloudflare/)
  assert.doesNotMatch(source, /publicSetup|publicSetupBusy|publicIp/)
  assert.doesNotMatch(source, /cloudflareHost|cloudflareToken|cloudflareMode|cloudflareBusy|cloudflareReady/)
  assert.doesNotMatch(source, /className: 'mgw-cloudflare-/)
  assert.doesNotMatch(source, /value: 'cloudflare'/)
})

test('loopback admin enable, pairing and device controls are preserved', () => {
  for (const endpoint of ['/mgw/gateway', '/mgw/devices', '/mgw/status', '/mgw/connection',
    '/mgw/pair', '/mgw/tls/regenerate', '/mgw/tools/', '/mgw/network-test']) {
    assert.ok(source.includes(endpoint), `missing admin endpoint ${endpoint}`)
  }
  assert.match(source, /id: 'mgw-pairing-url'/)
  assert.match(source, /id: 'mgw-manual-route'/)
  assert.match(source, /tr\('网关运行模式'\)/)
  assert.match(source, /tr\('可信设备'\)/)
  assert.match(source, /tr\('生成配对二维码'\)/)
  assert.match(source, /devices\/\$\{encodeURIComponent\(device\.id\)\}\/revoke/)
})
