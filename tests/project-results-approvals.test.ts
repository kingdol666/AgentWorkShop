/**
 * PR5 验收：成果 draft/submit/review/approve、审批 CAS/过期/自批、Reconciler、审计。
 * 内存 DB + 最小 manager stub；不启动真实 SchedulerLoop。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import {
  createProjectResultRepo,
  createProjectApprovalRepo,
} from '../server/services/workshop/db/project.repo'
import { ProjectService } from '../server/services/workshop/projects/service'
import { startProjectReconciler } from '../server/services/workshop/projects/reconciler'
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

async function setupDispatched() {
  const f = fixture()
  const svc = new ProjectService(f.manager, f.db)
  const owner = { id: 'u-1', role: 'user' }
  const p = await svc.create({ name: '成果验收项目', objective: '验证成果闭环' }, owner)
  const member = await f.manager.createChannel({
    name: '执行频道', ownerUserId: 'u-1', actor: owner,
    leadAgent: { name: 'Lead', harness: 'mock', agentKind: 'channel_agent' },
  })
  svc.bindChannel(p.id, member.channelId, owner)
  const d = svc.createDeliverable(p.id, owner, { name: '基线报告', ownerChannelId: member.channelId })
  const w = svc.createWorkItem(p.id, owner, {
    deliverableId: d.id, channelId: member.channelId, title: '建立基线', brief: '输出基线',
    execBudgetMinutes: 60, dedupeKey: 'baseline',
  })
  svc.activate(p.id, owner)
  await svc.dispatchWorkItem(p.id, w.id, owner)
  const root = f.tasks.listRoots(member.channelId)[0]!
  return { ...f, svc, owner, project: p, member, deliverable: d, workItem: w, root }
}

function completeRoot(tasks: ReturnType<typeof createTaskRepo>, rootId: string, state: 'COMPLETED' | 'FAILED' = 'COMPLETED') {
  return tasks.update(rootId, {
    state,
    artifacts: state === 'COMPLETED'
      ? [{ artifactId: 'art-1', name: 'baseline.md', parts: [{ text: '基线良率 97.9%，窗口 10-30 08:00-12:00' }] }]
      : [],
    closeReason: state === 'FAILED' ? 'HARNESS_UNAVAILABLE' : 'ROOT_COMPLETED',
  })
}

test('成果闭环：root COMPLETED → draft → submit → review → owner approve', async () => {
  const s = await setupDispatched()
  try {
    completeRoot(s.tasks, s.root.id)
    const rec = s.svc.reconcile(s.project.id, s.owner)
    assert.equal(rec.workItems.find(x => x.id === s.workItem.id)?.state, 'COMPLETED')

    const drafts = s.svc.listResults(s.project.id, s.owner)
    assert.equal(drafts.length, 1)
    const draft = drafts[0]!
    assert.equal(draft.status, 'draft')
    assert.ok(draft.sourceTaskId)
    assert.ok(draft.evidenceJson.includes('art-1'))
    assert.ok(draft.summary.includes('97.9'))

    // 幂等：再 reconcile 不重复生成
    s.svc.reconcile(s.project.id, s.owner)
    assert.equal(s.svc.listResults(s.project.id, s.owner).length, 1)

    const submitted = s.svc.submitResult(s.project.id, draft.id, s.owner, {
      summary: '基线良率 97.9%，数据窗口完整',
      method: '按产线/产品/配方取数',
      evidence: [{ artifactId: 'art-1', name: 'baseline.md' }],
    })
    assert.equal(submitted.status, 'submitted')

    const leaderActor = { id: 'agent-leader', role: 'lead', agentId: s.project.leadAgentId! }
    const reviewed = s.svc.reviewResult(s.project.id, draft.id, leaderActor, 'reviewed')
    assert.equal(reviewed.status, 'reviewed')

    const approval = s.svc.requestAcceptance(s.project.id, draft.id, s.owner)
    assert.equal(approval.status, 'pending')
    const approved = s.svc.decideApproval(s.project.id, approval.id, s.owner, true, '证据完整')
    assert.equal(approved.status, 'approved')

    const final = s.svc.listResults(s.project.id, s.owner)[0]!
    assert.equal(final.status, 'approved')
    assert.equal(final.approvedBy, s.owner.id)
    assert.equal(final.reviewedBy, s.project.leadAgentId)
    assert.equal(s.svc.listApprovals(s.project.id, s.owner).length, 0)
  }
  finally { s.db.close() }
})

test('审批：重复决策 409；过期 409；自批 403', async () => {
  const s = await setupDispatched()
  try {
    completeRoot(s.tasks, s.root.id)
    s.svc.reconcile(s.project.id, s.owner)
    const result = s.svc.listResults(s.project.id, s.owner)[0]!
    s.svc.submitResult(s.project.id, result.id, s.owner, { summary: 's' })
    const leaderActor = { id: 'agent-leader', role: 'lead', agentId: s.project.leadAgentId! }
    s.svc.reviewResult(s.project.id, result.id, leaderActor, 'reviewed')
    const approval = s.svc.requestAcceptance(s.project.id, result.id, s.owner)
    s.svc.decideApproval(s.project.id, approval.id, s.owner, true)
    assert.throws(
      () => s.svc.decideApproval(s.project.id, approval.id, s.owner, true),
      (e: unknown) => (e as { code?: string }).code === 'APPROVAL_STATE_INVALID',
    )

    // 过期审批：直接写一条已过期 pending
    const resultsRepo = createProjectResultRepo(s.db)
    const approvalsRepo = createProjectApprovalRepo(s.db)
    const result2 = resultsRepo.create({
      projectId: s.project.id, deliverableId: s.deliverable.id, channelId: s.member.channelId,
      workItemId: s.workItem.id, attemptNo: 2, version: 2, title: 'expired', summary: 's2',
      sourceTaskId: s.root.id, status: 'reviewed', authorUserId: 'u-2', traceId: s.root.traceId,
    })
    const expired = approvalsRepo.create({
      projectId: s.project.id, kind: 'deliverable_acceptance', subjectType: 'result',
      subjectId: result2.id, subjectVersion: 2, expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    assert.throws(
      () => s.svc.decideApproval(s.project.id, expired.id, s.owner, true),
      (e: unknown) => (e as { code?: string }).code === 'APPROVAL_STATE_INVALID',
    )

    // 自批：authorUserId = owner
    const selfResult = resultsRepo.create({
      projectId: s.project.id, deliverableId: s.deliverable.id, channelId: s.member.channelId,
      workItemId: s.workItem.id, attemptNo: 3, version: 3, title: 'self', summary: 's3',
      sourceTaskId: s.root.id, status: 'reviewed', authorUserId: s.owner.id, traceId: s.root.traceId,
    })
    const selfApproval = approvalsRepo.create({
      projectId: s.project.id, kind: 'deliverable_acceptance', subjectType: 'result',
      subjectId: selfResult.id, subjectVersion: 3,
    })
    assert.throws(
      () => s.svc.decideApproval(s.project.id, selfApproval.id, s.owner, true),
      (e: unknown) => (e as { code?: string }).code === 'SELF_APPROVAL_FORBIDDEN',
    )
  }
  finally { s.db.close() }
})

test('Reconciler：root FAILED → 工作项 FAILED；审计 decisions/events 可查', async () => {
  const s = await setupDispatched()
  try {
    completeRoot(s.tasks, s.root.id, 'FAILED')
    const rec = s.svc.reconcile(s.project.id, s.owner)
    assert.equal(rec.workItems.find(x => x.id === s.workItem.id)?.state, 'FAILED')
    assert.equal(s.svc.listResults(s.project.id, s.owner).length, 0)

    const decisions = s.svc.listDecisions(s.project.id, s.owner)
    const events = s.svc.listEvents(s.project.id, s.owner)
    assert.ok(decisions.length > 0)
    assert.ok(events.length > 0)
    assert.ok(decisions.some(d => d.traceId === s.root.traceId))
    assert.ok(decisions.every(d => d.argsSha256.length === 64))
    assert.equal(new Set(events.map(e => e.eventKey)).size, events.length)
  }
  finally { s.db.close() }
})

test('supersede：approved 成果可被 owner 取代且保留审批字段', async () => {
  const s = await setupDispatched()
  try {
    completeRoot(s.tasks, s.root.id)
    s.svc.reconcile(s.project.id, s.owner)
    const result = s.svc.listResults(s.project.id, s.owner)[0]!
    s.svc.submitResult(s.project.id, result.id, s.owner, { summary: 's' })
    const leaderActor = { id: 'agent-leader', role: 'lead', agentId: s.project.leadAgentId! }
    s.svc.reviewResult(s.project.id, result.id, leaderActor, 'reviewed')
    const approval = s.svc.requestAcceptance(s.project.id, result.id, s.owner)
    s.svc.decideApproval(s.project.id, approval.id, s.owner, true)
    const superseded = s.svc.supersedeResult(s.project.id, result.id, s.owner, '新版本替代')
    assert.equal(superseded.status, 'superseded')
    assert.equal(superseded.approvedBy, s.owner.id)
  }
  finally { s.db.close() }
})

test('plan_approval：请求 → owner 批准 → planVersion/planJson 落库', async () => {
  const s = await setupDispatched()
  try {
    const approval = s.svc.requestPlanApproval(s.project.id, s.owner, {
      version: 1,
      plan: { facts: ['产线/配方已确认'], deliverables: ['基线报告'], workItems: ['建立基线'] },
    })
    assert.equal(approval.kind, 'plan_approval')
    assert.equal(approval.status, 'pending')
    const decided = s.svc.decideApproval(s.project.id, approval.id, s.owner, true, '计划可执行')
    assert.equal(decided.status, 'approved')
    const p = s.svc.get(s.project.id, s.owner)
    assert.equal(p.planVersion, 1)
    assert.ok(p.planJson.includes('基线报告'))
  }
  finally { s.db.close() }
})

test('自主 Reconciler 定时器：stop 后不再 tick', async () => {
  let ticks = 0
  const fake = {
    listActiveProjects: () => [{ id: 'p-timer' }],
    reconcileInternal: () => {
      ticks += 1
      return { workItems: [], expiredApprovals: 0 }
    },
  } as never
  const handle = startProjectReconciler(fake, { intervalMs: 1000 })
  await new Promise(r => setTimeout(r, 1150))
  handle.stop()
  const afterStop = ticks
  await new Promise(r => setTimeout(r, 100))
  assert.ok(afterStop > 0)
  assert.equal(ticks, afterStop)
  const manual = handle.tick()
  assert.equal(manual.projects, 1)
  assert.equal(manual.errors.length, 0)
})
