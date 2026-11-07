/**
 * US-审计轮:approved 槽位按工作项隔离回归。
 * 修复前:槽位 (project, deliverable, resultKey) 交付物级共享 → 多工作项交付物的
 *        新批准 supersede 旧批准 → deliverableAcceptanceReady(每工作项需 approved)
 *        永不可满足 → 多工作项项目永远无法 complete。
 * 修复后:槽位 (project, deliverable, resultKey, workItem) 隔离;同工作项新版本仍收编旧版本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-approved-slot-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createProjectAttemptRepo, createProjectDecisionRepo, createProjectResultRepo, createProjectEventRepo, createProjectWorkItemRepo } = await import('../server/services/workshop/db/project.repo')
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
  const workItems = createProjectWorkItemRepo(db)
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
  return { db, channels, agents, tasks, attempts, decisions, results, events, kernel, workItems, manager, svc }
}

/** 派发→worker 子任务交付→root 收口→reconcile→agent 提交→L1→L2(返回最终状态)。 */
async function driveToAccepted(f: ReturnType<typeof fixture>, projectId: string, deliverableId: string, channelId: string, leadId: string, title: string) {
  const w = f.svc.createWorkItem(projectId, owner, { deliverableId, channelId, title })
  await f.svc.dispatchWorkItem(projectId, w.id, owner)
  const attempt = f.attempts.findLiveByWorkItem(w.id)!
  const rootId = attempt.channelTaskId!
  const child = f.tasks.create({
    channelId, parentId: rootId, creatorId: 'lead', assigneeId: 'worker-1',
    title: `${title}·执行`, source: 'project', projectId, projectWorkItemId: w.id,
  })
  f.tasks.update(child.id, { state: 'COMPLETED', artifacts: [{ artifactId: `c-${w.id}`, name: 'mock 成果', parts: [{ text: `<html>${title}</html>` }] }] })
  f.tasks.update(rootId, {
    state: 'COMPLETED',
    artifacts: [
      { artifactId: `in-${w.id}`, name: 'input', parts: [{ text: 'handoff' }] },
      { artifactId: `lead-${w.id}`, name: 'lead-acceptance-summary', parts: [{ text: `验收通过:${title}` }] },
    ],
  })
  f.svc.reconcile(projectId, owner)
  const draft = f.svc.listResults(projectId, owner).find(r => r.workItemId === w.id)!
  const submitted = f.svc.agentSubmitResult(leadId, { resultId: draft.id, taskId: rootId, summary: 'US-slot 提交' })
  f.svc.reviewResult(projectId, submitted.id, owner, 'reviewed', 'L1 通过')
  const req = f.svc.requestAcceptance(projectId, submitted.id, owner)
  const appr = f.svc.decideApproval(projectId, req.id, owner, true, 'L2 通过')
  const after = f.svc.listResults(projectId, owner).find(r => r.id === submitted.id)!
  return { w, submitted, appr, after }
}

