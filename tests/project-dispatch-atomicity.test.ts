/**
 * WP1 派发原子化回归（plan 2026-11-07-harness-orchestration-hardening-plan.md §3）：
 *
 *   DA-1 同一工作项并发派发（手动双发）→ 恰一个 attempt / 另一路 WORK_ITEM_IN_FLIGHT /
 *        只创建一个任务实例（串行链：后到者在 liveAttempt 校验处失败，不再各自先建实例）
 *   DA-2 attempt 序号唯一约束的错误签名（catch 的冲突识别依赖此消息形态）
 *   DA-3 claimForDispatch CAS：DRAFT 一次成功、二次失败，attempt_count 只 +1
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sha256 } from '../shared/context/hash'
import { createTaskInstanceChannel } from '../server/services/workshop/agents/task-channel'
import type { TaskInstanceDeps } from '../server/services/workshop/agents/task-channel'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createChannelSessionRepo } from '../server/services/workshop/db/channel-session.repo'
import { createProjectAttemptRepo, createProjectWorkItemRepo } from '../server/services/workshop/db/project.repo'
import { ProjectService } from '../server/services/workshop/projects/service'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'

interface CreatedInstance { channelId: string, sessionId: string }

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const sessions = createChannelSessionRepo(db)
  const createdInstances: CreatedInstance[] = []

  const manager = {
    async createChannel(input: Parameters<TaskInstanceDeps['createChannel']>[0] & {
      leadAgent: { agentKind?: 'channel_agent' | 'project_leader' }
    }) {
      const ch = channels.create({
        name: input.name,
        description: input.description,
        scenarioPrompt: input.scenarioPrompt,
        ownerUserId: input.ownerUserId ?? null,
      })
      const workspace = `data/workspaces/${ch.id}`
      channels.update(ch.id, { workspace })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({
          channelId: ch.id,
          templateId: null,
          name: input.leadAgent.name,
          harness: input.leadAgent.harness,
          config: input.leadAgent.config,
          prefabBindingJson: input.leadAgent.prefabBindingJson,
          role: 'lead',
          agentKind: input.leadAgent.agentKind ?? 'channel_agent',
        })
        channels.update(ch.id, { leadAgentId: inst.id, enabled: 1 })
        leadAgentId = inst.id
      }
      return { channelId: ch.id, leadAgentId, workspace }
    },
    async updateChannel(id: string, patch: Record<string, unknown>) {
      return channels.update(id, patch as never)!
    },
    getChannelForUser(id: string) {
      const ch = channels.findById(id)
      return ch ? { ...ch, agents: [] } : null
    },
    async getChannel(id: string) {
      return channels.findById(id) ?? null
    },
    async submitProjectRoot(input: {
      projectId: string
      workItemId: string
      attemptNo: number
      sourceKey: string
      traceId?: string
      channelId: string
      sessionId?: string
      title: string
      description?: string
      execBudgetMinutes?: number
    }) {
      const ch = channels.findById(input.channelId)!
      const row = tasks.create({
        channelId: input.channelId,
        creatorId: `project:${input.projectId}`,
        assigneeId: ch.leadAgentId!,
        title: input.title,
        description: input.description,
        sourceChatMessageId: input.sourceKey,
        deadlineAt: new Date(Date.now() + (input.execBudgetMinutes ?? 60) * 60_000).toISOString(),
        source: 'project',
        projectId: input.projectId,
        projectWorkItemId: input.workItemId,
        projectAttemptNo: input.attemptNo,
        traceId: input.traceId,
        sessionId: input.sessionId,
      })
      return { task: { id: row.id } as never, created: true }
    },
    async createTaskInstance(input: Parameters<AgentChannelManager['createTaskInstance']>[0]) {
      const instance = await createTaskInstanceChannel({
        channels,
        channelAgents: agents,
        sessions,
        createChannel: ch => this.createChannel(ch),
      }, { ...input, actorId: input.actor.id })
      createdInstances.push(instance)
      return instance
    },
    async closeChannelSession(input: { sessionId: string, channelId: string }) {
      sessions.close(input.sessionId)
    },
  } as unknown as AgentChannelManager

  return { db, manager, channels, agents, sessions, createdInstances, tasks }
}

/** 建项目→成员频道→交付物→工作项→激活（与 project-core 同一最小路径） */
async function prepareWorkItem(f: ReturnType<typeof fixture>) {
  const svc = new ProjectService(f.manager, f.db)
  const owner = { id: 'u-1', role: 'user' as const }
  const p = await svc.create({ name: '并发派发项目', objective: '验证派发原子性', planApprovalRequired: 0 }, owner)
  const member = await f.manager.createChannel({
    name: '执行频道',
    ownerUserId: 'u-1',
    leadAgent: { name: 'Lead', harness: 'mock', agentKind: 'channel_agent' },
  })
  svc.bindChannel(p.id, member.channelId, owner)
  const d = svc.createDeliverable(p.id, owner, { name: '基线', ownerChannelId: member.channelId })
  const w = svc.createWorkItem(p.id, owner, {
    deliverableId: d.id,
    channelId: member.channelId,
    title: '并发工作项',
    brief: '按验收标准输出',
    execBudgetMinutes: 60,
    dedupeKey: 'race',
  })
  svc.activate(p.id, owner)
  return { svc, owner, p, w, member }
}

