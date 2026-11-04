/**
 * PR7 MAST 回归（L1–L14）：把 14 类多 Agent 失败模式映射为可执行断言。
 * L1 任务规格 / L2 角色规格 / L3 重复步骤 / L4 历史丢失 / L5 终止条件 /
 * L6 对话重置 / L7 澄清 / L8 漂移 / L9 信息共享 / L10 忽略输入 /
 * L11 推理-行动 / L12 过早终止 / L13 验证不完整 / L14 验证错误。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import type { TaskRow } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createProjectDeliverableRepo, createProjectEventRepo, createProjectResultRepo, createProjectApprovalRepo } from '../server/services/workshop/db/project.repo'
import { ProjectService } from '../server/services/workshop/projects/service'
import { capabilitiesFor } from '../server/services/workshop/agents/role-capabilities'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'

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
      description?: string
      scenarioPrompt?: string
    }) {
      const ch = channels.create({ name: input.name, description: input.description, scenarioPrompt: input.scenarioPrompt, ownerUserId: input.ownerUserId ?? null })
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
  return { db, channels, agents, tasks, manager }
}

async function setup(opts: { dispatch?: boolean } = {}) {
  const f = fixture()
  const svc = new ProjectService(f.manager, f.db)
  const owner = { id: 'u-1', role: 'user' }
  const p = await svc.create({ name: 'MAST 项目', objective: '验证失败模式控制', planApprovalRequired: 0 }, owner)
  const member = await f.manager.createChannel({
    name: '执行频道', ownerUserId: 'u-1', actor: owner,
    leadAgent: { name: 'Lead', harness: 'mock', agentKind: 'channel_agent' },
  })
  svc.bindChannel(p.id, member.channelId, owner)
  const d = svc.createDeliverable(p.id, owner, { name: '交付物', ownerChannelId: member.channelId })
  const w = svc.createWorkItem(p.id, owner, {
    deliverableId: d.id, channelId: member.channelId, title: '工作项', brief: 'brief',
    execBudgetMinutes: 60, dedupeKey: 'main',
  })
  svc.activate(p.id, owner)
  let root: TaskRow
  if (opts.dispatch !== false) {
    await svc.dispatchWorkItem(p.id, w.id, owner)
    root = f.tasks.listRoots(member.channelId)[0]!
  }
  return { ...f, svc, owner, p, member, d, w, root: root! }
}

test('L1 任务规格：工作项必须绑定真实交付物', async () => {
  const s = await setup({ dispatch: false })
  try {
    assert.throws(
      () => s.svc.createWorkItem(s.p.id, s.owner, {
        deliverableId: 'missing', channelId: s.member.channelId, title: 'x', dedupeKey: 'x',
      }),
      (e: unknown) => (e as { code?: string }).code === 'NOT_FOUND',
    )
  }
  finally { s.db.close() }
})

test('L2 角色规格：project_leader 不拿 Channel lead 工具/工业写', () => {
  const cap = capabilitiesFor('lead', 'project_leader', 'project_office')
  assert.equal(cap.seesChannelLeadTools, false)
  assert.equal(cap.seesProjectProposeTools, true)
  assert.equal(cap.industrialWrite, 'none')
  assert.equal(cap.ownsChannelScheduler, false)
})

test('L3 重复步骤：重复派发被拒', async () => {
  const s = await setup()
  try {
    await assert.rejects(
      () => s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner),
      (e: unknown) => (e as { code?: string }).code === 'WORK_ITEM_IN_FLIGHT',
    )
    const events = createProjectEventRepo(s.db)
    const a = events.append({ projectId: s.p.id, type: 't', eventKey: 'same' })
    const b = events.append({ projectId: s.p.id, type: 't', eventKey: 'same' })
    assert.equal(a.inserted, true)
    assert.equal(b.inserted, false)
  }
  finally { s.db.close() }
})

test('L4 历史丢失：新 service 实例仍可读 decisions/events', async () => {
  const s = await setup()
  try {
    s.tasks.update(s.root.id, {
      state: 'COMPLETED',
      artifacts: [{ artifactId: 'a-history', name: 'r', parts: [{ text: 'ok' }] }],
    })
    s.svc.reconcile(s.p.id, s.owner)
    const svc2 = new ProjectService(s.manager, s.db)
    assert.ok(svc2.listDecisions(s.p.id, s.owner).length > 0)
    assert.ok(svc2.listEvents(s.p.id, s.owner).length > 0)
  }
  finally { s.db.close() }
})

test('L5 终止条件：必选交付物未验收时不能申请完成', async () => {
  const s = await setup()
  try {
    assert.throws(
      () => s.svc.requestProjectComplete(s.p.id, s.owner),
      (e: unknown) => (e as { code?: string }).code === 'DELIVERABLES_INCOMPLETE',
    )
  }
  finally { s.db.close() }
})

test('L6 对话重置：plan approval 在新实例仍生效', async () => {
  const s = await setup({ dispatch: false })
  try {
    const ap = s.svc.requestPlanApproval(s.p.id, s.owner, { version: 1, plan: { plan: ['p'] } })
    s.svc.decideApproval(s.p.id, ap.id, s.owner, true)
    const svc2 = new ProjectService(s.manager, s.db)
    assert.equal(svc2.get(s.p.id, s.owner).planVersion, 1)
  }
  finally { s.db.close() }
})

test('L7 澄清：未绑定 Channel 不能建工作项/派发', async () => {
  const s = await setup({ dispatch: false })
  try {
    const other = await s.manager.createChannel({
      name: '未绑定', ownerUserId: 'u-1', actor: s.owner,
      leadAgent: { name: 'Lead2', harness: 'mock', agentKind: 'channel_agent' },
    })
    assert.throws(
      () => s.svc.createWorkItem(s.p.id, s.owner, {
        deliverableId: s.d.id, channelId: other.channelId, title: '未绑定工作项', dedupeKey: 'unbound',
      }),
      (e: unknown) => (e as { code?: string }).code === 'CHANNEL_NOT_IN_PROJECT',
    )
  }
  finally { s.db.close() }
})

test('L8 任务漂移：DRAFT 自动对齐新计划；已执行旧版本（COMPLETED rework）拒绝', async () => {
  const s = await setup({ dispatch: false })
  try {
    const ap = s.svc.requestPlanApproval(s.p.id, s.owner, { version: 1, plan: { plan: ['p'] } })
    s.svc.decideApproval(s.p.id, ap.id, s.owner, true)
    // 未执行过的 DRAFT：派发时自动对齐 v1
    const aligned = await s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
    assert.equal(aligned.planVersion, 1)
    // 已按旧版本执行过（rework 场景）：不得悄然按新计划重派
    s.db.prepare('UPDATE project_work_items SET plan_version = 0, state = \'COMPLETED\', current_attempt_id = NULL WHERE id = ?').run(s.w.id)
    await assert.rejects(
      () => s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner),
      (e: unknown) => (e as { code?: string }).code === 'PLAN_VERSION_STALE',
    )
  }
  finally { s.db.close() }
})

test('L9 信息隐瞒：非 owner 读不到成果', async () => {
  const s = await setup()
  try {
    assert.throws(
      () => s.svc.listResults(s.p.id, { id: 'u-2', role: 'user' }),
      (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN',
    )
  }
  finally { s.db.close() }
})

test('L10 忽略输入：依赖未完成时拒绝派发', async () => {
  const s = await setup({ dispatch: false })
  try {
    const w2 = s.svc.createWorkItem(s.p.id, s.owner, {
      deliverableId: s.d.id, channelId: s.member.channelId, title: '下游', dependsOn: [s.w.id], dedupeKey: 'downstream',
    })
    await assert.rejects(
      () => s.svc.dispatchWorkItem(s.p.id, w2.id, s.owner),
      (e: unknown) => (e as { code?: string }).code === 'DEPENDENCY_NOT_READY',
    )
  }
  finally { s.db.close() }
})

test('L11 推理-行动不一致：draft 不能直接 review', async () => {
  const s = await setup()
  try {
    s.tasks.update(s.root.id, {
      state: 'COMPLETED',
      artifacts: [{ artifactId: 'a1', name: 'r', parts: [{ text: 'ok' }] }],
    })
    s.svc.reconcile(s.p.id, s.owner)
    const r = s.svc.listResults(s.p.id, s.owner)[0]!
    assert.throws(
      () => s.svc.reviewResult(s.p.id, r.id, { id: 'u-1', role: 'user' }, 'reviewed'),
      (e: unknown) => (e as { code?: string }).code === 'RESULT_STATE_INVALID',
    )
  }
  finally { s.db.close() }
})

test('L12 过早终止：交付物已批准但工作项未终态不能完成', async () => {
  const s = await setup()
  try {
    createProjectDeliverableRepo(s.db).setStatus(s.d.id, 'approved')
    assert.throws(
      () => s.svc.requestProjectComplete(s.p.id, s.owner),
      (e: unknown) => (e as { code?: string }).code === 'WORK_ITEMS_INCOMPLETE',
    )
  }
  finally { s.db.close() }
})

test('L13 验证不完整：无证据成果不能申请验收', async () => {
  const s = await setup()
  try {
    const results = createProjectResultRepo(s.db)
    const r = results.create({
      projectId: s.p.id, deliverableId: s.d.id, channelId: s.member.channelId,
      workItemId: s.w.id, attemptNo: 9, version: 9, title: 'no-evidence', summary: 's',
      sourceTaskId: s.root.id, status: 'reviewed', evidenceJson: '[]', traceId: s.root.traceId,
    })
    assert.throws(
      () => s.svc.requestAcceptance(s.p.id, r.id, s.owner),
      (e: unknown) => (e as { code?: string }).code === 'EVIDENCE_REQUIRED',
    )
  }
  finally { s.db.close() }
})

test('L14 验证错误：作者不能批准自己的成果', async () => {
  const s = await setup()
  try {
    const results = createProjectResultRepo(s.db)
    const approvals = createProjectApprovalRepo(s.db)
    const r = results.create({
      projectId: s.p.id, deliverableId: s.d.id, channelId: s.member.channelId,
      workItemId: s.w.id, attemptNo: 10, version: 10, title: 'self', summary: 's',
      sourceTaskId: s.root.id, status: 'reviewed', evidenceJson: '[{"artifactId":"a"}]',
      authorUserId: s.owner.id, traceId: s.root.traceId,
    })
    const ap = approvals.create({
      projectId: s.p.id, kind: 'deliverable_acceptance', subjectType: 'result', subjectId: r.id, subjectVersion: 10,
    })
    assert.throws(
      () => s.svc.decideApproval(s.p.id, ap.id, s.owner, true),
      (e: unknown) => (e as { code?: string }).code === 'SELF_APPROVAL_FORBIDDEN',
    )
  }
  finally { s.db.close() }
})
