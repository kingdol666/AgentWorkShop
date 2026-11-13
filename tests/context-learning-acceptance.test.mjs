import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAcceptance } from '../scripts/acceptance-context-learning.mjs'

const options = (profile, seed = 'runner-test') => ({ profile, mode: 'simulation', seed, noNetwork: true })

test('context learning runner uses the same generic path for parameterized profiles', () => {
  const profileIds = ['pva', 'injection', 'wwtp', 'document-event', 'batch-material', 'service-workflow', 'simulation', 'custom-driver', 'all']
  for (const profile of profileIds) {
    const result = runAcceptance(options(profile))
    assert.equal(result.exitCode, 0, profile)
    assert.equal(result.report.acceptance.status, 'PASS', profile)
    assert.equal(result.report.execution.classification, 'simulation', profile)
    assert.equal(result.report.execution.physicalHIL.claim, false, profile)
    assert.equal(result.report.sideEffects.counters.physicalWrites, 0, profile)
    assert.ok(result.report.contextSnapshot.contentHash, profile)
    assert.ok(result.report.candidateEvidence.length > 0, profile)
    for (const evidence of result.report.candidateEvidence) {
      assert.equal(evidence.candidateOnly, true, profile)
      assert.equal(evidence.claimLevel, 'candidate', profile)
    }
  }
})

test('context learning runner is deterministic for a fixed seed', () => {
  const first = runAcceptance(options('injection', 'fixed-seed'))
  const second = runAcceptance(options('injection', 'fixed-seed'))
  assert.equal(first.exitCode, 0)
  assert.equal(second.exitCode, 0)
  assert.equal(first.report.acceptanceFingerprint, second.report.acceptanceFingerprint)
  assert.deepEqual(first.report.candidateEvidence, second.report.candidateEvidence)
})

test('physical-HIL classification is explicit and blocked without a physical claim', () => {
  const result = runAcceptance({ ...options('pva'), mode: 'physical-hil' })
  assert.equal(result.exitCode, 2)
  assert.equal(result.report.acceptance.status, 'BLOCKED')
  assert.equal(result.report.execution.classification, 'physical-hil')
  assert.equal(result.report.execution.physicalHIL.executed, false)
  assert.equal(result.report.execution.physicalHIL.claim, false)
  assert.match(result.report.acceptance.errors[0], /not available/i)
})
