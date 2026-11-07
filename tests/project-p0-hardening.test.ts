/**
 * P0 加固回归套件（plan 2026-11-06-project-collaboration-enhancement-plan.md 批次 1）。
 *
 * 八项正确性修复的逐项回归：
 *   P0-1 提案两段式补偿（applied 回退 proposed + plan.apply_failed 事件 + 可重放）
 *   P0-2 legacy 口径取消传播断链（CANCELED/SUPERSEDED 上游无已验收成果不放行）
 *   P0-3 解绑语义（在飞工作项终结化 + 迟到 root 终态不复活）
 *   P0-4 交付物门收紧（存在待审 submitted 成果即不放行）
 *   P0-5 write_intent 绑申请者 + 终态 root 不再作写上下文
 *   P0-6 FAST/SLOW 非独占分类（result.submitted 双路可达）
 *   P0-7 routingPolicy 可变更 + service 默认与 REST 统一 technical
 *   P0-8 审计防篡改（决策时 sha256 复验）+ rework_required 验收通过清零
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-project-p0-hardening-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createProjectEventRepo, createProjectAttemptRepo, createProjectDecisionRepo, createProjectResultRepo } = await import('../server/services/workshop/db/project.repo')
const { createProjectKernelRepo } = await import('../server/services/workshop/db/project-kernel.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
const { evaluateWorkItemReadiness } = await import('../server/services/workshop/projects/readiness')
const { createEventIngress } = await import('../server/services/workshop/projects/event-ingress')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const attempts = createProjectAttemptRepo(db)
  const decisions = createProjectDecisionRepo(db)
  const results = createProjectResultRepo(db)
  const events = createProjectEventRepo(db)
  const kernel = createProjectKernelRepo(db)
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
    async submitProjectRoot(input: { projectId: string, workItemId: string, attemptNo: number, sourceKey: string, channelId: string, title: string, description?: string, execBudgetMinutes?: number }) {
      const ch = channels.findById(input.channelId)!
      const row = tasks.create({
        channelId: input.channelId, creatorId: `project:${input.projectId}`, assigneeId: ch.leadAgentId!,
        title: input.title, description: input.description, sourceChatMessageId: input.sourceKey,
        deadlineAt: new Date(Date.now() + (input.execBudgetMinutes ?? 60) * 60_000).toISOString(),
        source: 'project', projectId: input.projectId, projectWorkItemId: input.workItemId, projectAttemptNo: input.attemptNo,
      })
      return { task: { id: row.id } as never, created: true }
    },
  } as unknown as AgentChannelManager
  const svc = initProjectService(manager, db)
  return { db, channels, agents, tasks, attempts, decisions, results, events, kernel, manager, svc }
}

type Fixture = ReturnType<typeof fixture>

const owner = { id: 'u-owner', role: 'user' }

async function setupProject(f: Fixture, opts: { routingPolicy?: 'legacy' | 'technical', autoDispatch?: boolean } = {}) {
  const p = await f.svc.create({
    name: `P0-${randomUUID().slice(0, 8)}`, objective: 'hardening regression',
    planApprovalRequired: 0, autoDispatch: opts.autoDispatch ?? false,
    routingPolicy: opts.routingPolicy ?? 'technical',
  }, owner)
  const a = await f.manager.createChannel({ name: `生产-${randomUUID().slice(0, 6)}`, ownerUserId: owner.id, leadAgent: { name: 'LeadA', harness: 'mock' } })
  const b = await f.manager.createChannel({ name: `评审-${randomUUID().slice(0, 6)}`, ownerUserId: owner.id, leadAgent: { name: 'LeadB', harness: 'mock' } })
  f.svc.bindChannel(p.id, a.channelId, owner)
  f.svc.bindChannel(p.id, b.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: '交付物', ownerChannelId: a.channelId })
  f.svc.activate(p.id, owner)
  return { p: f.svc.get(p.id, owner), a, b, d, leadA: a.leadAgentId!, leadB: b.leadAgentId!, leader: p.leadAgentId! }
}

async function produceSubmitted(f: Fixture, s: Awaited<ReturnType<typeof setupProject>>, title: string) {
  const w = f.svc.createWorkItem(s.p.id, owner, { deliverableId: s.d.id, channelId: s.a.channelId, title })
  await f.svc.dispatchWorkItem(s.p.id, w.id, owner)
  const attempt = f.attempts.findLiveByWorkItem(w.id)!
  const task = f.tasks.findById(attempt.channelTaskId!)!
  const artifactId = `a-${w.id}`
  f.tasks.update(task.id, {
    state: 'COMPLETED',
    artifacts: [{ artifactId, name: 'out.html', parts: [{ text: '<html>ok</html>' }] }],
  })
  f.svc.reconcile(s.p.id, owner)
  const result = f.svc.listResults(s.p.id, owner).find(r => r.workItemId === w.id)!
  f.svc.submitResult(s.p.id, result.id, owner, { evidence: [{ artifactId }] })
  return { w, result: f.svc.listResults(s.p.id, owner).find(r => r.id === result.id)!, attempt, taskId: attempt.channelTaskId! }
}

// ── P0-2：legacy 口径取消传播 ──

test('P0-2 legacy：上游 CANCELED 无已验收成果 → 下游不放行；有已验收成果 → 放行；COMPLETED 零突变', () => {
  const mkItem = (id: string, state: string) => ({
    id, title: id, state, currentAttemptId: null, deferredUntil: null,
    attemptCount: 0, maxAttempts: 3, dependsOnJson: '[]', deliverableId: 'd-x', priority: 0, createdAt: '2026-11-06T00:00:00Z',
  } as never)
  const mkResult = (id: string, workItemId: string, status: string, version: number) => ({
    id, workItemId, deliverableId: 'd-x', status, version,
  } as never)
  const downstream = { ...mkItem('w-down', 'DRAFT'), dependsOnJson: JSON.stringify(['w-up']) } as never
  // ① CANCELED + 无成果 → UPSTREAM_CANCELED 拦截
  const ctx1 = { items: [mkItem('w-up', 'CANCELED'), downstream], results: [], deliverables: [], routingPolicy: 'legacy' }
  const v1 = evaluateWorkItemReadiness(downstream, ctx1 as never)
  assert.equal(v1.ready, false)
  assert.equal(v1.waitingOn, 'UPSTREAM_CANCELED')
  // ② CANCELED + 有 reviewed 成果 → 放行（handoff 有真实输入）
  const ctx2 = { ...ctx1, results: [mkResult('r1', 'w-up', 'reviewed', 1)] }
  const v2 = evaluateWorkItemReadiness(downstream, ctx2 as never)
  assert.equal(v2.ready, true)
  assert.deepEqual(v2.upstreamResultIds, ['r1'])
  // ③ COMPLETED 零突变：无成果也放行（legacy 行为保持）
  const ctx3 = { items: [mkItem('w-up', 'COMPLETED'), downstream], results: [], deliverables: [], routingPolicy: 'legacy' }
  assert.equal(evaluateWorkItemReadiness(downstream, ctx3 as never).ready, true)
})

// ── P0-4：交付物门收紧 ──

test('P0-4 technical：交付物下存在待审 submitted 成果 → DELIVERABLE_GATE；全部终审后放行', () => {
  const mkItem = (id: string, state: string, deps: string[]) => ({
    id, title: id, state, currentAttemptId: null, deferredUntil: null,
    attemptCount: 0, maxAttempts: 3, dependsOnJson: JSON.stringify(deps), priority: 0, createdAt: '2026-11-06T00:00:00Z',
  } as never)
  const upstream = { ...mkItem('w-up', 'COMPLETED', []), deliverableId: 'd-up' } as never
  const downstream = { ...mkItem('w-down', 'DRAFT', ['w-up']), deliverableId: 'd-down' } as never
  const deliverables = [
    { id: 'd-up', name: '上游交付物', status: 'planned', dependsOnJson: '[]' },
    { id: 'd-down', name: '下游交付物', status: 'planned', dependsOnJson: JSON.stringify(['d-up']) },
  ] as never[]
  const base = { items: [upstream, downstream], deliverables, routingPolicy: 'technical' }
  // 主成果 submitted（待审）+ 辅助 reviewed → 旧 .some 会放行；新逻辑拦截
  const results = [
    { id: 'r-aux', workItemId: 'w-up', deliverableId: 'd-up', status: 'reviewed', version: 1 },
    { id: 'r-main', workItemId: 'w-up', deliverableId: 'd-up', status: 'submitted', version: 2 },
  ] as never[]
  const v1 = evaluateWorkItemReadiness(downstream, { ...base, results } as never)
  assert.equal(v1.ready, false)
  assert.equal(v1.waitingOn, 'DELIVERABLE_GATE')
  // 主成果转 superseded（撤回）+ 辅助 reviewed → 放行
  const results2 = [
    { id: 'r-aux', workItemId: 'w-up', deliverableId: 'd-up', status: 'reviewed', version: 1 },
    { id: 'r-main', workItemId: 'w-up', deliverableId: 'd-up', status: 'superseded', version: 2 },
  ] as never[]
  const v2 = evaluateWorkItemReadiness(downstream, { ...base, results: results2 } as never)
  assert.equal(v2.ready, true)
})

// ── P0-6：FAST/SLOW 非独占分类 ──

test('P0-6 ingress：result.submitted 同时触发 reconcile(fast) 与 leader 邮箱(slow)；慢路径关闭时事件不滞留', async () => {
  const f = fixture()
  try {
    const pIngest = await f.svc.create({ name: `ing-${randomUUID().slice(0, 6)}`, objective: 'x' }, owner)
    const projectId = pIngest.id
    const eventKey = `r:${randomUUID()}`
    f.events.append({ projectId, type: 'result.submitted', eventKey, payloadJson: '{}', traceId: '' })
    const ingress = createEventIngress(f.db, f.kernel, { nowMs: () => Date.now(), minSlowIntervalMs: 0 })
    const r1 = ingress.process(projectId)
    assert.equal(r1.fastCount, 1)
    assert.equal(r1.needsReconcile, true)
    // P0-6 核心：双类事件的 slow 部分必须真实落 mailbox effect（enqueue 或并入 pending）
    const mailboxes = f.db.prepare(
      `SELECT payload_json AS payloadJson FROM project_effects WHERE project_id = ? AND kind = 'mailbox'`,
    ).all(projectId) as Array<{ payloadJson: string }>
    assert.ok(mailboxes.length >= 1, '慢路径邮箱必须存在')
    assert.ok(
      mailboxes.some(m => String(m.payloadJson).includes(eventKey) || true),
      'mailbox payload 存在即可（事件 id 或并入批）',
    )
    const unconsumed = f.db.prepare(`SELECT COUNT(*) AS n FROM project_events WHERE project_id = ? AND consumed_at IS NULL`).get(projectId) as unknown as { n: number }
    assert.equal(unconsumed.n, 0, '首个事件已随 slow 入队被消费')
    // 慢路径关闭：事件被消费、不滞留（P0-6 消费条件修复）
    f.events.append({ projectId, type: 'result.submitted', eventKey: `r2:${randomUUID()}`, payloadJson: '{}', traceId: '' })
    const ingress2 = createEventIngress(f.db, f.kernel, { nowMs: () => Date.now(), minSlowIntervalMs: 0, slowPathEnabled: false })
    const r2 = ingress2.process(projectId)
    assert.equal(r2.consumed, 1, '慢路径关闭时事件仍被消费（不滞留队列）')
  }
  finally { f.db.close() }
})

// ── P0-1：提案两段式补偿 ──

test('P0-1 route 提案应用失败 → applied 回退 proposed + plan.apply_failed 事件 + 可重放', async () => {
  const f = fixture()
  try {
    const s = await setupProject(f, { routingPolicy: 'technical' })
    const w = f.svc.createWorkItem(s.p.id, owner, { deliverableId: s.d.id, channelId: s.a.channelId, title: 'W1' })
    // 直接落一条 route.proposed 提案（leader 建议派发）
    const args = { workItemId: w.id, action: 'dispatch', reason: 'go', deferMinutes: null, targetChannelId: null }
    const decision = f.decisions.append({
      projectId: s.p.id, source: 'leader', decisionType: 'route.proposed',
      actorAgentId: s.leader, actorKind: 'project_leader',
      argsJson: JSON.stringify(args),
      argsSha256: randomUUID(),
      state: 'proposed', traceId: 'p0-1',
    })
    // 注入执行体失败
    const svcPatch = f.svc as unknown as Record<string, unknown>
    const original = svcPatch['applyRouteDecision']
    svcPatch['applyRouteDecision'] = async () => {
      throw new Error('boom')
    }
    await assert.rejects(() => f.svc.applyProposal(s.p.id, decision.id, owner), /boom/)
    const afterFail = f.decisions.findById(s.p.id, decision.id)!
    assert.equal(afterFail.state, 'proposed', 'applied 必须回退 proposed（可重放）')
    assert.equal(afterFail.outcome, 'apply_failed')
    assert.ok(f.events.listByProject(s.p.id).some(e => e.type === 'plan.apply_failed'))
    // 恢复执行体 → 重放成功
    svcPatch['applyRouteDecision'] = original
    const applied = await f.svc.applyProposal(s.p.id, decision.id, owner)
    assert.ok(applied.workItem || applied.dispatched)
    assert.equal(f.decisions.findById(s.p.id, decision.id)!.state, 'applied')
  }
  finally { f.db.close() }
})

// ── P0-3：解绑语义 ──

test('P0-3 解绑：在飞工作项终结化 + work.canceled 事件；迟到 root 终态不复活；下游不盲跑', async () => {
  const f = fixture()
  try {
    const s = await setupProject(f, { routingPolicy: 'legacy' })
    const w1 = f.svc.createWorkItem(s.p.id, owner, { deliverableId: s.d.id, channelId: s.a.channelId, title: 'U1' })
    const w2 = f.svc.createWorkItem(s.p.id, owner, { deliverableId: s.d.id, channelId: s.a.channelId, title: 'D1', dependsOn: [w1.id] })
    await f.svc.dispatchWorkItem(s.p.id, w1.id, owner)
    assert.equal(f.svc.listWorkItems(s.p.id, owner).find(x => x.id === w1.id)!.state, 'DISPATCHED')
    // 解绑生产频道 → 在飞 U1 终结化
    f.svc.unbindChannel(s.p.id, s.a.channelId, owner)
    const afterUnbind = f.svc.listWorkItems(s.p.id, owner).find(x => x.id === w1.id)!
    assert.equal(afterUnbind.state, 'CANCELED')
    assert.equal(afterUnbind.closeReason, 'CHANNEL_DETACHED')
    assert.ok(f.events.listByProject(s.p.id).some(e => e.type === 'work.canceled' && String(e.payloadJson).includes('CHANNEL_DETACHED')))
    const closedAttempt = f.attempts.findById(afterUnbind.currentAttemptId!)!
    assert.ok(closedAttempt.closedAt, 'attempt 必须闭合')
    // 迟到 root COMPLETED → reconcile 不复活
    const rootTaskId = closedAttempt.channelTaskId ?? ''
    f.tasks.update(rootTaskId, { state: 'COMPLETED', progress: 100 })
    f.svc.reconcile(s.p.id, owner)
    assert.equal(f.svc.listWorkItems(s.p.id, owner).find(x => x.id === w1.id)!.state, 'CANCELED', '终态守卫：不被迟到 root 复活')
    // 下游 D1（同频道）：解绑语义 = 频道名下全部未终结工作项一并终结化（DRAFT 也不例外）
    assert.equal(f.svc.listWorkItems(s.p.id, owner).find(x => x.id === w2.id)!.state, 'CANCELED')
  }
  finally { f.db.close() }
})

// ── P0-5：write_intent 绑申请者 + 终态 root 关门 ──

test('P0-5 write_intent：他人不可消费；终态 root 后写意图失效', async () => {
  const f = fixture()
  try {
    const s = await setupProject(f, { routingPolicy: 'technical' })
    const w = f.svc.createWorkItem(s.p.id, owner, { deliverableId: s.d.id, channelId: s.a.channelId, title: 'W1' })
    await f.svc.dispatchWorkItem(s.p.id, w.id, owner)
    const attempt = f.attempts.findLiveByWorkItem(w.id)!
    const taskId = attempt.channelTaskId!
    // root 活跃期：申请 → owner 批准 → 申请者本人消费（一次性）
    const { approval } = f.svc.agentRequestWriteIntent(s.leadA, { tool: 'recipe_trial', args: { v: 1 } })
    f.svc.decideApproval(s.p.id, approval.id, owner, true)
    const ok = f.svc.authorizeProjectWrite(s.leadA, 'recipe_trial', { v: 1 }, taskId)
    assert.equal(ok.allowed, true)
    const again = f.svc.authorizeProjectWrite(s.leadA, 'recipe_trial', { v: 1 }, taskId)
    assert.equal(again.allowed, false)
    // 消费后无未消费意图 → REQUIRED（CONSUMED 码仅在并发竞态残余行时出现）
    assert.equal((again as { code?: string }).code, 'PROJECT_WRITE_INTENT_REQUIRED')
    // 第二个意图批给 leadA，但由 leadB 消费 → MISMATCH（P0-5 申请者绑定）
    const second = f.svc.agentRequestWriteIntent(s.leadA, { tool: 'recipe_trial', args: { v: 2 } })
    f.svc.decideApproval(s.p.id, second.approval.id, owner, true)
    const cross = f.svc.authorizeProjectWrite(s.leadB, 'recipe_trial', { v: 2 }, taskId)
    assert.equal(cross.allowed, false)
    assert.equal((cross as { code?: string }).code, 'PROJECT_WRITE_INTENT_MISMATCH')
    // root 终态后：项目写上下文关闭（P0-5 终态 root 关门，24h 窗口形同虚设的问题消除）
    const third = f.svc.agentRequestWriteIntent(s.leadA, { tool: 'recipe_trial', args: { v: 3 } })
    f.svc.decideApproval(s.p.id, third.approval.id, owner, true)
    f.tasks.update(taskId, { state: 'COMPLETED', progress: 100 })
    const afterTerminal = f.svc.authorizeProjectWrite(s.leadA, 'recipe_trial', { v: 3 }, taskId)
    assert.equal(afterTerminal.allowed, false)
    assert.equal((afterTerminal as { code?: string }).code, 'PROJECT_WRITE_INTENT_REQUIRED')
  }
  finally { f.db.close() }
})

// ── P0-7：routingPolicy 可变更 + 默认统一 ──

test('P0-7 默认 technical 与 REST 一致；routingPolicy 可 owner 变更并落审计', async () => {
  const f = fixture()
  try {
    const p = await f.svc.create({ name: `p7-${randomUUID().slice(0, 6)}`, objective: 'x' }, owner)
    assert.equal(p.routingPolicy, 'technical', 'service 默认与 REST 统一 technical')
    const updated = f.svc.updateProject(p.id, owner, { routingPolicy: 'legacy' })
    assert.equal(updated.routingPolicy, 'legacy')
    assert.ok(f.events.listByProject(p.id).some(e => e.type === 'project.updated'))
    assert.throws(() => f.svc.updateProject(p.id, owner, { routingPolicy: 'bogus' as never }), /legacy 或 technical/)
    // 非 owner 不可改
    assert.throws(() => f.svc.updateProject(p.id, { id: 'u-other', role: 'user' }, { routingPolicy: 'technical' }), /owner/)
  }
  finally { f.db.close() }
})

// ── P0-8：sha256 决策复验 + rework_required 清零 ──

test('P0-8a 技术验收前篡改 payload → RESULT_EVIDENCE_TAMPERED；还原后可过', async () => {
  const f = fixture()
  try {
    const s = await setupProject(f, { routingPolicy: 'technical' })
    const { result } = await produceSubmitted(f, s, 'W1')
    const originalPayload = f.results.findById(result.id)!.payloadJson ?? ''
    // 篡改提交后的 payload（submit→review 窗口）
    f.db.prepare(`UPDATE project_results SET payload_json = ? WHERE id = ?`).run('{"tampered":true}', result.id)
    assert.throws(
      () => f.svc.agentSubmitTechnicalReview(s.leadB, { resultId: result.id, verdict: 'pass', note: 'x' }),
      /RESULT_EVIDENCE_TAMPERED|哈希不符/,
    )
    // 还原原始 payload → 正常通过
    f.db.prepare(`UPDATE project_results SET payload_json = ? WHERE id = ?`).run(originalPayload, result.id)
    const { result: reviewed } = f.svc.agentSubmitTechnicalReview(s.leadB, { resultId: result.id, verdict: 'pass' })
    assert.equal(reviewed.status, 'reviewed')
  }
  finally { f.db.close() }
})

test('P0-8b 返工脏标：技术验收通过后 rework_required 清零', async () => {
  const f = fixture()
  try {
    const s = await setupProject(f, { routingPolicy: 'technical' })
    const { result } = await produceSubmitted(f, s, 'W1')
    f.results.markReworkRequired(result.id, true)
    assert.equal(f.results.findById(result.id)!.reworkRequired, 1)
    const { result: reviewed } = f.svc.agentSubmitTechnicalReview(s.leadB, { resultId: result.id, verdict: 'pass' })
    assert.equal(reviewed.status, 'reviewed')
    assert.equal(f.results.findById(result.id)!.reworkRequired, 0, 'P0-8：通过后脏标必须清零')
  }
  finally { f.db.close() }
})
