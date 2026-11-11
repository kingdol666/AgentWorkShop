import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-integrity-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { createImprovementActionRepo } = await import('../server/services/workshop/db/improvement-action.repo')
const { createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
const { createHarnessProfileRepo } = await import('../server/services/workshop/experience/harness-profile')
const { recordBenchRun } = await import('../server/services/workshop/experience/bench-run')
const { mergeExperiences, promoteExperience } = await import('../server/services/workshop/experience/promote')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { channelOverlayText, resetHarnessOverlayCache } = await import('../server/services/workshop/experience/overlay')

function experience(repo: ReturnType<typeof createMemoryRepo>, channelId: string, dedupKey: string, taskIds: string[], status: 'candidate' | 'validated' = 'candidate', expiresAt: string | null = null) {
  return repo.upsertExperience({
    channelId, agentId: 'agent-a', kind: 'experience', title: dedupKey, titleFts: dedupKey,
    content: `内容-${dedupKey}`, importance: 0.8, dedupKey, outcome: 'positive',
    evidence: taskIds.length > 0 ? { taskIds } : { taskIds: [], traceId: `empty-${dedupKey}` }, scopeKind: 'line', scopeKey: 'line-1', status, expiresAt,
  })
}

function task(tasks: ReturnType<typeof createTaskRepo>, channelId: string, assigneeId: string, title: string, state: string = 'COMPLETED') {
  return tasks.create({ channelId, assigneeId, creatorId: assigneeId, title, state, source: 'channel' })
}

test('RSI bench ignores client pValue and derives a conservative paired value', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const result = recordBenchRun(db, {
      channelId: 'ch-1', actor: 'u-1',
      artifact: {
        profileId: 'profile-1', pValue: 0,
        perSeed: [{ seed: 1, a: 0, b: 1 }, { seed: 2, a: 0, b: 1 }, { seed: 3, a: 0, b: 1 }],
      },
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.run.pValue, 1, 'negative paired deltas cannot inherit pValue=0')
  }
  finally { db.close() }
})

test('RSI evidence merge rejects fake and cross-channel task IDs when task data exists', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const agents = createChannelAgentRepo(db)
    const tasks = createTaskRepo(db)
    const a = channels.create({ name: 'A' })
    const b = channels.create({ name: 'B' })
    const leadA = agents.create({ channelId: a.id, templateId: null, name: 'A lead', harness: 'mock', role: 'lead' })
    const leadB = agents.create({ channelId: b.id, templateId: null, name: 'B lead', harness: 'mock', role: 'lead' })
    const completedA1 = task(tasks, a.id, leadA.id, 'done-a1')
    const completedA2 = task(tasks, a.id, leadA.id, 'done-a2')
    const completedB1 = task(tasks, b.id, leadB.id, 'done-b1')
    const workingA = task(tasks, a.id, leadA.id, 'working-a', 'WORKING')
    const repo = createMemoryRepo(db)
    const first = experience(repo, a.id, 'one', [completedA1.id])
    const second = experience(repo, a.id, 'two', [completedA2.id])
    const fake = experience(repo, a.id, 'fake', ['fake-task'])
    const empty = experience(repo, a.id, 'empty', [])
    assert.equal(mergeExperiences(db, { channelId: a.id, memoryIds: [first.id, fake.id], actor: 'u-1' }).ok, false)
    assert.equal(mergeExperiences(db, { channelId: a.id, memoryIds: [first.id, empty.id], actor: 'u-1' }).ok, false)
    assert.equal(mergeExperiences(db, { channelId: a.id, memoryIds: [first.id, workingA.id], actor: 'u-1' }).ok, false)
    const foreign = experience(repo, a.id, 'foreign-task', [completedB1.id])
    assert.equal(mergeExperiences(db, { channelId: a.id, memoryIds: [first.id, foreign.id], actor: 'u-1' }).ok, false)
    const merged = mergeExperiences(db, { channelId: a.id, memoryIds: [first.id, second.id], actor: 'u-1' })
    assert.equal(merged.ok, true, merged.reasons.join('；'))
    assert.ok(completedA1.id && completedA2.id && completedB1.id && workingA.id && leadB.id)
  }
  finally { db.close() }
})

test('RSI overlay renders only validated same-line experience pins', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const a = channels.create({ name: 'A' })
    db.prepare('UPDATE channels SET line_id = ? WHERE id = ?').run('line-1', a.id)
    configureAmlRuntime(db)
    const repo = createMemoryRepo(db)
    const candidate = experience(repo, a.id, 'candidate', ['t-1'], 'candidate')
    const valid = experience(repo, a.id, 'valid', ['t-2'], 'validated')
    const expired = experience(repo, a.id, 'expired', ['t-4'], 'validated', new Date(Date.now() - 1_000).toISOString())
    const foreignChannel = channels.create({ name: 'B' })
    const foreign = experience(repo, foreignChannel.id, 'foreign', ['t-3'], 'validated')
    const profiles = createHarnessProfileRepo(db)
    profiles.create({ channelId: a.id, status: 'active', layers: { pins: [candidate.id, valid.id, expired.id, foreign.id] } })
    resetHarnessOverlayCache()
    const text = channelOverlayText(a.id)
    assert.match(text, /内容-valid/)
    assert.doesNotMatch(text, /内容-candidate/)
    assert.doesNotMatch(text, /内容-expired/)
    assert.doesNotMatch(text, /内容-foreign/)
  }
  finally { db.close() }
})

