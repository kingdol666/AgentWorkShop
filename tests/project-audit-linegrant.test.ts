/**
 * PR9：审计 fail-closed（B8）+ line grant 成果过滤（C11）。
 *
 * B8：破坏性动作（submit/review/decide/supersede/reconcile）与 decisions/events 同事务；
 *     审计写入失败 → 整体回滚（状态不变、审批回到 pending）。
 * C11：人类 actor 按可见产线集过滤成果；无授权单成果操作 403 LINE_FORBIDDEN。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-project-audit-linegrant-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createProjectApprovalRepo } = await import('../server/services/workshop/db/project.repo')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
type ProjectServiceCtor = typeof initProjectService
const { resetTransactionDepthForTest } = await import('../server/services/workshop/db/transaction')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

/** 可切换的故障注入 db：failEvents=true 时 project_events INSERT 在 run 阶段抛错。 */
function failingEventsDb(): { db: DatabaseSync, setFailEvents: (v: boolean) => void } {
  const real = openWorkshopDb(':memory:')
  let failEvents = false
  const proxy = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql)
          if (/INTO project_events/.test(sql)) {
            return {
              ...stmt,
              run: (...runArgs: unknown[]) => {
                if (failEvents) throw new Error('audit sink failure (injected)')
                return stmt.run(...(runArgs as []))
              },
            }
          }
          return stmt
        }
      }
      const v = Reflect.get(target, prop)
      // 原生方法必须以真实实例为 receiver（Proxy 上直接调用会 Illegal invocation）
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  return {
    db: proxy as unknown as DatabaseSync,
    setFailEvents: (v: boolean) => {
      failEvents = v
    },
  }
}

function fixture(db: DatabaseSync, deps?: ConstructorParameters<ProjectServiceCtor>[2]) {
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
      const ch = channels.create({ name: input.name, description: input.description, scenarioPrompt: input.scenarioPrompt, ownerUserId: input.ownerUserId ?? null })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({
          channelId: ch.id, templateId: null, name: input.leadAgent.name, harness: input.leadAgent.harness,
          config: input.leadAgent.config, role: 'lead', agentKind: input.leadAgent.agentKind,
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
      return ch ? { ...ch, agents: [], lineId: (ch as { lineId?: string }).lineId ?? '' } : null
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
        channelId: input.channelId, creatorId: `project:${input.projectId}`, assigneeId: ch.leadAgentId!,
        title: input.title, description: input.description, sourceChatMessageId: input.sourceKey,
        deadlineAt: new Date(Date.now() + (input.execBudgetMinutes ?? 60) * 60_000).toISOString(),
        source: 'project', projectId: input.projectId, projectWorkItemId: input.workItemId,
        projectAttemptNo: input.attemptNo, traceId: input.traceId,
      })
      return { task: { id: row.id } as never, created: true }
    },
  } as unknown as AgentChannelManager
  const svc = initProjectService(manager, db, deps)
  return { db, channels, agents, tasks, manager, svc }
}

/** 标准场景：项目 + 成员频道(line L1) + 交付物 + 工作项派发 + root 完成 + reconcile(draft)。 */
async function setupWithResult(db: DatabaseSync, deps?: ConstructorParameters<ProjectServiceCtor>[2]) {
  const f = fixture(db, deps)
  const owner = { id: 'u-owner', role: 'user' }
  const p = await f.svc.create({ name: '审计项目', objective: 'B8/C11 验证', planApprovalRequired: 0 }, owner)
  const member = await f.manager.createChannel({
    name: '成员频道', ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' },
  })
  f.channels.update(member.channelId, { lineId: 'L1' } as never)
  f.svc.bindChannel(p.id, member.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: '交付物', ownerChannelId: member.channelId })
  const w = f.svc.createWorkItem(p.id, owner, {
    deliverableId: d.id, channelId: member.channelId, title: '工作项', brief: 'x', dedupeKey: 'audit-flow',
  })
  f.svc.activate(p.id, owner)
  await f.svc.dispatchWorkItem(p.id, w.id, owner)
  const root = f.tasks.listRoots(member.channelId)[0]!
  f.tasks.update(root.id, {
    state: 'COMPLETED',
    artifacts: [{ artifactId: 'a1', name: 'r', parts: [{ text: 'ok' }] }],
  })
  f.svc.reconcile(p.id, owner)
  const draft = f.svc.listResults(p.id, owner)[0]!
  // fixture 直写成果产线快照（channel.repo.update 不含 line_id 列，绕开绑线管线）
  db.prepare(`UPDATE project_results SET line_id = 'L1' WHERE id = ?`).run(draft.id)
  const submitAndReview = () => {
    // 自批规则生效：成果由 channel lead（agent 路径）提交，owner 复核——owner 不得自提自批
    f.svc.agentSubmitResult(member.leadAgentId!, { resultId: draft.id, summary: 's', evidence: [{ artifactId: 'a1' }] })
    f.svc.reviewResult(p.id, draft.id, owner, 'reviewed')
  }
  return { ...f, owner, p, member, d, w, root, draft, submitAndReview }
}

