import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ManagerRuntimeWiring } from '../server/services/workshop/runtime/manager/runtime-wiring'

const key = 'ch-scope\u0000ag-scope'

function managerWith(fingerprint: string) {
  const manager = Object.create(ManagerRuntimeWiring.prototype) as Record<string, unknown>
  manager.agentIndex = new Map([[key, { getState: () => 'idle' }]])
  manager.appliedRuntimeRevisions = new Map([[key, 0]])
  manager.appliedScopeFingerprints = new Map([[key, 'fp-old']])
  manager.pendingRuntimeRebuilds = new Map()
  manager.sessionRuntimeRevisionOf = () => 0
  manager.sessionScopeFingerprintOf = () => fingerprint
  return manager as {
    runtimeRevisionChanged: (channelId: string, agentId: string) => boolean
  }
}

test('a changed session scope fingerprint forces the next-turn hot reload', () => {
  assert.equal(managerWith('fp-new').runtimeRevisionChanged('ch-scope', 'ag-scope'), true)
  assert.equal(managerWith('fp-old').runtimeRevisionChanged('ch-scope', 'ag-scope'), false)
})

test('the fingerprint check is skipped when no fingerprint was ever applied', () => {
  const manager = Object.create(ManagerRuntimeWiring.prototype) as Record<string, unknown>
  manager.agentIndex = new Map([[key, { getState: () => 'idle' }]])
  manager.appliedRuntimeRevisions = new Map([[key, 0]])
  manager.appliedScopeFingerprints = new Map()
  manager.pendingRuntimeRebuilds = new Map()
  manager.sessionRuntimeRevisionOf = () => 0
  manager.sessionScopeFingerprintOf = () => 'fp-new'
  const api = manager as { runtimeRevisionChanged: (c: string, a: string) => boolean }
  assert.equal(api.runtimeRevisionChanged('ch-scope', 'ag-scope'), false)
})