test('RSI memory status CAS cannot overwrite validated with a stale write', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const agents = createChannelAgentRepo(db)
    const tasks = createTaskRepo(db)
    const a = channels.create({ name: 'A' })
    const lead = agents.create({ channelId: a.id, templateId: null, name: 'A lead', harness: 'mock', role: 'lead' })
    const completedA1 = task(tasks, a.id, lead.id, 'done-a1')
    const completedA2 = task(tasks, a.id, lead.id, 'done-a2')
    const repo = createMemoryRepo(db)
    const row = experience(repo, a.id, 'cas', [completedA1.id, completedA2.id])
    assert.equal(repo.markStatus(row.id, 'validated', 'candidate'), true)
    assert.equal(repo.markStatus(row.id, 'candidate', 'validated'), false)
    assert.equal(repo.markStatus(row.id, 'contested', 'candidate'), false)
    assert.equal(repo.markStatus(row.id, 'active', 'candidate'), false)
    assert.equal(repo.getById(row.id)?.status, 'validated')
    assert.equal(promoteExperience(db, { memoryId: row.id, channelId: a.id, to: 'validated', actor: 'u-1' }).ok, false)
  }
  finally { db.close() }
})

test('RSI promotion rejects a deterministic stale CAS without audit or improvement action', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const agents = createChannelAgentRepo(db)
    const tasks = createTaskRepo(db)
    const a = channels.create({ name: 'A' })
    const lead = agents.create({ channelId: a.id, templateId: null, name: 'A lead', harness: 'mock', role: 'lead' })
    const completedA1 = task(tasks, a.id, lead.id, 'done-a1')
    const completedA2 = task(tasks, a.id, lead.id, 'done-a2')
    const repo = createMemoryRepo(db)
    const row = experience(repo, a.id, 'stale-cas', [completedA1.id, completedA2.id])
    const staleRepo = {
      getById: (id: string) => repo.getById(id),
      markStatus: (id: string, status: 'validated' | 'retired', expectedStatus: 'candidate' | 'active' | 'validated' | 'retired') => {
        assert.equal(repo.markStatus(id, 'validated', expectedStatus), true, 'simulated concurrent candidate→validated update')
        return repo.markStatus(id, status, expectedStatus)
      },
    }
    bindOpsRepos({ audit: createAuditRepo(db) } as never)

    const result = promoteExperience(
      db,
      { memoryId: row.id, channelId: a.id, to: 'validated', actor: 'u-1' },
      { memoryRepo: staleRepo },
    )

    assert.equal(result.ok, false)
    assert.deepEqual(result.reasons, ['PROMOTION_CAS_FAILED: 经验状态迁移未命中（目标 validated，条目已被并发更新）'])
    assert.equal(repo.getById(row.id)?.status, 'validated')
    assert.equal(createImprovementActionRepo(db).stats(a.id).length, 0, 'stale CAS must not record improvement action')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND target_id = ?').get('experience.promote.validated', row.id)?.n, 0, 'stale CAS must not record promotion audit')
  }
  finally { db.close() }
})

test('RSI direct validated promotion rejects empty, fake, non-completed, and cross-channel evidence', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const channels = createChannelRepo(db)
    const agents = createChannelAgentRepo(db)
    const tasks = createTaskRepo(db)
    const a = channels.create({ name: 'A' })
    const b = channels.create({ name: 'B' })
    const leadA = agents.create({ channelId: a.id, templateId: null, name: 'A lead', harness: 'mock', role: 'lead' })
    const leadB = agents.create({ channelId: b.id, templateId: null, name: 'B lead', harness: 'mock', role: 'lead' })
    const completedA1 = task(tasks, a.id, leadA.id, 'done-a1')
    const completedA2 = task(tasks, a.id, leadA.id, 'done-a2')
    const completedB1 = task(tasks, b.id, leadB.id, 'done-b1')
    const workingA = task(tasks, a.id, leadA.id, 'working-a', 'WORKING')
    const repo = createMemoryRepo(db)
    for (const [key, taskIds] of [
      ['empty', []],
      ['fake', ['fake-task']],
      ['working', [workingA.id, completedA1.id]],
      ['foreign', [completedB1.id, completedA1.id]],
    ] as Array<[string, string[]]>) {
      const row = experience(repo, a.id, `promote-${key}`, taskIds)
      assert.equal(promoteExperience(db, { memoryId: row.id, channelId: a.id, to: 'validated', actor: 'u-1' }).ok, false, key)
    }
    const valid = experience(repo, a.id, 'promote-valid', [completedA1.id, completedA2.id])
    assert.equal(promoteExperience(db, { memoryId: valid.id, channelId: a.id, to: 'validated', actor: 'u-1' }).ok, true)
  }
  finally { db.close() }
})
