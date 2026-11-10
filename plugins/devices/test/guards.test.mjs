// FR5 / hard boundary: every /devices request must come from loopback AND be
// same-origin. A request that fails either check never reaches a route, so no
// remote host list, token file or outbound dial is reachable from outside.
import assert from 'node:assert/strict'
import { check, finish, mountPlugin } from './helpers.mjs'

console.log('guards')
const mounted = await mountPlugin()
const ROUTES = [
  ['GET', '/devices/remotes'],
  ['POST', '/devices/remotes', { address: '127.0.0.1:1', pairingString: 'x'.repeat(40) }],
  ['DELETE', '/devices/remotes/00000000-0000-4000-8000-000000000001'],
  ['GET', '/devices/remotes/00000000-0000-4000-8000-000000000001/sessions'],
  ['GET', '/devices/remotes/00000000-0000-4000-8000-000000000001/history?sessionId=s1'],
  // Spec 008 P2c: the path form of the same route reads the local copy offline.
  ['GET', '/devices/remotes/00000000-0000-4000-8000-000000000001/sessions/s1/history'],
  ['POST', '/devices/remotes/00000000-0000-4000-8000-000000000001/prompt', { sessionId: 's1', text: 'hi' }],
  ['POST', '/devices/remotes/00000000-0000-4000-8000-000000000001/approval', { rpcId: 'r' }],
]

await check('registers the /devices prefix (and nothing else)', () => {
  assert.equal(mounted.route().kind, 'prefix')
  assert.equal(mounted.route().path, '/devices')
})

for (const [method, url, body] of ROUTES) {
  await check(`${method} ${url.replace(/[0-9a-f-]{36}/, ':id')} refuses a non-loopback peer`, async () => {
    for (const remoteAddress of ['192.168.1.50', '10.0.0.2', '8.8.8.8', '::ffff:192.168.1.5', 'fe80::1']) {
      const answer = await mounted.call(method, url, { body, remoteAddress })
      assert.equal(answer.status, 403, `${remoteAddress}: ${answer.text}`)
      assert.equal(answer.json.error, 'forbidden')
      assert.match(answer.json.message, /loopback-only/)
    }
  })
  await check(`${method} ${url.replace(/[0-9a-f-]{36}/, ':id')} refuses a cross-origin request`, async () => {
    for (const origin of ['https://evil.example', 'http://127.0.0.1:9999', 'null', 'http://localhost:3080']) {
      const answer = await mounted.call(method, url, { body, headers: { origin } })
      assert.equal(answer.status, 403, `${origin}: ${answer.text}`)
      assert.match(answer.json.message, /cross-origin/)
    }
    // A malformed Origin is also refused, never treated as "absent".
    assert.equal((await mounted.call(method, url, { body, headers: { origin: '::bad' } })).status, 403)
  })
}

await check('loopback + same-origin (or no Origin) is served', async () => {
  for (const loopback of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const answer = await mounted.call('GET', '/devices/remotes', { remoteAddress: loopback })
    assert.equal(answer.status, 200, loopback)
    assert.deepEqual(answer.json.remotes, [])
    // Spec 008 P2a: the page also learns whether multi-host routing is live. This
    // fake Host composes no `typertGateway`, so the wrapper patched nothing.
    assert.equal(answer.json.routing.remote, false)
    assert.equal(answer.json.routing.reason, 'no-gateway')
  }
  const same = await mounted.call('GET', '/devices/remotes', { headers: { origin: 'http://127.0.0.1:3080' } })
  assert.equal(same.status, 200)
})

await check('GET is guarded too (stricter than /mgw): the list exposes remotes and approvals', async () => {
  assert.equal((await mounted.call('GET', '/devices/remotes', { headers: { origin: 'https://evil.example' } })).status, 403)
})

await check('responses are not cacheable and carry nosniff', async () => {
  const answer = await mounted.call('GET', '/devices/remotes')
  assert.equal(answer.headers['Cache-Control'], 'no-store')
  assert.equal(answer.headers['X-Content-Type-Options'], 'nosniff')
})

await check('unknown paths and unknown ids are 404, input errors are 400', async () => {
  assert.equal((await mounted.call('GET', '/devices/other')).status, 404)
  assert.equal((await mounted.call('GET', '/devices/remotes/not-a-uuid/sessions')).status, 404)
  assert.equal((await mounted.call('GET', '/devices/remotes/00000000-0000-4000-8000-000000000001')).status, 404)
  const bad = await mounted.call('POST', '/devices/remotes', { body: { address: '127.0.0.1:1', pairingString: 'not base64!' } })
  assert.equal(bad.status, 400)
  const notJson = await mounted.call('POST', '/devices/remotes', { body: '[1,2]' })
  assert.equal(notJson.status, 400)
})

mounted.close()
finish('guards')
