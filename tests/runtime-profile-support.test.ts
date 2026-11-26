import assert from 'node:assert/strict'
import { test } from 'node:test'

const { profileSupportOf, effortSettingKeyOf } = await import('../server/services/workshop/agent-prefabs/profile')

test('profileSupportOf reflects each harness native selector support', () => {
  assert.deepEqual(profileSupportOf('omp'), { provider: true, model: true, effort: true })
  assert.deepEqual(profileSupportOf('codex'), { provider: false, model: true, effort: true })
  assert.deepEqual(profileSupportOf('claude'), { provider: false, model: true, effort: false })
  assert.deepEqual(profileSupportOf('mock'), { provider: false, model: false, effort: false })
  assert.deepEqual(profileSupportOf('not-a-harness'), { provider: false, model: false, effort: false })
})

test('effortSettingKeyOf maps native effort aliases and leaves codex/others unmapped', () => {
  assert.equal(effortSettingKeyOf('omp'), 'thinkingLevel')
  assert.equal(effortSettingKeyOf('opencode'), 'variant')
  assert.equal(effortSettingKeyOf('pi'), 'thinking')
  assert.equal(effortSettingKeyOf('codex'), undefined)
  assert.equal(effortSettingKeyOf('gemini'), undefined)
})
