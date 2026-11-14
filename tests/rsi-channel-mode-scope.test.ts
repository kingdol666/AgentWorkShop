import { test } from 'node:test'
import { canonicalHash, canonicalJson } from '../shared/context/hash'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-mode-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { reflectExperience } = await import('../server/services/workshop/runtime/memory/reflector')
const { promoteExperience, mergeExperiences } = await import('../server/services/workshop/experience/promote')
const { channelModeOf, channelModeForAgent } = await import('../server/services/workshop/channel-mode')
const { ManagerA2A } = await import('../server/services/workshop/runtime/manager/a2a')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { createHarnessProfileRepo } = await import('../server/services/workshop/experience/harness-profile')
const { channelOverlayText, resetHarnessOverlayCache } = await import('../server/services/workshop/experience/overlay')

function fixture() {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, created_at, updated_at)
    VALUES ('ch','C','','','','{}',1,1,'line',?,?)`).run(now, now)
  const snapshot = { schemaVersion: 1, channelId: 'ch', bindingRevision: 1, productId: 'prod', lineId: 'line', recipes: [], agentBindings: [], executionProfile: { mode: 'auto' } }
  db.prepare(`INSERT INTO channel_sessions (id, channel_id, title, status, memory_policy, channel_mode, product_id, line_id, binding_snapshot_json, binding_snapshot_hash, binding_snapshot_revision, created_at)
    VALUES ('sess','ch','S','active','shared','production_line_integrated','prod','line',?,?,1,?)`).run(canonicalJson(snapshot), canonicalHash(snapshot), now)
  return { db, repo: createMemoryRepo(db) }
}

function exp(repo: ReturnType<typeof createMemoryRepo>, key: string, scopeKind: 'line' | 'product' | 'global' | 'channel', status: 'candidate' | 'validated' = 'validated') {
  return repo.upsertExperience({ channelId: 'ch', agentId: 'agent', title: `unique ${key}`, titleFts: `unique ${key}`, content: `content ${key}`, importance: 0.8, dedupKey: key, scopeKind, scopeKey: scopeKind === 'line' ? 'line' : scopeKind === 'product' ? 'prod' : '', status, outcome: 'positive', evidence: { taskIds: ['t1', 't2'] } })
}

test('generic memory denies industrial writes while retaining private and shared memory', async () => {
  const { db, repo } = fixture()
  try {
    const mem = new AgentMemory(repo, { channelId: 'ch', agentId: 'agent' })
    for (const scope of ['line', 'global'] as const) {
      await assert.rejects(() => mem.save({ title: 'T', content: 'C', scope, sessionId: 'sess', taskId: 't1' }), /industrial|production.line/i)
    }
    await mem.save({ title: 'private text', content: 'private body', scope: 'private' })
    await mem.save({ title: 'shared text', content: 'shared body', scope: 'shared' })
    assert.ok((await mem.recallRows('private')).some(r => r.title === 'private text'))
    assert.ok((await mem.recallRows('shared')).some(r => r.title === 'shared text'))
  }
  finally { db.close() }
})

test('generic recall excludes all industrial scope, including explicit product context', async () => {
  const { db, repo } = fixture()
  try {
    for (const scope of ['line', 'product', 'global', 'channel'] as const) exp(repo, scope, scope)
    const mem = new AgentMemory(repo, { channelId: 'ch', agentId: 'agent' })
    const rows = await mem.recallRows('unique', { limit: 20, scopeContext: { lineId: 'line', productId: 'prod' } })
    assert.deepEqual(rows.map(r => r.scopeKind), ['channel'])
    const block = await mem.recall('unique', { budgetTokens: 1000, scopeContext: { lineId: 'line', productId: 'prod' } })
    assert.match(block ?? '', /unique channel/)
    assert.doesNotMatch(block ?? '', /unique (line|product|global)/)
  }
  finally { db.close() }
})

test('integrated recall uses immutable trusted line and product anchors, not tool scope overrides', async () => {
  const { db, repo } = fixture()
  try {
    exp(repo, 'line-other', 'line')
    exp(repo, 'product-other', 'product')
    db.prepare(`UPDATE agent_memories SET scope_key = 'other-line' WHERE channel_id = 'ch' AND agent_id = 'agent' AND dedup_key = 'line-other'`).run()
    db.prepare(`UPDATE agent_memories SET scope_key = 'other-product' WHERE channel_id = 'ch' AND agent_id = 'agent' AND dedup_key = 'product-other'`).run()
    const mem = new AgentMemory(repo, { channelId: 'ch', agentId: 'agent', industrialScopeEnabled: true, productId: 'prod', lineId: 'line' })
    const wrongProduct = await mem.recallRows('unique product-other', { scope: 'private', scopeContext: { productId: 'other-product' } })
    const wrongLine = await mem.recallRows('unique line-other', { scope: 'private', scopeContext: { lineId: 'other-line' } })
    assert.deepEqual(wrongProduct, [])
    assert.deepEqual(wrongLine, [])
  }
  finally { db.close() }
})

test('trusted integrated memory enables industrial writes and recall', async () => {
  const { db, repo } = fixture()
  try {
    const mem = new AgentMemory(repo, { channelId: 'ch', agentId: 'agent', industrialScopeEnabled: true, productId: 'prod' } as never)
    await mem.save({ title: 'line saved', content: 'content', scope: 'line', sessionId: 'sess', taskId: 't1' })
    exp(repo, 'product', 'product')
    assert.ok((await mem.recallRows('unique', { scopeContext: { productId: 'prod' } })).some(r => r.scopeKind === 'product'))
  }
  finally { db.close() }
})

test('reflection keeps generic task experience in the channel despite line metadata', async () => {
  const { db, repo } = fixture()
  try {
    const fact = { source: 'task' as const, channelId: 'ch', agentId: 'agent', taskId: 't1', title: 'job', state: 'COMPLETED', deliverable: 'done', lineId: 'line' }
    const result = await reflectExperience(repo, null, fact)
    assert.equal(repo.getById(result.id!)?.scopeKind, 'channel')
    const integrated = await reflectExperience(repo, null, { ...fact, taskId: 't2' }, { industrialScopeEnabled: true } as never)
    assert.equal(repo.getById(integrated.id!)?.scopeKind, 'line')
    const replay = await reflectExperience(repo, null, { ...fact, taskId: 't2' })
    assert.equal(replay.written, false)
    assert.equal(repo.getById(integrated.id!)?.scopeKind, 'line')
  }
  finally { db.close() }
})

test('generic channels cannot promote or merge industrial experience', () => {
  const { db, repo } = fixture()
  try {
    const first = exp(repo, 'one', 'line', 'candidate')
    const second = exp(repo, 'two', 'line', 'candidate')
    const promote = promoteExperience(db, { memoryId: first.id, channelId: 'ch', to: 'validated', actor: 'human' })
    const merge = mergeExperiences(db, { memoryIds: [first.id, second.id], channelId: 'ch', actor: 'human' })
    assert.match(promote.reasons.join(' '), /industrial|production.line/i)
    assert.match(merge.reasons.join(' '), /industrial|production.line/i)
    assert.equal(repo.getById(first.id)?.status, 'candidate')
  }
  finally { db.close() }
})

test('mode helpers fail closed on missing, invalid and throwing managers', () => {
  const g = globalThis as unknown as { __workshopManager?: unknown }
  const old = g.__workshopManager
  try {
    g.__workshopManager = undefined
    assert.equal(channelModeOf('ch'), 'generic')
    g.__workshopManager = {
      channelModeOf: () => 'invalid',
      channelModeForAgent: () => { throw new Error('unavailable') },
    }
    assert.equal(channelModeOf('ch'), 'generic')
    assert.equal(channelModeForAgent('agent'), 'generic')
    g.__workshopManager = { channelModeOf: () => 'production_line_integrated', channelModeForAgent: () => 'production_line_integrated' }
    assert.equal(channelModeOf('ch'), 'production_line_integrated')
    assert.equal(channelModeForAgent('agent'), 'production_line_integrated')
  }
  finally { g.__workshopManager = old }
})

test('generic mode blocks cached overlay but integrated mode can render it', () => {
  const { db } = fixture()
  const g = globalThis as unknown as { __workshopManager?: unknown }
  const old = g.__workshopManager
  let mode = 'production_line_integrated'
  try {
    configureAmlRuntime(db)
    g.__workshopManager = { channelModeOf: () => mode }
    createHarnessProfileRepo(db).create({ channelId: 'ch', status: 'active', layers: { overlay: 'industrial overlay' } } as never)
    resetHarnessOverlayCache()
    assert.match(channelOverlayText('ch'), /industrial overlay/)
    mode = 'generic'
    assert.equal(channelOverlayText('ch'), '')
  }
  finally {
    g.__workshopManager = old
    resetHarnessOverlayCache()
    db.close()
  }
})

test('overlay pins use each agent session snapshot and never reuse another session cache', () => {
  const { db, repo } = fixture()
  const g = globalThis as unknown as { __workshopManager?: unknown }
  const old = g.__workshopManager
  const aml = globalThis as unknown as { __amlRuntime?: unknown }
  const oldAml = aml.__amlRuntime
  let scope: { sessionId: string, lineId: string, productId: string } | null = { sessionId: 's1', lineId: 'line', productId: 'prod' }
  let mode = 'production_line_integrated'
  let channelMode = 'generic'
  try {
    aml.__amlRuntime = undefined
    configureAmlRuntime(db)
    g.__workshopManager = {
      channelModeOf: () => channelMode,
      channelModeForAgent: () => mode,
      channelSessionScopeOfAgent: () => scope,
    }
    const line = exp(repo, 'line-pin', 'line')
    const product = exp(repo, 'product-pin', 'product')
    const channel = exp(repo, 'channel-pin', 'channel')
    createHarnessProfileRepo(db).create({ channelId: 'ch', status: 'active', layers: { pins: [line.id, product.id, channel.id] } })
    resetHarnessOverlayCache()
    const first = channelOverlayText('ch', 'agent')
    assert.match(first, /content line-pin/)
    assert.match(first, /content product-pin/)
    scope = { sessionId: 's2', lineId: 'different-line', productId: 'different-product' }
    const second = channelOverlayText('ch', 'agent')
    assert.doesNotMatch(second, /content (line-pin|product-pin)/)
    assert.match(second, /content channel-pin/)
    scope = null
    const missing = channelOverlayText('ch', 'agent')
    assert.doesNotMatch(missing, /content (line-pin|product-pin)/)
    assert.match(missing, /content channel-pin/)
    channelMode = 'production_line_integrated'
    mode = 'generic'
    assert.equal(channelOverlayText('ch', 'agent'), '')
  }
  finally {
    g.__workshopManager = old
    aml.__amlRuntime = oldAml
    resetHarnessOverlayCache()
    db.close()
  }
})

test('cross-channel industrial search checks requester and source modes', () => {
  const inst = Object.create(ManagerA2A.prototype) as {
    requireMember: () => object
    channelModeForAgent: () => string
    channelModeOf: (channelId: string) => string
    channelSessionScopeOfAgent: (channelId: string, agentId: string) => { sessionId: string, productId: string, lineId: string, bindingSnapshotHash: string, bindingSnapshotRevision: number } | null
    otherSameOwnerChannels: () => Array<{ id: string, name: string }>
    deps: unknown
    searchSharedExperience: (channelId: string, agentId: string, input: { query: string, scope: 'line' }) => unknown[]
  }
  let requester = 'generic'
  let source = 'production_line_integrated'
  let searches = 0
  inst.requireMember = () => ({})
  inst.channelModeForAgent = () => requester
  inst.channelModeOf = () => source
  inst.otherSameOwnerChannels = () => [{ id: 'other', name: 'Other' }]
  const trustedScope = { sessionId: 'sess', productId: 'prod', lineId: 'line', bindingSnapshotHash: 'hash', bindingSnapshotRevision: 1 }
  inst.channelSessionScopeOfAgent = () => trustedScope
  inst.deps = { repos: {
    channels: { findById: () => ({ lineId: 'line' }), list: () => [{ id: 'other', name: 'Other', enabled: 1, ownerUserId: 'owner' }] },
    memories: { searchExperienceAcross: () => {
      searches++
      return []
    }, channelScope: () => ({ lineId: 'line', productId: 'prod' }), touch: () => {} },
  } }
  const query = { query: 'test', scope: 'line' as const }
  assert.deepEqual(inst.searchSharedExperience('ch', 'agent', query), [])
  requester = 'production_line_integrated'
  source = 'generic'
  assert.deepEqual(inst.searchSharedExperience('ch', 'agent', query), [])
  assert.equal(searches, 0)
  source = 'production_line_integrated'
  inst.searchSharedExperience('ch', 'agent', query)
  assert.equal(searches, 1)
  inst.channelModeForAgent = () => {
    throw new Error('failed')
  }
  assert.deepEqual(inst.searchSharedExperience('ch', 'agent', query), [])
})
