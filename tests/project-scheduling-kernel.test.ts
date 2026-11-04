/**
 * PR17：M4 调度内核回归（S2/S3 事件分级 + S5 双账本 + S7 watchdog + S11 effects）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-project-kernel-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createProjectEventRepo, createProjectDecisionRepo } = await import('../server/services/workshop/db/project.repo')
const { createProjectKernelRepo } = await import('../server/services/workshop/db/project-kernel.repo')
const { initProjectService, ledgerAssessmentOf } = await import('../server/services/workshop/projects/service')
const { createEventIngress } = await import('../server/services/workshop/projects/event-ingress')
const { createEffectsOutbox } = await import('../server/services/workshop/projects/effects')
const { createProjectWatchdog } = await import('../server/services/workshop/projects/watchdog')
const { initProjectKernel, getProjectKernel } = await import('../server/services/workshop/projects/kernel')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

type Fixture = ReturnType<typeof fixture>

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
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
  return { db, channels, tasks, manager, svc, kernel: createProjectKernelRepo(db) }
}

async function activeProject() {
  const f = fixture()
  const owner = { id: 'u-owner', role: 'user' }
  const p = await f.svc.create({ name: '内核项目', objective: 'M4', planApprovalRequired: 0 }, owner)
  const member = await f.manager.createChannel({ name: '执行频道', ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' } })
  f.svc.bindChannel(p.id, member.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: '账本交付物', ownerChannelId: member.channelId })
  const w = f.svc.createWorkItem(p.id, owner, { deliverableId: d.id, channelId: member.channelId, title: '账本工作项', brief: 'x', dedupeKey: 'base-w1' })
  f.svc.activate(p.id, owner)
  return { ...f, owner, p, member, d, w }
}

function appendEvent(f: Fixture, projectId: string, type: string, eventKey: string) {
  createProjectEventRepo(f.db).append({ projectId, type, eventKey, payloadJson: '{}', traceId: '' })
}

test('S5 双账本：plan_versions 不可变 + 单 approved；里程碑事件入 Progress Ledger', async () => {
  const s = await activeProject()
  try {
    // 里程碑：assessment 由规则确定；非里程碑不写
    assert.equal(ledgerAssessmentOf('work.completed', {})!.assessment.plan_valid, true)
    assert.equal(ledgerAssessmentOf('work.failed', {})!.assessment.stuck, true)
    assert.equal(ledgerAssessmentOf('project.updated', {}), null)

    const ap = s.svc.requestPlanApproval(s.p.id, s.owner, { version: 1, plan: { facts: ['x'] } })
    s.svc.decideApproval(s.p.id, ap.id, s.owner, true)
    // 不变量 12：v1 approved；快照行存在
    const approved = s.kernel.planVersions.getApproved(s.p.id)
    assert.equal(approved?.version, 1)
    assert.equal(approved?.status, 'approved')
    // ledger：plan.requested 非里程碑(0条) + approval.approved 里程碑(≥1)
    assert.ok(s.kernel.ledger.count(s.p.id) >= 1, `ledger count=${s.kernel.ledger.count(s.p.id)}`)
    const tail = s.kernel.ledger.list(s.p.id, 10)
    assert.ok(tail.some(r => r.summary === 'approval.approved'))

    // v2 draft → approve → v1 收编 superseded，唯一 approved
    const ap2 = s.svc.requestPlanApproval(s.p.id, s.owner, { version: 2, plan: { facts: ['y'] } })
    const v2row = s.kernel.planVersions.get(s.p.id, 2)
    assert.equal(v2row?.status, 'draft')
    s.svc.decideApproval(s.p.id, ap2.id, s.owner, true)
    assert.equal(s.kernel.planVersions.getApproved(s.p.id)?.version, 2)
    const v1 = s.kernel.planVersions.get(s.p.id, 1)
    assert.equal(v1?.status, 'superseded')

    // reject 分支：v3 draft → rejected
    const ap3 = s.svc.requestPlanApproval(s.p.id, s.owner, { version: 3, plan: { facts: ['z'] } })
    s.svc.decideApproval(s.p.id, ap3.id, s.owner, false, 'no')
    assert.equal(s.kernel.planVersions.get(s.p.id, 3)?.status, 'rejected')
    assert.equal(s.kernel.planVersions.getApproved(s.p.id)?.version, 2)
  }
  finally {
    s.db.close()
  }
})

test('S2 快路径：fast 事件触发 reconcile 且不投递 LLM；未知类型按 fast 兜底', async () => {
  const s = await activeProject()
  try {
    const ingress = createEventIngress(s.db, s.kernel, { minSlowIntervalMs: 0 })
    appendEvent(s, s.p.id, 'work.completed', 'e1')
    appendEvent(s, s.p.id, 'unknown.future_type', 'e2')
    const r = ingress.process(s.p.id)
    assert.equal(r.needsReconcile, true)
    assert.equal(r.consumed, 2)
    assert.equal(r.fastCount, 2)
    // 无 mailbox effect 产生
    assert.deepEqual(s.kernel.effects.countByStatus(s.p.id), {})
  }
  finally {
    s.db.close()
  }
})

test('S3 慢路径：单飞合并 + 最小间隔退避（defer 事件留队列）', async () => {
  const s = await activeProject()
  try {
    let clock = Date.now()
    const ingress = createEventIngress(s.db, s.kernel, { nowMs: () => clock, minSlowIntervalMs: 10 * 60_000 })
    appendEvent(s, s.p.id, 'work.blocked', 'b1')
    const r1 = ingress.process(s.p.id)
    assert.equal(r1.consumed, 1)
    assert.deepEqual(s.kernel.effects.countByStatus(s.p.id), { pending: 1 })

    // pending 存在：新 slow 事件并入同一批（不新增 effect 行）
    appendEvent(s, s.p.id, 'work.overdue', 'b2')
    const r2 = ingress.process(s.p.id)
    assert.equal(r2.consumed, 1)
    const rows = s.kernel.effects.countByStatus(s.p.id)
    assert.equal(rows.pending, 1)
    const pending = s.kernel.effects.listByStatus(s.p.id, ['pending'])
    const merged = JSON.parse(pending[0]!.payloadJson) as { events: string[] }
    assert.equal(merged.events.length, 2)

    // 完成 mailbox 后再来的 slow 事件：距上次 < minSlowIntervalMs → defer（留在队列）
    s.kernel.effects.claim(pending[0]!.id)
    s.kernel.effects.markDone(pending[0]!.id)
    clock += 60_000
    appendEvent(s, s.p.id, 'result.submit', 'b3')
    const r3 = ingress.process(s.p.id)
    assert.equal(r3.deferred, 1)
    assert.equal(r3.consumed, 0)
    // 静默期过后：重新入批
    clock += 11 * 60_000
    const r4 = ingress.process(s.p.id)
    assert.equal(r4.consumed, 1)
    assert.equal(s.kernel.effects.countByStatus(s.p.id).pending, 1)
  }
  finally {
    s.db.close()
  }
})

test('S11 effects：退避 5s→…→dead 3 次 + 升级 notify effect', async () => {
  const s = await activeProject()
  try {
    let clock = Date.now()
    const outbox = createEffectsOutbox(s.kernel, {
      mailbox: () => { throw new Error('boom') },
      notify: () => {},
      reconcile: () => {},
    }, { nowMs: () => clock, maxAttempts: 3, baseBackoffMs: 5_000, maxBackoffMs: 300_000 })
    s.kernel.effects.enqueue({ projectId: s.p.id, dedupeKey: 'assess:1', kind: 'mailbox', payload: { events: ['e1'] } })
    // 幂等：同 dedupeKey 不重复入队
    const again = s.kernel.effects.enqueue({ projectId: s.p.id, dedupeKey: 'assess:1', kind: 'mailbox' })
    assert.equal(again.inserted, false)

    const d1 = await outbox.drain()
    assert.equal(d1.retried, 1)
    let row = s.kernel.effects.findById(s.kernel.effects.listByStatus(s.p.id, ['pending'])[0]!.id)!
    assert.equal(row.attempts, 1)
    assert.ok(row.nextRetryAt && row.lastError.includes('boom'))
    // 未到 next_retry_at 不执行
    clock += 1_000
    assert.equal((await outbox.drain()).retried, 0)
    // 退避 5s → 10s
    clock += 5_100
    assert.equal((await outbox.drain()).retried, 1)
    clock += 10_100
    const d3 = await outbox.drain()
    assert.equal(d3.dead, 1)
    assert.equal(d3.escalated.length, 1)
    row = s.kernel.effects.findById(row.id)!
    assert.equal(row.status, 'dead')
    // 升级 effect（notify）执行成功
    const d4 = await outbox.drain()
    assert.equal(d4.done, 1)
    const counts = s.kernel.effects.countByStatus(s.p.id)
    assert.equal(counts.dead, 1)
    assert.equal(counts.done, 1)
  }
  finally {
    s.db.close()
  }
})

test('S7 watchdog：budget_burn/no_progress/repeated_decision + 通知去重（小时桶）', async () => {
  const s = await activeProject()
  try {
    // 制造：派发基础工作项 → 超期（直接改 deadline）
    await s.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
    s.db.prepare('UPDATE project_work_items SET deadline_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), s.w.id)
    // 重复决策 ×3（同类型）
    for (let i = 0; i < 3; i++) {
      createProjectDecisionRepo(s.db).append({
        projectId: s.p.id, source: 'leader', decisionType: 'channel.proposed', actorAgentId: 'a1',
        argsJson: `{"i":${i}}`, argsSha256: `sha${i}`, state: 'applied', outcome: '', traceId: '',
      })
    }
    const wd = createProjectWatchdog(s.db, s.kernel, { noProgressMs: -1 })
    const findings = wd.scanProject(s.p.id, 1)
    const types = findings.map(f => f.type).sort()
    assert.deepEqual(types, ['budget_burn', 'no_progress', 'repeated_decision'])
    // ledger 有 watchdog 条目；health degraded；通知 effect 入队（小时桶去重）
    assert.ok(s.kernel.ledger.list(s.p.id, 10).some(r => r.triggerType === 'watchdog'))
    assert.equal(s.kernel.health.get(s.p.id, 'watchdog')?.status, 'degraded')
    const before = s.kernel.effects.countByStatus(s.p.id).pending ?? 0
    wd.scanProject(s.p.id, 1)
    const after = s.kernel.effects.countByStatus(s.p.id).pending ?? 0
    assert.equal(after, before, '同小时桶内通知不重复入队')
    // 心跳恢复
    wd.heartbeat(s.p.id)
    assert.equal(s.kernel.health.get(s.p.id, 'watchdog')?.status, 'ok')
  }
  finally {
    s.db.close()
  }
})

test('kernel tick：fast 事件→reconcile、slow 事件→mailbox 投递、健康心跳与 dead-man', async () => {
  const s = await activeProject()
  try {
    const mailboxTexts: string[] = []
    const notifications: Array<{ title: string }> = []
    const kernel = initProjectKernel({
      db: s.db,
      service: s.svc,
      kernelRepo: s.kernel,
      sendMailbox: (_projectId, text) => { mailboxTexts.push(text) },
      notifyOwner: (_projectId, title) => { notifications.push({ title }) },
    }, { tickMs: 3_600_000, watchdogEveryTicks: 1, minSlowIntervalMs: 0 })
    assert.equal(getProjectKernel(), kernel)

    appendEvent(s, s.p.id, 'work.completed', 'k1')
    const t1 = await kernel.tick()
    assert.equal(t1.reconciles, 1)
    assert.equal(t1.projects, 1)
    assert.equal(s.kernel.health.get(s.p.id, 'ingress')?.status, 'ok')

    appendEvent(s, s.p.id, 'work.blocked', 'k2')
    const t2 = await kernel.tick()
    // 同一 tick 内：ingress 入批 → drain 立即执行 mailbox handler
    assert.equal(t2.effects.done, 1, `effects=${JSON.stringify(t2.effects)}`)
    assert.equal(mailboxTexts.length, 1)
    assert.ok(mailboxTexts[0]!.includes('work.blocked'))

    // dead-man：启动时清 stale；stop 后不再 tick
    kernel.start()
    kernel.stop()
    assert.equal(s.kernel.health.list(s.p.id).length >= 1, true)
  }
  finally {
    s.db.close()
  }
})

test('内核读面：ledgerTail/kernelStatus 权限与聚合', async () => {
  const s = await activeProject()
  try {
    const ap = s.svc.requestPlanApproval(s.p.id, s.owner, { version: 1, plan: { facts: ['x'] } })
    s.svc.decideApproval(s.p.id, ap.id, s.owner, true)
    const tail = s.svc.ledgerTail(s.p.id, s.owner, 10)
    assert.equal(tail.project.planVersion, 1)
    assert.ok(tail.count >= 1)
    assert.ok(tail.items.every(i => typeof i.assessment === 'object'))
    const status = s.svc.kernelStatus(s.p.id, s.owner)
    assert.equal(status.planVersions.approvedVersion, 1)
    assert.equal(status.planVersions.count >= 1, true)
    assert.ok(Array.isArray(status.health))
    // viewer 可读（PR10 读面含 viewer）；非 owner 不能手动 tick
    s.svc.addMember(s.p.id, s.owner, { userId: 'u-v', role: 'viewer' })
    assert.ok(s.svc.kernelStatus(s.p.id, { id: 'u-v', role: 'user' }).project.id === s.p.id)
    assert.throws(() => s.svc.assertProjectOwner(s.p.id, { id: 'u-v', role: 'user' }), (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN')
    s.svc.assertProjectOwner(s.p.id, s.owner)
  }
  finally {
    s.db.close()
  }
})
