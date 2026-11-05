/**
 * Router v3 P3（2026-11-05）：执行工作台读模型。
 *
 * 覆盖：后端派生 stage/waitingOn；Channel 泳道计数；交付物三级门投影；
 * 工作项执行链（attempts/root/worker/artifacts/results/reviews）；activity 游标；route 日志。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-observability-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createProjectAttemptRepo } = await import('../server/services/workshop/db/project.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const attempts = createProjectAttemptRepo(db)
  const manager = {
    async createChannel(input: { name: string, ownerUserId?: string | null, leadAgent?: { name: string, harness: string, agentKind?: string } }) {
      const ch = channels.create({ name: input.name, ownerUserId: input.ownerUserId ?? null })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({
          channelId: ch.id, templateId: null, name: input.leadAgent.name, harness: input.leadAgent.harness,
          role: 'lead', agentKind: input.leadAgent.agentKind as never,
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
    async submitProjectRoot(input: { projectId: string, workItemId: string, attemptNo: number, sourceKey: string, channelId: string, title: string, description?: string, execBudgetMinutes?: number, parts?: unknown[] }) {
      const ch = channels.findById(input.channelId)!
      const row = tasks.create({
        channelId: input.channelId, creatorId: `project:${input.projectId}`, assigneeId: ch.leadAgentId!,
        title: input.title, description: input.description, sourceChatMessageId: input.sourceKey,
        deadlineAt: new Date(Date.now() + (input.execBudgetMinutes ?? 60) * 60_000).toISOString(),
        source: 'project', projectId: input.projectId, projectWorkItemId: input.workItemId, projectAttemptNo: input.attemptNo,
      })
      return { task: { id: row.id } as never, created: true }
    },
    async sendImmediateMessage() {
      return { messageId: randomUUID() }
    },
  } as unknown as AgentChannelManager
  const svc = initProjectService(manager, db)
  return { db, channels, agents, tasks, attempts, manager, svc }
}

type Fixture = ReturnType<typeof fixture>

async function setup(f: Fixture) {
  const owner = { id: 'u-owner', role: 'user' }
  const p = await f.svc.create({
    name: `Obs-${randomUUID().slice(0, 8)}`, objective: 'observability',
    planApprovalRequired: 0, autoDispatch: true, routingPolicy: 'technical',
  }, owner)
  const a = await f.manager.createChannel({ name: `生产-${randomUUID().slice(0, 6)}`, ownerUserId: owner.id, leadAgent: { name: 'LeadA', harness: 'mock' } })
  const b = await f.manager.createChannel({ name: `评审-${randomUUID().slice(0, 6)}`, ownerUserId: owner.id, leadAgent: { name: 'LeadB', harness: 'mock' } })
  f.svc.bindChannel(p.id, a.channelId, owner)
  f.svc.bindChannel(p.id, b.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: '交付物', ownerChannelId: a.channelId, acceptanceCriteria: ['artifact.present'] })
  f.svc.activate(p.id, owner)
  return { owner, p, a, b, d, leadA: a.leadAgentId!, leadB: b.leadAgentId!, lead: f.svc.get(p.id, owner).leadAgentId! }
}

test('observability：stage 派生、Channel 泳道、交付物三级门、执行链、activity/route', async () => {
  const f = fixture()
  const s = await setup(f)
  const w = f.svc.createWorkItem(s.p.id, s.owner, { deliverableId: s.d.id, channelId: s.a.channelId, title: 'W1' })
  await f.svc.dispatchWorkItem(s.p.id, w.id, s.owner)
  const attempt = f.attempts.findLiveByWorkItem(w.id)!
  const task = f.tasks.findById(attempt.channelTaskId!)!
  f.tasks.update(task.id, {
    state: 'COMPLETED',
    artifacts: [{ artifactId: 'art-1', name: 'out.html', parts: [{ text: '<html>real</html>' }] }],
  })
  // 直接调用回调路径：立即收敛 + 自动派发（无后续可派项）
  f.svc.onTaskStateChange(task.id, 'COMPLETED')
  await f.svc.runRouteLoop(s.p.id)
  const result = f.svc.listResults(s.p.id, s.owner).find(r => r.workItemId === w.id)!
  f.svc.submitResult(s.p.id, result.id, s.owner, { evidence: [{ artifactId: 'art-1' }] })

  const obs1 = f.svc.projectObservability(s.p.id, s.owner)
  const obsW1 = obs1.workItems.find(x => x.id === w.id)!
  assert.equal(obsW1.stage, 'result_pending_review')
  assert.equal(obs1.summary.inFlight, 0)
  assert.equal(obs1.channels.find(c => c.channelId === s.a.channelId)!.workItems, 1)
  const obsD = obs1.deliverables.find(x => x.id === s.d.id)!
  assert.equal(obsD.contentReady, true)
  assert.equal(obsD.technicalAccepted, false)
  assert.equal(obsD.businessApproved, false)

  const detail1 = f.svc.projectWorkItemDetail(s.p.id, w.id, s.owner)
  assert.equal(detail1.attempts.length, 1)
  assert.equal(detail1.attempts[0]!.task!.artifacts.length, 1)
  assert.equal(detail1.attempts[0]!.task!.artifacts[0]!.bytes, 17)
  assert.equal(detail1.results.length, 1)
  assert.equal(detail1.results[0]!.status, 'submitted')
  assert.ok(detail1.events.some(e => e.type === 'work.completed'))

  f.svc.agentSubmitTechnicalReview(s.leadB, { resultId: result.id, verdict: 'pass' })
  const obs2 = f.svc.projectObservability(s.p.id, s.owner)
  assert.equal(obs2.workItems.find(x => x.id === w.id)!.stage, 'result_pending_acceptance')
  assert.equal(obs2.deliverables.find(x => x.id === s.d.id)!.technicalAccepted, true)
  const detail2 = f.svc.projectWorkItemDetail(s.p.id, w.id, s.owner)
  assert.equal(detail2.results[0]!.reviews.length, 1)
  assert.equal(detail2.results[0]!.reviews[0]!.verdict, 'pass')

  const activity = f.svc.projectActivity(s.p.id, s.owner, { limit: 100 })
  assert.ok(activity.items.length > 0)
  assert.ok(activity.items.some((i: Record<string, unknown>) => i.type === 'result.technical_accepted'))
  const last = activity.items[activity.items.length - 1] as { at: string }
  const after = f.svc.projectActivity(s.p.id, s.owner, { after: last.at, limit: 100 })
  assert.equal(after.items.length, 0)

  const route = f.svc.projectRouteView(s.p.id, s.owner)
  assert.equal(route.route.autoDispatch, true)
  assert.ok(route.dispatchLog.some(x => x.type === 'work.dispatch_auto' || x.type === 'work.dispatched'))
  assert.ok(route.planVersions.length >= 0)
})
