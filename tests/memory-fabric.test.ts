/**
 * 批次 I/J/K/L：Memory Fabric 策略、Core Blocks、记忆文件、工作记忆、时序/链接、导出导入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-fabric-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { upsertBlock, appendBlock, getBlock, setBlockLocked, rollbackBlock, blockRevisions } = await import('../server/services/workshop/memory/blocks')
const { createDocument, getDocument, insertDocument, replaceInDocument, renameDocument, softDeleteDocument, restoreDocument, normalizeDocumentPath } = await import('../server/services/workshop/memory/documents')
const { upsertWorkingMemory, loadWorkingMemory, cleanupWorkingMemory } = await import('../server/services/workshop/memory/working')
const { addMemoryLink, listMemoryLinks, supersedeMemory } = await import('../server/services/workshop/memory/links')
const { exportMemoryJsonl, importMemoryJsonl, redactSensitive, memoryHealth, repairMemory } = await import('../server/services/workshop/memory/export')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'fabric.sqlite'))
configureAmlRuntime(db)
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
  VALUES ('c1','C1','','','','{}',1,1,'L1','u1',?,?)`).run(now, now)
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
  VALUES ('c2','C2','','','','{}',1,1,'L1','u1',?,?)`).run(now, now)
const repo = createMemoryRepo(db)

test('access policy: disabled blocks read/write, isolated hides line/product', async () => {
  const lineExp = repo.upsertExperience({
    channelId: 'c1', agentId: 'a1', kind: 'experience', title: '线经验', titleFts: '线 经 验',
    content: '线经验 123', importance: 0.7, dedupKey: 'exp:line', evidence: { taskIds: ['t1'] },
    scopeKind: 'line', scopeKey: 'L1', status: 'validated',
  }).id
  db.prepare(`INSERT INTO experience_versions
    (version_id, experience_id, claim_origin_id, scope_kind, scope_key, claim_json, content, content_hash,
     evidence_json, evidence_snapshot_hash, lifecycle, deployment, claim_origin_time, beta_ancestors_json, idempotency_key, created_at)
    VALUES ('ev-fab-line', ?, 'co-fab', 'line','L1','{}','x','h1','[]','h2','validated','active',?,'[]','idem-fab',?)`).run(lineExp, now, now)
  db.prepare(`INSERT INTO experience_heads(experience_id, version_id, updated_at) VALUES (?, 'ev-fab-line', ?)`).run(lineExp, now)

  const memory = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: 's1', lineId: 'L1', industrialScopeEnabled: true })
  const isolated = await memory.recallRows('线经验 123', { scope: 'auto', sessionId: 's1' })
  assert.ok(isolated.some(r => r.id === lineExp), 'inherit 下可见线经验')

  db.prepare(`UPDATE channels SET memory_access_mode='isolated' WHERE id='c1'`).run()
  const hidden = await memory.recallRows('线经验 123', { scope: 'auto', sessionId: 's1' })
  assert.ok(!hidden.some(r => r.id === lineExp), 'isolated 不读 line/product')

  db.prepare(`UPDATE channels SET memory_access_mode='disabled' WHERE id='c1'`).run()
  assert.equal(await memory.recall('线经验'), null)
  await assert.rejects(() => memory.save({ title: 'x', content: 'y', scope: 'private', sessionId: 's1' }))
  db.prepare(`UPDATE channels SET memory_access_mode='inherit' WHERE id='c1'`).run()
})

test('core blocks: limit, locked, revisions, rollback', () => {
  const scopeId = 'channel:c1'
  const first = upsertBlock(db, { scopeId, channelId: 'c1', label: '工艺口径', value: '保压 62', actor: 'a1', limitChars: 100 })
  assert.equal(first.block.revision, 1)
  const appended = appendBlock(db, { scopeId, channelId: 'c1', label: '工艺口径', value: '壁厚 ≥ 3.0', actor: 'a1', limitChars: 100 })
  assert.equal(appended.block.revision, 2)
  assert.ok(appended.block.value.includes('壁厚'))

  setBlockLocked(db, scopeId, '工艺口径', true, 'u1')
  assert.throws(() => appendBlock(db, { scopeId, channelId: 'c1', label: '工艺口径', value: 'x', actor: 'a1' }))
  const human = appendBlock(db, { scopeId, channelId: 'c1', label: '工艺口径', value: '人工追加', actor: 'u1', human: true })
  assert.ok(human.block.value.includes('人工追加'))

  const revisions = blockRevisions(db, scopeId, '工艺口径')
  assert.ok(revisions.length >= 2)
  assert.equal(rollbackBlock(db, scopeId, '工艺口径', 1, 'u1'), true)
  assert.equal(getBlock(db, scopeId, '工艺口径')?.value, '保压 62')
})

test('memory files: six commands, traversal rejection, soft delete/restore', () => {
  const scopeId = 'channel:c1'
  const input = { scopeId, channelId: 'c1', authorKind: 'agent' as const, authorId: 'a1' }
  const doc = createDocument(db, { ...input, path: '/memories/channel/note.md', content: 'line1' })
  assert.equal(doc.revision, 1)
  insertDocument(db, { ...input, path: '/memories/channel/note.md', content: 'line2' }, 1)
  assert.ok(getDocument(db, scopeId, '/memories/channel/note.md')!.content.includes('line2'))
  replaceInDocument(db, { ...input, path: '/memories/channel/note.md', content: 'lineX' }, 'line2')
  assert.ok(getDocument(db, scopeId, '/memories/channel/note.md')!.content.includes('lineX'))
  const renamed = renameDocument(db, scopeId, '/memories/channel/note.md', '/memories/channel/note2.md', 'a1')
  assert.equal(renamed.path, '/memories/channel/note2.md')
  assert.equal(softDeleteDocument(db, scopeId, renamed.path, 'a1'), true)
  assert.ok(getDocument(db, scopeId, renamed.path)!.deletedAt)
  assert.equal(restoreDocument(db, scopeId, renamed.path), true)
  assert.equal(getDocument(db, scopeId, renamed.path)!.deletedAt, null)

  for (const path of ['/memories/channel/../etc', '/etc/passwd', 'C:/x', '/memories/channel/%2e%2e/x', '/memories/channel\\x']) {
    assert.throws(() => normalizeDocumentPath(path), `应拒绝 ${path}`)
  }
})

test('working memory: per runtime/session/task; TTL cleanup', () => {
  upsertWorkingMemory(db, { runtimeId: 'r1', sessionId: 's1', taskId: 't1', key: 'last_turn', value: '正在调保压' })
  upsertWorkingMemory(db, { runtimeId: 'r2', sessionId: 's1', taskId: 't1', key: 'last_turn', value: '另一个 runtime' })
  const mine = loadWorkingMemory(db, 'r1', 's1', 't1')
  assert.equal(mine.length, 1)
  assert.ok(mine[0]!.value.includes('保压'))
  assert.equal(loadWorkingMemory(db, 'r2', 's1', 't1')[0]!.value, '另一个 runtime')
  db.prepare('UPDATE runtime_working_memory SET expires_at = ? WHERE runtime_id = ?').run(new Date(Date.now() - 1000).toISOString(), 'r2')
  cleanupWorkingMemory(db)
  assert.equal(loadWorkingMemory(db, 'r2', 's1', 't1').length, 0)
})

test('temporal validity + links: expired excluded, asOf sees history, supersede keeps row', async () => {
  const oldId = repo.upsert({ channelId: 'c1', agentId: 'a1', kind: 'semantic', title: '旧结论', titleFts: '旧 结 论', content: '旧结论 111', importance: 0.7, sessionId: '', dedupKey: 'old' }).id
  const newId = repo.upsert({ channelId: 'c1', agentId: 'a1', kind: 'semantic', title: '新结论', titleFts: '新 结 论', content: '新结论 222', importance: 0.7, sessionId: '', dedupKey: 'new' }).id
  supersedeMemory(db, oldId, newId, 'u1')
  addMemoryLink(db, { srcId: newId, dstId: oldId, relation: 'supports', createdBy: 'u1' })
  const memory = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: '', industrialScopeEnabled: false })
  const current = await memory.recallRows('结论 111 222', { scope: 'auto' })
  assert.ok(!current.some(r => r.id === oldId), '失效事实默认排除')
  assert.ok(current.some(r => r.id === newId))
  const past = await memory.recallRows('结论 111', { scope: 'auto', asOf: now })
  assert.ok(past.some(r => r.id === oldId), 'asOf 回看历史有效事实')
  assert.ok(listMemoryLinks(db, oldId).some(l => l.relation === 'supersedes' && l.srcId === newId))
})

test('export/import roundtrip, redaction, health and repair', () => {
  repo.upsert({ channelId: 'c1', agentId: 'a1', kind: 'semantic', title: '导出样本', titleFts: '导 出 样 本', content: 'api_key = sk-123456789012345', importance: 0.7, sessionId: '', dedupKey: 'export' })
  upsertBlock(db, { scopeId: 'channel:c1', channelId: 'c1', label: '导出块', value: '块值', actor: 'u1' })
  const jsonl = exportMemoryJsonl(db, { channelId: 'c1' })
  assert.ok(jsonl.includes('"type":"memory"'))
  assert.ok(jsonl.includes('"type":"block"'))
  const report = importMemoryJsonl(db, 'c2', jsonl, 'u1')
  assert.ok(report.memories > 0)
  assert.ok(report.redacted >= 1)
  const imported = db.prepare(`SELECT content FROM agent_memories WHERE channel_id='c2' AND title='导出样本'`).get() as { content?: string }
  assert.ok(!String(imported.content).includes('sk-123456789012345'), '敏感值不得落库')
  const health = memoryHealth(db, 'c1')
  assert.equal(health.ftsHealthy, true)
  const repaired = repairMemory(db)
  assert.ok(typeof repaired.expiredWorking === 'number')
  assert.equal(redactSensitive('password=abcdefgh').hits, 1)
})
