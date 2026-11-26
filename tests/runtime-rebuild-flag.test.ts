import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { ManagerRuntimeWiring } from '../server/services/workshop/runtime/manager/runtime-wiring'

process.env.AGENTWORKSHOP_TEST = '1'

const key = (channelId: string, agentId: string): string => `${channelId}\u0000${agentId}`

function fixture(role: 'lead' | 'worker') {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const channel = channels.create({ name: 'rebuild' })
  const member = agents.create({ channelId: channel.id, templateId: null, name: role, harness: 'omp', role, config: {} })
  const manager = Object.create(ManagerRuntimeWiring.prototype) as Record<string, unknown>
  manager.deps = { db, repos: { channelAgents: agents } }
  manager.agentIndex = new Map([[key(channel.id, member.id), { getState: () => 'idle' }]])
  manager.appliedRuntimeRevisions = new Map([[key(channel.id, member.id), 0]])
  manager.pendingRuntimeRebuilds = new Map()
  return { db, channel, member, manager }
}

test('a pending rebuild forces the next-turn reload check for a wired worker', () => {
  const f = fixture('worker')
  try {
    const manager = f.manager as {
      requestRuntimeRebuild: (channelId: string, agentId: string, reason?: string) => boolean
      runtimeRevisionChanged: (channelId: string, agentId: string) => boolean
    }
    assert.equal(manager.runtimeRevisionChanged(f.channel.id, f.member.id), false)
    assert.equal(manager.requestRuntimeRebuild(f.channel.id, f.member.id, 'bindings'), true)
    assert.equal(manager.runtimeRevisionChanged(f.channel.id, f.member.id), true)
  }
  finally {
    f.db.close()
  }
})

test('rebuild requests are refused for leads and unwired runtimes', () => {
  const lead = fixture('lead')
  try {
    const manager = lead.manager as { requestRuntimeRebuild: (channelId: string, agentId: string) => boolean }
    assert.equal(manager.requestRuntimeRebuild(lead.channel.id, lead.member.id), false)
    assert.equal(manager.requestRuntimeRebuild(lead.channel.id, 'missing'), false)
  }
  finally {
    lead.db.close()
  }
})

test('hot swap clears the pending flag only after the new runtime is wired', () => {
  const source = readFileSync(new URL('../server/services/workshop/runtime/manager/runtime-wiring.ts', import.meta.url), 'utf8')
  const wireAt = source.indexOf('const fresh = this.wireMember(row)')
  const clearAt = source.indexOf('pendingRuntimeRebuilds?.delete(key)', wireAt)
  assert.ok(wireAt > 0 && clearAt > wireAt, 'pending flag must be cleared after a successful wire, so a failed wire retries next turn')
  const sourceSupervise = readFileSync(new URL('../server/services/workshop/runtime/agent-runtime/supervise.ts', import.meta.url), 'utf8')
  assert.match(sourceSupervise, /runtimeReloadRequested\?\.\(\)/)
  // 热切换不是消息执行失败：用 releaseClaim（不计 attempts），不能吃掉重试预算。
  assert.match(sourceSupervise, /releaseClaim\(msg\.messageId, claimToken\)/)
  assert.doesNotMatch(sourceSupervise, /requeue\(msg\.messageId, claimToken\)/)
  // 未安装新 runtime 时旧循环必须继续，不能退出成僵尸。
  assert.match(sourceSupervise, /swapped !== false/)
  // 热切换失败不得落回旧配置执行（claim 已释放），也不能空转：退避后 continue。
  assert.match(sourceSupervise, /热切换失败[\s\S]{0,400}?setTimeout\(resolve, 1000\)[\s\S]{0,80}?continue/)
})

test('omp exposes a live tool-surface refresh entry', () => {
  const source = readFileSync(new URL('../server/services/workshop/agents/omp-agent/helpers.ts', import.meta.url), 'utf8')
  assert.match(source, /export function refreshLiveOmpToolSurfaces\(\)/)
})
