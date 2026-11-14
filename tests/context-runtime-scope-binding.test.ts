/**
 * RSI Beta 宿主权威 scope 绑定回归(2026-11-14 P0/P1):
 *  ① resolveScopeBinding 从持久宿主记录推导授权(kv 不再是授权前提);
 *  ② normalizeScope 对未知非空字段 fail-closed(跨 tenant/subject 不再静默丢弃);
 *  ③ 频道绑线只读面并入 lineIds(与 agentOpsScope 同源)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'

const { createContextRuntimeService } = await import('@/server/services/workshop/context/runtime')

type Scope = { workspaceId: string, channelId: string, workerId: string }

/** 最小 repos 桩:workspace 挂载 + channel 启用/绑线 + worker 启用/角色/成员 */
function makeRepos(opts: {
  mounted?: boolean
  channelEnabled?: number
  channelLineId?: string
  workerEnabled?: number
  workerRole?: string
  ownerUserId?: string
  memberOfPrincipal?: boolean
} = {}) {
  const workspace = { id: 'ws-1', ownerUserId: opts.ownerUserId ?? 'owner-1' }
  void workspace
  const channel = { id: 'ch-1', enabled: opts.channelEnabled ?? 1, ownerUserId: 'owner-1', lineId: opts.channelLineId ?? '' }
  const worker = { id: 'worker-1', enabled: opts.workerEnabled ?? 1, role: opts.workerRole ?? 'worker' }
  const mounted = opts.mounted ?? true
  const member = opts.memberOfPrincipal ?? false
  return {
    users: {
      getWorkspace: () => ({ id: 'ws-1', ownerUserId: 'owner-1' }),
      listMountedChannels: () => (mounted ? ['ch-1'] : []),
    },
    channels: { findById: () => channel },
    channelAgents: { findByChannelAgent: () => worker },
    channelMembers: { isActiveMember: () => member },
  }
}

const owner = { id: 'owner-1', role: 'user' }
const scope: Scope = { workspaceId: 'ws-1', channelId: 'ch-1', workerId: 'worker-1' }

test('resolveScopeBinding:部署面 + 属主成立 → ok;频道绑线并入 boundLineIds', () => {
  const runtime = createContextRuntimeService({ repos: makeRepos({ channelLineId: 'ln-9' }) as never })
  const binding = runtime.resolveScopeBinding({ principal: owner, scope })
  assert.equal(binding.ok, true)
  if (binding.ok) {
    assert.deepEqual(binding.scope, scope)
    assert.ok(binding.boundLineIds.includes('ln-9'), '频道绑线必须出现在 boundLineIds(即使 worker 无节点绑定)')
    assert.equal(binding.channelLineId, 'ln-9')
  }
})

test('resolveScopeBinding:未挂载/停用频道/停用 worker/非 worker 角色 → 一律拒绝', () => {
  for (const opts of [
    { mounted: false },
    { channelEnabled: 0 },
    { workerEnabled: 0 },
    { workerRole: 'lead' },
  ]) {
    const runtime = createContextRuntimeService({ repos: makeRepos(opts) as never })
    const binding = runtime.resolveScopeBinding({ principal: owner, scope })
    assert.equal(binding.ok, false, `case=${JSON.stringify(opts)} 必须 fail-closed`)
  }
})

test('resolveScopeBinding:非属主且非成员拒绝;成员放行;admin 放行', () => {
  const memberRuntime = createContextRuntimeService({ repos: makeRepos({ memberOfPrincipal: true }) as never })
  const member = { id: 'member-1', role: 'user' }
  assert.equal(memberRuntime.resolveScopeBinding({ principal: member, scope }).ok, true)

  const outsiderRuntime = createContextRuntimeService({ repos: makeRepos() as never })
  const outsider = { id: 'outsider', role: 'user' }
  assert.equal(outsiderRuntime.resolveScopeBinding({ principal: outsider, scope }).ok, false)

  const adminRuntime = createContextRuntimeService({ repos: makeRepos() as never })
  assert.equal(adminRuntime.resolveScopeBinding({ principal: { id: 'a', role: 'admin' }, scope }).ok, true)
})

test('normalizeScope:未知非空字段(tenantId 等)fail-closed 拒绝;空值字段容忍', () => {
  const runtime = createContextRuntimeService({ repos: makeRepos() as never })
  const foreignTenant = { ...scope, tenantId: 'tenant-evil' }
  assert.equal(runtime.resolveScopeBinding({ principal: owner, scope: foreignTenant }).ok, false, '跨 tenant 字段必须拒绝而非静默丢弃')
  const foreignSubject = { ...scope, subjectRefs: ['subject-evil'] }
  assert.equal(runtime.resolveScopeBinding({ principal: owner, scope: foreignSubject }).ok, false, '跨 subject 字段必须拒绝')
  const withEmpty = { ...scope, tenantId: '', lineIds: [] }
  assert.equal(runtime.resolveScopeBinding({ principal: owner, scope: withEmpty }).ok, true, '空值字段容忍(视为未声明)')
})
