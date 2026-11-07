/**
 * PR14：plan §7.1 API 补全回归（update×3 / retry / snapshot / trace / 审批历史）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-project-api-completion-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const manager = {
    async createChannel(input: {
      name: string
      leadAgent?: { name: string, harness: string, agentKind?: 'channel_agent' | 'project_leader' }
      ownerUserId?: string | null
      scenarioPrompt?: string
    }) {
      const ch = channels.create({ name: input.name, scenarioPrompt: input.scenarioPrompt, ownerUserId: input.ownerUserId ?? null })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({
          channelId: ch.id, templateId: null, name: input.leadAgent.name, harness: input.leadAgent.harness,
          role: 'lead', agentKind: input.leadAgent.agentKind,
        })
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
        channelId: input.channelId, creatorId: `project:${input.projectId}`, assigneeId: ch.leadAgentId!,
        title: input.title, description: input.description, sourceChatMessageId: input.sourceKey,
        deadlineAt: new Date(Date.now() + (input.execBudgetMinutes ?? 60) * 60_000).toISOString(),
        source: 'project', projectId: input.projectId, projectWorkItemId: input.workItemId,
        projectAttemptNo: input.attemptNo, traceId: input.traceId,
      })
      return { task: { id: row.id } as never, created: true }
    },
  } as unknown as AgentChannelManager
  const svc = initProjectService(manager, db)
  return { db, channels, agents, tasks, manager, svc }
}

async function setup() {
  const f = fixture()
  const owner = { id: 'u-owner', role: 'user' }
  const p = await f.svc.create({ name: 'API 补全项目', objective: 'plan §7.1', planApprovalRequired: 0 }, owner)
  const member = await f.manager.createChannel({
    name: '执行频道', ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' },
  })
  f.svc.bindChannel(p.id, member.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: '交付物', ownerChannelId: member.channelId })
  const w = f.svc.createWorkItem(p.id, owner, {
    deliverableId: d.id, channelId: member.channelId, title: '工作项', brief: 'x', dedupeKey: 'api-flow',
  })
  f.svc.activate(p.id, owner)
  return { ...f, owner, p, member, d, w }
}

test('PATCH 项目：owner 更新基本信息生效 + 审计落库；viewer 403', async () => {
  const s = await setup()
  try {
    s.svc.addMember(s.p.id, s.owner, { userId: 'u-v', role: 'viewer' })
    assert.throws(
      () => s.svc.updateProject(s.p.id, { id: 'u-v', role: 'user' }, { name: 'X' }),
      (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN',
    )
    const next = s.svc.updateProject(s.p.id, s.owner, { name: 'API 补全项目 V2', mode: 'observe' })
    assert.equal(next.name, 'API 补全项目 V2')
    assert.equal(next.mode, 'observe')
    assert.ok(s.svc.listDecisions(s.p.id, s.owner).some(d => d.decisionType === 'project.updated'))
    // reviewerChannelId 传空串必须真正删除 config 键（JSON.stringify 会丢 undefined）
    s.svc.updateProject(s.p.id, s.owner, { reviewerChannelId: s.member.channelId })
    assert.equal(JSON.parse(s.svc.get(s.p.id, s.owner).configJson).reviewerChannelId, s.member.channelId)
    s.svc.updateProject(s.p.id, s.owner, { reviewerChannelId: '' })
    assert.equal('reviewerChannelId' in JSON.parse(s.svc.get(s.p.id, s.owner).configJson), false)
    assert.throws(
      () => s.svc.updateProject(s.p.id, s.owner, { name: '  ' }),
      (e: unknown) => (e as { code?: string }).code === 'BAD_REQUEST',
    )
  }
  finally {
    s.db.close()
  }
})

test('PATCH 交付物/工作项：状态门 + 字段生效', async () => {
  const s = await setup()
  try {
    const d2 = s.svc.updateDeliverableItem(s.p.id, s.d.id, s.owner, {
      name: '交付物 V2', required: false, acceptanceCriteria: ['c1'],
    })
    assert.equal(d2.name, '交付物 V2')
    assert.equal(d2.required, 0)
    const w2 = s.svc.updateWorkItem(s.p.id, s.w.id, s.owner, { title: '工作项 V2', execBudgetMinutes: 90, dependsOn: [] })
    assert.equal(w2.title, '工作项 V2')
    assert.equal(w2.execBudgetMinutes, 90)
    // 参数校验（DRAFT 态）
    assert.throws(
      () => s.svc.updateWorkItem(s.p.id, s.w.id, s.owner, { execBudgetMinutes: 0 }),
      (e: unknown) => (e as { code?: string }).code === 'BAD_REQUEST',
    )
    // 派发后契约锁定
    await s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
    assert.throws(
      () => s.svc.updateWorkItem(s.p.id, s.w.id, s.owner, { title: 'X' }),
      (e: unknown) => (e as { code?: string }).code === 'WORK_ITEM_STATE_INVALID',
    )
  }
  finally {
    s.db.close()
  }
})

test('retry：FAILED 工作项重派 attempt 递增；snapshot/trace/审批历史聚合', async () => {
  const s = await setup()
  try {
    await s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
    const root = s.tasks.listRoots(s.member.channelId)[0]!

    // PR16 护栏（纯函数直测）：lead 不得自行取消项目来源 root；非 project 任务不受影响
    const { assertProjectRootCancelAllowed } = await import('../server/services/workshop/projects/root-cancel-guard')
    assert.throws(
      () => assertProjectRootCancelAllowed(
        { source: 'project', parentId: null, creatorId: `project:${s.p.id}` },
        { role: 'lead', agentId: s.member.leadAgentId! },
      ),
      (e: unknown) => (e as { code?: string }).code === 'PROJECT_ROOT_CANCEL_FORBIDDEN',
    )
    assert.doesNotThrow(() => assertProjectRootCancelAllowed(
      { source: 'channel', parentId: null, creatorId: s.member.leadAgentId },
      { role: 'lead', agentId: s.member.leadAgentId! },
    ))
    // project root（creator 恒为 project:<id>）即使被 lead「创建」语义也不放行
    assert.throws(() => assertProjectRootCancelAllowed(
      { source: 'project', parentId: null, creatorId: `project:${s.p.id}` },
      { role: 'lead', agentId: s.p.leadAgentId! },
    ), (e: unknown) => (e as { code?: string }).code === 'PROJECT_ROOT_CANCEL_FORBIDDEN')

    s.tasks.update(root.id, { state: 'FAILED', closeReason: 'boom' })
    s.svc.reconcile(s.p.id, s.owner)
    const retried = await s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
    assert.equal(retried.state, 'DISPATCHED')
    const attempts = s.db.prepare('SELECT attempt_no FROM project_work_item_attempts WHERE work_item_id = ?').all(s.w.id) as Array<{ attempt_no: number }>
    assert.equal(attempts.length, 2)

    // trace 聚合：root 带项目 traceId
    const traceId = (s.tasks.findById(root.id) as { traceId?: string }).traceId ?? ''
    const trace = s.svc.traceLookup(s.p.id, traceId, s.owner)
    assert.equal(trace.summary.tasks >= 1, true, `tasks=${trace.summary.tasks}`)

    // snapshot 聚合
    const snap = s.svc.projectSnapshot(s.p.id, s.owner)
    assert.equal(snap.project.id, s.p.id)
    assert.equal(snap.workItems.length, 1)
    assert.ok(snap.report)

    // 审批历史：制造一次 plan 审批后 all 可见
    const ap = s.svc.requestPlanApproval(s.p.id, s.owner, { version: 1, plan: { facts: ['x'] } })
    s.svc.decideApproval(s.p.id, ap.id, s.owner, true)
    const history = s.svc.listApprovalHistory(s.p.id, s.owner)
    assert.ok(history.some(a => a.id === ap.id && a.status === 'approved'))
    assert.equal(history[0]!.createdAt >= history[history.length - 1]!.createdAt, true, '倒序')
  }
  finally {
    s.db.close()
  }
})
