/**
 * US-9 证据回溯域回归:P2 聚合证据(child artifact 引用)必须能在「root+后代」树内回溯。
 * 修复前:verifyEvidenceAgainstTask 只对 root 任务 artifacts_json 摘要 →
 *        ensureDraftFromTask 聚合的 child 引用一律 EVIDENCE_UNVERIFIED(多级任务树必炸)。
 * 修复后:submitResult / agent submit / assertAcceptanceGates 三个调用点都传入树域;
 *        树外 artifact 依旧拒绝(provenance 边界不放宽)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-evidence-tree-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createProjectAttemptRepo, createProjectDecisionRepo, createProjectResultRepo, createProjectEventRepo } = await import('../server/services/workshop/db/project.repo')
const { createProjectKernelRepo } = await import('../server/services/workshop/db/project-kernel.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

const owner = { id: 'u-owner', role: 'user' }

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const attempts = createProjectAttemptRepo(db)
  const decisions = createProjectDecisionRepo(db)
  const results = createProjectResultRepo(db)
  const events = createProjectEventRepo(db)
  const kernel = createProjectKernelRepo(db)
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
  return { db, channels, agents, tasks, attempts, decisions, results, events, kernel, manager, svc }
}

/** 派发 → worker 子任务交付 → lead 收口(root),复刻真实 mock 链的产物分布。 */
async function runWorkItemToDraft(f: ReturnType<typeof fixture>, projectId: string, deliverableId: string, channelId: string, leadId: string, title: string) {
  const w = f.svc.createWorkItem(projectId, owner, { deliverableId, channelId, title })
  await f.svc.dispatchWorkItem(projectId, w.id, owner)
  const attempt = f.attempts.findLiveByWorkItem(w.id)!
  const rootId = attempt.channelTaskId!
  const childArtifact = { artifactId: `c-${w.id}`, name: 'mock 成果', parts: [{ text: `<html>${title}</html>` }] }
  const child = f.tasks.create({
    channelId, parentId: rootId, creatorId: leadId, assigneeId: 'worker-1',
    title: `${title}·执行`, source: 'project', projectId, projectWorkItemId: w.id,
  })
  f.tasks.update(child.id, { state: 'COMPLETED', artifacts: [childArtifact] })
  f.tasks.update(rootId, {
    state: 'COMPLETED',
    artifacts: [
      { artifactId: `in-${w.id}`, name: 'input', parts: [{ text: 'handoff' }] },
      { artifactId: `lead-${w.id}`, name: 'lead-acceptance-summary', parts: [{ text: `验收通过:${title}` }] },
    ],
  })
  return { w, rootId, childArtifactId: childArtifact.artifactId }
}

test('US-9:child artifact 证据可回溯——draft(含 child 引用)→ submit 成功 → 验收门通过', async () => {
  const f = fixture()
  try {
    const p = await f.svc.create({
      name: `EV-${randomUUID().slice(0, 8)}`, objective: 'evidence tree',
      planApprovalRequired: 0, autoDispatch: false, routingPolicy: 'legacy',
    }, owner)
    const a = await f.manager.createChannel({ name: `ch-${randomUUID().slice(0, 6)}`, ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' } })
    f.svc.bindChannel(p.id, a.channelId, owner)
    const d = f.svc.createDeliverable(p.id, owner, { name: 'landing-page.html', ownerChannelId: a.channelId })
    f.svc.activate(p.id, owner)

    const run = await runWorkItemToDraft(f, p.id, d.id, a.channelId, a.leadAgentId!, '市场定位与首屏文案')
    f.svc.reconcile(p.id, owner)
    const draft = f.svc.listResults(p.id, owner).find(r => r.workItemId === run.w.id)!
    const evidence = JSON.parse(draft.evidenceJson) as Array<{ artifactId: string, source?: string }>
    assert.ok(evidence.some(e => e.artifactId === run.childArtifactId && e.source === 'child'), 'draft 聚合了 child artifact 引用')

    // 修复点:submit 默认证据(draft 全量,含 child 引用)必须通过
    const submitted = f.svc.submitResult(p.id, draft.id, owner, {})
    assert.equal(submitted.status, 'submitted')

    // L1 技术评审(review)→ L2 验收申请(assertAcceptanceGates 重跑 provenance)
    const reviewed = f.svc.reviewResult(p.id, draft.id, owner, 'reviewed', 'US-9 回归')
    assert.equal(reviewed.status, 'reviewed')
    const approval = f.svc.requestAcceptance(p.id, draft.id, owner)
    assert.ok(approval, 'requestAcceptance 走过证据门')
  }
  finally {
    f.db.close()
  }
})

test('US-9 反向:树外 artifact 证据仍被拒绝(provenance 边界不放宽)', async () => {
  const f = fixture()
  try {
    const p = await f.svc.create({
      name: `EV-X-${randomUUID().slice(0, 8)}`, objective: 'evidence tree negative',
      planApprovalRequired: 0, autoDispatch: false, routingPolicy: 'legacy',
    }, owner)
    const a = await f.manager.createChannel({ name: `ch-${randomUUID().slice(0, 6)}`, ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' } })
    f.svc.bindChannel(p.id, a.channelId, owner)
    const d = f.svc.createDeliverable(p.id, owner, { name: 'x.html', ownerChannelId: a.channelId })
    f.svc.activate(p.id, owner)

    await runWorkItemToDraft(f, p.id, d.id, a.channelId, a.leadAgentId!, '工作项一')
    f.svc.reconcile(p.id, owner)
    const draft = f.svc.listResults(p.id, owner)[0]!

    // 外来任务(不属于本任务树)的 artifact → 必须拒绝
    const foreignTask = f.tasks.create({ channelId: a.channelId, creatorId: owner.id, assigneeId: 'worker-1', title: '无关任务' })
    f.tasks.update(foreignTask.id, {
      state: 'COMPLETED',
      artifacts: [{ artifactId: 'foreign-1', name: ' чужой', parts: [{ text: 'foreign content' }] }],
    })
    assert.throws(
      () => f.svc.submitResult(p.id, draft.id, owner, { evidence: [{ artifactId: 'foreign-1', sha256: '' }] }),
      (e: unknown) => (e as { code?: string }).code === 'EVIDENCE_UNVERIFIED',
      '树外 artifact 不得作为证据',
    )
  }
  finally {
    f.db.close()
  }
})
