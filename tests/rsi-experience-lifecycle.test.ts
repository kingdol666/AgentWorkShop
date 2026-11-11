/**
 * RSI 经验生命周期守卫(2026-11-10 审计)。
 *
 * 三个真问题:
 *  ① `upsertExperience` 的 ON CONFLICT 无条件写 status/evidence —— 任何一次反射器重放
 *    或 Agent 重存都会把人工策展的 validated 打回 candidate 并抹掉合并证据;
 *  ② 反射器一任务一条经验,晋升门要求 ≥2 独立任务样本,但没有合并端点 →
 *    自动产物永远停在 candidate("先验证再晋级"退化为"永不晋级"),现场只能裸 SQL 合并;
 *  ③ `rejected`/`expired` 状态全库无写者;`markRecipeProposalsAccepted` 按 recipe_id
 *    把该配方**所有** pending 一把收 accepted(内容无关的提案也记"已采纳")。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-lifecycle-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { mergeExperiences, promoteExperience } = await import('../server/services/workshop/experience/promote')
const { createImprovementRepo, markRecipeProposalsAccepted, expireStaleProposals } = await import('../server/services/workshop/db/improvement.repo')

const fixture = () => {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  return { db, repo: createMemoryRepo(db) }
}

const completedTasks = (db: ReturnType<typeof openWorkshopDb>, channelId: string, count: number) => {
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const channel = channels.findById(channelId)
  const agent = agents.create({ channelId: channel?.id ?? channelId, templateId: null, name: 'lead', harness: 'mock', role: 'lead' })
  return Array.from({ length: count }, (_, i) => tasks.create({
    channelId, assigneeId: agent.id, creatorId: agent.id, title: `done-${i + 1}`, state: 'COMPLETED', source: 'channel',
  }))
}

const seed = (repo: ReturnType<typeof fixture>['repo'], dedupKey: string, taskIds: string[], status: 'candidate' | 'validated' = 'candidate') =>
  repo.upsertExperience({
    channelId: 'ch-1', agentId: 'agent-a', kind: 'experience',
    title: `经验-${dedupKey}`, titleFts: '经 验', content: '同结论', importance: 0.8,
    dedupKey, outcome: 'positive', evidence: taskIds.length > 0 ? { taskIds } : { taskIds: [], traceId: `empty-${dedupKey}` },
    scopeKind: 'line', scopeKey: 'line-1', status, expiresAt: null,
  })

test('状态单调性:重放/重存不得把 validated 打回 candidate,也不覆盖证据', () => {
  const { db, repo } = fixture()
  try {
    const { id } = seed(repo, 'exp:mono', ['t-1', 't-2'], 'validated')
    seed(repo, 'exp:mono', ['t-9'], 'candidate')
    const row = repo.getById(id)!
    assert.equal(row.status, 'validated', '人工策展状态必须单调')
    const ev = JSON.parse(String(row.evidenceJson)) as { taskIds: string[] }
    assert.deepEqual(ev.taskIds, ['t-1', 't-2'], '证据不得被重放覆盖')
  }
  finally {
    db.close()
  }
})

test('合并端点:证据并集 + 不自动晋级(人审批)', () => {
  const { db, repo } = fixture()
  try {
    const tasks = completedTasks(db, 'ch-1', 2)
    const a = seed(repo, 'exp:m1', [tasks[0]!.id])
    const b = seed(repo, 'exp:m2', [tasks[1]!.id])
    const merged = mergeExperiences(db, { channelId: 'ch-1', memoryIds: [a.id, b.id], actor: 'u-1' })
    assert.equal(merged.ok, true, merged.reasons.join('；'))
    assert.deepEqual([...(merged.taskIds ?? [])].sort(), [tasks[0]!.id, tasks[1]!.id].sort())
    const row = repo.getById(merged.memoryId!)!
    assert.equal(row.status, 'candidate', '合并本身不晋级')
    // 证据并集后达到门要求(≥2 独立任务) → 人可晋升
    const promoted = promoteExperience(db, { memoryId: merged.memoryId!, channelId: 'ch-1', to: 'validated', actor: 'u-1' })
    assert.equal(promoted.ok, true, promoted.reasons.join('；'))
  }
  finally {
    db.close()
  }
})

test('合并端点:跨频道/空、伪造、未完成证据一律拒绝', () => {
  const { db, repo } = fixture()
  try {
    const channels = createChannelRepo(db)
    const agents = createChannelAgentRepo(db)
    const tasks = createTaskRepo(db)
    const a = channels.create({ name: 'A' })
    const b = channels.create({ name: 'B' })
    const leadA = agents.create({ channelId: a.id, templateId: null, name: 'A lead', harness: 'mock', role: 'lead' })
    const leadB = agents.create({ channelId: b.id, templateId: null, name: 'B lead', harness: 'mock', role: 'lead' })
    const completedA = tasks.create({ channelId: a.id, assigneeId: leadA.id, creatorId: leadA.id, title: 'done-a', state: 'COMPLETED', source: 'channel' })
    const completedB = tasks.create({ channelId: b.id, assigneeId: leadB.id, creatorId: leadB.id, title: 'done-b', state: 'COMPLETED', source: 'channel' })
    const workingA = tasks.create({ channelId: a.id, assigneeId: leadA.id, creatorId: leadA.id, title: 'working-a', state: 'WORKING', source: 'channel' })
    const empty = seed(repo, 'exp:empty', [])
    const fake = seed(repo, 'exp:fake', ['fake-task'])
    const nonCompleted = seed(repo, 'exp:working', [workingA.id])
    const crossChannel = seed(repo, 'exp:cross', [completedB.id])
    const completed = seed(repo, 'exp:completed', [completedA.id])
    assert.equal(mergeExperiences(db, { channelId: a.id, memoryIds: [empty.id, completed.id], actor: 'u-1' }).ok, false)
    assert.equal(mergeExperiences(db, { channelId: a.id, memoryIds: [fake.id, completed.id], actor: 'u-1' }).ok, false)
    assert.equal(mergeExperiences(db, { channelId: a.id, memoryIds: [nonCompleted.id, completed.id], actor: 'u-1' }).ok, false)
    assert.equal(mergeExperiences(db, { channelId: a.id, memoryIds: [crossChannel.id, completed.id], actor: 'u-1' }).ok, false)
    assert.equal(mergeExperiences(db, { channelId: a.id, memoryIds: [completed.id], actor: 'u-1' }).ok, false)
  }
  finally {
    db.close()
  }
})

test('提案生命周期:按源收口只动 recipe_update + 过期清理可写 expired', () => {
  const { db } = fixture()
  try {
    const repo = createImprovementRepo(db)
    repo.create({ kind: 'recipe_update', channelId: 'ch-1', lineId: 'line-1', recipeId: 'r-1', sourceKind: 'intervention', sourceId: 's1', title: 'a', evidence: { taskIds: ['t-1'] } })
    repo.create({ kind: 'kb_ingest', channelId: 'ch-1', lineId: 'line-1', recipeId: 'r-1', sourceKind: 'review', sourceId: 's2', title: 'b', evidence: { taskIds: ['t-2'] } })
    const n = markRecipeProposalsAccepted(db, 'r-1', 'u-1')
    assert.equal(n, 1, '只收口 recipe_update 类提案')
    const rows = repo.listByChannel('ch-1', { limit: 10 })
    assert.equal(rows.find(r => r.kind === 'recipe_update')?.status, 'accepted')
    assert.equal(rows.find(r => r.kind === 'kb_ingest')?.status, 'pending', '内容无关的提案不得被连带收口')
    // 过期清理:把 created_at 改到 31 天前,再跑 sweep
    db.prepare('UPDATE improvement_proposals SET created_at = ? WHERE kind = ?').run(new Date(Date.now() - 31 * 86_400_000).toISOString(), 'kb_ingest')
    assert.equal(expireStaleProposals(db, 30), 1)
    assert.equal(repo.listByChannel('ch-1', { limit: 10 }).find(r => r.kind === 'kb_ingest')?.status, 'expired')
  }
  finally {
    db.close()
  }
})
