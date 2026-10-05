import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPluginDriverRegistry } from '../server/services/workshop/plugin-driver-registry'

interface FakeDriver {
  kind: string
  meta?: { label?: unknown, status?: unknown, configFields?: unknown, replaces?: unknown }
}

function driver(kind: string, meta?: FakeDriver['meta']): FakeDriver {
  return { kind, meta }
}

function make() {
  return createPluginDriverRegistry<FakeDriver>({
    builtinKinds: { mock: true, modbus: true },
    driversKey: '__testPluginDrivers',
    metasKey: '__testPluginDriverMetas',
    onOverrideBuiltin: () => {},
  })
}

test('plugin driver registry: register, list, and clear', () => {
  const p = make()
  p.register(driver('acme', { label: 'Acme', status: 'real', configFields: [] }))
  assert.deepEqual(p.listKeys(), ['acme'])
  assert.equal(p.listMetas()[0]?.label, 'Acme')
  assert.equal(p.listMetas()[0]?.plugin, true)
  p.clear()
  assert.deepEqual(p.listKeys(), [])
  assert.deepEqual(p.listMetas(), [])
})

test('plugin driver registry: meta-less registration clears stale meta on hot reload', () => {
  const p = make()
  p.register(driver('acme', { label: 'Acme', status: 'real', configFields: [] }))
  p.register(driver('acme'))
  assert.deepEqual(p.listKeys(), ['acme'])
  assert.deepEqual(p.listMetas(), [])
})

test('plugin driver registry: merged catalog overrides builtin entry and marks plugin', () => {
  const p = make()
  p.register(driver('modbus', { label: '自定义 Modbus', status: 'real', configFields: [], replaces: ['modbus'] }))
  p.register(driver('acme', { label: 'Acme', status: 'planned', configFields: [] }))
  const cat = p.mergedCatalog([
    { kind: 'mock', label: 'Mock', status: 'builtin', configFields: [] },
    { kind: 'modbus', label: 'Modbus', status: 'builtin', configFields: [] },
  ])
  const modbus = cat.find(d => d.kind === 'modbus')
  const acme = cat.find(d => d.kind === 'acme')
  const mock = cat.find(d => d.kind === 'mock')
  assert.equal(modbus?.label, '自定义 Modbus')
  assert.equal(modbus?.plugin, true)
  assert.equal(acme?.status, 'planned')
  assert.equal(acme?.plugin, true)
  assert.equal(mock?.plugin, undefined)
})

test('plugin driver registry: overriding a builtin without replaces declaration is rejected', () => {
  let fired = false
  const strict = createPluginDriverRegistry<FakeDriver>({
    builtinKinds: { mock: true, modbus: true },
    driversKey: '__testStrictDrivers',
    metasKey: '__testStrictMetas',
    onOverrideBuiltin: () => { fired = true },
  })
  assert.throws(() => strict.register(driver('modbus', { label: 'X', status: 'real', configFields: [] })), /PLUGIN_OVERRIDE_NOT_DECLARED/)
  assert.equal(fired, false)
  assert.equal(strict.listKeys().includes('modbus'), false)
})

test('plugin driver registry: overriding a builtin kind fires the override warning hook', () => {
  const seen: string[] = []
  const p = createPluginDriverRegistry<FakeDriver>({
    builtinKinds: { mock: true },
    driversKey: '__testPluginDrivers2',
    metasKey: '__testPluginDriverMetas2',
    onOverrideBuiltin: kind => seen.push(kind),
  })
  p.register(driver('acme'))
  p.register(driver('mock', { replaces: ['mock'] }))
  assert.deepEqual(seen, ['mock'])
})

test('plugin driver registry: illegal status coerces to real', () => {
  const p = make()
  p.register(driver('acme', { label: 'Acme', status: 'bogus', configFields: [] }))
  assert.equal(p.listMetas()[0]?.status, 'real')
})