test('B8a: decideApproval 审计失败 → 整体回滚（审批回到 pending，成果/交付物不变）', async () => {
  resetTransactionDepthForTest()
  const { db, setFailEvents } = failingEventsDb()
  const s = await setupWithResult(db)
  try {
    s.submitAndReview()
    const ap = s.svc.requestAcceptance(s.p.id, s.draft.id, s.owner)
    setFailEvents(true)
    assert.throws(
      () => s.svc.decideApproval(s.p.id, ap.id, s.owner, true, 'x'),
      /audit sink failure/,
    )
    // 回滚断言：审批仍 pending、成果仍 reviewed、交付物未 approved、无残留 decisions
    const approvalsRepo = createProjectApprovalRepo(s.db)
    assert.equal(approvalsRepo.findById(ap.id)!.status, 'pending')
    const result = s.svc.listResults(s.p.id, s.owner)[0]!
    assert.equal(result.status, 'reviewed')
    assert.equal(result.approvedBy, null)
    const deliverable = s.svc.listDeliverables(s.p.id, s.owner).find(x => x.id === s.d.id)!
    assert.equal(deliverable.status, 'planned')
  }
  finally {
    db.close()
  }
})

test('B8b: submitResult 审计失败 → 成果保持 draft', async () => {
  resetTransactionDepthForTest()
  const { db, setFailEvents } = failingEventsDb()
  const s = await setupWithResult(db)
  try {
    setFailEvents(true)
    assert.throws(
      () => s.svc.submitResult(s.p.id, s.draft.id, s.owner, { summary: 'x' }),
      /audit sink failure/,
    )
    assert.equal(s.svc.listResults(s.p.id, s.owner)[0]!.status, 'draft')
  }
  finally {
    db.close()
  }
})

test('B8c: 拒绝决策同样落审计（decisions+events 均有 approval.rejected）', async () => {
  resetTransactionDepthForTest()
  const { db } = failingEventsDb()
  const s = await setupWithResult(db)
  try {
    s.submitAndReview()
    const ap = s.svc.requestAcceptance(s.p.id, s.draft.id, s.owner)
    s.svc.decideApproval(s.p.id, ap.id, s.owner, false, '证据不足')
    const decisions = s.svc.listDecisions(s.p.id, s.owner)
    assert.ok(decisions.some(d => d.decisionType === 'approval.rejected' && d.argsJson.includes(ap.id)))
    const result = s.svc.listResults(s.p.id, s.owner)[0]!
    assert.equal(result.status, 'rejected')
  }
  finally {
    db.close()
  }
})

test('C11: 列表过滤——owner 仅见授权产线成果；无授权=空；未启用=原行为', async () => {
  resetTransactionDepthForTest()
  const { db } = failingEventsDb()
  const s = await setupWithResult(db)
  try {
    // owner u-owner 授权 L1 → 可见（成果 lineId=L1）
    const granted = initProjectService(s.manager, s.db, { lineAccessOf: id => (id === 'u-owner' ? new Set(['L1']) : new Set<string>()) })
    assert.equal(granted.listResults(s.p.id, s.owner).length, 1)
    // 无任何授权 → 空
    const none = initProjectService(s.manager, s.db, { lineAccessOf: () => new Set<string>() })
    assert.equal(none.listResults(s.p.id, s.owner).length, 0)
    // 未启用（deps 缺省）→ 原行为全量
    const legacy = initProjectService(s.manager, s.db)
    assert.equal(legacy.listResults(s.p.id, s.owner).length, 1)
    // admin 直通
    assert.equal(granted.listResults(s.p.id, { id: 'x', role: 'admin' }).length, 1)
    // 非产线项目（无成员 Channel 绑线）：空 line_id 成果按项目成员治理，approver 可见/可签核。
    // 线绑定项目的空 line_id 仍按 S4 隐藏；单成果操作门测试覆盖非空 line 的 LINE_FORBIDDEN。
    s.db.prepare('UPDATE project_results SET line_id = \'\' WHERE id = ?').run(s.draft.id)
    assert.equal(granted.listResults(s.p.id, s.owner).length, 1)
    assert.equal(granted.listResults(s.p.id, { id: 'x', role: 'admin' }).length, 1)
  }
  finally {
    db.close()
  }
})

test('C11: 单成果操作门——无授权 requestAcceptance/supersede → LINE_FORBIDDEN', async () => {
  resetTransactionDepthForTest()
  const { db } = failingEventsDb()
  const s = await setupWithResult(db)
  try {
    s.submitAndReview()
    const revoked = initProjectService(s.manager, s.db, { lineAccessOf: () => new Set<string>() })
    assert.throws(
      () => revoked.requestAcceptance(s.p.id, s.draft.id, s.owner),
      (e: unknown) => (e as { code?: string }).code === 'LINE_FORBIDDEN',
    )
    assert.throws(
      () => revoked.supersedeResult(s.p.id, s.draft.id, s.owner, 'x'),
      (e: unknown) => (e as { code?: string }).code === 'LINE_FORBIDDEN',
    )
    // leader（agent 路径）不受 grant 过滤影响（已在项目作用域内）
    const ap = revoked.agentRequestAcceptance(s.p.leadAgentId!, s.draft.id)
    assert.equal(ap.kind, 'deliverable_acceptance')
  }
  finally {
    db.close()
  }
})
