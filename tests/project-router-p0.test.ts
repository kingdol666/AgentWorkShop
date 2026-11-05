/**
 * Router v3 P0（2026-11-05）：真相与安全回归。
 *
 * 覆盖：
 *  - technical 口径：上游成果未技术验收 → 下游不派发；reviewed/approved → 派发；
 *  - legacy 口径保持旧行为（上游工作项终态即放行）；
 *  - 证据 provenance：空壳/伪造 artifactId 拒绝，真实 artifact 通过；
 *  - 派发 CAS：并发双派只产生一个 live attempt；
 *  - 双图环检测：交付物/工作项依赖成环拒绝；
 *  - 任务回调：source=project 状态迁移落 task_callback effect（durable、去重）；
 *  - 审计主体：leader/channel lead 不再一律记成 leader。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-router-p0-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createProjectAttemptRepo } = await import('../server/services/workshop/db/project.repo')
const { createProjectKernelRepo } = await import('../server/services/workshop/db/project-kernel.repo')
const { initProjectService, normalizeProjectPlan } = await import('../server/services/workshop/projects/service')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const attempts = createProjectAttemptRepo(db)
  const kernel = createProjectKernelRepo(db)
  const rootParts: Array<{ taskId: string, parts: unknown[] }> = []
  const manager = {
    async createChannel(input: { name: string, ownerUserId?: string | null, leadAgent?: { name: string, harness: string, agentKind?: string } }) {
      const ch = channels.create({ name: input.name, ownerUserId: input.ownerUserId ?? null })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({
          channelId: ch.id, templateId: null, name: input.leadAgent.name, harness: input.leadAgent.harness,
          role: 'lead', agentKind: input.leadAgent.agentKind as never,
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
      channelId: string
      title: string
      description?: string
      execBudgetMinutes?: number
      parts?: unknown[]
    }) {
      const ch = channels.findById(input.channelId)!
      const row = tasks.create({
        channelId: input.channelId, creatorId: `project:${input.projectId}`, assigneeId: ch.leadAgentId!,
        title: input.title, description: input.description, sourceChatMessageId: input.sourceKey,
        deadlineAt: new Date(Date.now() + (input.execBudgetMinutes ?? 60) * 60_000).toISOString(),
        source: 'project', projectId: input.projectId, projectWorkItemId: input.workItemId, projectAttemptNo: input.attemptNo,
      })
      if (input.parts?.length) rootParts.push({ taskId: row.id, parts: input.parts })
      return { task: { id: row.id } as never, created: true }
    },
  } as unknown as AgentChannelManager
  const svc = initProjectService(manager, db)
  return { db, channels, agents, tasks, attempts, kernel, manager, svc }
}

type Fixture = ReturnType<typeof fixture>

async function setupChain(f: Fixture, opts: { routingPolicy: 'legacy' | 'technical', autoDispatch?: boolean }) {
  const owner = { id: 'u-owner', role: 'user' }
  const p = await f.svc.create({
    name: `P0-${randomUUID().slice(0, 8)}`, objective: 'router p0',
    planApprovalRequired: 0, autoDispatch: opts.autoDispatch ?? true, routingPolicy: opts.routingPolicy,
  }, owner)
  const member = await f.manager.createChannel({
    name: `成员-${randomUUID().slice(0, 6)}`, ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' },
  })
  f.svc.bindChannel(p.id, member.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: '交付物', ownerChannelId: member.channelId })
  const w1 = f.svc.createWorkItem(p.id, owner, { deliverableId: d.id, channelId: member.channelId, title: 'W1' })
  const w2 = f.svc.createWorkItem(p.id, owner, { deliverableId: d.id, channelId: member.channelId, title: 'W2', dependsOn: [w1.id] })
  f.svc.activate(p.id, owner)
  return { owner, p, member, d, w1, w2 }
}

function completeRoot(f: Fixture, workItemId: string) {
  const attempt = f.attempts.findLiveByWorkItem(workItemId)!
  return { attempt, task: f.tasks.findById(attempt.channelTaskId!)! }
}

test('technical 门：上游成果未技术验收，下游不派发；reviewed 后派发', async () => {
  const f = fixture()
  const { owner, p, w1, w2 } = await setupChain(f, { routingPolicy: 'technical' })
  await f.svc.dispatchWorkItem(p.id, w1.id, owner)
  const { attempt, task } = completeRoot(f, w1.id)
  // 真实 artifact + root COMPLETED → reconcile 生成 draft
  f.tasks.update(task.id, {
    state: 'COMPLETED',
    artifacts: [{ artifactId: 'a-w1', name: 'index.html', parts: [{ text: '<html>real artifact</html>' }] }],
  })
  f.svc.reconcile(p.id, owner)
  const draft = f.svc.listResults(p.id, owner)[0]!
  assert.equal(draft.status, 'draft')
  let loop = await f.svc.runRouteLoop(p.id)
  assert.equal(loop.autoDispatch.dispatched.length, 0, 'draft 成果不得放行下游')
  // 提交 + 技术复核
  f.svc.submitResult(p.id, draft.id, owner, { evidence: [{ artifactId: 'a-w1', name: 'index.html' }] })
  f.svc.reviewResult(p.id, draft.id, owner, 'reviewed')
  loop = await f.svc.runRouteLoop(p.id)
  assert.equal(loop.autoDispatch.dispatched.length, 1)
  assert.equal(f.svc.listWorkItems(p.id, owner).find(w => w.id === w2.id)!.state, 'DISPATCHED')
  assert.equal(attempt.closedAt, null)
})

test('legacy 门：上游工作项 COMPLETED 即放行（零突变）', async () => {
  const f = fixture()
  const { owner, p, w1, w2 } = await setupChain(f, { routingPolicy: 'legacy' })
  await f.svc.dispatchWorkItem(p.id, w1.id, owner)
  const { task } = completeRoot(f, w1.id)
  f.tasks.update(task.id, { state: 'COMPLETED', artifacts: [{ artifactId: 'a1', name: 'x', parts: [{ text: 'done' }] }] })
  await f.svc.runRouteLoop(p.id)
  assert.equal(f.svc.listWorkItems(p.id, owner).find(w => w.id === w2.id)!.state, 'DISPATCHED')
})

test('证据 provenance：伪造/空壳 artifactId 拒绝；真实 artifact 通过', async () => {
  const f = fixture()
  const { owner, p, w1 } = await setupChain(f, { routingPolicy: 'technical' })
  await f.svc.dispatchWorkItem(p.id, w1.id, owner)
  const { task } = completeRoot(f, w1.id)
  f.tasks.update(task.id, {
    state: 'COMPLETED',
    artifacts: [{ artifactId: 'real-1', name: 'out.html', parts: [{ text: '<h1>real</h1>' }] }],
  })
  f.svc.reconcile(p.id, owner)
  const draft = f.svc.listResults(p.id, owner)[0]!
  assert.throws(() => f.svc.submitResult(p.id, draft.id, owner, {
    evidence: [{ artifactId: 'fake-1', name: 'fake' }],
  }), /EVIDENCE_UNVERIFIED|证据不可回溯/)
  const submitted = f.svc.submitResult(p.id, draft.id, owner, {
    evidence: [{ artifactId: 'real-1', name: 'out.html' }],
  })
  assert.equal(submitted.status, 'submitted')
  assert.ok(submitted.evidenceVerifiedAt)
  assert.ok(submitted.contentSha256.length === 64)
})

test('派发 CAS：并发双派只产生一个 live attempt', async () => {
  const f = fixture()
  const { owner, p, w1 } = await setupChain(f, { routingPolicy: 'technical' })
  const results = await Promise.allSettled([
    f.svc.dispatchWorkItem(p.id, w1.id, owner),
    f.svc.dispatchWorkItem(p.id, w1.id, owner),
  ])
  const ok = results.filter(r => r.status === 'fulfilled')
  assert.equal(ok.length, 1)
  assert.equal(f.attempts.listByWorkItem(w1.id).filter(a => !a.closedAt).length, 1)
  assert.equal(f.svc.listWorkItems(p.id, owner)[0]!.state, 'DISPATCHED')
})

test('双图环检测：交付物/工作项依赖成环拒绝', () => {
  assert.throws(() => normalizeProjectPlan({
    deliverables: [
      { key: 'a', name: 'A', dependsOn: ['b'] },
      { key: 'b', name: 'B', dependsOn: ['a'] },
    ],
    work_items: [{ key: 'w1', deliverableKey: 'a', channelId: 'ch-1', title: 'W1' }],
  }), /成环/)
  assert.throws(() => normalizeProjectPlan({
    deliverables: [{ key: 'a', name: 'A' }],
    work_items: [
      { key: 'w1', deliverableKey: 'a', channelId: 'ch-1', title: 'W1', dependsOn: ['w2'] },
      { key: 'w2', deliverableKey: 'a', channelId: 'ch-1', title: 'W2', dependsOn: ['w1'] },
    ],
  }), /成环/)
})

test('任务回调：source=project 状态迁移落 task_callback effect（幂等）', async () => {
  const f = fixture()
  const { owner, p, w1 } = await setupChain(f, { routingPolicy: 'technical' })
  await f.svc.dispatchWorkItem(p.id, w1.id, owner)
  const { task } = completeRoot(f, w1.id)
  f.svc.onTaskStateChange(task.id, 'COMPLETED')
  f.svc.onTaskStateChange(task.id, 'COMPLETED')
  const effects = f.kernel.effects.listByStatus(p.id, ['pending'])
  assert.equal(effects.filter(e => e.kind === 'task_callback').length, 1)
  // 非项目任务不触发
  const ordinary = f.tasks.create({ channelId: task.channelId, creatorId: 'user', assigneeId: task.assigneeId, title: 'ordinary' })
  f.svc.onTaskStateChange(ordinary.id, 'COMPLETED')
  assert.equal(f.kernel.effects.listByStatus(p.id, ['pending']).filter(e => e.kind === 'task_callback').length, 1)
})

test('审计主体：leader 决策落 project_leader，不再一律 source=leader', async () => {
  const f = fixture()
  const { owner, p, member } = await setupChain(f, { routingPolicy: 'technical' })
  const leadId = p.leadAgentId!
  assert.ok(leadId)
  f.svc.agentRequestPlan(leadId, {
    deliverables: [{ key: 'd1', name: 'D1' }],
    work_items: [{ key: 'w1', deliverableKey: 'd1', channelId: member.channelId, title: 'W1' }],
  })
  const decision = f.svc.listDecisions(p.id, owner).find(d => d.decisionType === 'plan.proposed')!
  assert.equal(decision.actorKind, 'project_leader')
  assert.equal(decision.actorAgentId, leadId)
})
