/**
 * PR20：Project Route 派发闭环回归（plan 2026-11-05 R1–R8/R11）。
 *
 * 主逻辑：Project 作为对 Channel 的上层 route —— 派发 W1 → root 终态回调
 * （reconcile 收敛）→ 自动派发 W2 → … 直到全部工作项终态（项目完成仍走 owner 审批门）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-route-dispatch-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createProjectEventRepo, createProjectAttemptRepo } = await import('../server/services/workshop/db/project.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
const { selectReadyWorkItems } = await import('../server/services/workshop/projects/route-dispatcher')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const attempts = createProjectAttemptRepo(db)
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
  return { db, channels, tasks, attempts, manager, svc, events: createProjectEventRepo(db) }
}

type Fixture = ReturnType<typeof fixture>

/** autoDispatch/planApprovalRequired 可调的 active 项目；chainTitles 依序建依赖链。 */
async function routeProject(f: Fixture, chainTitles: string[], opts: { autoDispatch?: boolean, planApprovalRequired?: number } = {}) {
  const owner = { id: 'u-owner', role: 'user' }
  const p = await f.svc.create({
    name: `Route 项目-${randomUUID().slice(0, 8)}`, objective: 'route dispatch loop',
    planApprovalRequired: opts.planApprovalRequired ?? 0,
    autoDispatch: opts.autoDispatch ?? true,
  }, owner)
  const member = await f.manager.createChannel({ name: `Route 频道-${randomUUID().slice(0, 8)}`, ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' } })
  f.svc.bindChannel(p.id, member.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: 'Route 交付物', ownerChannelId: member.channelId })
  const items: ReturnType<Fixture['svc']['createWorkItem']>[] = []
  chainTitles.forEach((title, i) => {
    items.push(f.svc.createWorkItem(p.id, owner, {
      deliverableId: d.id, channelId: member.channelId, title,
      dependsOn: i > 0 ? [items[i - 1]!.id] : [],
    }))
  })
  f.svc.activate(p.id, owner)
  return { owner, p, member, d, items }
}

const ownerOf = (s: { owner: { id: string, role: string } }) => s.owner

function workItems(f: Fixture, projectId: string) {
  return f.svc.listWorkItems(projectId, { id: 'u-owner', role: 'user' })
}

function byTitle(f: Fixture, projectId: string, title: string) {
  const wi = workItems(f, projectId).find(w => w.title === title)
  assert.ok(wi, `工作项 ${title} 不存在`)
  return wi
}

function stateOf(f: Fixture, projectId: string, title: string) {
  return workItems(f, projectId).find(w => w.title === title)?.state
}

function eventsOf(f: Fixture, projectId: string, type: string) {
  return f.events.listByProject(projectId).filter(e => e.type === type)
}

function eventPayload(e: { payloadJson: string }): Record<string, unknown> {
  try {
    return JSON.parse(e.payloadJson) as Record<string, unknown>
  }
  catch {
    return {}
  }
}

/** 模拟 Channel lead 完成：把工作项在飞 attempt 的 root task 置 COMPLETED。 */
function completeRoot(f: Fixture, projectId: string, title: string) {
  const wi = byTitle(f, projectId, title)
  const attempt = wi.currentAttemptId ? f.attempts.findById(wi.currentAttemptId) : undefined
  assert.ok(attempt?.channelTaskId, `工作项 ${title} 无在飞 root`)
  f.tasks.update(attempt.channelTaskId!, { state: 'COMPLETED', progress: 100 })
}

test('R2+R6 链式回调：W1 完成前 W2 不派发；route loop 收敛后 W2 自动 DISPATCHED', async () => {
  const f = fixture()
  try {
    const s = await routeProject(f, ['R1 基线', 'R2 分析'])
    const owner = ownerOf(s)
    const w1 = byTitle(f, s.p.id, 'R1 基线')
    await f.svc.dispatchWorkItem(s.p.id, w1.id, owner)
    assert.equal(stateOf(f, s.p.id, 'R1 基线'), 'DISPATCHED')
    assert.equal(stateOf(f, s.p.id, 'R2 分析'), 'DRAFT')
    // R1：手动派发落 work.dispatched（此前手动派发无事件）
    assert.equal(eventsOf(f, s.p.id, 'work.dispatched').length, 1)
    // W1 在飞：route loop 不派下游
    const r1 = await f.svc.runRouteLoop(s.p.id)
    assert.equal(r1.autoDispatch.dispatched.length, 0)
    assert.equal(stateOf(f, s.p.id, 'R2 分析'), 'DRAFT')
    // 回调：W1 root COMPLETED → 同一 route loop 内收敛 + W2 自动派发（R6，无人工介入）
    completeRoot(f, s.p.id, 'R1 基线')
    const r2 = await f.svc.runRouteLoop(s.p.id)
    assert.equal(r2.autoDispatch.dispatched.length, 1)
    assert.equal(stateOf(f, s.p.id, 'R2 分析'), 'DISPATCHED')
    // R1：自动派发落 work.dispatch_auto，payload 带正确 workItemId
    const autoEvents = eventsOf(f, s.p.id, 'work.dispatch_auto')
    assert.equal(autoEvents.length, 1)
    assert.equal(eventPayload(autoEvents[0]!).workItemId, byTitle(f, s.p.id, 'R2 分析').id)
  }
  finally { f.db.close() }
})

test('R9 三环链式：C1→C2→C3 逐环自动派发直至全部 COMPLETED', async () => {
  const f = fixture()
  try {
    const s = await routeProject(f, ['C1', 'C2', 'C3'])
    const owner = ownerOf(s)
    await f.svc.dispatchWorkItem(s.p.id, byTitle(f, s.p.id, 'C1').id, owner)
    for (const title of ['C1', 'C2', 'C3']) {
      assert.equal(stateOf(f, s.p.id, title), 'DISPATCHED', `环节 ${title} 未被派发`)
      completeRoot(f, s.p.id, title)
      await f.svc.runRouteLoop(s.p.id)
    }
    assert.deepEqual(workItems(f, s.p.id).map(w => w.state), ['COMPLETED', 'COMPLETED', 'COMPLETED'])
    assert.equal(eventsOf(f, s.p.id, 'work.dispatch_auto').length, 2)
  }
  finally { f.db.close() }
})

test('R3 开关：autoDispatch=false 不派发；owner 切 true 后派发', async () => {
  const f = fixture()
  try {
    const s = await routeProject(f, ['S1', 'S2'], { autoDispatch: false })
    const owner = ownerOf(s)
    assert.equal(f.svc.projectSnapshot(s.p.id, owner).project.autoDispatch, false)
    await f.svc.dispatchWorkItem(s.p.id, byTitle(f, s.p.id, 'S1').id, owner)
    completeRoot(f, s.p.id, 'S1')
    const r1 = await f.svc.runRouteLoop(s.p.id)
    assert.equal(r1.autoDispatch.dispatched.length, 0)
    assert.equal(stateOf(f, s.p.id, 'S2'), 'DRAFT')
    // owner 切换开关（切换落 project.updated 审计）
    f.svc.updateProject(s.p.id, owner, { autoDispatch: true })
    assert.equal(f.svc.projectSnapshot(s.p.id, owner).project.autoDispatch, true)
    const r2 = await f.svc.runRouteLoop(s.p.id)
    assert.equal(r2.autoDispatch.dispatched.length, 1)
    assert.equal(stateOf(f, s.p.id, 'S2'), 'DISPATCHED')
  }
  finally { f.db.close() }
})

test('R4 计划门：planApprovalRequired=1 且 plan_version=0 → 自动派发器不派发', async () => {
  const f = fixture()
  try {
    const s = await routeProject(f, ['G1', 'G2'], { planApprovalRequired: 1 })
    const r = await f.svc.runRouteLoop(s.p.id)
    assert.equal(r.autoDispatch.skippedByGate, true)
    assert.equal(r.autoDispatch.dispatched.length, 0)
    assert.equal(stateOf(f, s.p.id, 'G1'), 'DRAFT')
    assert.equal(stateOf(f, s.p.id, 'G2'), 'DRAFT')
  }
  finally { f.db.close() }
})

test('R5 失败隔离：目标频道禁用 → 该项 BLOCKED + work.blocked（SLOW 邮箱），其他项目不受影响', async () => {
  const f = fixture()
  try {
    const s = await routeProject(f, ['F1'])
    const owner = ownerOf(s)
    const bad = await f.manager.createChannel({ name: '失联频道', ownerUserId: owner.id, leadAgent: { name: 'Bad Lead', harness: 'mock' } })
    f.channels.update(bad.channelId, { enabled: 0 })
    const p2 = await f.svc.create({ name: `失联项目-${randomUUID().slice(0, 8)}`, objective: 'isolation', planApprovalRequired: 0, autoDispatch: true }, owner)
    f.svc.bindChannel(p2.id, bad.channelId, owner)
    const d2 = f.svc.createDeliverable(p2.id, owner, { name: '失联交付物', ownerChannelId: bad.channelId })
    f.svc.createWorkItem(p2.id, owner, { deliverableId: d2.id, channelId: bad.channelId, title: 'B1' })
    f.svc.activate(p2.id, owner)
    const r = await f.svc.runRouteLoop(p2.id)
    assert.equal(r.autoDispatch.dispatched.length, 0)
    assert.equal(r.autoDispatch.failed, 1)
    assert.equal(stateOf(f, p2.id, 'B1'), 'BLOCKED')
    assert.ok(eventsOf(f, p2.id, 'work.blocked').length >= 1)
    // 隔离面：好项目照常自动派发
    assert.equal(stateOf(f, s.p.id, 'F1'), 'DRAFT')
    const r2 = await f.svc.runRouteLoop(s.p.id)
    assert.equal(r2.autoDispatch.dispatched.length, 1)
  }
  finally { f.db.close() }
})

test('R7 排序：selectReadyWorkItems 依赖过滤 + priority DESC / createdAt ASC', () => {
  const mk = (id: string, state: string, deps: string[], priority?: number, createdAt = '2026-11-05T00:00:00Z') => ({
    id, state, currentAttemptId: null, dependsOnJson: JSON.stringify(deps), priority, createdAt,
  })
  const rows = [
    mk('a', 'COMPLETED', []),
    mk('b', 'DRAFT', ['a'], 1, '2026-11-05T00:00:01Z'),
    mk('c', 'DRAFT', ['a'], 5, '2026-11-05T00:00:02Z'),
    mk('d', 'DRAFT', ['a'], 5, '2026-11-05T00:00:00Z'),
    mk('e', 'DRAFT', ['b']),
    mk('g', 'DISPATCHED', []),
    mk('h', 'DRAFT', ['missing']),
  ] as unknown as Parameters<typeof selectReadyWorkItems>[0]
  assert.deepEqual(selectReadyWorkItems(rows).map(w => w.id), ['d', 'c', 'b'])
})

test('R10+R11 完成门与默认值：自动派发不自动完成项目；缺省项目 autoDispatch=false', async () => {
  const f = fixture()
  try {
    const owner = { id: 'u-owner', role: 'user' }
    const p = await f.svc.create({ name: `默认项目-${randomUUID().slice(0, 8)}`, objective: 'defaults', planApprovalRequired: 0 }, owner)
    assert.equal(f.svc.projectSnapshot(p.id, owner).project.autoDispatch, false)
    const s = await routeProject(f, ['D1'])
    const r = await f.svc.runRouteLoop(s.p.id)
    assert.equal(r.autoDispatch.dispatched.length, 1)
    completeRoot(f, s.p.id, 'D1')
    await f.svc.runRouteLoop(s.p.id)
    assert.equal(stateOf(f, s.p.id, 'D1'), 'COMPLETED')
    // R10：工作项全 COMPLETED ≠ 项目 completed（完成必须走 requestCompletion + owner 批准）
    const after = f.svc.get(s.p.id, ownerOf(s))
    assert.equal(after?.status, 'active')
  }
  finally { f.db.close() }
})
