// Owner rule 2026-11-10: the settings section is registered only while the Host
// reports that `@dsh-ext/devices` is absent, and the pair (page + sidebar icon)
// is registered and withdrawn as one unit so both states are never live at once.
//
// The real `apply()` is loaded out of the shipped bundle, so the lifecycle under
// test is the one that ships rather than a copy of it.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function loadApply({ status = {}, failStatus = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8')
  const start = source.indexOf('    // Whale mark for the settings section icon.')
  const end = source.indexOf('    exports.apply = apply')
  assert.ok(start > 0 && end > start, 'lib/client.js no longer contains the settings-section tail this test drives')
  const injections = [], registrations = [], disposals = [], requests = []
  const slots = {
    // Both `inject` and `register` return disposers (see plugins/devices/lib/client.js,
    // which removes its sidebar entry the same way).
    inject(name, register) {
      injections.push(name)
      const disposeRegistration = register()
      return () => {
        disposals.push(name)
        if (typeof disposeRegistration === 'function') disposeRegistration()
      }
    },
    register(meta) {
      const entry = { ...meta }
      registrations.push(entry)
      return () => {
        const index = registrations.indexOf(entry)
        if (index !== -1) registrations.splice(index, 1)
      }
    },
  }
  const request = (url) => {
    requests.push({ url })
    return failStatus ? Promise.reject(new Error('status unavailable')) : Promise.resolve(status)
  }
  const sandbox = {
    React: { createElement: (type, props) => ({ type, props }) },
    tr: text => text,
    DevicePanel: () => null,
    // The factory-scope values apply()'s effects read and write; everything else
    // the sliced tail needs is either in the slice or listed here.
    panelCss: '',
    hostLanguage: undefined,
    publishUiLanguage() {},
    document: { createElement: () => ({ textContent: '', remove() {} }), head: { appendChild() {} } },
    request,
  }
  vm.createContext(sandbox)
  const apply = vm.runInContext(`${source.slice(start, end)}\n    apply`, sandbox)
  const effects = []
  const ctx = {
    locale: { getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => {} },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    slots,
  }
  return { apply, ctx, effects, injections, registrations, disposals, requests }
}

// The status answer lands on a microtask; one macrotask lets it land.
const settled = () => new Promise(resolve => setImmediate(resolve))

test('a loaded devices plugin withdraws the section and its icon', async () => {
  const api = loadApply({ status: { devicesPluginPresent: true } })
  api.apply(api.ctx)
  // Registered first, as before, and then corrected by the Host's answer.
  assert.deepEqual(api.injections, ['settings.section', 'settings.section.icon'])
  await settled()
  assert.deepEqual(api.disposals, ['settings.section', 'settings.section.icon'])
  assert.deepEqual(api.registrations, [], 'no settings registration may survive')
  // One startup read of the answer, not a polling loop of its own.
  assert.deepEqual(api.requests.map(call => call.url), ['/mgw/status'])
})

test('standalone, both registrations stay with the shipped metadata', async () => {
  const api = loadApply({ status: { devicesPluginPresent: false } })
  api.apply(api.ctx)
  await settled()
  assert.deepEqual(api.registrations.map(entry => entry.name), ['settings.section', 'settings.section.icon'])
  for (const entry of api.registrations) {
    assert.equal(entry.id, 'dsh-ext.mobile-gateway-devices')
    assert.equal(entry.order, 90)
    assert.equal(entry.label, '我的移动设备')
  }
  assert.deepEqual(api.disposals, [])
})

test('an answer without the field keeps the section visible', async () => {
  const api = loadApply({ status: {} })
  api.apply(api.ctx)
  await settled()
  assert.equal(api.registrations.length, 2)
  assert.deepEqual(api.disposals, [])
})

test('a failed status fetch leaves both registered and does not throw', async () => {
  const api = loadApply({ failStatus: true })
  assert.doesNotThrow(() => api.apply(api.ctx))
  await settled()
  assert.deepEqual(api.registrations.map(entry => entry.name), ['settings.section', 'settings.section.icon'])
  assert.deepEqual(api.disposals, [])
  // The open panel still owns the only status polling; the plugin itself never
  // leaves an unhandled rejection behind.
  assert.deepEqual(api.requests.map(call => call.url), ['/mgw/status'])
})
