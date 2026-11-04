/**
 * PR8：write_intent 审批链 + project-origin 高风险写闸门。
 *
 * 覆盖：默认 project_may_write=false；无审批拒绝；工具/args digest/attempt 不匹配拒绝；
 * 批准后一次性消费；重复消费拒绝；显式 mayWrite=true 放行；非项目任务不受影响。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-project-write-intent-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const manager = {
    async createChannel(input: {
      name: string
      leadAgent?: { name: string, harness: string, config?: Record<string, unknown>, agentKind?: 'channel_agent' | 'project_leader' }
      ownerUserId?: string | null
      description?: string
      scenarioPrompt?: string
    }) {
      const ch = channels.create({
        name: input.name,
        description: input.description,
        scenarioPrompt: input.scenarioPrompt,
        ownerUserId: input.ownerUserId ?? null,
      })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({
          channelId: ch.id,
          templateId: null,
          name: input.leadAgent.name,
          harness: input.leadAgent.harness,
          config: input.leadAgent.config,
          role: 'lead',
          agentKind: input.leadAgent.agentKind,
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
      })
      return { task: { id: row.id } as never, created: true }
    },
  } as unknown as AgentChannelManager
  const svc = initProjectService(manager, db)
  return { db, channels, agents, tasks, manager, svc }
}

async function setup() {
  const f = fixture()
  const owner = { id: 'u-1', role: 'user' }
  const p = await f.svc.create({ name: '写意图项目', objective: '验证 write_intent 闸门', planApprovalRequired: 0 }, owner)
  const member = await f.manager.createChannel({
    name: '写频道',
    ownerUserId: 'u-1',
    actor: owner,
    leadAgent: { name: 'Lead', harness: 'mock', agentKind: 'channel_agent' },
  })
  f.svc.bindChannel(p.id, member.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: '写交付物', ownerChannelId: member.channelId })
  const w = f.svc.createWorkItem(p.id, owner, {
    deliverableId: d.id,
    channelId: member.channelId,
    title: '调整参数',
    brief: '写测试',
    dedupeKey: 'write-intent',
  })
  f.svc.activate(p.id, owner)
  await f.svc.dispatchWorkItem(p.id, w.id, owner)
  const root = f.tasks.listRoots(member.channelId)[0]!
  return { ...f, owner, p, member, d, w, root, leadId: member.leadAgentId! }
}

test('默认 project_may_write=false：无 write_intent 拒绝高风险写', async () => {
  const s = await setup()
  try {
    const verdict = s.svc.authorizeProjectWrite(s.leadId, 'recipe_update', { value: 1 }, s.root.id)
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.code, 'PROJECT_WRITE_INTENT_REQUIRED')
  }
  finally {
    s.db.close()
  }
})

test('申请 → owner 批准 → 只放行一次；重复消费拒绝', async () => {
  const s = await setup()
  try {
    const args = { nodeId: 'n-1', value: 12.5 }
    const { approval, digest } = s.svc.agentRequestWriteIntent(s.leadId, {
      tool: 'recipe_update',
      args,
      reason: '按计划调参',
      taskId: s.root.id,
    })
    assert.equal(approval.status, 'pending')
    assert.equal(approval.kind, 'write_intent')
    assert.equal(approval.argsDigest, digest)

    // 未批准前仍拒绝
    assert.equal(s.svc.authorizeProjectWrite(s.leadId, 'recipe_update', args, s.root.id).code, 'PROJECT_WRITE_INTENT_REQUIRED')

    s.svc.decideApproval(s.p.id, approval.id, s.owner, true)
    const allowed = s.svc.authorizeProjectWrite(s.leadId, 'recipe_update', args, s.root.id)
    assert.equal(allowed.allowed, true)
    assert.equal(allowed.approvalId, approval.id)

    const replay = s.svc.authorizeProjectWrite(s.leadId, 'recipe_update', args, s.root.id)
    assert.equal(replay.allowed, false)
    assert.equal(replay.code, 'PROJECT_WRITE_INTENT_REQUIRED')
  }
  finally {
    s.db.close()
  }
})

test('digest 不匹配拒绝（tool/args 任一变化）', async () => {
  const s = await setup()
  try {
    const args = { nodeId: 'n-1', value: 10 }
    const { approval } = s.svc.agentRequestWriteIntent(s.leadId, {
      tool: 'recipe_update',
      args,
      taskId: s.root.id,
    })
    s.svc.decideApproval(s.p.id, approval.id, s.owner, true)

    const wrongValue = s.svc.authorizeProjectWrite(s.leadId, 'recipe_update', { nodeId: 'n-1', value: 11 }, s.root.id)
    assert.equal(wrongValue.allowed, false)
    assert.equal(wrongValue.code, 'PROJECT_WRITE_INTENT_MISMATCH')

    const wrongTool = s.svc.authorizeProjectWrite(s.leadId, 'recipe_apply', args, s.root.id)
    assert.equal(wrongTool.allowed, false)
    assert.equal(wrongTool.code, 'PROJECT_WRITE_INTENT_MISMATCH')
  }
  finally {
    s.db.close()
  }
})

test('同工作项不同参数：pending 冲突拒绝，避免审批被复用', async () => {
  const s = await setup()
  try {
    s.svc.agentRequestWriteIntent(s.leadId, { tool: 'recipe_update', args: { value: 1 }, taskId: s.root.id })
    assert.throws(
      () => s.svc.agentRequestWriteIntent(s.leadId, { tool: 'recipe_update', args: { value: 2 }, taskId: s.root.id }),
      (e: unknown) => (e as { code?: string }).code === 'WRITE_INTENT_PENDING',
    )
  }
  finally {
    s.db.close()
  }
})

test('显式 mayWrite=true 放行；非项目任务不受项目闸门影响', async () => {
  const s = await setup()
  try {
    s.db.prepare('UPDATE projects SET config_json = ? WHERE id = ?')
      .run(JSON.stringify({ mayWrite: true }), s.p.id)
    assert.equal(s.svc.authorizeProjectWrite(s.leadId, 'recipe_update', { value: 3 }, s.root.id).allowed, true)

    // 非项目任务：source=channel → 无项目来源，放行
    const other = await s.manager.createChannel({
      name: '普通频道', ownerUserId: 'u-1', leadAgent: { name: 'Plain', harness: 'mock' },
    })
    s.channels.update(other.channelId, { leadAgentId: other.leadAgentId })
    const plain = s.tasks.create({
      channelId: other.channelId,
      assigneeId: other.leadAgentId!,
      title: '普通任务',
      source: 'channel',
    })
    assert.equal(s.svc.authorizeProjectWrite(other.leadAgentId!, 'recipe_update', { value: 4 }, plain.id).allowed, true)
  }
  finally {
    s.db.close()
  }
})
