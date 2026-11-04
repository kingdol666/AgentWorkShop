/**
 * Project 核心 PR3：ProjectService（办公室频道 + 生命周期 + 成员绑定）+ 能力矩阵。
 * 使用内存 DB + 最小 manager stub，不启动真实 AgentRuntime/SchedulerLoop。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createProjectDeliverableRepo } from '../server/services/workshop/db/project.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { TaskEngine } from '../server/services/workshop/runtime/task-engine'
import { ProjectService } from '../server/services/workshop/projects/service'
import { capabilitiesFor, isProjectLeaderIdentity } from '../server/services/workshop/agents/role-capabilities'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const manager = {
    async createChannel(input: {
      name: string
      description?: string
      scenarioPrompt?: string
      leadAgent?: { name: string, harness: string, config?: Record<string, unknown>, agentKind?: 'channel_agent' | 'project_leader' }
      ownerUserId?: string | null
    }) {
      const ch = channels.create({ name: input.name, description: input.description, scenarioPrompt: input.scenarioPrompt, ownerUserId: input.ownerUserId ?? null })
      const workspace = `data/workspaces/${ch.id}`
      channels.update(ch.id, { workspace })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({
          channelId: ch.id,
          templateId: null,
          name: input.leadAgent.name,
          harness: input.leadAgent.harness,
          config: input.leadAgent.config,
          role: 'lead',
          agentKind: input.leadAgent.agentKind,
        })
        channels.update(ch.id, { leadAgentId: inst.id })
        leadAgentId = inst.id
      }
      return { channelId: ch.id, leadAgentId, workspace }
    },
    async updateChannel(id: string, patch: Record<string, unknown>) {
      return channels.update(id, patch as never)!
    },
    getChannelForUser(id: string) {
      const ch = channels.findById(id)
      return ch ? { ...ch, agents: [] } : null
    },
    async submitProjectRoot(input: {
      projectId: string
      workItemId: string
      attemptNo: number
      sourceKey: string
      traceId?: string
      channelId: string
      title: string
      description?: string
      execBudgetMinutes?: number
    }) {
      const ch = channels.findById(input.channelId)!
      const row = tasks.create({
        channelId: input.channelId,
        creatorId: `project:${input.projectId}`,
        assigneeId: ch.leadAgentId!,
        title: input.title,
        description: input.description,
        sourceChatMessageId: input.sourceKey,
        deadlineAt: new Date(Date.now() + (input.execBudgetMinutes ?? 60) * 60_000).toISOString(),
        source: 'project',
        projectId: input.projectId,
        projectWorkItemId: input.workItemId,
        projectAttemptNo: input.attemptNo,
        traceId: input.traceId,
      })
      return { task: { id: row.id } as never, created: true }
    },
  } as unknown as AgentChannelManager
  return { db, channels, agents, tasks, manager }
}

test('role capabilities: project_leader 只拿项目读/提案，不拿 Channel lead 工具', () => {
  const pl = capabilitiesFor('lead', 'project_leader', 'project_office')
  assert.equal(pl.projectLeader, true)
  assert.equal(pl.channelLead, false)
  assert.equal(pl.seesChannelLeadTools, false)
  assert.equal(pl.seesProjectProposeTools, true)
  assert.equal(pl.seesProjectSubmitTool, false)
  assert.equal(pl.industrialWrite, 'none')
  assert.equal(pl.idleUnloadExempt, true)
  assert.equal(pl.ownsChannelScheduler, false)

  const lead = capabilitiesFor('lead', 'channel_agent', 'normal')
  assert.equal(lead.channelLead, true)
  assert.equal(lead.seesChannelLeadTools, true)
  assert.equal(lead.seesProjectSubmitTool, true)
  assert.equal(lead.ownsChannelScheduler, true)

  const worker = capabilitiesFor('worker', 'channel_agent', 'normal')
  assert.equal(worker.seesChannelLeadTools, false)
  assert.equal(worker.seesProjectReadTools, true)
  assert.equal(worker.seesProjectSubmitTool, false)

  assert.equal(isProjectLeaderIdentity('lead', 'project_leader'), true)
  assert.equal(isProjectLeaderIdentity('worker', 'project_leader'), false)
})

test('ProjectService: create → 办公室 + project_leader；绑定/激活/暂停/恢复/归档', async () => {
  const { db, channels, agents, manager } = fixture()
  try {
    const svc = new ProjectService(manager, db)
    const owner = { id: 'u-1', role: 'user' }
    const p = await svc.create({ name: '良率提升', objective: '把 A 线良率提升到 98%' }, owner)
    assert.equal(p.status, 'draft')
    assert.ok(p.officeChannelId)
    assert.ok(p.leadAgentId)

    const office = channels.findById(p.officeChannelId!)!
    assert.equal(office.ownerUserId, 'u-1')
    assert.equal(office.chatEnabled, 1)
    const leader = agents.findById(p.leadAgentId!)!
    assert.equal(leader.role, 'lead')
    assert.equal(leader.agentKind, 'project_leader')

    // 成员 Channel（已有 lead）
    const member = await manager.createChannel({
      name: '数据分析', ownerUserId: 'u-1', actor: owner,
      leadAgent: { name: '数据 Lead', harness: 'mock', agentKind: 'channel_agent' },
    })
    const bound = svc.bindChannel(p.id, member.channelId, owner, '负责基线/质量')
    assert.equal(bound.status, 'active')
    assert.equal(svc.listChannels(p.id, owner).length, 1)

    // 激活需要至少一个必选交付物
    const deliverables = createProjectDeliverableRepo(db)
    deliverables.create({ projectId: p.id, name: '基线报告', ownerChannelId: member.channelId })
    const active = svc.activate(p.id, owner)
    assert.equal(active.status, 'active')

    // active 办公室受保护
    assert.throws(() => svc.assertOfficeChannelMutable(p.officeChannelId!), (e: unknown) => (e as { code?: string }).code === 'PROJECT_OFFICE_PROTECTED')
    assert.throws(() => svc.assertNotOfficeChannel(p.officeChannelId!), (e: unknown) => (e as { code?: string }).code === 'PROJECT_OFFICE_NOT_MEMBER')

    assert.equal(svc.pause(p.id, owner).status, 'paused')
    assert.equal(svc.resume(p.id, owner).status, 'active')
    assert.equal(svc.pause(p.id, owner).status, 'paused')
    assert.equal(svc.archive(p.id, owner).status, 'archived')
  }
  finally { db.close() }
})

test('ProjectService: 非 owner 不可读/改；同一 Channel 不能同时属于两个项目', async () => {
  const { db, manager } = fixture()
  try {
    const svc = new ProjectService(manager, db)
    const owner = { id: 'u-1', role: 'user' }
    const other = { id: 'u-2', role: 'user' }
    const p1 = await svc.create({ name: 'P1', objective: 'O1' }, owner)
    const p2 = await svc.create({ name: 'P2', objective: 'O2' }, owner)
    assert.throws(() => svc.get(p1.id, other), (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN')

    const member = await manager.createChannel({
      name: '共享分析', ownerUserId: 'u-1', actor: owner,
      leadAgent: { name: 'Lead', harness: 'mock', agentKind: 'channel_agent' },
    })
    svc.bindChannel(p1.id, member.channelId, owner)
    assert.throws(
      () => svc.bindChannel(p2.id, member.channelId, owner),
      (e: unknown) => (e as { code?: string }).code === 'CHANNEL_ALREADY_BOUND',
    )
    svc.unbindChannel(p1.id, member.channelId, owner)
    assert.equal(svc.bindChannel(p2.id, member.channelId, owner).status, 'active')
  }
  finally { db.close() }
})

test('ProjectService: 派发 root task + 项目上下文传播到子任务', async () => {
  const { db, manager, tasks } = fixture()
  try {
    const svc = new ProjectService(manager, db)
    const owner = { id: 'u-1', role: 'user' }
    const p = await svc.create({ name: '派发项目', objective: '验证派发' }, owner)
    const member = await manager.createChannel({
      name: '执行频道', ownerUserId: 'u-1', actor: owner,
      leadAgent: { name: 'Lead', harness: 'mock', agentKind: 'channel_agent' },
    })
    svc.bindChannel(p.id, member.channelId, owner)
    const d = svc.createDeliverable(p.id, owner, { name: '基线', ownerChannelId: member.channelId })
    const w = svc.createWorkItem(p.id, owner, {
      deliverableId: d.id, channelId: member.channelId, title: '建立基线',
      brief: '按验收标准输出', execBudgetMinutes: 60, dedupeKey: 'baseline',
    })
    svc.activate(p.id, owner)
    const dispatched = await svc.dispatchWorkItem(p.id, w.id, owner)
    assert.equal(dispatched.state, 'DISPATCHED')
    assert.ok(dispatched.currentAttemptId)

    const root = tasks.listRoots(member.channelId)[0]!
    assert.equal(root.source, 'project')
    assert.equal(root.projectId, p.id)
    assert.equal(root.projectWorkItemId, w.id)
    assert.equal(root.projectAttemptNo, 1)
    assert.ok(root.traceId)
    const budgetMs = new Date(root.deadlineAt!).getTime() - Date.now()
    assert.ok(budgetMs > 30 * 60_000, `deadline should use project budget, got ${budgetMs}ms`)

    await assert.rejects(
      () => svc.dispatchWorkItem(p.id, w.id, owner),
      (e: unknown) => (e as { code?: string }).code === 'WORK_ITEM_IN_FLIGHT',
    )

    // 子任务继承 project 上下文（project-origin 写策略/审计依赖）
    const engine = new TaskEngine({ tasks, messages: createMessageRepo(db) }, { onTaskChange: () => {} })
    const parent = engine.get(root.id)!
    const child = engine.dispatch(parent, { assigneeId: parent.assigneeId, title: '子任务' })
    assert.equal(child.source, 'project')
    assert.equal(child.projectId, p.id)
    assert.equal(child.projectWorkItemId, w.id)
    assert.equal(child.traceId, root.traceId)
  }
  finally { db.close() }
})
