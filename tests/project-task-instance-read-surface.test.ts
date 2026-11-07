/**
 * 任务实例读面对称回归（2026-11-07 运行时审查 P1-4）：
 *
 * 提交侧早已接受「工作项模板频道 || 任务实例频道」双通道（agentSubmitResult），
 * 但读面（agentProjectBrief / agentReadWorkItems / agentReadResults）只比模板
 * channelId → 任务实例 lead 的 brief/工作项/成果读面恒为空集，导致实例内的
 * L1 自检、成果复核与工作项认知全部失明。
 *
 * 本回归锁定：实例频道成员能认领本工作项与本成果；其他成员频道仍然看不到
 * 未批准的实例成果（读面放宽不放权）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createChannelSessionRepo } from '../server/services/workshop/db/channel-session.repo'
import { ProjectService } from '../server/services/workshop/projects/service'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'

interface CreatedInstance { channelId: string, sessionId: string, leadAgentId: string }

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const sessions = createChannelSessionRepo(db)
  const createdInstances: CreatedInstance[] = []

  const manager = {
    async createChannel(input: {
      name: string
      ownerUserId?: string | null
      leadAgent?: { name: string, harness: string, config?: Record<string, unknown>, agentKind?: 'channel_agent' | 'project_leader' }
    }) {
      const ch = channels.create({ name: input.name, ownerUserId: input.ownerUserId ?? null })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({
          channelId: ch.id,
          templateId: null,
          name: input.leadAgent.name,
          harness: input.leadAgent.harness,
          config: input.leadAgent.config,
          role: 'lead',
          agentKind: input.leadAgent.agentKind ?? 'channel_agent',
        })
        channels.update(ch.id, { leadAgentId: inst.id, enabled: 1 })
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
    async getChannel(id: string) {
      return channels.findById(id) ?? null
    },
    async submitProjectRoot(input: {
      projectId: string
      workItemId: string
      attemptNo: number
      sourceKey: string
      traceId?: string
      channelId: string
      sessionId?: string
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
        sessionId: input.sessionId,
      })
      return { task: { id: row.id } as never, created: true }
    },
    /** 任务实例创建最小子集：Channel + 实例 lead + 任务会话行（service 负责项目绑定）。 */
    async createTaskInstance(input: { projectId: string, workItemId: string, templateChannelId: string, title: string }) {
      const ch = channels.create({ name: `任务实例-${createdInstances.length + 1}`, ownerUserId: 'u-1' })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      const lead = agents.create({
        channelId: ch.id,
        templateId: null,
        name: '实例Lead',
        harness: 'mock',
        role: 'lead',
        agentKind: 'channel_agent',
      })
      channels.update(ch.id, { leadAgentId: lead.id, enabled: 1 })
      const s = sessions.create({
        channelId: ch.id,
        title: input.title,
        memberMap: { [lead.id]: lead.id },
        projectId: input.projectId,
        projectWorkItemId: input.workItemId,
        createdByKind: 'project',
        instanceKind: 'task',
      })
      createdInstances.push({ channelId: ch.id, sessionId: s.id, leadAgentId: lead.id })
      return { channelId: ch.id, sessionId: s.id, members: [{ id: lead.id }], leadAgentId: lead.id }
    },
    async closeChannelSession(input: { sessionId: string }) {
      sessions.close(input.sessionId)
    },
  } as unknown as AgentChannelManager

  return { db, manager, channels, agents, tasks, createdInstances }
}

async function prepare(f: ReturnType<typeof fixture>) {
  const svc = new ProjectService(f.manager, f.db)
  const owner = { id: 'u-1', role: 'user' as const }
  const p = await svc.create({ name: '读面对称项目', objective: '验证任务实例读面', planApprovalRequired: 0 }, owner)
  const member = await f.manager.createChannel({
    name: '执行频道',
    ownerUserId: 'u-1',
    leadAgent: { name: 'Lead', harness: 'mock', agentKind: 'channel_agent' },
  })
  svc.bindChannel(p.id, member.channelId, owner)
  const d = svc.createDeliverable(p.id, owner, { name: '实例交付物', ownerChannelId: member.channelId })
  const w = svc.createWorkItem(p.id, owner, {
    deliverableId: d.id,
    channelId: member.channelId,
    title: '实例工作项',
    brief: '产出实例成果',
    execBudgetMinutes: 60,
    dedupeKey: 'read-surface',
  })
  svc.activate(p.id, owner)
  await svc.dispatchWorkItem(p.id, w.id, owner)
  return { svc, owner, p, w, member }
}

