/**
 * G4 工具面授权(C15/A21):
 *  - optimizer 门控:legacy/训练档位拒绝;无绑定拒绝 solve;capabilities 允许无绑定;
 *  - REST Agent 归属:非成员 403,admin/成员放行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { optimizerDispatchGate } from '../server/services/workshop/agents/host-tool-bridge/optimizer-gate'
import { assertAgentAccess } from '../server/services/workshop/optimization/rest-auth'

test('optimizer 门控:legacy/训练/无绑定一律拒绝(非未知工具)', () => {
  assert.equal(optimizerDispatchGate({ toolName: 'optimizer_solve', twinKind: 'legacy', bindingCount: 1 }).code, 'OPTIMIZER_CHANNEL_DISABLED')
  assert.equal(optimizerDispatchGate({ toolName: 'optimizer_solve', twinKind: 'aml_training', bindingCount: 1 }).code, 'OPTIMIZER_PROFILE_DENIED')
  assert.equal(optimizerDispatchGate({ toolName: 'optimizer_solve', twinKind: 'aml_optimization', bindingCount: 0 }).code, 'BINDING_NOT_FOUND')
  assert.equal(optimizerDispatchGate({ toolName: 'optimizer_capabilities', twinKind: 'aml_optimization', bindingCount: 0 }).allowed, true)
  assert.equal(optimizerDispatchGate({ toolName: 'optimizer_solve', twinKind: 'hybrid_twin', bindingCount: 1 }).allowed, true)
})

interface FakeUser { id: string, name: string, role: 'admin' | 'user' | 'editor' }
const fakeUser = (role: FakeUser['role']): FakeUser => ({ id: 'u1', name: 'u', role })

test('REST Agent 归属:非成员 403;admin 放行;成员放行;不存在 404', () => {
  const g = globalThis as { __workshopManager?: unknown }
  const saved = g.__workshopManager
  g.__workshopManager = {
    deps: { repos: { channelAgents: { findById: (id: string) => (id === 'ca-1' ? { channelId: 'ch-1' } : undefined) } } },
    channelPermissionsOf: (_channelId: string, user: FakeUser) => ({ isMember: user.id === 'member' }),
  }
  try {
    assert.deepEqual(assertAgentAccess(fakeUser('admin') as never, 'ca-1'), { channelId: 'ch-1' })
    assert.deepEqual(assertAgentAccess({ id: 'member', name: 'm', role: 'user' } as never, 'ca-1'), { channelId: 'ch-1' })
    assert.throws(() => assertAgentAccess(fakeUser('editor') as never, 'ca-1'), (err: { status?: number, code?: string }) => err.status === 403 && err.code === 'SCOPE_VIOLATION')
    assert.throws(() => assertAgentAccess(fakeUser('admin') as never, 'ca-x'), (err: { status?: number }) => err.status === 404)
  }
  finally {
    g.__workshopManager = saved
  }
})