function binding(revision: number, goal: string): string {
  return JSON.stringify({ prefabId: 'test-prefab', revision, slotValues: { goal }, contentHash: String(revision).repeat(64) })
}

function finishAttempt(f: ReturnType<typeof fixture>, workItemId: string) {
  const attempts = createProjectAttemptRepo(f.db)
  attempts.close(attempts.findLiveByWorkItem(workItemId)!.id, 'CLOSED')
  createProjectWorkItemRepo(f.db).update(workItemId, { state: 'FAILED' })
}

function instanceBindings(f: ReturnType<typeof fixture>, sessionId: string): Record<string, string | undefined> {
  const members = JSON.parse(f.sessions.findById(sessionId)!.memberMapJson) as Record<string, string>
  return Object.fromEntries(Object.entries(members).map(([baseId, instanceId]) => [baseId, f.agents.findById(instanceId)?.prefabBindingJson]))
}

test('prefab snapshot: retry reuses the exact first bindings after its instance closes; a new item captures current bindings', async () => {
  const f = fixture()
  try {
    const { svc, owner, p, w, member } = await prepareWorkItem(f)
    const leadId = member.leadAgentId!
    const worker = f.agents.create({ channelId: member.channelId, templateId: null, name: 'Worker', harness: 'mock', role: 'worker', prefabBindingJson: binding(1, 'first-worker') })
    f.agents.update(leadId, { prefabBindingJson: binding(1, 'first-lead') })
    const first = await svc.dispatchWorkItem(p.id, w.id, owner)
    const snapshot = { prefabSnapshotJson: first.prefabSnapshotJson, prefabSnapshotHash: first.prefabSnapshotHash }
    const initialBindings = { [leadId]: binding(1, 'first-lead'), [worker.id]: binding(1, 'first-worker') }
    assert.deepEqual(JSON.parse(snapshot.prefabSnapshotJson!), initialBindings)
    assert.equal(snapshot.prefabSnapshotHash, sha256(snapshot.prefabSnapshotJson!))
    const originalSession = f.createdInstances[0]!.sessionId
    assert.deepEqual(instanceBindings(f, originalSession), initialBindings)

    f.agents.update(leadId, { prefabBindingJson: binding(2, 'next-lead') })
    f.agents.update(worker.id, { prefabBindingJson: '' })
    finishAttempt(f, w.id)
    // A usable first instance is still reused despite changes to the template.
    const activeRetry = await svc.dispatchWorkItem(p.id, w.id, owner)
    assert.equal(activeRetry.instanceChannelId, first.instanceChannelId)
    assert.equal(f.createdInstances.length, 1)

    finishAttempt(f, w.id)
    f.sessions.close(originalSession)
    f.channels.update(first.instanceChannelId!, { enabled: 0 })
    const retry = await svc.dispatchWorkItem(p.id, w.id, owner)
    assert.notEqual(retry.instanceChannelId, first.instanceChannelId)
    assert.equal(retry.prefabSnapshotJson, snapshot.prefabSnapshotJson)
    assert.equal(retry.prefabSnapshotHash, snapshot.prefabSnapshotHash)
    const retrySession = f.sessions.findById(f.createdInstances[1]!.sessionId)!
    assert.equal(retrySession.prefabSnapshotJson, snapshot.prefabSnapshotJson)
    assert.equal(retrySession.prefabSnapshotHash, snapshot.prefabSnapshotHash)
    assert.deepEqual(instanceBindings(f, retrySession.id), initialBindings)
    assert.equal(createProjectAttemptRepo(f.db).findLiveByWorkItem(w.id)?.sessionId, retrySession.id)

    const newItem = svc.createWorkItem(p.id, owner, { deliverableId: w.deliverableId, channelId: w.channelId, title: '新任务', dedupeKey: 'new-prefab-task' })
    const fresh = await svc.dispatchWorkItem(p.id, newItem.id, owner)
    assert.notEqual(fresh.prefabSnapshotHash, snapshot.prefabSnapshotHash)
    assert.deepEqual(instanceBindings(f, f.createdInstances[2]!.sessionId), { [leadId]: binding(2, 'next-lead'), [worker.id]: '' })
  }
  finally { f.db.close() }
})

