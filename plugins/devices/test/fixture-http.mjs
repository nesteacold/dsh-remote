// HTTP client for the fixture gateways these tests start themselves.
//
// `fetch` is undici, and undici refuses the Fetch spec's "bad ports" (0-1023 plus a
// fixed list that includes 6665-6669) before it opens a socket. The fixture servers
// listen on the port the OS hands out, so the suite was a port lottery: a run that
// drew 6669 died in its first `get('status')` with
//   TypeError: fetch failed { [cause]: Error: bad port }
// while the same suite went 3/3 green on a re-run (measured 2026-11-10). Which port
// the OS assigns is not what any of these tests is about, so they do not go through
// undici at all: `node:http` has no port policy. The port stays `listen(0)` — no
// re-listen loop, no bounded retries, nothing to get wrong under load.
import http from 'node:http'

/**
 * One request against a fixture gateway at `base` (`http://127.0.0.1:<port>`).
 * The gateway's write routes require an `Origin` that matches the Host header, so
 * callers pass it in `headers` exactly as they did with `fetch`.
 * @param {string} base origin of the fixture server, e.g. `http://127.0.0.1:3080`
 * @param {string} method HTTP method
 * @param {string} path path (and query) to request, e.g. `/mgw/status`
 * @param {{body?: unknown, headers?: Record<string, string>}} [options] `body` is JSON-encoded
 * @returns {Promise<{status: number, data: any}>} status code and the parsed JSON body
 */
export function requestJson(base, method, path, { body, headers = {} } = {}) {
  const url = new URL(path, base)
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const requestHeaders = { ...headers }
  if (payload) {
    requestHeaders['Content-Type'] = 'application/json'
    requestHeaders['Content-Length'] = String(payload.length)
  }
  return new Promise((resolve, reject) => {
    // `agent: false` per request: no keep-alive socket may outlive the test that
    // opened it (a poll loop would otherwise hold the event loop on a dead gateway).
    const request = http.request({
      method, protocol: url.protocol, hostname: url.hostname, port: url.port,
      path: `${url.pathname}${url.search}`, headers: requestHeaders, agent: false,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ status: response.statusCode, data: JSON.parse(text) })
        } catch (cause) {
          // `response.json()` used to reject here too: a non-JSON answer fails the call.
          reject(new Error(`${method} ${url.pathname} did not answer JSON (status ${response.statusCode}): ${text.slice(0, 200)}`, { cause }))
        }
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}
