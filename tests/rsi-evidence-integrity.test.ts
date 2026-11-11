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
const { createHarnessProfileRepo } = await import('../server/services/workshop/experience/harness-profile')
const { recordBenchRun } = await import('../server/services/workshop/experience/bench-run')
const { mergeExperiences, promoteExperience } = await import('../server/services/workshop/experience/promote')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { channelOverlayText, resetHarnessOverlayCache } = await import('../server/services/workshop/experience/overlay')

function experience(repo: ReturnType<typeof createMemoryRepo>, channelId: string, dedupKey: string, taskIds: string[], status: 'candidate' | 'validated' = 'candidate') {
  return repo.upsertExperience({
    channelId, agentId: 'agent-a', kind: 'experience', title: dedupKey, titleFts: dedupKey,
    content: `内容-${dedupKey}`, importance: 0.8, dedupKey, outcome: 'positive',
    evidence: { taskIds }, scopeKind: 'line', scopeKey: 'line-1', status,
  })
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
    const task = tasks.create({ channelId: a.id, assigneeId: leadA.id, creatorId: leadA.id, title: 'done', state: 'COMPLETED', source: 'channel' })
    const repo = createMemoryRepo(db)
    const first = experience(repo, a.id, 'one', [task.id])
    const fake = experience(repo, a.id, 'two', ['fake-task'])
    assert.equal(mergeExperiences(db, { channelId: a.id, memoryIds: [first.id, fake.id], actor: 'u-1' }).ok, false)
    const foreign = experience(repo, b.id, 'foreign', [task.id])
    assert.equal(mergeExperiences(db, { channelId: b.id, memoryIds: [foreign.id, foreign.id], actor: 'u-1' }).ok, false)
    assert.ok(leadB.id)
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
    const foreignChannel = channels.create({ name: 'B' })
    const foreign = experience(repo, foreignChannel.id, 'foreign', ['t-3'], 'validated')
    const profiles = createHarnessProfileRepo(db)
    profiles.create({ channelId: a.id, status: 'active', layers: { pins: [candidate.id, valid.id, foreign.id] } })
    resetHarnessOverlayCache()
    const text = channelOverlayText(a.id)
    assert.match(text, /内容-valid/)
    assert.doesNotMatch(text, /内容-candidate/)
    assert.doesNotMatch(text, /内容-foreign/)
  }
  finally { db.close() }
})

test('RSI memory status CAS cannot overwrite validated with a stale write', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const repo = createMemoryRepo(db)
    const row = experience(repo, 'ch-1', 'cas', ['t-1', 't-2'])
    assert.equal(repo.markStatus(row.id, 'validated'), true)
    assert.equal(repo.markStatus(row.id, 'candidate'), false)
    assert.equal(repo.getById(row.id)?.status, 'validated')
    assert.equal(promoteExperience(db, { memoryId: row.id, channelId: 'ch-1', to: 'validated', actor: 'u-1' }).ok, false)
  }
  finally { db.close() }
})