test('approved 槽位按工作项隔离:两个工作项先后批准互不 supersede,交付物 approved,complete 门放行', async () => {
  const f = fixture()
  try {
    const p = await f.svc.create({
      name: `SLOT-${randomUUID().slice(0, 8)}`, objective: 'slot scope',
      planApprovalRequired: 0, autoDispatch: false, routingPolicy: 'legacy',
    }, owner)
    const a = await f.manager.createChannel({ name: `ch-${randomUUID().slice(0, 6)}`, ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' } })
    f.svc.bindChannel(p.id, a.channelId, owner)
    const d = f.svc.createDeliverable(p.id, owner, { name: 'multi.html', ownerChannelId: a.channelId })
    f.svc.activate(p.id, owner)

    const r1 = await driveToAccepted(f, p.id, d.id, a.channelId, a.leadAgentId!, '工作项一')
    assert.equal(r1.after.status, 'approved')
    const r2 = await driveToAccepted(f, p.id, d.id, a.channelId, a.leadAgentId!, '工作项二')
    assert.equal(r2.after.status, 'approved', '第二个工作项批准不被 supersede(槽位隔离)')
    const r1After = f.svc.listResults(p.id, owner).find(x => x.id === r1.submitted.id)!
    assert.equal(r1After.status, 'approved', '第一个工作项的 approved 不被跨工作项收编')

    const deliverable = f.svc.listDeliverables(p.id, owner).find(x => x.id === d.id)!
    assert.equal(deliverable.status, 'approved', '全部工作项各有 approved → 交付物 approved')

    // complete 门放行
    const approval = f.svc.requestProjectComplete(p.id, owner)
    assert.ok(approval, 'complete 门通过(不再 DELIVERABLES_INCOMPLETE)')
    f.svc.decideApproval(p.id, approval.id, owner, true, '完成')
    const after = f.svc.get(p.id, owner)
    assert.equal(after.status, 'completed')
  }
  finally {
    f.db.close()
  }
})

test('approved 槽位:同工作项新版本批准仍收编旧版本(版本替换语义保持)', async () => {
  const f = fixture()
  try {
    const p = await f.svc.create({
      name: `SLOT-V-${randomUUID().slice(0, 8)}`, objective: 'slot versioning',
      planApprovalRequired: 0, autoDispatch: false, routingPolicy: 'legacy',
    }, owner)
    const a = await f.manager.createChannel({ name: `ch-${randomUUID().slice(0, 6)}`, ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' } })
    f.svc.bindChannel(p.id, a.channelId, owner)
    const d = f.svc.createDeliverable(p.id, owner, { name: 'v.html', ownerChannelId: a.channelId })
    f.svc.activate(p.id, owner)

    const r1 = await driveToAccepted(f, p.id, d.id, a.channelId, a.leadAgentId!, '版本一')
    assert.equal(r1.after.status, 'approved')
    // 同工作项 rework → retry → 新 attempt → 新 draft → 新批准收编旧版本
    f.workItems.update(r1.w.id, { state: 'DRAFT', stateReason: 'SLOT_TEST', currentAttemptId: null })
    await f.svc.dispatchWorkItem(p.id, r1.w.id, owner)
    const attempt2 = f.attempts.findLiveByWorkItem(r1.w.id)!
    const root2 = attempt2.channelTaskId!
    const child2 = f.tasks.create({
      channelId: a.channelId, parentId: root2, creatorId: 'lead', assigneeId: 'worker-1',
      title: '版本二·执行', source: 'project', projectId: p.id, projectWorkItemId: r1.w.id,
    })
    f.tasks.update(child2.id, { state: 'COMPLETED', artifacts: [{ artifactId: `c2-${r1.w.id}`, name: 'mock 成果', parts: [{ text: '<html>版本二</html>' }] }] })
    f.tasks.update(root2, { state: 'COMPLETED', artifacts: [{ artifactId: `lead2-${r1.w.id}`, name: 'lead-acceptance-summary', parts: [{ text: '验收通过:版本二' }] }] })
    f.svc.reconcile(p.id, owner)
    const draft2 = f.svc.listResults(p.id, owner).find(x => x.workItemId === r1.w.id && x.status === 'draft')!
    const sub2 = f.svc.agentSubmitResult(a.leadAgentId!, { resultId: draft2.id, taskId: root2, summary: '版本二提交' })
    f.svc.reviewResult(p.id, sub2.id, owner, 'reviewed', 'L1 通过')
    const req2 = f.svc.requestAcceptance(p.id, sub2.id, owner)
    f.svc.decideApproval(p.id, req2.id, owner, true, 'L2 通过')
    const after2 = f.svc.listResults(p.id, owner).find(x => x.id === sub2.id)!
    assert.equal(after2.status, 'approved', '新版本 approved')
    const oldRow = f.svc.listResults(p.id, owner).find(x => x.id === r1.submitted.id)!
    assert.equal(oldRow.status, 'superseded', '同工作项旧版本被收编(版本替换语义保持)')
  }
  finally {
    f.db.close()
  }
})

test('重复创建工作项 → 结构化 409(不再是 500)', async () => {
  const f = fixture()
  try {
    const p = await f.svc.create({
      name: `DUP-${randomUUID().slice(0, 8)}`, objective: 'dup',
      planApprovalRequired: 0, autoDispatch: false, routingPolicy: 'legacy',
    }, owner)
    const a = await f.manager.createChannel({ name: `ch-${randomUUID().slice(0, 6)}`, ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' } })
    f.svc.bindChannel(p.id, a.channelId, owner)
    const d = f.svc.createDeliverable(p.id, owner, { name: 'dup.html', ownerChannelId: a.channelId })
    f.svc.activate(p.id, owner)
    f.svc.createWorkItem(p.id, owner, { deliverableId: d.id, channelId: a.channelId, title: '同标题工作项' })
    assert.throws(
      () => f.svc.createWorkItem(p.id, owner, { deliverableId: d.id, channelId: a.channelId, title: '同标题工作项' }),
      (e: unknown) => (e as { code?: string }).code === 'WORK_ITEM_EXISTS',
      '同 dedupe 键重复创建 → 结构化 409 WORK_ITEM_EXISTS',
    )
  }
  finally {
    f.db.close()
  }
})
