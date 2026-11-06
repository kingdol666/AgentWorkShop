/**
 * P1 增强回归套件（plan 2026-11-06 §3 批次 2 / PR A）。
 *
 *   P1-1 项目蓝图：命名模板 save/list/find/remove + owner 隔离 + 结构校验；
 *        instantiateBlueprint 一键实例化（免批=active 全链 / 需批=pending_plan_approval）
 *   P1-6 watchdog no_progress 按预算比例（0.75×budget 钳位 [10min,6h]；显式 noProgressMs 兼容）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-project-p1-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createProjectAttemptRepo, createProjectWorkItemRepo } = await import('../server/services/workshop/db/project.repo')
const { createProjectKernelRepo } = await import('../server/services/workshop/db/project-kernel.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
const { createProjectWatchdog } = await import('../server/services/workshop/projects/watchdog')
const { createProjectBlueprintRepo, validateBlueprint } = await import('../server/services/workshop/projects/blueprints.repo')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const attempts = createProjectAttemptRepo(db)
  const manager = {
    async createChannel(input: { name: string, ownerUserId?: string | null, description?: string, scenarioPrompt?: string, leadAgent?: { name: string, harness: string, config?: Record<string, unknown> } }) {
      const ch = channels.create({ name: input.name, ownerUserId: input.ownerUserId ?? null, description: input.description, scenarioPrompt: input.scenarioPrompt })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({ channelId: ch.id, templateId: null, name: input.leadAgent.name, harness: input.leadAgent.harness, config: input.leadAgent.config, role: 'lead' })
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
  return { db, channels, agents, tasks, attempts, manager, svc }
}

const owner = { id: 'u-owner', role: 'user' }

function sampleBlueprint() {
  return {
    name: '四频道协同蓝图',
    objective: '本体→工艺→质量 technical 协作',
    routingPolicy: 'technical' as const,
    planApprovalRequired: false,
    channels: [
      { key: 'ont', name: '本体频道', charter: '编译守卫', leadHarness: 'mock' },
      { key: 'proc', name: '工艺频道', charter: '寻优执行', leadHarness: 'mock' },
    ],
    plan: {
      deliverables: [
        { key: 'd1', name: '守卫工件', channelKey: 'ont', acceptanceCriteria: ['artifact.present'] },
        { key: 'd2', name: '寻优报告', channelKey: 'proc', dependsOn: ['d1'] },
      ],
      work_items: [
        { key: 'w1', title: 'W1 守卫编译', deliverableKey: 'd1', channelKey: 'ont' },
        { key: 'w2', title: 'W2 工艺寻优', deliverableKey: 'd2', channelKey: 'proc', dependsOn: ['w1'] },
      ],
    },
  }
}

// ── P1-1：蓝图 repo ──

test('P1-1a 蓝图 repo：命名保存/查重/owner 隔离/删除/结构校验', () => {
  const repo = createProjectBlueprintRepo()
  const bp = sampleBlueprint()
  const saved = repo.save('协同模板', owner.id, bp)
  assert.ok(saved.id.startsWith('pb-'))
  // 同名覆盖（owner 同）
  const again = repo.save('协同模板', owner.id, { ...bp, objective: 'v2' })
  assert.equal(again.id, saved.id)
  assert.equal(again.blueprint.objective, 'v2')
  // owner 隔离：他人不可见/不可删
  assert.equal(repo.findByName('协同模板', 'u-other'), undefined)
  assert.equal(repo.list('u-other').length, 0)
  assert.throws(() => repo.remove(saved.id, 'u-other'), /属主/)
  // admin 全量可见 + 可删
  assert.equal(repo.findByName('协同模板', 'anyone', 'admin')?.id, saved.id)
  // 结构校验：重复 channel key / 空 deliverables / 非法 policy
  assert.throws(() => repo.save('坏模板', owner.id, { ...bp, channels: [{ key: 'x' }, { key: 'x' }] } as never), /key 重复/)
  assert.throws(() => repo.save('坏模板', owner.id, { ...bp, plan: { deliverables: [], work_items: [] } } as never), /deliverables 不能为空/)
  assert.throws(() => repo.save('坏模板', owner.id, { ...bp, routingPolicy: 'bogus' } as never), /legacy 或 technical/)
  assert.throws(() => validateBlueprint({ ...bp, objective: '' } as never), /objective/)
  // 清理（admin 删除路径）
  assert.equal(repo.remove(saved.id, owner.id), true)
})

// ── P1-1：一键实例化 ──

test('P1-1b 免批蓝图一键实例化：active + 频道绑定 + 工作项物化 + technical 默认', async () => {
  const f = fixture()
  try {
    const bp = { ...sampleBlueprint(), planApprovalRequired: false }
    const result = await f.svc.instantiateBlueprint(owner, { blueprint: bp })
    assert.equal(result.status, 'active')
    assert.equal(Object.keys(result.channelIdByKey).length, 2)
    assert.equal(result.workItemIds.length, 2, '计划已物化（2 工作项）')
    const snap = f.svc.get(result.projectId, owner)
    assert.equal(snap.status, 'active')
    assert.equal(snap.routingPolicy, 'technical', 'P0-7 默认口径')
    // 频道真实创建且绑定
    const bound = f.svc.listBoundChannels(f.svc.get(result.projectId, owner))
    assert.equal(bound.length, 2)
    assert.ok(bound.some(c => String(c.name).startsWith('本体频道-')), '蓝图频道本体已绑定')
    assert.ok(bound.some(c => String(c.name).startsWith('工艺频道-')), '蓝图频道工艺已绑定')
    // 工作项依赖链保持（W2 dependsOn W1）
    const items = f.svc.listWorkItems(result.projectId, owner)
    const w2 = items.find(x => x.title === 'W2 工艺寻优')!
    assert.deepEqual(JSON.parse(w2.dependsOnJson), [items.find(x => x.title === 'W1 守卫编译')!.id])
    // 二次实例化 = 全新会话（新 project id）
    const second = await f.svc.instantiateBlueprint(owner, { blueprint: bp })
    assert.notEqual(second.projectId, result.projectId)
    assert.equal(second.workItemIds.length, 2, '新会话工作项同样物化')
  }
  finally { f.db.close() }
})

test('P1-1c 需批蓝图：pending_plan_approval + planApprovalId；批准后可激活', async () => {
  const f = fixture()
  try {
    const bp = { ...sampleBlueprint(), planApprovalRequired: true }
    const result = await f.svc.instantiateBlueprint(owner, { blueprint: bp })
    assert.equal(result.status, 'pending_plan_approval')
    assert.ok(result.planApprovalId, '返回待批计划审批 id')
    const before = f.svc.get(result.projectId, owner)
    assert.equal(before.status, 'draft', '需批蓝图不自动激活')
    // owner 批准 → 物化 → 激活
    f.svc.decideApproval(result.projectId, result.planApprovalId!, owner, true)
    f.svc.activate(result.projectId, owner)
    assert.equal(f.svc.get(result.projectId, owner).status, 'active')
    assert.equal(f.svc.listWorkItems(result.projectId, owner).length, 2)
  }
  finally { f.db.close() }
})

// ── P1-6：watchdog no_progress 预算比例阈值 ──

test('P1-6 watchdog：60min 预算 31min 静默不误报（阈值 45min）；50min 静默告警；显式 noProgressMs 兼容', async () => {
  const f = fixture()
  try {
    const p = await f.svc.create({ name: `p6-${randomUUID().slice(0, 6)}`, objective: 'x', planApprovalRequired: 0, routingPolicy: 'legacy' }, owner)
    const ch = await f.manager.createChannel({ name: 'C', ownerUserId: owner.id, leadAgent: { name: 'L', harness: 'mock' } })
    f.svc.bindChannel(p.id, ch.channelId, owner)
    const d = f.svc.createDeliverable(p.id, owner, { name: 'D', ownerChannelId: ch.channelId })
    f.svc.activate(p.id, owner)
    const w = f.svc.createWorkItem(p.id, owner, { deliverableId: d.id, channelId: ch.channelId, title: 'W', execBudgetMinutes: 60 })
    await f.svc.dispatchWorkItem(p.id, w.id, owner)
    const kernel = createProjectKernelRepo(f.db)
    const appendLedgerAt = (iso: string) => {
      kernel.ledger.append({ projectId: p.id, planVersion: 1, stepNo: 0, triggerType: 'test', summary: 'beat', facts: [], assessment: {}, nextAction: '', evidence: [], traceId: `t:${randomUUID()}` })
      f.db.prepare('UPDATE project_progress_ledger SET created_at = ? WHERE project_id = ?').run(iso, p.id)
    }
    // ① 31min 静默（预算 60min → 阈值 45min）→ 不误报
    appendLedgerAt(new Date(Date.now() - 31 * 60_000).toISOString())
    const wd = createProjectWatchdog(f.db, kernel)
    const findings1 = wd.scanProject(p.id, 1).filter(x => x.type === 'no_progress')
    assert.equal(findings1.length, 0, '60min 预算 31min 静默不得误报（旧固定 30min 必误报）')
    // ② 50min 静默 → 告警
    appendLedgerAt(new Date(Date.now() - 50 * 60_000).toISOString())
    const findings2 = wd.scanProject(p.id, 1).filter(x => x.type === 'no_progress')
    assert.equal(findings2.length, 1)
    assert.ok(findings2[0]!.detail.includes('阈值 45 分钟'), `detail=${findings2[0]!.detail}`)
    // ③ 显式 noProgressMs 兼容（固定阈值行为）
    appendLedgerAt(new Date(Date.now() - 31 * 60_000).toISOString())
    const wd2 = createProjectWatchdog(f.db, kernel, { noProgressMs: 10 * 60_000 })
    const findings3 = wd2.scanProject(p.id, 1).filter(x => x.type === 'no_progress')
    assert.equal(findings3.length, 1, '显式 noProgressMs 保持固定阈值行为')
  }
  finally { f.db.close() }
})