test('R-1 任务实例 lead 的 brief/工作项/成果读面命中本工作项（此前恒空集）', async () => {
  const f = fixture()
  try {
    const { svc, p, w, member } = await prepare(f)
    const inst = f.createdInstances[0]!
    const attempt = (svc as unknown as { attempts: { findLiveByWorkItem(id: string): { attemptNo: number, channelTaskId: string | null } | undefined } })
      .attempts.findLiveByWorkItem(w.id)!
    const result = (svc as unknown as { results: { create(input: Record<string, unknown>): { id: string } } })
      .results.create({
        projectId: p.id,
        deliverableId: w.deliverableId,
        channelId: w.channelId,
        workItemId: w.id,
        attemptNo: attempt.attemptNo,
        resultKey: w.resultKey,
        version: 1,
        title: '实例成果',
        summary: '实例成果摘要',
        status: 'draft',
        sourceTaskId: attempt.channelTaskId,
        authorAgentId: inst.leadAgentId,
        traceId: w.traceId,
      })

    const items = svc.agentReadWorkItems(inst.leadAgentId)
    assert.equal(items.length, 1, '实例 lead 只看到本实例的工作项')
    assert.equal(items[0]!.id, w.id)

    const brief = svc.agentProjectBrief(inst.leadAgentId)
    assert.equal(brief.workItems.length, 1, 'brief 注入面同样认领实例工作项')
    assert.equal(brief.workItems[0]!.id, w.id)

    const results = svc.agentReadResults(inst.leadAgentId)
    assert.ok(results.some(r => r.id === result.id), '实例 lead 能读到自己工作项的 draft 成果（L1 自检前提）')

    // 模板频道 lead 仍按原口径看到本频道工作项/成果（不放宽也不收紧）
    assert.ok(svc.agentReadWorkItems(member.leadAgentId!).some(i => i.id === w.id), '模板频道 lead 读面保持')
    assert.ok(svc.agentReadResults(member.leadAgentId!).some(r => r.id === result.id), '模板频道 lead 成果读面保持')
  }
  finally { f.db.close() }
})

test('R-2 其他成员频道看不到实例的未批准成果与工作项（读面放宽不放权）', async () => {
  const f = fixture()
  try {
    const { svc, owner, p, w } = await prepare(f)
    const inst = f.createdInstances[0]!
    const attempt = (svc as unknown as { attempts: { findLiveByWorkItem(id: string): { attemptNo: number, channelTaskId: string | null } | undefined } })
      .attempts.findLiveByWorkItem(w.id)!
    const result = (svc as unknown as { results: { create(input: Record<string, unknown>): { id: string } } })
      .results.create({
        projectId: p.id,
        deliverableId: w.deliverableId,
        channelId: w.channelId,
        workItemId: w.id,
        attemptNo: attempt.attemptNo,
        resultKey: w.resultKey,
        version: 1,
        title: '实例成果',
        summary: '实例成果摘要',
        status: 'draft',
        sourceTaskId: attempt.channelTaskId,
        authorAgentId: inst.leadAgentId,
        traceId: w.traceId,
      })
    const other = await f.manager.createChannel({
      name: '旁观频道',
      ownerUserId: 'u-1',
      leadAgent: { name: '旁观Lead', harness: 'mock', agentKind: 'channel_agent' },
    })
    svc.bindChannel(p.id, other.channelId, owner)
    assert.equal(svc.agentReadWorkItems(other.leadAgentId!).length, 0, '他频道工作项读面仍为空')
    assert.equal(svc.agentReadResults(other.leadAgentId!).some(r => r.id === result.id), false, '他频道读不到未批准实例成果')
  }
  finally { f.db.close() }
})