for (const kind of ['missing', 'hash-only', 'bad-hash', 'bad-json', 'bad-binding', 'missing-member'] as const) {
  test(`prefab snapshot: retry fails closed for ${kind}`, async () => {
    const f = fixture()
    try {
      const { svc, owner, p, w, member } = await prepareWorkItem(f)
      const first = await svc.dispatchWorkItem(p.id, w.id, owner)
      const originalJson = first.prefabSnapshotJson!
      const leadId = member.leadAgentId!
      let json = originalJson
      let hash = first.prefabSnapshotHash!
      let code = 'TASK_PREFAB_SNAPSHOT_INVALID'
      switch (kind) {
        case 'missing':
          json = ''
          hash = ''
          code = 'TASK_PREFAB_SNAPSHOT_MISSING'
          break
        case 'hash-only':
          json = ''
          break
        case 'bad-hash':
          hash = '0'.repeat(64)
          break
        case 'bad-json':
          json = '{bad'
          hash = sha256(json)
          break
        case 'bad-binding':
          json = JSON.stringify({ [leadId]: 'bad-binding' })
          hash = sha256(json)
          break
        case 'missing-member':
          json = JSON.stringify({ 'other-member': '' })
          hash = sha256(json)
          code = 'TASK_PREFAB_SNAPSHOT_MEMBERS_CHANGED'
          break
      }
      finishAttempt(f, w.id)
      if (kind !== 'bad-hash') f.sessions.close(f.createdInstances[0]!.sessionId)
      f.agents.update(leadId, { prefabBindingJson: binding(2, 'must-not-be-used') })
      f.db.prepare('UPDATE project_work_items SET prefab_snapshot_json = ?, prefab_snapshot_hash = ? WHERE id = ?').run(json, hash, w.id)

      await assert.rejects(() => svc.dispatchWorkItem(p.id, w.id, owner), { code })
      assert.equal(f.createdInstances.length, 1)
      assert.equal(createProjectAttemptRepo(f.db).listByWorkItem(w.id).length, 1)
      const blocked = createProjectWorkItemRepo(f.db).findById(w.id)!
      assert.equal(blocked.state, 'BLOCKED')
      assert.equal(blocked.prefabSnapshotJson, json)
      assert.equal(blocked.prefabSnapshotHash, hash)
    }
    finally { f.db.close() }
  })
}

test('DA-1 同一工作项并发派发：恰一个 attempt、另一路 WORK_ITEM_IN_FLIGHT、只建一个实例', async () => {
  const f = fixture()
  try {
    const { svc, owner, p, w } = await prepareWorkItem(f)
    const results = await Promise.allSettled([
      svc.dispatchWorkItem(p.id, w.id, owner),
      svc.dispatchWorkItem(p.id, w.id, owner),
    ])
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    assert.equal(fulfilled.length, 1, '只有一路赢得派发')
    assert.equal(rejected.length, 1, '另一路被拒')
    assert.equal((rejected[0]!.reason as { code?: string }).code, 'WORK_ITEM_IN_FLIGHT')

    const attempts = (svc as unknown as { attempts: { listByWorkItem(id: string): unknown[] } }).attempts
    assert.equal(attempts.listByWorkItem(w.id).length, 1, '同工作项只有一个 attempt')
    assert.equal(f.createdInstances.length, 1, '只创建一个任务实例 Channel（后到者在 liveAttempt 校验处失败）')

    const [row] = svc.listWorkItems(p.id, owner)
    assert.equal(row!.state, 'DISPATCHED')
    assert.equal(row!.instanceChannelId, f.createdInstances[0]!.channelId, '工作项指针指向唯一实例')
  }
  finally { f.db.close() }
})

test('DA-2 attempt 序号唯一约束的错误签名（冲突识别依赖）', async () => {
  const f = fixture()
  try {
    const { svc, p, w } = await prepareWorkItem(f)
    void svc
    const attempts = createProjectAttemptRepo(f.db)
    attempts.create({
      projectId: p.id,
      workItemId: w.id,
      attemptNo: 1,
      channelId: 'dw-any',
      sourceKey: 'src:1',
      traceId: 'trace:1',
    })
    assert.throws(
      () => attempts.create({
        projectId: p.id,
        workItemId: w.id,
        attemptNo: 1,
        channelId: 'dw-any',
        sourceKey: 'src:2',
        traceId: 'trace:2',
      }),
      /UNIQUE constraint failed: project_work_item_attempts/i,
      '重复 attempt_no 必须抛出 catch 可识别的唯一约束消息',
    )
  }
  finally { f.db.close() }
})

test('DA-3 claimForDispatch CAS：DRAFT 一次成功、二次失败、attempt_count 只 +1', async () => {
  const f = fixture()
  try {
    const { owner, p, w } = await prepareWorkItem(f)
    void owner
    const workItems = createProjectWorkItemRepo(f.db)
    assert.equal(workItems.claimForDispatch(w.id, 'att-a'), true)
    assert.equal(workItems.claimForDispatch(w.id, 'att-b'), false, '非 DRAFT/已有 current_attempt 的 claim 必须失败')
    const row = workItems.findById(w.id)!
    assert.equal(row.state, 'DISPATCHING')
    assert.equal(row.currentAttemptId, 'att-a')
    assert.equal(row.attemptCount, 1, 'claim 只应递增一次')
    void p
  }
  finally { f.db.close() }
})
