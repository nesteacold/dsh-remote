// Shared test helpers. Tests run as plain scripts (`node test/x.test.mjs`)
// because spawning `node --test` workers is EPERM in the sandbox.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import plugin, { internalsFor } from '../lib/index.mjs'

const require = createRequire(import.meta.url)
// `selfsigned` is the gateway's own certificate generator; reused from its
// node_modules (no network install here) to mint certificates for fake remotes.
export const selfsigned = require('../../mobile-gateway/node_modules/selfsigned')
export const { WebSocketServer } = require('../../mobile-gateway/node_modules/ws')

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
let passes = 0
export async function check(name, fn) {
  try {
    await fn()
    passes += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n       ') : error}`)
  }
}
export function finish(label) {
  console.log(`${label}: ${passes} passed, ${failures} failed`)
  // Sockets/servers a failed test left open must not keep the run alive.
  process.exit(failures === 0 ? 0 : 1)
}
export function skip(name, reason) {
  console.log(`  SKIP ${name} (${reason})`)
}

export function tempDir(prefix = 'dsh-devices-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** SHA-256 of a PEM certificate's DER, the pin format of the pairing payload. */
export function pinOf(pem) {
  return crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex')
}

/** Mount the plugin on a fake web server; returns a request function that drives its handler. */
export async function mountPlugin(config = {}) {
  const dataDir = config.dataDir ?? tempDir()
  let route
  const disposers = []
  const ctx = {
    webServer: { register(entry) { route = entry; return () => { route = undefined } } },
    // Cordis services the plugin reads optionally (`ctx.get(name, false)`), e.g.
    // the Host `typertGateway` the multi-host router wraps (spec 008 P2a).
    get(name) { return config.services?.[name] },
    effect(fn) { disposers.push(fn()) },
  }
  const logs = []
  await plugin.apply(ctx, { dataDir, log: (line) => logs.push(line), ...config })
  // `apply` is async and Cordis rejects a non-function resolution as an invalid
  // effect, so the internals come from the plugin's WeakMap, not from a return.
  const instance = internalsFor(ctx) ?? {}
  const call = (method, url, { body, headers = {}, remoteAddress = '127.0.0.1' } = {}) => new Promise((resolve) => {
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const req = {
      method, url, headers: { host: '127.0.0.1:3080', ...headers }, socket: { remoteAddress },
      on(event, handler) {
        if (event === 'data') queueMicrotask(() => chunks.forEach((chunk) => handler(chunk)))
        if (event === 'end') queueMicrotask(() => queueMicrotask(() => handler()))
        return req
      },
    }
    const res = {
      writeHead(status, responseHeaders) { res.status = status; res.headers = responseHeaders },
      end(text) { resolve({ status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined, text }) },
    }
    route.handler(req, res)
  })
  return {
    dataDir, logs, call, instance, route: () => route,
    close() { for (const dispose of disposers.splice(0)) dispose?.(); fs.rmSync(dataDir, { recursive: true, force: true }) },
  }
}
