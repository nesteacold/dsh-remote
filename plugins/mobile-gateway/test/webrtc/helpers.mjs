import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { listenFetchSafe } from '../support/fetch-safe-listen.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import plugin from '../../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from '../helpers/peer.mjs'
import { FrameInbox } from '../../bin/webrtc-client.mjs'

export async function startGateway(webrtc = { enabled: true }, overrides = {}, implementation = plugin) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mgw-rtc-'))
  let management, upgrade, dispose
  const calls = []
  const listeners = new Map()
  const server = http.createServer((req, res) => management.handler(req, res))
  server.on('upgrade', (req, socket, head) => upgrade.handler(req, socket, head))
  // fetch-safe, tcp-probed: this fixture binds before `implementation.apply` below
  // registers `management`, so its request handler cannot answer a probe yet —
  // an HTTP probe would hit `management.handler` while it is still undefined
  // (measured: TypeError, five failing tests). The helper's blocklist still
  // rejects every port undici's `fetch` refuses; only the reachability half is TCP.
  await listenFetchSafe(server, { probe: 'tcp' })
  const port = server.address().port
  const ctx = {
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    agentDefaultModel: {},
    webServer: {
      port,
      register(route) {
        management = route
        return () => {}
      },
      registerUpgrade(route) {
        upgrade = route
        return () => {}
      },
    },
    typertGateway: {
      async invoke(call) {
        calls.push(call)
        if (call.method === 'create') return { sessionId: 'rtc-created-session' }
        if (call.method === 'list') return { items: [] }
        return { accepted: true }
      },
      async stream(call) {
        return (async function* () {
          if (call.namespace === 'workspace')
            yield {
              type: 'baseline',
              value: { items: [{ workspaceId: 'rtc-workspace', name: 'RTC workspace' }], archivedSessionIds: [] },
            }
          else if (call.method === 'follow')
            yield {
              type: 'snapshot',
              header: { version: 4, id: call.args.request.address.sessionId },
              cursor: 0,
              records: [
                {
                  type: 'event',
                  event: {
                    type: 'user/message',
                    seq: 0,
                    time: 1,
                    data: { message: { content: [{ type: 'text', text: '中文 RTC history' }] } },
                  },
                },
              ],
              projections: {
                asOfSeq: 0,
                values: { agentPreset: 'standard', sessionListMetadata: { blank: true, lastPromptAt: null } },
              },
              hasMore: false,
            }
          else yield { type: 'baseline', value: { projections: {} } }
          try {
            await delay(3600000, undefined, { signal: call.signal })
          } catch {
            /* cancelled */
          }
        })()
      },
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect(factory) {
      dispose = factory()
    },
  }
  // T016/T017/T019: the plugin owns a TLS listener and a v3 pairing code is
  // redeemed there, so the harness enables it and pairs over it.
  await implementation.apply(ctx, {
    gatewayEnabled: true,
    deviceFile: path.join(temp, 'devices.json'),
    tlsCertificateDir: path.join(temp, 'tls'),
    // T022: these suites exercise the admin surface over the business channel.
    legacyAdmin: true,
    // Spec 008 P1b: Host approval is the default; these suites exercise the direct
    // claim path (like the 12 other harnesses). Pre-existing gap, not 36d9 work.
    requireHostApproval: false,
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    webrtc,
    ...overrides,
  })
  const request = async (route, body) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/mgw/${route}`,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    )
    if (!response.ok) throw new Error(`management ${route}: ${response.status}`)
    return response.json()
  }
  const url = `ws://127.0.0.1:${port}/ws/mobile`
  const initialStatus = await request('status')
  const gatewayId = initialStatus.gatewayId
  const deviceId = 'rtc-test-installation'
  const tlsUrl = initialStatus.lan?.urls?.[0]
  if (!tlsUrl) throw new Error('the plugin TLS listener must be listening for a v3 pairing code')
  const offerEndpoint = initialStatus.pairingRoute === 'tailscale' && initialStatus.tailscaleUrl
    ? initialStatus.tailscaleUrl
    : tlsUrl
  const pairing = await request('pair', { publicUrl: offerEndpoint })
  const pairedSocket = new WebSocket(tlsUrl, ['dsh-mobile-v1', `dsh-pair.${pairing.payload.pairingCode}`], {
    rejectUnauthorized: false,
    headers: { 'X-DSH-Device-ID': deviceId },
  })
  const pairedInbox = new FrameInbox()
  pairedSocket.on('message', (data) => pairedInbox.push(JSON.parse(data)))
  const paired = await pairedInbox.take((frame) => frame.kind === 'paired')
  const closed = new Promise((resolve) => pairedSocket.once('close', resolve))
  pairedSocket.close()
  await closed
  pairedInbox.close()
  if (webrtc.enabled && webrtc.mode !== 'ws-only') {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await request('status')).webrtc.runtime !== 'loading') break
      await delay(20)
    }
  }
  return {
    // T022: the suites drive the admin surface over the business channel.
    adminFrames: true,
    request,
    url,
    // Device credentials are accepted only on the plugin-owned TLS listener, so
    // the companion socket dials that one (self-signed in tests).
    socketUrl: tlsUrl,
    tlsOptions: { rejectUnauthorized: false },
    gatewayId,
    deviceId,
    token: paired.token,
    registryId: paired.device.id,
    calls,
    listeners,
    async close() {
      dispose()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await fs.rm(temp, { recursive: true, force: true })
    },
  }
}
