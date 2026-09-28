import { test } from 'node:test'
import assert from 'node:assert/strict'
import { opcuaWriteOnce } from '../server/services/workshop/dcw/drivers/opcua'

function input(eng: number, tolerance = 0.5) {
  return { eng, tolerance, domain: { min: 0, max: 100 }, driverConfig: { endpoint: 'opc.tcp://127.0.0.1:4840', nodeId: 'ns=2;s=test' } }
}

function connWith(readValue: unknown, writeStatus = 0) {
  return {
    errors: 0,
    session: {
      async write() {
        return { statusCode: { value: writeStatus } }
      },
      async read() {
        return { value: { value: readValue } }
      },
    } as never,
  }
}

test('opcua write: ok when readback is finite and within tolerance; raw carries eng', async () => {
  const r = await opcuaWriteOnce(connWith(50.3), input(50, 0.5))
  assert.equal(r.ok, true)
  assert.equal(r.readback, 50.3)
  assert.equal(r.raw, 50)
  assert.match(r.message, /写入并回读一致:50,回读 50\.3/)
})

test('opcua write: past-tolerance readback fails and names the tolerance band', async () => {
  const r = await opcuaWriteOnce(connWith(51.2), input(50, 0.5))
  assert.equal(r.ok, false)
  assert.match(r.message, /回读偏差超容差:写 50,回读 51\.2\(容差 0\.5\)/)
})

test('opcua write: non-finite readback normalizes to null and reports 非数值', async () => {
  for (const bad of ['not-a-number', Number.NaN, undefined]) {
    const r = await opcuaWriteOnce(connWith(bad), input(50, 0.5))
    assert.equal(r.ok, false)
    assert.equal(r.readback, null)
    assert.match(r.message, /非数值/)
  }
})

test('opcua write: non-zero write status throws before any readback', async () => {
  await assert.rejects(
    () => opcuaWriteOnce(connWith(50, 0x80ae0000), input(50, 0.5)),
    /写入状态异常/,
  )
})
