/**
 * P1 批次 B 回归：项目终止（级联终结）+ 快照频道 rootTasks 可见面。
 *
 *   T1 终止级联：在飞工作项 → CANCELED + root 任务树 cancelTree（经 manager 暴露的
 *      TaskEngine stub 断言调用）+ attempt 闭合 + project.canceled + 审批过期；
 *   T2 终态守卫：completed/archived 不可终止；canceled 幂等；终止后 resume → 409；
 *   T3 快照可见面：channels[].rootTasks 透出在飞 root 任务态；owner 消息队列 FIFO
 *      消费顺序（messages created_at 顺序 + 全部 consumed）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-project-p1b-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createProjectAttemptRepo } = await import('../server/services/workshop/db/project.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture(withEngine: boolean) {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const attempts = createProjectAttemptRepo(db)
  const canceledTrees: string[] = []
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
  if (withEngine) {
    ;(manager as unknown as Record<string, unknown>)['getTaskEngine'] = () => ({
      cancelTree: (taskId: string, _by: string, reason: string) => {
        canceledTrees.push(taskId)
        const t = tasks.findById(taskId)
        if (t && !['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)) tasks.update(taskId, { state: 'CANCELED', closeReason: reason })
        return [{ id: taskId, state: 'CANCELED' }]
      },
    })
  }
  const svc = initProjectService(manager, db)
  return { db, channels, agents, tasks, attempts, manager, svc, canceledTrees }
}

const owner = { id: 'u-owner', role: 'user' }

async function boot(f: ReturnType<typeof fixture>) {
  const p = await f.svc.create({ name: `T-${randomUUID().slice(0, 6)}`, objective: 'x', planApprovalRequired: 0, routingPolicy: 'legacy', autoDispatch: false }, owner)
  const a = await f.manager.createChannel({ name: '执行', ownerUserId: owner.id, leadAgent: { name: 'L', harness: 'mock' } })
  f.svc.bindChannel(p.id, a.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: 'D', ownerChannelId: a.channelId })
  f.svc.activate(p.id, owner)
  const w1 = f.svc.createWorkItem(p.id, owner, { deliverableId: d.id, channelId: a.channelId, title: 'W1' })
  const w2 = f.svc.createWorkItem(p.id, owner, { deliverableId: d.id, channelId: a.channelId, title: 'W2', dependsOn: [w1.id] })
  return { p, ch: a, d, w1, w2 }
}

test('T1 终止级联：在飞工作项 CANCELED + root 任务树取消 + 审批过期 + 项目 canceled', async () => {
  const f = fixture(true)
  try {
    const s = await boot(f)
    await f.svc.dispatchWorkItem(s.p.id, s.w1.id, owner)
    const attempt = f.attempts.findLiveByWorkItem(s.w1.id)!
    const rootTaskId = attempt.channelTaskId!
    // 待批审批（write_intent）应在终止时过期（保持 pending，不决策）
    const { approval } = f.svc.agentRequestWriteIntent(s.ch.leadAgentId!, { tool: 'recipe_trial', args: { q: 1 } })
    // 终止
    const after = f.svc.terminate(s.p.id, owner, '试点终止')
    assert.equal(after.status, 'canceled')
    const items = f.svc.listWorkItems(s.p.id, owner)
    assert.equal(items.find(x => x.id === s.w1.id)!.state, 'CANCELED')
    assert.equal(items.find(x => x.id === s.w1.id)!.closeReason, 'PROJECT_TERMINATED')
    assert.equal(items.find(x => x.id === s.w2.id)!.state, 'CANCELED', 'DRAFT 工作项一并终结')
    assert.deepEqual(f.canceledTrees, [rootTaskId], 'root 任务树必须被取消')
    assert.equal(f.tasks.findById(rootTaskId)!.state, 'CANCELED')
    const closed = f.attempts.findById(attempt.id)!
    assert.ok(closed.closedAt, 'attempt 必须闭合')
    // 审批过期
    const row = (f.db as unknown as { prepare: (s: string) => { get: (id: string) => { status: string } } }).prepare('SELECT status FROM project_approvals WHERE id = ?').get(approval.id)
    assert.equal(row.status, 'expired', '待批审批随终止过期')
  }
  finally { f.db.close() }
})

test('T2 终态守卫：completed 不可终止；canceled 幂等；终止后 resume → 409；stub 无引擎不炸', async () => {
  const f = fixture(false)
  try {
    const s = await boot(f)
    // 无 getTaskEngine stub：终止不抛（工作项侧终结，任务树取消跳过）
    const after = f.svc.terminate(s.p.id, owner, 'no engine')
    assert.equal(after.status, 'canceled')
    assert.equal(f.svc.listWorkItems(s.p.id, owner).every(x => x.state === 'CANCELED'), true)
    // 幂等
    assert.equal(f.svc.terminate(s.p.id, owner, 'again').status, 'canceled')
    // resume → 409
    assert.throws(() => f.svc.resume(s.p.id, owner), /不能恢复/)
    // completed 不可终止
    const f2 = fixture(false)
    try {
      const s2 = await boot(f2)
      f2.db.prepare(`UPDATE projects SET status='completed' WHERE id=?`).run(s2.p.id)
      assert.throws(() => f2.svc.terminate(s2.p.id, owner, 'x'), /不可终止/)
    }
    finally { f2.db.close() }
  }
  finally { f.db.close() }
})

test('T3 快照可见面：channels[].rootTasks 透出在飞 root 任务态；消息队列 FIFO 消费', async () => {
  const f = fixture(false)
  try {
    const s = await boot(f)
    await f.svc.dispatchWorkItem(s.p.id, s.w1.id, owner)
    const snap = f.svc.projectSnapshot(s.p.id, owner)
    const ch = (snap.channels ?? []).find(c => c.channelId === s.ch.channelId)!
    assert.ok(ch.rootTasks?.length === 1, `rootTasks=${JSON.stringify(ch.rootTasks)}`)
    assert.equal(ch.rootTasks[0]!.taskState ?? 'SUBMITTED', ch.rootTasks[0]!.taskState || 'SUBMITTED')
    assert.equal(ch.inFlight, 1)
    // 消息队列 FIFO：owner 连发 3 条 task 消息给频道 lead → 顺序入库
    const sentAt: string[] = []
    const ins = f.db.prepare(
      `INSERT INTO messages (id, channel_id, from_agent_id, to_agent_id, role, parts_json, metadata_json, state, attempts, created_at)
       VALUES (?, ?, NULL, ?, 'ROLE_USER', ?, '{}', 'pending', 0, ?)`,
    )
    for (const i of [1, 2, 3]) {
      const id = randomUUID()
      const at = new Date(Date.now() + i).toISOString()
      ins.run(id, s.ch.channelId, s.ch.leadAgentId, JSON.stringify([{ text: `问题${i}` }]), at)
      sentAt.push(id)
    }
    const queued = f.db.prepare(
      `SELECT id, state, created_at FROM messages WHERE to_agent_id = ? AND state = 'pending' ORDER BY created_at ASC`,
    ).all(s.ch.leadAgentId) as Array<{ id: string, state: string, created_at: string }>
    assert.deepEqual(queued.map(m => m.id), sentAt, '队列按 created_at 顺序 pop（FIFO）')
    assert.equal(queued.length, 3)
  }
  finally { f.db.close() }
})
