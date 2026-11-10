import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  PUBLIC_SETUP_DISABLED,
  assertPublicIpv4,
  certName,
  currentPackageSpec,
  helperService,
  isMainModule,
  nginxHttpConfig,
  nginxTlsConfig,
  parseArgs,
  pluginInstallArgs,
  renewalService,
  renewalTimer,
} from '../bin/setup-ip.mjs'

const parsed = parseArgs(['setup', '--ip', '203.0.113.7', '--port', '33080', '--email', 'ops@example.com', '--yes'])
assert.deepEqual(parsed, {
  command: 'setup',
  port: 33080,
  yes: true,
  ip: '203.0.113.7',
  email: 'ops@example.com',
})

assert.doesNotThrow(() => assertPublicIpv4('8.8.8.8'))
for (const address of ['', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '224.0.0.1']) {
  assert.throws(() => assertPublicIpv4(address))
}

assert.equal(certName('203.0.113.7'), 'dsh-mobile-gateway-203-0-113-7')
const packageManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(currentPackageSpec(), `${packageManifest.name}@${packageManifest.version}`)
assert.deepEqual(pluginInstallArgs('dsh-plugin-mobile-gateway@9.8.7'), [
  'plugin', '--profile', 'web', 'add', 'dsh-plugin-mobile-gateway@9.8.7',
  '--config.minimum-release-age-exclude=dsh-plugin-mobile-gateway@9.8.7',
])

const httpConfig = nginxHttpConfig('203.0.113.7')
assert.match(httpConfig, /listen 80;/)
assert.match(httpConfig, /server_name 203\.0\.113\.7;/)
assert.match(httpConfig, /\.well-known\/acme-challenge/)
assert.match(httpConfig, /location \/ \{ return 404; \}/)

const tlsConfig = nginxTlsConfig('203.0.113.7', 33080)
assert.match(tlsConfig, /listen 443 ssl;/)
assert.match(tlsConfig, /location = \/ws\/mobile/)
assert.match(tlsConfig, /proxy_pass http:\/\/127\.0\.0\.1:33080;/)
assert.match(tlsConfig, /if \(\$args != ""\) \{ return 404; \}/)
assert.doesNotMatch(tlsConfig, /location \/mgw/)

assert.match(renewalService(), /certbot renew --quiet/)
assert.match(renewalService(), /systemctl reload nginx/)
assert.match(renewalTimer(), /OnCalendar=\*-\*-\* 00,12:00:00/)
assert.match(helperService(1000), /ExecStart=\/usr\/bin\/python3 .* --uid 1000/)
assert.match(helperService(1000), /NoNewPrivileges=true/)
assert.doesNotMatch(helperService(1000), /\/bin\/sh/)

const helperPath = fileURLToPath(new URL('../helper/dsh_mobile_gateway_helper.py', import.meta.url))
const helperSyntax = spawnSync('python3', ['-c', 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec")', helperPath], { encoding: 'utf8' })
assert.equal(helperSyntax.status, 0, helperSyntax.stderr)

const binPath = fileURLToPath(new URL('../bin/setup-ip.mjs', import.meta.url))
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-gateway-bin-'))
const linkedBin = path.join(temporaryDirectory, 'dsh-plugin-mobile-gateway')
fs.symlinkSync(binPath, linkedBin)
assert.equal(isMainModule(linkedBin), true)
const linkedInvocation = spawnSync(process.execPath, [linkedBin, '--help'], { encoding: 'utf8' })
assert.equal(linkedInvocation.status, 0, linkedInvocation.stderr)
assert.match(linkedInvocation.stdout, /dsh-plugin-mobile-gateway setup/)

// FR-011 / R9 (T031): the command must refuse instead of configuring anything.
// `setup`, `init`, `setup-helper`, `remove-helper`, `status` and `remove` all
// exit non-zero with the disable message and print no setup progress; only
// --help stays available, so an owner who still runs it learns why. The former
// package `bin` entry is removed too, so a fresh install no longer offers it.
assert.equal(PUBLIC_SETUP_DISABLED, true)
assert.equal('bin' in packageManifest, false, 'package.json must not declare the removed setup executable as a bin')
assert.match(linkedInvocation.stdout, /DISABLED in this release \(FR-011\/R9\)/)
for (const command of ['setup', 'init', 'setup-helper', 'remove-helper', 'status', 'remove']) {
  const invocation = spawnSync(process.execPath, [linkedBin, command], { encoding: 'utf8' })
  assert.equal(invocation.status, 1, `${command} must exit non-zero`)
  assert.equal(invocation.stdout, '', `${command} must not print setup output`)
  assert.match(invocation.stderr, /disabled in this release \(FR-011\/R9\)/, command)
  assert.match(invocation.stderr, /Nothing was configured/, command)
}
fs.rmSync(temporaryDirectory, { recursive: true })

console.log('public IP setup tests passed')
