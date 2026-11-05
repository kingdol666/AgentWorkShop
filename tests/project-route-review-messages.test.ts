/**
 * Router v3 P2（2026-11-05）：Leader route gate + 可委派技术验收 + 项目消息 + 审批分权。
 *
 * 覆盖：
 *  - 独立 reviewer Channel 可做 L1 技术验收；生产频道自验/作者自验拒绝；
 *  - Leader route 提案：supervised=owner apply；auto+routeGate=leader 即时应用；
 *  - defer/retry/rework/escalate 的确定性执行；
 *  - Leader↔Channel、Channel↔Channel 消息（同项目约束、落库+投递）；
 *  - approver 可决策 plan/acceptance，但不能决策 project_complete/write_intent。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-route-review-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createProjectAttemptRepo } = await import('../server/services/workshop/db/project.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const attempts = createProjectAttemptRepo(db)
  const sent: Array<{ channelId: string, toAgentId: string, text: string, fromLabel?: string }> = []
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
    async submitProjectRoot(input: { projectId: string, workItemId: string, attemptNo: number, sourceKey: string, channelId: string, title: string, description?: string, execBudgetMinutes?: number, parts?: unknown[] }) {
      const ch = channels.findById(input.channelId)!
      const row = tasks.create({
        channelId: input.channelId, creatorId: `project:${input.projectId}`, assigneeId: ch.leadAgentId!,
        title: input.title, description: input.description, sourceChatMessageId: input.sourceKey,
        deadlineAt: new Date(Date.now() + (input.execBudgetMinutes ?? 60) * 60_000).toISOString(),
        source: 'project', projectId: input.projectId, projectWorkItemId: input.workItemId, projectAttemptNo: input.attemptNo,
      })
      return { task: { id: row.id } as never, created: true }
    },
    async sendImmediateMessage(input: { channelId: string, toAgentId: string, parts: Array<{ text?: string }>, fromLabel?: string }) {
      sent.push({ channelId: input.channelId, toAgentId: input.toAgentId, text: input.parts.map(p => p.text ?? '').join(''), fromLabel: input.fromLabel })
      return { messageId: randomUUID() }
    },
  } as unknown as AgentChannelManager
  const svc = initProjectService(manager, db)
  return { db, channels, agents, tasks, attempts, manager, svc, sent }
}

type Fixture = ReturnType<typeof fixture>

async function setupProject(f: Fixture, opts: { mode?: 'supervised' | 'auto', routeGate?: boolean } = {}) {
  const owner = { id: 'u-owner', role: 'user' }
  const p = await f.svc.create({
    name: `P2-${randomUUID().slice(0, 8)}`, objective: 'route/review/messages',
    planApprovalRequired: 0, autoDispatch: false, routingPolicy: 'technical', mode: opts.mode ?? 'supervised',
    ...(opts.routeGate ? { routeGate: 'leader' as const } : {}),
  }, owner)
  const a = await f.manager.createChannel({ name: `生产-${randomUUID().slice(0, 6)}`, ownerUserId: owner.id, leadAgent: { name: 'LeadA', harness: 'mock' } })
  const b = await f.manager.createChannel({ name: `评审-${randomUUID().slice(0, 6)}`, ownerUserId: owner.id, leadAgent: { name: 'LeadB', harness: 'mock' } })
  f.svc.bindChannel(p.id, a.channelId, owner)
  f.svc.bindChannel(p.id, b.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: '交付物', ownerChannelId: a.channelId, acceptanceCriteria: ['artifact.present'] })
  f.svc.activate(p.id, owner)
  const office = f.channels.findById(p.officeChannelId!)!
  return { owner, p: f.svc.get(p.id, owner), a, b, d, leadA: a.leadAgentId!, leadB: b.leadAgentId!, lead: p.leadAgentId!, officeLead: office.leadAgentId! }
}

async function produceSubmitted(f: Fixture, setup: Awaited<ReturnType<typeof setupProject>>, title: string, html = '<html>ok</html>') {
  const { owner, p, a, d } = setup
  const w = f.svc.createWorkItem(p.id, owner, { deliverableId: d.id, channelId: a.channelId, title })
  await f.svc.dispatchWorkItem(p.id, w.id, owner)
  const attempt = f.attempts.findLiveByWorkItem(w.id)!
  const task = f.tasks.findById(attempt.channelTaskId!)!
  const artifactId = `a-${w.id}`
  f.tasks.update(task.id, {
    state: 'COMPLETED',
    artifacts: [{ artifactId, name: 'out.html', parts: [{ text: html }] }],
  })
  f.svc.reconcile(p.id, owner)
  const result = f.svc.listResults(p.id, owner).find(r => r.workItemId === w.id)!
  f.svc.submitResult(p.id, result.id, owner, { evidence: [{ artifactId }] })
  return { w, result: f.svc.listResults(p.id, owner).find(r => r.id === result.id)!, artifactId }
}

test('技术验收可委派：reviewer Channel pass → reviewed；生产频道自验拒绝', async () => {
  const f = fixture()
  const setup = await setupProject(f)
  const { result } = await produceSubmitted(f, setup, 'W1')
  const { review, result: reviewed } = f.svc.agentSubmitTechnicalReview(setup.leadB, { resultId: result.id, verdict: 'pass', note: 'looks good' })
  assert.equal(review.reviewerChannelId, setup.b.channelId)
  assert.equal(review.reviewerKind, 'channel_lead')
  assert.equal(reviewed.status, 'reviewed')
  assert.ok(reviewed.technicalVerdictJson.includes('pass'))
  // 生产频道自验
  const second = await produceSubmitted(f, setup, 'W2')
  assert.throws(() => f.svc.agentSubmitTechnicalReview(setup.leadA, { resultId: second.result.id, verdict: 'pass' }), /自己产出|自验/)
})

test('Leader 技术验收：可验任何成果；作者自验拒绝', async () => {
  const f = fixture()
  const setup = await setupProject(f)
  const { result } = await produceSubmitted(f, setup, 'W1')
  const { review, result: reviewed } = f.svc.agentSubmitTechnicalReview(setup.lead, { resultId: result.id, verdict: 'pass' })
  assert.equal(review.reviewerKind, 'project_leader')
  assert.equal(reviewed.status, 'reviewed')
  const second = await produceSubmitted(f, setup, 'W2')
  assert.throws(() => f.svc.agentSubmitTechnicalReview(second.result.authorAgentId!, { resultId: second.result.id, verdict: 'pass' }), /自己产出|自验/)
})

test('route 提案：supervised → owner apply；defer 生效', async () => {
  const f = fixture()
  const setup = await setupProject(f)
  const w = f.svc.createWorkItem(setup.p.id, setup.owner, { deliverableId: setup.d.id, channelId: setup.a.channelId, title: '路由项' })
  const proposed = await f.svc.agentProposeRoute(setup.lead, { workItemId: w.id, action: 'dispatch', reason: 'ready now' })
  assert.equal(proposed.applied, false)
  assert.equal(proposed.decision.state, 'proposed')
  const applied = await f.svc.applyProposal(setup.p.id, proposed.decision.id, setup.owner)
  assert.equal(applied.dispatched, true)
  assert.equal(f.svc.listWorkItems(setup.p.id, setup.owner).find(x => x.id === w.id)!.state, 'DISPATCHED')
  // defer
  const w2 = f.svc.createWorkItem(setup.p.id, setup.owner, { deliverableId: setup.d.id, channelId: setup.a.channelId, title: '延后项' })
  const defer = await f.svc.agentProposeRoute(setup.lead, { workItemId: w2.id, action: 'defer', deferMinutes: 5, reason: 'wait' })
  await f.svc.applyProposal(setup.p.id, defer.decision.id, setup.owner)
  const deferred = f.svc.listWorkItems(setup.p.id, setup.owner).find(x => x.id === w2.id)!
  assert.ok(deferred.deferredUntil && Date.parse(deferred.deferredUntil) > Date.now())
})

test('route 提案：auto + routeGate=leader 即时应用', async () => {
  const f = fixture()
  const setup = await setupProject(f, { mode: 'auto', routeGate: true })
  const w = f.svc.createWorkItem(setup.p.id, setup.owner, { deliverableId: setup.d.id, channelId: setup.a.channelId, title: '自动路由项' })
  const proposed = await f.svc.agentProposeRoute(setup.lead, { workItemId: w.id, action: 'dispatch', reason: 'auto' })
  assert.equal(proposed.applied, true)
  assert.equal(f.svc.listWorkItems(setup.p.id, setup.owner).find(x => x.id === w.id)!.state, 'DISPATCHED')
})

test('项目消息：Leader→Channel、Channel→Leader、Channel→Channel；跨项目拒绝', async () => {
  const f = fixture()
  const setup = await setupProject(f)
  const m1 = await f.svc.agentSendProjectMessage(setup.lead, { toChannelId: setup.a.channelId, body: '请开始设计', requireReply: true })
  assert.equal(m1.status, 'delivered')
  assert.ok(f.sent.some(s => s.channelId === setup.a.channelId && s.toAgentId === setup.leadA && s.text === '请开始设计'))
  const m2 = await f.svc.agentSendProjectMessage(setup.leadA, { toLeader: true, body: '收到，需要素材', kind: 'reply' })
  assert.equal(m2.toChannelId, setup.p.officeChannelId)
  assert.ok(f.sent.some(s => s.channelId === setup.p.officeChannelId && s.toAgentId === setup.lead))
  const m3 = await f.svc.agentSendProjectMessage(setup.leadA, { toChannelId: setup.b.channelId, body: '请评审', kind: 'request_review' })
  assert.equal(m3.toChannelId, setup.b.channelId)
  // 消息读面：leader 看全部，成员看自己
  assert.equal(f.svc.agentListProjectMessages(setup.lead).length, 3)
  assert.equal(f.svc.agentListProjectMessages(setup.leadB).length, 1)
  // 跨项目频道拒绝
  const other = await f.manager.createChannel({ name: `外部-${randomUUID().slice(0, 6)}`, ownerUserId: setup.owner.id, leadAgent: { name: 'Out', harness: 'mock' } })
  await assert.rejects(f.svc.agentSendProjectMessage(setup.lead, { toChannelId: other.channelId, body: 'x' }), /CHANNEL_NOT_IN_PROJECT|未绑定/)
})

test('审批分权：approver 可决策验收，但不能决策 project_complete', async () => {
  const f = fixture()
  const setup = await setupProject(f)
  f.svc.addMember(setup.p.id, setup.owner, { userId: 'u-approver', role: 'approver' })
  const approver = { id: 'u-approver', role: 'user' }
  const { w, result } = await produceSubmitted(f, setup, 'W1')
  f.svc.agentSubmitTechnicalReview(setup.leadB, { resultId: result.id, verdict: 'pass' })
  const acceptance = f.svc.requestAcceptance(setup.p.id, result.id, setup.owner)
  const decided = f.svc.decideApproval(setup.p.id, acceptance.id, approver, true)
  assert.equal(decided.status, 'approved')
  assert.equal(f.svc.listResults(setup.p.id, setup.owner).find(r => r.id === result.id)!.status, 'approved')
  assert.equal(f.svc.listWorkItems(setup.p.id, setup.owner).find(x => x.id === w.id)!.state, 'COMPLETED')
  const complete = f.svc.requestProjectComplete(setup.p.id, setup.owner)
  assert.throws(() => f.svc.decideApproval(setup.p.id, complete.id, approver, true), /仅项目 owner\/admin/)
})

test('成果提交后自动向独立评审 Channel 发 L1 请求（幂等）', async () => {
  const f = fixture()
  const setup = await setupProject(f)
  const { result } = await produceSubmitted(f, setup, 'W1')
  assert.equal(result.status, 'submitted')
  await f.svc.runRouteLoop(setup.p.id)
  const msgs = f.svc.agentListProjectMessages(setup.lead).filter(m => m.kind === 'request_review' && m.resultId === result.id)
  assert.equal(msgs.length, 1, '每个 submitted 成果恰好一条 L1 请求')
  assert.equal(msgs[0]!.toChannelId, setup.b.channelId, '优先选择无工作项的独立评审 Channel')
  assert.equal(msgs[0]!.toAgentId, setup.leadB)
  assert.match(String(msgs[0]!.body), new RegExp(result.id))
  assert.match(String(msgs[0]!.body), /project_submit_technical_review/)
  assert.equal(f.sent.filter(s => s.channelId === setup.b.channelId).length, 1)
  // 重复 tick 不重复投递
  await f.svc.runRouteLoop(setup.p.id)
  assert.equal(f.svc.agentListProjectMessages(setup.lead).filter(m => m.kind === 'request_review' && m.resultId === result.id).length, 1)
  assert.equal(f.sent.filter(s => s.channelId === setup.b.channelId).length, 1)
})

test('L1 前置：reviewed 但无技术验收记录 → L2 拒绝', async () => {
  const f = fixture()
  const setup = await setupProject(f)
  const { result } = await produceSubmitted(f, setup, 'W1')
  // 模拟历史/外部把成果置 reviewed，但没有 project_technical_reviews 记录。
  f.db.prepare(`UPDATE project_results SET status = 'reviewed', reviewed_by = 'u-owner' WHERE id = ?`).run(result.id)
  assert.throws(
    () => f.svc.requestAcceptance(setup.p.id, result.id, setup.owner),
    (err: unknown) => (err as { code?: string }).code === 'TECHNICAL_REVIEW_REQUIRED',
  )
})

test('owner 兜底复核写 owner 技术验收并允许 L2', async () => {
  const f = fixture()
  const setup = await setupProject(f)
  const { result } = await produceSubmitted(f, setup, 'W1')
  const reviewed = f.svc.reviewResult(setup.p.id, result.id, setup.owner, 'reviewed', 'owner fallback: reviewer runtime unavailable')
  assert.equal(reviewed.status, 'reviewed')
  const reviews = f.svc.listTechnicalReviews(setup.p.id, result.id, setup.owner)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0]!.reviewerKind, 'owner', 'owner 兜底必须如实记录，不能冒充 leader')
  assert.equal(reviews[0]!.verdict, 'pass')
  const acceptance = f.svc.requestAcceptance(setup.p.id, result.id, setup.owner)
  assert.equal(acceptance.kind, 'deliverable_acceptance')
})

test('observe 模式：自动派发被门禁挡住，手动派发仍可用', async () => {
  const f = fixture()
  const setup = await setupProject(f)
  f.db.prepare('UPDATE projects SET mode = ?, auto_dispatch = 1 WHERE id = ?').run('observe', setup.p.id)
  const w = f.svc.createWorkItem(setup.p.id, setup.owner, { deliverableId: setup.d.id, channelId: setup.a.channelId, title: '观察项' })
  const out = await f.svc.autoDispatchProject(setup.p.id)
  assert.equal(out.skippedByGate, true)
  assert.equal(f.svc.listWorkItems(setup.p.id, setup.owner).find(x => x.id === w.id)!.state, 'DRAFT')
  await f.svc.dispatchWorkItem(setup.p.id, w.id, setup.owner)
  assert.equal(f.svc.listWorkItems(setup.p.id, setup.owner).find(x => x.id === w.id)!.state, 'DISPATCHED')
})
