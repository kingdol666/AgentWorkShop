import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBaselineManifest, classifyEvidenceCheck } from '../scripts/_audit/governed-learning-evidence.mjs'

test('a green selected subset does not complete an interrupted check', () => {
  assert.equal(classifyEvidenceCheck({ execution: 'incomplete', passed: true }), 'PARTIAL')
})

test('unstarted physical validation is not counted', () => {
  assert.equal(classifyEvidenceCheck({ execution: 'not_started' }), 'NOT_RUN')
})

test('an explicit blocker takes precedence over execution and reported success', () => {
  for (const execution of ['not_started', 'incomplete', 'terminal'] as const) {
    assert.equal(classifyEvidenceCheck({ execution, passed: true, blockedReason: 'required evidence unavailable' }), 'BLOCKED')
  }
})

test('a terminal check requires an explicit Boolean verdict', () => {
  assert.equal(classifyEvidenceCheck({ execution: 'terminal', passed: true }), 'PASS')
  assert.equal(classifyEvidenceCheck({ execution: 'terminal', passed: false }), 'FAIL')
  assert.equal(classifyEvidenceCheck({ execution: 'terminal' }), 'BLOCKED')
  assert.equal(Reflect.apply(classifyEvidenceCheck, undefined, [{ execution: 'terminal', passed: 'true' }]), 'BLOCKED')
  assert.equal(Reflect.apply(classifyEvidenceCheck, undefined, [{ execution: 'unrecognized', passed: true }]), 'BLOCKED')
})

test('the manifest accounts for incomplete delivery and excludes simulation from field admission', () => {
  const manifest = buildBaselineManifest({
    revision: null,
    runId: 'fixture-simulation',
    environment: 'simulation',
    modelProvenance: 'real_model',
    captureHashes: { 'historical-summary': 'a'.repeat(64) },
    missing: [{ id: 'historical-raw-capture', reason: 'historical-local / unavailable' }],
    checks: [
      { id: 'readback', category: 'mechanism', execution: 'terminal', passed: true },
      { id: 'new-project-delivery', category: 'mechanism', execution: 'incomplete', passed: true },
      { id: 'measured-reuse', category: 'effect', execution: 'not_started' },
      { id: 'dependency-recovery', category: 'resilience', execution: 'terminal', passed: false },
      { id: 'on-site', category: 'field_admission', execution: 'terminal', passed: true },
    ],
  })
  assert.equal(manifest.revision, null)
  assert.equal(manifest.modelProvenance, 'real_model')
  assert.deepEqual(manifest.captureHashes, { 'historical-summary': 'a'.repeat(64) })
  assert.deepEqual(manifest.missing, [{ id: 'historical-raw-capture', reason: 'historical-local / unavailable' }])
  assert.deepEqual(manifest.checks.map((check: { id: string, status: string }) => [check.id, check.status]), [
    ['readback', 'PASS'], ['new-project-delivery', 'PARTIAL'], ['measured-reuse', 'NOT_RUN'],
    ['dependency-recovery', 'FAIL'], ['on-site', 'BLOCKED'],
  ])
  assert.deepEqual(manifest.denominators, { mechanism: 2, effect: 1, resilience: 1, field_admission: 1 })
})
