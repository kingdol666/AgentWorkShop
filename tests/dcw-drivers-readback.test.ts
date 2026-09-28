import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readbackAck } from '../server/services/workshop/dcw/drivers/shared'

function input(eng: number, tolerance = 0.5) {
  return { eng, tolerance, domain: { min: 0, max: 100 }, driverConfig: {} }
}

test('readbackAck passes when readback is finite and within tolerance', () => {
  const r = readbackAck(input(50, 0.5), 50.3, { raw: 50.3, rawNote: '50.3' })
  assert.equal(r.ok, true)
  assert.equal(r.readback, 50.3)
  assert.equal(r.raw, 50.3)
  assert.match(r.message, /写入并回读一致:50 → raw 50\.3,回读 50\.3/)
})

test('readbackAck: deadband is inclusive — |Δ| == tolerance passes', () => {
  const r = readbackAck(input(50, 0.5), 50.5, { raw: 50.5 })
  assert.equal(r.ok, true)
  assert.equal(readbackAck(input(50, 0.5), 50.5001, { raw: 50.5 }).ok, false)
})

test('readbackAck fails past tolerance and reports the tolerance band', () => {
  const r = readbackAck(input(50, 0.5), 51.2, { raw: 51.2, rawNote: '51.2' })
  assert.equal(r.ok, false)
  assert.equal(r.readback, 51.2)
  assert.match(r.message, /回读偏差超容差:写 50,回读 51\.2\(容差 0\.5\)/)
})

test('readbackAck treats non-finite readback as unconfirmed and nulls it', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = readbackAck(input(50, 0.5), bad, { raw: null })
    assert.equal(r.ok, false)
    assert.equal(r.readback, null)
    assert.match(r.message, /非数值/)
  }
})

test('readbackAck omits the raw note for direct-write drivers', () => {
  const r = readbackAck(input(50, 0.5), 50, { raw: 50 })
  assert.equal(r.ok, true)
  assert.doesNotMatch(r.message, /raw /)
})
