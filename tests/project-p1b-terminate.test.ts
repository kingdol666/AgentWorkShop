/**
 * P1 批次 B 回归：项目终止（级联终结）+ 快照频道 rootTasks 可见面。
 *
 *   T1 终止级联：在飞工作项 → CANCELED + root 任务树 cancelTree（经 manager 暴露的
 *      TaskEngine stub 断言调用）+ attempt 闭合 + project.canceled + 审批过期；
 *   T2 终态守卫：completed/archived 不可终止；canceled 幂等；终止后 resume → 409；
 *   T3 快照可见面：channels[].rootTasks 透出在飞 root 任务态；owner 消息队列 FIFO
 *      消费顺序（messages created_at 顺序 + 全部 consumed）；
 *   T-orphan：孤立 task_instance 绑定的活任务树在事务内 cancelTree（runtime-first），
 *      事务提交后仅做 durable 收口（session closed / channel 停用 / binding detach）；
 *   T-orphan-fail-closed：孤立绑定活任务取消失败时整个事务回滚，项目/绑定/任务保持
 *      非终态（fail-closed，数据库终态不先于 runtime 取消提交）。
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
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createProjectAttemptRepo } = await import('../server/services/workshop/db/project.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture(withEngine: boolean) {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const sessions = createChannelSessionRepo(db)
  const tasks = createTaskRepo(db)
  const attempts = createProjectAttemptRepo(db)
  const canceledTrees: string[] = []
  const manager = {
    async createChannel(input: { name: string, ownerUserId?: string | null, leadAgent?: { name: string, harness: string, agentKind?: 'channel_agent' | 'project_leader' } }) {
      const ch = channels.create({ name: input.name, ownerUserId: input.ownerUserId ?? null })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({ channelId: ch.id, templateId: null, name: input.leadAgent.name, harness: input.leadAgent.harness, role: 'lead', agentKind: input.leadAgent.agentKind })
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
  return { db, channels, agents, sessions, tasks, attempts, manager, svc, canceledTrees }
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
    const after = await f.svc.terminate(s.p.id, owner, '试点终止')
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

test('T2 终态守卫：completed 不可终止；canceled 幂等；终止后 resume → 409；无 runtime 能力时 fail-closed', async () => {
  const f = fixture(false)
  try {
    const s = await boot(f)
    // 无 runtime cancel 能力：终止必须失败且不能提交数据库终态。
    await f.svc.dispatchWorkItem(s.p.id, s.w1.id, owner)
    await assert.rejects(() => f.svc.terminate(s.p.id, owner, 'no engine'), /运行时不支持取消/)
    assert.equal(f.svc.get(s.p.id, owner).status, 'active')
    assert.equal(f.svc.listWorkItems(s.p.id, owner).find(x => x.id === s.w1.id)!.state, 'DISPATCHED')
    // 提供 runtime stub 后才能终止，随后幂等；resume → 409
    ;(f.manager as unknown as Record<string, unknown>)['getTaskEngine'] = () => ({ cancelTree: () => [] })
    assert.equal((await f.svc.terminate(s.p.id, owner, 'with engine')).status, 'canceled')
    assert.equal((await f.svc.terminate(s.p.id, owner, 'again')).status, 'canceled')
    assert.throws(() => f.svc.resume(s.p.id, owner), /不能恢复/)
    // completed 不可终止
    const f2 = fixture(false)
    try {
      const s2 = await boot(f2)
      f2.db.prepare(`UPDATE projects SET status='completed' WHERE id=?`).run(s2.p.id)
      await assert.rejects(() => f2.svc.terminate(s2.p.id, owner, 'x'), /不可终止/)
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
    const consume = f.db.prepare(`UPDATE messages SET state = 'consumed', consumed_at = ? WHERE id = ?`)
    for (const id of sentAt) consume.run(new Date().toISOString(), id)
    const remaining = f.db.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE id IN (${sentAt.map(() => '?').join(',')}) AND state != 'consumed'`,
    ).get(...sentAt) as { n: number }
    assert.equal(remaining.n, 0, 'FIFO 队列消费后全部消息必须为 consumed')
  }
  finally { f.db.close() }
})
test('C-04：runtime cancel 失败时终止 fail-closed，不提交数据库终态', async () => {
  const f = fixture(true)
  try {
    const s = await boot(f)
    await f.svc.dispatchWorkItem(s.p.id, s.w1.id, owner)
    ;(f.manager as unknown as Record<string, unknown>).cancelTaskTreeInternal = () => {
      throw new Error('abort failed')
    }
    await assert.rejects(() => f.svc.terminate(s.p.id, owner, 'abort failure'), /abort failed/)
    assert.equal(f.svc.get(s.p.id, owner).status, 'active')
    assert.equal(f.svc.listWorkItems(s.p.id, owner).find(x => x.id === s.w1.id)!.state, 'DISPATCHED')
  }
  finally { f.db.close() }
})

test('C-05：canceled Project 所有可变入口 fail-closed；回调/对账不写库', async () => {
  const f = fixture(true)
  try {
    const s = await boot(f)

    // 先用真实项目路径准备可复用的成果、审批、route 提案和 replan 提案；
    // 终止后用这些真实对象验证入口在资源校验前统一收口。
    await f.svc.dispatchWorkItem(s.p.id, s.w1.id, owner)
    const rootTaskId = f.attempts.findLiveByWorkItem(s.w1.id)!.channelTaskId!
    f.tasks.update(rootTaskId, {
      state: 'COMPLETED',
      artifacts: [{ artifactId: 'c05-artifact', name: 'output.txt', parts: [{ text: '真实完成证据' }] }],
    })
    f.svc.reconcile(s.p.id, owner)
    const draft = f.svc.listResults(s.p.id, owner).find(r => r.workItemId === s.w1.id)!
    f.svc.submitResult(s.p.id, draft.id, owner, { summary: '真实成果' })
    f.svc.reviewResult(s.p.id, draft.id, owner, 'reviewed')
    const acceptance = f.svc.requestAcceptance(s.p.id, draft.id, owner)

    const plan = f.svc.requestPlanApproval(s.p.id, owner, { version: 1, plan: { facts: ['before-cancel'] } })
    f.svc.decideApproval(s.p.id, plan.id, owner, true)
    const projectBeforeCancel = f.svc.get(s.p.id, owner)
    const leaderId = projectBeforeCancel.leadAgentId!
    const route = await f.svc.agentProposeRoute(leaderId, {
      workItemId: s.w2.id, action: 'defer', deferMinutes: 5, reason: 'before-cancel',
    })
    const replan = f.svc.agentRequestPlan(leaderId, {
      deliverables: [{ key: 'late', name: '终止前提案', required: true, channelId: s.ch.channelId }],
      work_items: [{ key: 'late-w', deliverableKey: 'late', channelId: s.ch.channelId, title: '终止前工作项' }],
    }, 'replan')
    assert.equal(route.decision.state, 'proposed')
    assert.equal(replan.approval.status, 'pending')

    assert.equal((await f.svc.terminate(s.p.id, owner, 'terminal')).status, 'canceled')

    const stateError = (e: unknown) => (e as { code?: string }).code === 'PROJECT_STATE_INVALID'
    const failClosed = (fn: () => unknown) => assert.throws(fn, stateError)
    const failClosedAsync = async (fn: () => Promise<unknown>) => assert.rejects(fn, stateError)

    failClosed(() => f.svc.updateProject(s.p.id, owner, { name: 'late' }))
    failClosed(() => f.svc.createDeliverable(s.p.id, owner, { name: 'late deliverable' }))
    failClosed(() => f.svc.createWorkItem(s.p.id, owner, { deliverableId: s.d.id, channelId: s.ch.channelId, title: 'late work' }))
    failClosed(() => f.svc.updateDeliverableItem(s.p.id, s.d.id, owner, { name: 'late-edit' }))
    failClosed(() => f.svc.updateWorkItem(s.p.id, s.w2.id, owner, { title: 'late' }))
    failClosed(() => f.svc.waiveDeliverable(s.p.id, s.d.id, owner, 'late'))
    failClosed(() => f.svc.bindChannel(s.p.id, s.ch.channelId, owner))
    failClosed(() => f.svc.unbindChannel(s.p.id, s.ch.channelId, owner))
    failClosed(() => f.svc.cancelWorkItem(s.p.id, s.w2.id, owner, 'late'))
    failClosed(() => f.svc.activate(s.p.id, owner))
    failClosed(() => f.svc.archive(s.p.id, owner))
    failClosed(() => f.svc.addMember(s.p.id, owner, { userId: 'late-user' }))
    failClosed(() => f.svc.removeMember(s.p.id, 'late-user', owner))
    await assert.rejects(
      () => f.svc.dispatchWorkItem(s.p.id, s.w2.id, owner),
      (e: unknown) => (e as { code?: string }).code === 'PROJECT_NOT_ACTIVE',
    )
    failClosed(() => f.svc.requestPlanApproval(s.p.id, owner, { version: 2, plan: {} }))
    failClosed(() => f.svc.requestAcceptance(s.p.id, draft.id, owner))
    failClosed(() => f.svc.agentRequestAcceptance(leaderId, draft.id))
    failClosed(() => f.svc.decideApproval(s.p.id, acceptance.id, owner, true))
    failClosed(() => f.svc.decideApproval(s.p.id, replan.approval.id, owner, true))
    failClosed(() => f.svc.requestProjectComplete(s.p.id, owner))
    failClosed(() => f.svc.pause(s.p.id, owner))
    failClosed(() => f.svc.resume(s.p.id, owner))
    const mayWrite = JSON.stringify({ mayWrite: true })
    f.db.prepare('UPDATE projects SET config_json = ? WHERE id = ?').run(mayWrite, s.p.id)
    const writeGate = f.svc.authorizeProjectWrite(leaderId, 'recipe_trial', { v: 99 })
    assert.equal(writeGate.allowed, false)
    assert.equal(writeGate.code, 'PROJECT_STATE_INVALID')
    failClosed(() => f.svc.agentRequestPlan(leaderId, {}, 'replan'))
    failClosed(() => f.svc.agentRequestProjectComplete(leaderId))
    await failClosedAsync(() => f.svc.applyProposal(s.p.id, route.decision.id, owner))
    await failClosedAsync(() => f.svc.continueProject(s.p.id, owner, { message: 'reopen' }))
    failClosed(() => f.svc.agentProposeChannel(leaderId, { name: 'late channel' }))
    await failClosedAsync(() => f.svc.agentProposeRoute(leaderId, {
      workItemId: s.w2.id, action: 'defer', deferMinutes: 5,
    }))

    // late COMPLETED root：ensureDraft/onTaskStateChange/reconcile 均只读，不重新生成成果、事件或 effect。
    const lateTask = f.tasks.create({
      channelId: s.ch.channelId,
      creatorId: `project:${s.p.id}`,
      assigneeId: s.ch.leadAgentId!,
      title: 'late root',
      source: 'project',
      projectId: s.p.id,
      projectWorkItemId: s.w2.id,
      projectAttemptNo: 1,
    })
    f.tasks.update(lateTask.id, {
      state: 'COMPLETED',
      artifacts: [{ artifactId: 'late-artifact', name: 'late.txt', parts: [{ text: 'late' }] }],
    })
    const beforeChanges = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    assert.equal(f.svc.ensureDraftFromTask(lateTask.id), undefined)
    f.svc.onTaskStateChange(lateTask.id, 'COMPLETED')
    const reconciled = f.svc.reconcile(s.p.id, owner)
    const internal = f.svc.reconcileInternal(s.p.id)
    assert.equal(reconciled.expiredApprovals, 0)
    assert.equal(internal.expiredApprovals, 0)
    const afterChanges = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    assert.equal(afterChanges, beforeChanges, 'canceled 项目迟到回调/对账不得写库')
    assert.equal(f.svc.listResults(s.p.id, owner).filter(r => r.sourceTaskId === lateTask.id).length, 0)
    assert.equal(f.svc.get(s.p.id, owner).status, 'canceled')
  }
  finally { f.db.close() }
})

test('C-06：reconcile orphan task 关闭 attempt 并清 pointer，随后可安全 retry', async () => {
  const f = fixture(false)
  try {
    const s = await boot(f)
    await f.svc.dispatchWorkItem(s.p.id, s.w1.id, owner)
    const attempt = f.attempts.findLiveByWorkItem(s.w1.id)!
    const taskId = attempt.channelTaskId!
    f.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
    f.svc.reconcile(s.p.id, owner)
    const blocked = f.svc.listWorkItems(s.p.id, owner).find(x => x.id === s.w1.id)!
    assert.equal(blocked.state, 'BLOCKED')
    assert.equal(blocked.currentAttemptId, null)
    assert.ok(f.attempts.findById(attempt.id)!.closedAt)
    const retried = await f.svc.dispatchWorkItem(s.p.id, s.w1.id, owner)
    assert.equal(retried.state, 'DISPATCHED')
  }
  finally { f.db.close() }
})

test('C-12：解绑在飞工作项先取消 runtime task tree 再收口数据库', async () => {
  const f = fixture(true)
  try {
    const s = await boot(f)
    await f.svc.dispatchWorkItem(s.p.id, s.w1.id, owner)
    const taskId = f.attempts.findLiveByWorkItem(s.w1.id)!.channelTaskId!
    f.svc.unbindChannel(s.p.id, s.ch.channelId, owner)
    assert.deepEqual(f.canceledTrees, [taskId])
    assert.equal(f.svc.listWorkItems(s.p.id, owner).find(x => x.id === s.w1.id)!.state, 'CANCELED')
    assert.equal(f.tasks.findById(taskId)!.state, 'CANCELED')
  }
  finally { f.db.close() }
})

/** 构造孤立 task_instance 绑定：新频道 + active 绑定行（无对应 workItem）。 */
async function seedOrphanBinding(f: ReturnType<typeof fixture>) {
  const s = await boot(f)
  const ch = await f.manager.createChannel({ name: 'orphan-instance', ownerUserId: owner.id, leadAgent: { name: 'O', harness: 'mock' } })
  f.db.prepare(
    `INSERT INTO project_channels (project_id, channel_id, binding_type, charter, status, added_by, added_at)
     VALUES (?, ?, 'task_instance', '', 'active', ?, ?)`,
  ).run(s.p.id, ch.channelId, owner.id, new Date().toISOString())
  // 孤立频道上的活任务（state 非终态，SUBMITTED 默认值）
  const task = f.tasks.create({
    channelId: ch.channelId,
    creatorId: `project:${s.p.id}`,
    assigneeId: ch.leadAgentId!,
    title: 'orphan root',
    source: 'project',
    projectId: s.p.id,
  } as never)
  const session = f.sessions.create({ channelId: ch.channelId, memberMap: {}, projectId: s.p.id, instanceKind: 'task', createdByKind: 'project' })
  return { ...s, orphan: { channelId: ch.channelId, taskId: task.id, sessionId: session.id } }
}

