import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectMobileTestClient } from '../../bin/webrtc-client.mjs'
import { startGateway } from './helpers.mjs'

for (const enabled of [false, true]) {
  test(`correlated network probes and the ping requestId rule over ${enabled ? 'RTC' : 'WebSocket'}`, { timeout: 45000 }, async () => {
    const gateway = await startGateway({ enabled })
    let client
    try {
      client = await connectMobileTestClient(gateway)
      assert.equal(client.mode, enabled ? 'webrtc' : 'websocket')
      for (const channel of ['control', 'conversation']) {
        // Contract §1: the id is bounded to [A-Za-z0-9._-] (no ':').
        const requestId = `network-check-test-${channel}`
        await client.send(channel, { type: 'ping', requestId })
        const pong = await client.inbox.take(frame => frame.kind === 'pong' && frame.requestId === requestId)
        assert.equal(pong.channel, channel)
        assert.equal(typeof pong.at, 'number')
        // Contract §1 is a fence, not a hint: an id outside the rule is refused
        // with `bad-request` and never answered with a pong (the old behaviour —
        // "legacy ping" tolerated any id and just omitted the echo — is gone).
        for (const invalid of [undefined, '', 12, { bad: true }, 'x'.repeat(65), 'has space']) {
          await client.send(channel, { type: 'ping', requestId: invalid })
          const refusal = await client.inbox.take(frame => frame.kind === 'error' && frame.requestType === 'ping')
          assert.equal(refusal.code, 'bad-request', JSON.stringify(invalid))
        }
      }
    } finally {
      await client?.close()
      await gateway.close()
    }
  })
}
