/**
 * PR13：并行审查 P0 修复回归。
 * 1 Reconciler 不动 DRAFT + decisions 幂等（不再无限膨胀）
 * 2 计划门：planApprovalRequired=1 时 plan 未批不能派发；批准后可派发
 * 3 attempt 闭合：FAILED 后可重派（不再永久 IN_FLIGHT）
 * 4 完成门豁免入口：owner waive/cancel 后完成门可达
 * 5 write_intent 堵 submit_task 绕道：项目成员普通任务上下文高危写一律拒
 * 6 自批可达：owner 提交的成果 owner 不能批准
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-project-review-fixes-'))
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
      leadAgent?: { name: string, harness: string, config?: Record<string, unknown>, agentKind?: 'channel_agent' | 'project_leader' }
      ownerUserId?: string | null
      scenarioPrompt?: string
    }) {
      const ch = channels.create({ name: input.name, scenarioPrompt: input.scenarioPrompt, ownerUserId: input.ownerUserId ?? null })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({
          channelId: ch.id, templateId: null, name: input.leadAgent.name, harness: input.leadAgent.harness,
          config: input.leadAgent.config, role: 'lead', agentKind: input.leadAgent.agentKind,
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

async function setup(opts: { planRequired?: boolean } = {}) {
  const f = fixture()
  const owner = { id: 'u-owner', role: 'user' }
  const p = await f.svc.create({
    name: '审查修复项目', objective: 'P0 回归',
    planApprovalRequired: opts.planRequired === false ? 0 : 1,
  }, owner)
  const member = await f.manager.createChannel({
    name: '执行频道', ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' },
  })
  f.svc.bindChannel(p.id, member.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: '交付物', ownerChannelId: member.channelId })
  const w = f.svc.createWorkItem(p.id, owner, {
    deliverableId: d.id, channelId: member.channelId, title: '工作项', brief: 'x', dedupeKey: 'fix-flow',
  })
  f.svc.activate(p.id, owner)
  return { ...f, owner, p, member, d, w, leadId: member.leadAgentId! }
}

async function approvePlan(s: ReturnType<typeof setup>, version = 1) {
  const ap = s.svc.requestPlanApproval(s.p.id, s.owner, { version, plan: { facts: ['ok'] } })
  s.svc.decideApproval(s.p.id, ap.id, s.owner, true)
}

test('计划门：plan 未批派发 409 PLAN_NOT_APPROVED；批准后可派发', async () => {
  const s = await setup({ planRequired: true })
  try {
    await assert.rejects(
      () => s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner),
      (e: unknown) => (e as { code?: string }).code === 'PLAN_NOT_APPROVED',
    )
    await approvePlan(s)
    // 批准前手建的 DRAFT 工作项：派发时自动对齐当前批准版本（避免死锁）
    const dispatched = await s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
    assert.equal(dispatched.state, 'DISPATCHED')
    assert.equal(dispatched.planVersion, 1)
    const decisions = s.svc.listDecisions(s.p.id, s.owner)
    assert.ok(decisions.some(d => d.decisionType === 'work.plan_aligned'))
  }
  finally {
    s.db.close()
  }
})

test('计划门关闭（planApprovalRequired=0）派发不受阻', async () => {
  const s = await setup({ planRequired: false })
  try {
    const dispatched = await s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
    assert.equal(dispatched.state, 'DISPATCHED')
  }
  finally {
    s.db.close()
  }
})

test('Reconciler：DRAFT 工作项不被 BLOCKED，且周期 reconcile 不膨胀 decisions', async () => {
  const s = await setup({ planRequired: false })
  try {
    // 未派发的 DRAFT 工作项 + 无 deadline
    for (let i = 0; i < 3; i++) s.svc.reconcileInternal(s.p.id)
    const wi = s.svc.listWorkItems(s.p.id, s.owner).find(x => x.id === s.w.id)!
    assert.equal(wi.state, 'DRAFT')
    // decisions 不因重复 reconcile 膨胀（work.* 类零条；DRAFT 也不触发 overdue）
    const decisions = s.svc.listDecisions(s.p.id, s.owner)
    assert.equal(decisions.filter(d => d.decisionType.startsWith('work.')).length, 0)
  }
  finally {
    s.db.close()
  }
})

test('attempt 闭合：root FAILED 后可重新派发（不再永久 IN_FLIGHT）', async () => {
  const s = await setup({ planRequired: false })
  try {
    await s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
    const root1 = s.tasks.listRoots(s.member.channelId)[0]!
    s.tasks.update(root1.id, { state: 'FAILED', closeReason: 'boom' })
    s.svc.reconcile(s.p.id, s.owner)
    const failed = s.svc.listWorkItems(s.p.id, s.owner).find(x => x.id === s.w.id)!
    assert.equal(failed.state, 'FAILED')
    // 重派成功（此前 WORK_ITEM_IN_FLIGHT 死锁）
    const retry = await s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
    assert.equal(retry.state, 'DISPATCHED')
    const attempts = s.db.prepare('SELECT attempt_no, closed_at FROM project_work_item_attempts WHERE work_item_id = ? ORDER BY attempt_no').all(s.w.id) as Array<{ attempt_no: number, closed_at: string | null }>
    assert.equal(attempts.length, 2)
    assert.ok(attempts[0]!.closed_at, '第一次 attempt 应已闭合')
    assert.equal(attempts[1]!.closed_at, null)
  }
  finally {
    s.db.close()
  }
})

test('完成门豁免：FAILED 工作项 owner cancel 后 + 交付物 waive 后完成门可达', async () => {
  const s = await setup({ planRequired: false })
  try {
    await s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
    const root = s.tasks.listRoots(s.member.channelId)[0]!
    s.tasks.update(root.id, { state: 'FAILED', closeReason: 'boom' })
    s.svc.reconcile(s.p.id, s.owner)
    // FAILED 不满足完成门（终态集合不含 FAILED）→ 先豁免交付物再验证工作项门
    s.svc.waiveDeliverable(s.p.id, s.d.id, s.owner, '审查修复：演练豁免')
    const waived = s.svc.listDeliverables(s.p.id, s.owner).find(x => x.id === s.d.id)!
    assert.equal(waived.status, 'waived')
    assert.throws(
      () => s.svc.requestProjectComplete(s.p.id, s.owner),
      (e: unknown) => (e as { code?: string }).code === 'WORK_ITEMS_INCOMPLETE',
    )
    s.svc.cancelWorkItem(s.p.id, s.w.id, s.owner, '失败项不再重试')
    const ap = s.svc.requestProjectComplete(s.p.id, s.owner)
    assert.equal(ap.kind, 'project_complete')
  }
  finally {
    s.db.close()
  }
})

test('cancelWorkItem：RUNNING 工作项 owner 取消 → 终态 + attempt 闭合', async () => {
  const s = await setup({ planRequired: false })
  try {
    await s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
    const canceled = s.svc.cancelWorkItem(s.p.id, s.w.id, s.owner, '不再需要')
    assert.equal(canceled.state, 'CANCELED')
    const attempts = s.db.prepare('SELECT closed_at FROM project_work_item_attempts WHERE work_item_id = ?').all(s.w.id) as Array<{ closed_at: string | null }>
    assert.ok(attempts[0]!.closed_at)
    // viewer 不能取消
    s.svc.addMember(s.p.id, s.owner, { userId: 'u-v', role: 'viewer' })
    assert.throws(
      () => s.svc.cancelWorkItem(s.p.id, s.w.id, { id: 'u-v', role: 'user' }, 'x'),
      (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN',
    )
  }
  finally {
    s.db.close()
  }
})

test('write_intent 堵绕道：项目成员在普通任务上下文高危写被拒', async () => {
  const s = await setup({ planRequired: false })
  try {
    // channel lead 建一条 source=channel 的普通任务（绕道场景）
    const plain = s.tasks.create({
      channelId: s.member.channelId, assigneeId: s.leadId, title: '绕道任务', source: 'channel',
    })
    const verdict = s.svc.authorizeProjectWrite(s.leadId, 'recipe_update', { value: 1 }, plain.id)
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.code, 'PROJECT_WRITE_INTENT_REQUIRED')
    assert.match(verdict.message ?? '', /不得用普通任务绕过/)
    // 非项目 agent 的普通任务不受影响
    const outsider = await s.manager.createChannel({
      name: '局外频道', ownerUserId: s.owner.id, leadAgent: { name: 'Out', harness: 'mock' },
    })
    const outTask = s.tasks.create({
      channelId: outsider.channelId, assigneeId: outsider.leadAgentId!, title: '局外任务', source: 'channel',
    })
    assert.equal(s.svc.authorizeProjectWrite(outsider.leadAgentId!, 'recipe_update', { value: 2 }, outTask.id).allowed, true)
  }
  finally {
    s.db.close()
  }
})

test('自批可达：owner 提交的成果 owner 不能批准（SELF_APPROVAL_FORBIDDEN）', async () => {
  const s = await setup({ planRequired: false })
  try {
    await s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
    const root = s.tasks.listRoots(s.member.channelId)[0]!
    s.tasks.update(root.id, { state: 'COMPLETED', artifacts: [{ artifactId: 'a', name: 'r', parts: [{ text: 'x' }] }] })
    s.svc.reconcile(s.p.id, s.owner)
    const draft = s.svc.listResults(s.p.id, s.owner)[0]!
    // owner 直接提交（人类路径落 authorUserId）
    s.svc.submitResult(s.p.id, draft.id, s.owner, { summary: 'owner 代提交' })
    s.svc.reviewResult(s.p.id, draft.id, s.owner, 'reviewed')
    const ap = s.svc.requestAcceptance(s.p.id, draft.id, s.owner)
    assert.throws(
      () => s.svc.decideApproval(s.p.id, ap.id, s.owner, true),
      (e: unknown) => (e as { code?: string }).code === 'SELF_APPROVAL_FORBIDDEN',
    )
    // author_user_id 已落库
    const row = s.db.prepare('SELECT author_user_id FROM project_results WHERE id = ?').get(draft.id) as { author_user_id: string | null }
    assert.equal(row.author_user_id, s.owner.id)
  }
  finally {
    s.db.close()
  }
})
