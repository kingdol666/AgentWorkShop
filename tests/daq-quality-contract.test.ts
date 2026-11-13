import test from 'node:test'
import assert from 'node:assert/strict'
import { qualityFromReading, type QualityInput } from '../server/services/workshop/daq/quality'

test('qualityFromReading maps driver quality and freshness explicitly', () => {
  const base: QualityInput = { enabled: true, value: 12, state: 'ok', driverOk: true, ageMs: 100 }
  assert.equal(qualityFromReading(base), 'good')
  assert.equal(qualityFromReading({ ...base, driverOk: false }), 'bad')
  assert.equal(qualityFromReading({ ...base, ageMs: 31_000, staleMs: 30_000 }), 'stale')
  assert.equal(qualityFromReading({ ...base, enabled: false }), 'offline')
  assert.equal(qualityFromReading({ ...base, value: null }), 'uncertain')
})

test('qualityFromReading never treats range alarm as a transport failure', () => {
  const input: QualityInput = { enabled: true, value: 120, state: 'alarm', driverOk: true, ageMs: 100 }
  assert.equal(qualityFromReading(input), 'good')
})
