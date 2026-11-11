/**
 * H0 取消/终止硬停回归：
 *  1) 开工栅栏：project 来源任务进入 WORKING 前校验项目/工作项/attempt。
 *  2) submit 返回后 CAS：取消窗口内不落 DISPATCHED，任务树被取消、attempt 闭合。
 *  3) cancelWorkItem / terminate 统一 cancelTree（含 abort 入口）；重复 terminate 仍扫尾。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-h0-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
const { TaskEngine } = await import('../server/services/workshop/runtime/task-engine')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

type Fixture = ReturnType<typeof fixture>

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const cancelCalls: Array<{ taskId: string, by: string, reason: string }> = []
  let onSubmit: (() => Promise<void> | void) | null = null

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
      if (onSubmit) await onSubmit()
      const ch = channels.findById(input.channelId)!
      const row = tasks.create({
        channelId: input.channelId, creatorId: `project:${input.projectId}`, assigneeId: ch.leadAgentId!,
        title: input.title, description: input.description, sourceChatMessageId: input.sourceKey,
        deadlineAt: new Date(Date.now() + (input.execBudgetMinutes ?? 60) * 60_000).toISOString(),
        source: 'project', projectId: input.projectId, projectWorkItemId: input.workItemId, projectAttemptNo: input.attemptNo,
      })
      return { task: { id: row.id } as never, created: true }
    },
    cancelTaskTreeInternal(taskId: string, by: string, reason: string) {
      cancelCalls.push({ taskId, by, reason })
      return [{ id: taskId, state: 'CANCELED' }]
    },
  } as unknown as AgentChannelManager

  const svc = initProjectService(manager, db)
  return {
    db, channels, tasks, manager, svc, cancelCalls,
    setOnSubmit(fn: (() => Promise<void> | void) | null) { onSubmit = fn },
  }
}

async function activeProject(f: Fixture) {
  const owner = { id: 'u-owner', role: 'user' as const }
  const p = await f.svc.create({ name: 'H0项目', objective: '取消硬停', planApprovalRequired: 0 }, owner)
  const member = await f.manager.createChannel({ name: '执行频道', ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' } })
  f.svc.bindChannel(p.id, member.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: '交付物', ownerChannelId: member.channelId })
  const w = f.svc.createWorkItem(p.id, owner, { deliverableId: d.id, channelId: member.channelId, title: '工作项', brief: 'x', dedupeKey: `w-${Date.now()}` })
  f.svc.activate(p.id, owner)
  return { owner, p, member, d, w }
}

test('H0 开工栅栏：项目 pause/terminate 后 project 任务不可进入 WORKING', async () => {
  const f = fixture()
  const s = await activeProject(f)
  const task = f.tasks.create({
    channelId: s.member.channelId, creatorId: 'project', assigneeId: s.member.leadAgentId!,
    title: 'project root', source: 'project', projectId: s.p.id, projectWorkItemId: s.w.id, projectAttemptNo: 1,
  } as never)
  assert.equal(f.svc.isProjectTaskRunnable(s.p.id, task.id), true)
  f.svc.pause(s.p.id, s.owner)
  assert.equal(f.svc.isProjectTaskRunnable(s.p.id, task.id), false)
})

test('H0 开工栅栏：TaskEngine 在 WORKING 迁移处拒绝不可执行的项目任务', () => {
  const db = openWorkshopDb(':memory:')
  const tasks = createTaskRepo(db)
  const messages = createMessageRepo(db)
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const ch = channels.create({ name: 'guard-ch' })
  const lead = agents.create({ channelId: ch.id, templateId: null, name: 'Lead', harness: 'mock', role: 'lead' })
  const engine = new TaskEngine({ tasks, messages }, {
    guardProjectTaskStart: t => t.projectId !== 'p-canceled',
  })
  const row = tasks.create({
    channelId: ch.id, creatorId: 'project', assigneeId: lead.id, title: 'x',
    source: 'project', projectId: 'p-canceled', projectWorkItemId: 'w', projectAttemptNo: 1,
  } as never)
  const task = engine.get(row.id)!
  assert.throws(
    () => engine.transition(task.id, 'WORKING', 'agent'),
    (err: unknown) => (err as { code?: string }).code === 'PROJECT_NOT_ACTIVE',
  )
  assert.equal(tasks.findById(row.id)!.state, 'SUBMITTED')
})

test('H0 派发后 CAS：submit 期间 terminate → 不落 DISPATCHED、任务树取消、attempt 闭合', async () => {
  const f = fixture()
  const s = await activeProject(f)
  f.setOnSubmit(async () => {
    await f.svc.terminate(s.p.id, s.owner, 'submit 窗口取消')
  })
  await assert.rejects(
    () => f.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner),
    (err: unknown) => (err as { code?: string }).code === 'PROJECT_STATE_CHANGED',
  )
  const wi = f.svc.listWorkItems(s.p.id, s.owner).find(x => x.id === s.w.id)!
  assert.equal(wi.state, 'CANCELED')
  assert.equal(wi.closedAt !== null, true)
  const attempts = f.db.prepare('SELECT closed_at AS closedAt, state FROM project_work_item_attempts WHERE work_item_id = ?').all(s.w.id) as Array<{ closedAt: string | null, state: string }>
  assert.equal(attempts.length, 1)
  assert.notEqual(attempts[0].closedAt, null)
  assert.ok(f.cancelCalls.length >= 1, 'cancelTaskTreeInternal 必须被调用')
})

test('H0 cancelWorkItem：关闭 attempt 的同时取消任务树', async () => {
  const f = fixture()
  const s = await activeProject(f)
  const wi = await f.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
  assert.equal(wi.state, 'DISPATCHED')
  const taskId = f.db.prepare('SELECT channel_task_id AS taskId FROM project_work_item_attempts WHERE work_item_id = ?').get(s.w.id) as { taskId: string }
  assert.ok(taskId.taskId)
  f.cancelCalls.length = 0
  f.svc.cancelWorkItem(s.p.id, s.w.id, s.owner, 'owner 取消')
  assert.ok(f.cancelCalls.some(c => c.taskId === taskId.taskId), 'cancelTaskTreeInternal 必须以 channelTaskId 调用')
})

test('H0 terminate 幂等扫尾：工作项已 CANCELED 但任务仍在飞，重复 terminate 仍取消', async () => {
  const f = fixture()
  const s = await activeProject(f)
  await f.svc.dispatchWorkItem(s.p.id, s.w.id, s.owner)
  const attempt = f.db.prepare('SELECT channel_task_id AS taskId FROM project_work_item_attempts WHERE work_item_id = ?').get(s.w.id) as { taskId: string }
  // 模拟取消竞态残留：工作项已终态，但任务仍非终态。
  f.db.prepare(`UPDATE project_work_items SET state='CANCELED', closed_at=?, close_reason='OWNER_CANCELED' WHERE id=?`).run(new Date().toISOString(), s.w.id)
  f.cancelCalls.length = 0
  await f.svc.terminate(s.p.id, s.owner, '重复终止扫尾')
  assert.ok(f.cancelCalls.some(c => c.taskId === attempt.taskId), '重复 terminate 必须扫尾在飞任务')
})
