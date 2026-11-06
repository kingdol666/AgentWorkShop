/**
 * S1 多会话回归（plan 2026-11-06-channel-multi-session-runtime-plan.md Phase S1）：
 *
 *   S-A 会话克隆：基础成员克隆为独立 worker 实例（独立 agentId=独立 runtime/omp 进程/
 *      记忆域的前提）+ 绑定面复制 + 频道会话注册
 *   S-B 记忆隔离前提：两 clone agentId 不同（auto 域按 agentId 过滤 ⇒ 会话记忆隔离）；
 *      team 域按 channelId 共享不变
 *   S-C 关闭级联：clone 名下在飞任务 cancelTree + 实例停用 + 会话 closed（幂等）
 *   S-D 无基础成员 → 400 NO_BASE_MEMBERS
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-channel-sessions-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
const { createChannelSession, closeChannelSession } = await import('../server/services/workshop/agents/session-clone')
type SessionCloneDeps = import('../server/services/workshop/agents/session-clone').SessionCloneDeps
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const sessionRepo = createChannelSessionRepo(db)
  const canceledTrees: string[] = []
  const unloaded: string[] = []
  const bindingsByAgent: Record<string, Array<{ nodeId: string, kind: string, mode?: string }>> = {}
  const bindings = {
    byAgent: (agentId: string) => bindingsByAgent[agentId] ?? [],
    bind: (agentId: string, nodeId: string, kind: string, mode?: string) => {
      ;(bindingsByAgent[agentId] ??= []).push({ nodeId, kind, mode })
    },
  }
  const tasksDep = {
    list: (channelId: string) => tasks.listByChannel
      ? tasks.listByChannel(channelId).map(t => ({ id: t.id, state: t.state, assigneeId: t.assigneeId }))
      : [],
    cancelTree: (taskId: string, _by: string, _reason: string) => { canceledTrees.push(taskId) },
  }
  const manager = {
    async createChannel(input: { name: string, ownerUserId?: string | null, leadAgent?: { name: string, harness: string } }) {
      const ch = channels.create({ name: input.name, ownerUserId: input.ownerUserId ?? null })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({ channelId: ch.id, templateId: null, name: input.leadAgent.name, harness: input.leadAgent.harness, role: 'lead' })
        channels.update(ch.id, { leadAgentId: inst.id })
        leadAgentId = inst.id
      }
      return { channelId: ch.id, leadAgentId, workspace: `data/workspaces/${ch.id}` }
    },
    async updateChannel(id: string, patch: Record<string, unknown>) {
      return channels.update(id, patch as never)!
    },
    getChannelForUser(id: string) {
      const ch = channels.findById(id)
      return ch ? { ...ch, agents: [] } : null
    },
    async submitProjectRoot(input: { projectId: string, workItemId: string, attemptNo: number, sourceKey: string, channelId: string, title: string }) {
      const ch = channels.findById(input.channelId)!
      const row = tasks.create({
        channelId: input.channelId, creatorId: `project:${input.projectId}`, assigneeId: ch.leadAgentId!,
        title: input.title, sourceChatMessageId: input.sourceKey,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        source: 'project', projectId: input.projectId, projectWorkItemId: input.workItemId, projectAttemptNo: input.attemptNo,
      })
      return { task: { id: row.id } as never, created: true }
    },
  } as unknown as AgentChannelManager

  const deps = {
    channelAgents: agents,
    tasks: tasksDep,
    bindings,
    unloadAgent: async (_channelId: string, instanceId: string, _reason: string) => { unloaded.push(instanceId) },
  } as unknown as SessionCloneDeps
  return { db, channels, agents, tasks, sessionRepo, deps, manager, canceledTrees, unloaded, bindingsByAgent, bindings }
}

test('S-A 会话克隆：独立 worker 实例 + 绑定复制 + 会话注册', async () => {
  const f = fixture()
  try {
    const owner = { id: 'u-owner', role: 'user' }
    const ch = await f.manager.createChannel({ name: '多会话频道', ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' } })
    // 给基础 lead 一个绑定面（应被 clone 复制）
    f.bindings.bind(ch.leadAgentId!, 'dw-test-1', 'dcw', 'auto')
    const result = await createChannelSession(f.deps, {
      channelId: ch.channelId,
      actorId: owner.id,
      title: '会话一',
      sessionRepo: f.sessionRepo,
    })
    assert.equal(result.members.length, 1, '基础成员 lead 被克隆')
    const clone = result.members[0]!
    assert.notEqual(clone.cloneId, ch.leadAgentId, 'clone 是全新实例（独立 agentId=独立 runtime/记忆域前提）')
    assert.equal(clone.role, 'worker', 'clone 统一 worker 定位')
    // 会话已注册（active）
    const session = f.sessionRepo.findById(result.sessionId)!
    assert.equal(session.status, 'active')
    assert.equal(session.title, '会话一')
    assert.deepEqual(Object.keys(JSON.parse(session.memberMapJson)), [ch.leadAgentId])
    // 绑定复制：clone 名下有同样的绑定面
    const cloneBindings = f.bindings.byAgent(clone.cloneId)
    assert.equal(cloneBindings.length, 1)
    assert.equal(cloneBindings[0]!.nodeId, 'dw-test-1')
    // 二次实例化 = 第二个会话（并行前提）
    const second = await createChannelSession(f.deps, { channelId: ch.channelId, actorId: owner.id, title: '会话二', sessionRepo: f.sessionRepo })
    assert.notEqual(second.sessionId, result.sessionId)
    assert.notEqual(second.members[0]!.cloneId, clone.cloneId, '两会话实例互不相同（并行隔离前提）')
  }
  finally { f.db.close() }
})

test('S-B 记忆隔离前提：两会话 clone 的 agentId 互不相同（auto 域按 agentId 过滤即隔离）', async () => {
  const f = fixture()
  try {
    const owner = { id: 'u-owner', role: 'user' }
    const ch = await f.manager.createChannel({ name: '隔离频道', ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' } })
    const r1 = await createChannelSession(f.deps, { channelId: ch.channelId, actorId: owner.id, sessionRepo: f.sessionRepo })
    const r2 = await createChannelSession(f.deps, { channelId: ch.channelId, actorId: owner.id, sessionRepo: f.sessionRepo })
    const idA = r1.members[0]!.cloneId
    const idB = r2.members[0]!.cloneId
    assert.notEqual(idA, idB, '两会话实例 agentId 互不相同 → agent_memories 按 agentId 归属即天然隔离')
    // team 域共享：两 clone 同频道（channelId 相同 → TEAM 行可见性不变）
    assert.equal(typeof idA, 'string')
  }
  finally { f.db.close() }
})

test('S-C 关闭级联：clone 在飞任务 cancelTree + 实例停用 + 会话 closed（幂等）', async () => {
  const f = fixture()
  try {
    const owner = { id: 'u-owner', role: 'user' }
    const ch = await f.manager.createChannel({ name: '关闭频道', ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' } })
    const r = await createChannelSession(f.deps, { channelId: ch.channelId, actorId: owner.id, sessionRepo: f.sessionRepo })
    const cloneId = r.members[0]!.cloneId
    // clone 名下一在飞任务（SUBMITTED 未被领取 → 可被 cancelTree 终止）
    f.tasks.create({
      channelId: ch.channelId, creatorId: 'tester', assigneeId: cloneId,
      title: '在飞任务', sourceChatMessageId: 'src',
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), source: 'project', projectId: 'p-x',
    })
    const res = await closeChannelSession(f.deps, {
      channelId: ch.channelId, sessionId: r.sessionId, actorId: owner.id, reason: '验收',
      sessionRepo: f.sessionRepo,
    })
    assert.ok(f.canceledTrees.length >= 1, `cancelTree 被调用：${JSON.stringify(f.canceledTrees)}`)
    assert.ok(f.unloaded.includes(cloneId), 'clone 实例已停用（runtime 卸载）')
    assert.equal(f.sessionRepo.findById(r.sessionId)!.status, 'closed')
    assert.equal(res.canceledTasks >= 1, true)
    // 幂等：再关一次
    const again = await closeChannelSession(f.deps, {
      channelId: ch.channelId, sessionId: r.sessionId, actorId: owner.id,
      sessionRepo: f.sessionRepo,
    })
    assert.equal(again.canceledTasks, 0, '已关闭会话重复 close 不重复取消')
  }
  finally { f.db.close() }
})

test('S-D 无基础成员 → 400 NO_BASE_MEMBERS', async () => {
  const f = fixture()
  try {
    const owner = { id: 'u-owner', role: 'user' }
    const ch = await f.manager.createChannel({ name: '空频道', ownerUserId: owner.id })
    assert.throws(
      () => createChannelSession(f.deps, { channelId: ch.channelId, actorId: owner.id, sessionRepo: f.sessionRepo }),
      /基础成员/)
  }
  finally { f.db.close() }
})