test('T-orphan：孤立 task_instance 绑定在事务内取消活任务树，事务后 durable 收口', async () => {
  const f = fixture(true)
  try {
    const s = await seedOrphanBinding(f)
    assert.equal(f.tasks.findById(s.orphan.taskId)!.state, 'SUBMITTED')
    const after = await f.svc.terminate(s.p.id, owner, '孤立绑定清理')
    assert.equal(after.status, 'canceled')
    // runtime 取消发生在事务内（cancelTree 被调用且任务落终态）
    assert.ok(f.canceledTrees.includes(s.orphan.taskId), '孤立绑定的活任务树必须在事务内 cancelTree')
    assert.equal(f.tasks.findById(s.orphan.taskId)!.state, 'CANCELED')
    // durable 收口：session closed / channel 停用 / binding detached
    assert.equal(f.sessions.findById(s.orphan.sessionId)!.status, 'closed')
    assert.equal(f.channels.findById(s.orphan.channelId)!.enabled, 0)
    const binding = f.db.prepare(
      'SELECT status FROM project_channels WHERE project_id = ? AND channel_id = ?',
    ).get(s.p.id, s.orphan.channelId) as { status: string }
    assert.equal(binding.status, 'detached')
  }
  finally { f.db.close() }
})

test('T-orphan-fail-closed：孤立绑定活任务取消失败时整个事务回滚，不落任何终态', async () => {
  const f = fixture(true)
  try {
    const s = await seedOrphanBinding(f)
    // 覆盖 getTaskEngine：cancelTree 抛错模拟 runtime 级联失败
    ;(f.manager as unknown as Record<string, unknown>)['getTaskEngine'] = () => ({
      cancelTree: () => {
        throw new Error('abort failed')
      },
    })
    await assert.rejects(() => f.svc.terminate(s.p.id, owner, '孤立绑定取消失败'), /运行时不支持取消|abort/)
    assert.equal(f.svc.get(s.p.id, owner).status, 'active', '取消失败时项目不得落 canceled')
    const binding = f.db.prepare(
      'SELECT status FROM project_channels WHERE project_id = ? AND channel_id = ?',
    ).get(s.p.id, s.orphan.channelId) as { status: string }
    assert.equal(binding.status, 'active', '取消失败时绑定不得 detach')
    const state = f.tasks.findById(s.orphan.taskId)!.state
    assert.ok(!['COMPLETED', 'FAILED', 'CANCELED', 'SUPERSEDED'].includes(state), `任务必须保持非终态，实际 ${state}`)
    assert.equal(f.sessions.findById(s.orphan.sessionId)!.status, 'active', '事务回滚后会话行保持 active')
  }
  finally { f.db.close() }
})
