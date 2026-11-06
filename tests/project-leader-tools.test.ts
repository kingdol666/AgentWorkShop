/**
 * PR8：Project Leader 提案工具 / 成员成果 / 执行层硬门。
 *
 * 覆盖：注入面矩阵、leader 执行拒绝、计划提案→owner 批准→物化、
 * 派发提案→apply、成果提交/复核/验收权限、leader 不能批准。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-project-leader-tools-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
const { dispatchProjectTool } = await import('../server/services/workshop/projects/tools')
const { projectExecutionGate } = await import('../server/services/workshop/projects/execution-gate')
const { filterLeaderToolSurface, filterProjectToolSurface } = await import('../server/services/workshop/projects/tool-surface')
const { normalizeProjectPlan } = await import('../server/services/workshop/projects/service')
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
  const p = await f.svc.create({ name: '项目A', objective: '验证 leader 提案闭环', planApprovalRequired: 0 }, owner)
  const member = await f.manager.createChannel({
    name: '执行频道',
    ownerUserId: 'u-1',
    actor: owner,
    leadAgent: { name: 'Lead', harness: 'mock', agentKind: 'channel_agent' },
  })
  f.svc.bindChannel(p.id, member.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: '交付物A', ownerChannelId: member.channelId })
  f.svc.activate(p.id, owner)
  return { ...f, owner, p, member, d, leaderId: p.leadAgentId!, memberLeadId: member.leadAgentId! }
}

test('工具面矩阵：leader 白名单 / channel lead / worker / 非项目', () => {
  const tools = [
    { name: 'dispatch_task' },
    { name: 'recipe_update' },
    { name: 'project_get_status' },
    { name: 'project_propose_plan' },
    { name: 'project_read_results' },
    { name: 'project_submit_result' },
    { name: 'project_request_write_intent' },
  ]
  assert.deepEqual(
    filterLeaderToolSurface(tools).map(t => t.name),
    ['project_get_status', 'project_propose_plan', 'project_read_results'],
  )
  assert.deepEqual(
    filterProjectToolSurface(tools, 'channel_lead').map(t => t.name),
    ['dispatch_task', 'recipe_update', 'project_read_results', 'project_submit_result', 'project_request_write_intent'],
  )
  assert.deepEqual(
    filterProjectToolSurface(tools, 'worker').map(t => t.name),
    ['dispatch_task', 'recipe_update', 'project_read_results'],
  )
  assert.deepEqual(
    filterProjectToolSurface(tools, 'none').map(t => t.name),
    ['dispatch_task', 'recipe_update'],
  )
})

test('执行层硬门：leader 不得调 Channel/工业工具，成员不得提案，项目外无 project 工具', async () => {
  const s = await setup()
  try {
    const leaderCtx = s.svc.agentProjectContext(s.leaderId)!
    assert.equal(leaderCtx.isLeader, true)
    const denied = projectExecutionGate(s.leaderId, 'dispatch_task')
    assert.ok(denied?.isError)
    assert.match(denied!.text, /PROJECT_TOOL_DENIED/)
    assert.equal(projectExecutionGate(s.leaderId, 'project_get_status'), null)

    const leadDenied = projectExecutionGate(s.memberLeadId, 'project_propose_plan')
    assert.ok(leadDenied?.isError)
    assert.equal(projectExecutionGate(s.memberLeadId, 'project_submit_result'), null)

    const worker = s.agents.create({
      channelId: s.member.channelId, templateId: null, name: 'Worker', harness: 'mock', role: 'worker',
    })
    assert.match(projectExecutionGate(worker.id, 'project_submit_result')!.text, /PROJECT_TOOL_DENIED/)
    assert.equal(projectExecutionGate(worker.id, 'project_read_results'), null)

    const outsiderChannel = await s.manager.createChannel({
      name: '项目外频道', ownerUserId: 'u-1', leadAgent: { name: 'Out', harness: 'mock' },
    })
    assert.match(projectExecutionGate(outsiderChannel.leadAgentId!, 'project_get_status')!.text, /PROJECT_TOOL_DENIED/)
  }
  finally {
    s.db.close()
  }
})

test('leader 只读工具：status/channels 返回真实项目与成员频道', async () => {
  const s = await setup()
  try {
    const status = await dispatchProjectTool(
      { agentId: s.leaderId, channelId: s.p.officeChannelId!, role: 'lead', name: 'Project Leader' },
      'project_get_status',
      {},
    )
    assert.equal(status.isError, undefined)
    const parsed = JSON.parse(status.text)
    assert.equal(parsed.project.id, s.p.id)
    assert.ok(parsed.channels.some((c: { channelId: string }) => c.channelId === s.member.channelId))

    const channels = await dispatchProjectTool(
      { agentId: s.leaderId, channelId: s.p.officeChannelId!, role: 'lead', name: 'Project Leader' },
      'project_list_channels',
      {},
    )
    assert.ok(JSON.parse(channels.text).some((c: { channelId: string }) => c.channelId === s.member.channelId))
  }
  finally {
    s.db.close()
  }
})

test('计划提案 → owner 批准 → 交付物/工作项物化（幂等）', async () => {
  const s = await setup()
  try {
    const plan = {
      deliverables: [
        { key: 'd-plan', name: '计划交付物', description: '计划新增', required: true, channelId: s.member.channelId },
      ],
      work_items: [
        { key: 'w-plan', deliverableKey: 'd-plan', channelId: s.member.channelId, title: '计划工作项', brief: '按计划执行', dependsOn: [] },
      ],
    }
    const first = await dispatchProjectTool(
      { agentId: s.leaderId, channelId: s.p.officeChannelId!, role: 'lead', name: 'Project Leader' },
      'project_propose_plan',
      { plan },
    )
    assert.equal(first.isError, undefined)
    const proposed = JSON.parse(first.text)
    assert.equal(proposed.planVersion, 1)

    // 同版本重复提案幂等：同一 approval
    const again = await dispatchProjectTool(
      { agentId: s.leaderId, channelId: s.p.officeChannelId!, role: 'lead', name: 'Project Leader' },
      'project_propose_plan',
      { plan },
    )
    assert.equal(JSON.parse(again.text).approvalId, proposed.approvalId)

    const decided = s.svc.decideApproval(s.p.id, proposed.approvalId, s.owner, true)
    assert.equal(decided.status, 'approved')
    assert.equal(s.svc.get(s.p.id, s.owner).planVersion, 1)
    assert.ok(s.svc.listDeliverables(s.p.id, s.owner).some(d => d.name === '计划交付物'))
    assert.ok(s.svc.listWorkItems(s.p.id, s.owner).some(w => w.title === '计划工作项' && w.planVersion === 1))
  }
  finally {
    s.db.close()
  }
})

test('计划 schema 校验：空交付物/未知依赖/未知交付物全部拒绝', () => {
  assert.throws(() => normalizeProjectPlan({ deliverables: [] }), /至少一个交付物/)
  assert.throws(
    () => normalizeProjectPlan({ deliverables: [{ key: 'd1', name: 'D1' }], work_items: [{ deliverableKey: 'nope', channelId: 'c', title: 'x' }] }),
    /未知交付物/,
  )
  assert.throws(
    () => normalizeProjectPlan({
      deliverables: [{ key: 'd1', name: 'D1' }],
      work_items: [{ key: 'w1', deliverableKey: 'd1', channelId: 'c', title: 'x', dependsOn: ['missing'] }],
    }),
    /依赖未知工作项/,
  )
})

test('派发提案 → owner apply → 工作项创建；重复 apply 拒绝', async () => {
  const s = await setup()
  try {
    const d2 = s.svc.createDeliverable(s.p.id, s.owner, { name: '派发交付物', ownerChannelId: s.member.channelId })
    const decision = s.svc.agentProposeDispatch(s.leaderId, {
      deliverableId: d2.id,
      channelId: s.member.channelId,
      title: '提案工作项',
      brief: 'owner 应用后创建',
      dispatch: false,
    })
    assert.equal(decision.state, 'proposed')
    const applied = await s.svc.applyProposal(s.p.id, decision.id, s.owner)
    assert.equal(applied.workItem?.title, '提案工作项')
    assert.equal(applied.dispatched, false)
    await assert.rejects(
      () => s.svc.applyProposal(s.p.id, decision.id, s.owner),
      (e: unknown) => (e as { code?: string }).code === 'PROPOSAL_STATE_INVALID',
    )
  }
  finally {
    s.db.close()
  }
})

test('成果链：channel lead 提交 → leader 复核 → leader 申请验收但不能批准', async () => {
  const s = await setup()
  try {
    const w = s.svc.createWorkItem(s.p.id, s.owner, {
      deliverableId: s.d.id,
      channelId: s.member.channelId,
      title: '成果工作项',
      brief: '执行并交付',
      dedupeKey: 'result-flow',
    })
    await s.svc.dispatchWorkItem(s.p.id, w.id, s.owner)
    const root = s.tasks.listRoots(s.member.channelId)[0]!
    s.tasks.update(root.id, {
      state: 'COMPLETED',
      artifacts: [{ artifactId: 'a-result', name: 'report', parts: [{ text: '实测结果 42' }] }],
    })
    s.svc.reconcile(s.p.id, s.owner)
    const draft = s.svc.listResults(s.p.id, s.owner)[0]!

    const submitted = await dispatchProjectTool(
      { agentId: s.memberLeadId, channelId: s.member.channelId, role: 'lead', name: 'Lead' },
      'project_submit_result',
      { result_id: draft.id, summary: '补充后的结果摘要', evidence: [{ artifactId: 'a-result', kind: 'artifact' }] },
    )
    assert.equal(submitted.isError, undefined, submitted.text)
    const reviewed = await dispatchProjectTool(
      { agentId: s.leaderId, channelId: s.p.officeChannelId!, role: 'lead', name: 'Project Leader' },
      'project_review_result',
      { result_id: draft.id, decision: 'reviewed', reason: '证据充分' },
    )
    assert.equal(reviewed.isError, undefined, reviewed.text)

    const acceptance = await dispatchProjectTool(
      { agentId: s.leaderId, channelId: s.p.officeChannelId!, role: 'lead', name: 'Project Leader' },
      'project_request_approval',
      { kind: 'deliverable_acceptance', result_id: draft.id },
    )
    const parsed = JSON.parse(acceptance.text)
    assert.throws(
      () => s.svc.decideApproval(s.p.id, parsed.approvalId, { id: s.leaderId, role: 'lead', agentId: s.leaderId }, true),
      (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN',
    )
  }
  finally {
    s.db.close()
  }
})

test('提交权限：leader/worker 不能提交成果', async () => {
  const s = await setup()
  try {
    assert.throws(
      () => s.svc.agentSubmitResult(s.leaderId, { summary: 'x' }),
      (e: unknown) => (e as { code?: string }).code === 'PROJECT_CHANNEL_LEAD_REQUIRED',
    )
    const worker = s.agents.create({
      channelId: s.member.channelId, templateId: null, name: 'W2', harness: 'mock', role: 'worker',
    })
    assert.throws(
      () => s.svc.agentSubmitResult(worker.id, { summary: 'x' }),
      (e: unknown) => (e as { code?: string }).code === 'PROJECT_CHANNEL_LEAD_REQUIRED',
    )
  }
  finally {
    s.db.close()
  }
})
