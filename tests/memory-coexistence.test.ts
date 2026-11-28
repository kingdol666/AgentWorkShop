/**
 * AgentRuntime 记忆 ↔ 记忆中心 共存/冲突回归（2026-11-28）。
 *
 * 架构事实：两者共用 `agent_memories`（记忆中心是同一张表的 HITL 治理面），
 * 命名空间隔离（运行时真实 agentId / 策展 `curator` / 团队 `__team__`），
 * 图谱整理对记忆表只读 —— 天然共存。但审查发现四处会互相"冻结/误删"的隐患：
 *  1) 人工覆写把行锁成 human 后，运行时自动写入永久停摆 → 提供 unprotect 回退通道；
 *  2) 维护任务物理删除只看 kind，会删掉人工置顶/覆写/已验证行 → 加保护位；
 *  3) save_memory 的私有 dedupKey 可撞平台内部键（task:/brief:/exp:…）→ 收进命名空间；
 *  4) reject 任意 kind 会把知识手册退役成"永不再生" → 自动维护型行禁止裁定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-coexist-'))
delete process.env.AW_BENCH_MODE
delete process.env.AW_MEMORY_GRAPH_RETRIEVAL

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory, runMemoryMaintenance, segmentCJK } = await import('../server/services/workshop/runtime/memory')
const { unprotectMemory, rejectMemory, updateMemory, MemoryAdminError } = await import('../server/services/workshop/memory/memory-admin')

const db = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const NOW = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, memory_access_mode, created_at, updated_at)
  VALUES ('c1', 'c1', '', '', '', '{}', 1, 1, '', 'u1', 'inherit', ?, ?)`).run(NOW, NOW)

function insertRow(input: {
  id: string
  agentId?: string
  kind?: string
  title: string
  content?: string
  status?: string
  authorKind?: string
  pinned?: number
  dedupKey?: string
  lastAccessedAt?: string
  createdAt?: string
}): void {
  const at = input.createdAt ?? NOW
  db.prepare(`INSERT INTO agent_memories(id, channel_id, agent_id, kind, title, title_fts, content, importance,
      session_id, dedup_key, scope_kind, scope_key, status, author_kind, pinned, created_at, updated_at, last_accessed_at)
    VALUES (?, 'c1', ?, ?, ?, ?, ?, 0.5, '', ?, 'channel', '', ?, ?, ?, ?, ?, ?)`)
    .run(
      input.id, input.agentId ?? 'a1', input.kind ?? 'episodic-task',
      input.title, segmentCJK(input.title), segmentCJK(input.content ?? '正文'),
      input.dedupKey ?? `k:${input.id}`, input.status ?? 'active', input.authorKind ?? 'agent',
      input.pinned ?? 0, at, at, input.lastAccessedAt ?? at,
    )
}

test('unprotect：人工保护行可交还自动维护（旧版先快照，revision+1）', () => {
  insertRow({ id: 'brief-1', kind: 'brief', title: '会话简报', authorKind: 'human', dedupKey: 'brief:a1:channel' })
  // 先确认"冻结"事实：agent 侧 upsert 拿不到写权
  const blocked = repo.upsert({
    channelId: 'c1', agentId: 'a1', kind: 'brief', title: '会话简报', titleFts: 'x',
    content: 'new', importance: 0.5, dedupKey: 'brief:a1:channel',
  })
  assert.equal(blocked.outcome, 'protected', '人工保护 → 运行时写入被拦（冻结）')

  const res = unprotectMemory(db, {
    id: 'brief-1', expectedRevision: 1, reason: '恢复自动维护', actor: { kind: 'human', id: 'u1' },
  })
  assert.equal(res.revision, 2)
  const row = db.prepare(`SELECT author_kind AS ak, revision FROM agent_memories WHERE id = 'brief-1'`).get() as { ak: string, revision: number }
  assert.equal(row.ak, 'agent', '保护解除后交还自动维护')
  const rev = db.prepare(`SELECT COUNT(*) AS n FROM memory_revisions WHERE memory_id = 'brief-1'`).get() as { n: number }
  assert.ok(rev.n >= 1, '解除前必须留版本快照')
  // 解除后运行时写入恢复
  const ok = repo.upsert({
    channelId: 'c1', agentId: 'a1', kind: 'brief', title: '会话简报', titleFts: 'x',
    content: 'refreshed', importance: 0.5, dedupKey: 'brief:a1:channel',
  })
  assert.notEqual(ok.outcome, 'protected', '解除保护后自动写入恢复')

  // 边界：非人工行 / validated 行不可解除
  insertRow({ id: 'agent-1', title: '普通行' })
  assert.throws(() => unprotectMemory(db, { id: 'agent-1', expectedRevision: 1, reason: 'x', actor: { kind: 'human', id: 'u1' } }),
    (e: unknown) => e instanceof MemoryAdminError && e.code === 'NOT_PROTECTED')
  insertRow({ id: 'val-1', title: '已验证', authorKind: 'human', status: 'validated' })
  assert.throws(() => unprotectMemory(db, { id: 'val-1', expectedRevision: 1, reason: 'x', actor: { kind: 'human', id: 'u1' } }),
    (e: unknown) => e instanceof MemoryAdminError && e.code === 'MEMORY_IMMUTABLE')
})

test('维护任务不得物理删除人工/置顶/已验证行（容量与过期都算）', () => {
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString()
  insertRow({ id: 'keep-pinned', title: '置顶行', pinned: 1, lastAccessedAt: old, createdAt: old })
  insertRow({ id: 'keep-human', title: '人工行', authorKind: 'human', lastAccessedAt: old, createdAt: old })
  insertRow({ id: 'keep-validated', title: '已验证行', status: 'validated', lastAccessedAt: old, createdAt: old })
  insertRow({ id: 'evict-plain-1', title: '普通行一', lastAccessedAt: old, createdAt: old })
  insertRow({ id: 'evict-plain-2', title: '普通行二', lastAccessedAt: old, createdAt: old })

  const res = runMemoryMaintenance(repo, { expireDays: 1, cap: 1 })
  assert.ok(res.deletedExpired + res.evicted >= 1, '普通行应被治理')
  const alive = (id: string) => repo.getById(id) !== null
  assert.ok(alive('keep-pinned'), '置顶行永不物理删除')
  assert.ok(alive('keep-human'), '人工行不得被维护删除')
  assert.ok(alive('keep-validated'), '已验证行保留')
  assert.ok(!alive('evict-plain-1') || !alive('evict-plain-2'), '普通行会被过期/淘汰')
})

test('save_memory 私有 dedupKey 撞内部命名空间时被收编，不改写平台行', async () => {
  insertRow({ id: 'task-row', title: '任务沉淀', dedupKey: 'task:abc', kind: 'episodic-task' })
  const mem = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: null })
  const saved = await mem.save({ title: '伪装任务', content: '想覆盖任务行', scope: 'private', dedupKey: 'task:abc' })
  assert.ok(saved.dedupKey.startsWith('agent-save:'), `内部键必须收编，实际 ${saved.dedupKey}`)
  const platform = db.prepare(`SELECT kind, title FROM agent_memories WHERE dedup_key = 'task:abc'`).get() as { kind: string, title: string }
  assert.equal(platform.kind, 'episodic-task', '平台任务行未被改写')
  assert.equal(platform.title, '任务沉淀')
  // 经验键同理（否则真实蒸馏会撞 EXPERIENCE_KEY_CONFLICT 被静默丢弃）
  const savedExp = await mem.save({ title: '伪装经验', content: 'x', scope: 'private', dedupKey: 'exp:line:a1:k' })
  assert.ok(savedExp.dedupKey.startsWith('agent-save:exp:'), '经验键同样收编')
})

test('自动维护型条目禁止"裁定不成立"（否则知识手册永不再生）', () => {
  insertRow({ id: 'curated-1', agentId: 'curator', kind: 'curated', title: '知识手册', dedupKey: 'curated:knowledge:c1' })
  assert.throws(() => rejectMemory(db, { id: 'curated-1', reason: 'x', actor: { kind: 'human', id: 'u1' } }),
    (e: unknown) => e instanceof MemoryAdminError && e.code === 'AGENT_MAINTAINED')
  const row = db.prepare(`SELECT status FROM agent_memories WHERE id = 'curated-1'`).get() as { status: string }
  assert.equal(row.status, 'active', '手册仍可汇整')
  // 普通语义行仍可裁定（保留既有治理能力）
  insertRow({ id: 'sem-1', kind: 'semantic', title: '语义结论' })
  const res = rejectMemory(db, { id: 'sem-1', reason: '数据不成立', actor: { kind: 'human', id: 'u1' } })
  assert.equal(res.retired, true)
})

test('覆写仍标记人工所有（未改变既有权威语义）', async () => {
  insertRow({ id: 'edit-1', kind: 'semantic', title: '待覆写' })
  await updateMemory(db, {
    id: 'edit-1', expectedRevision: 1, title: '人工改写', content: '人工正文', reason: '治理', actor: { kind: 'human', id: 'u1' },
  }, {})
  const row = db.prepare(`SELECT author_kind AS ak, content FROM agent_memories WHERE id = 'edit-1'`).get() as { ak: string, content: string }
  assert.equal(row.ak, 'human', '覆写=人工权威，语义不变')
  assert.ok(row.content.includes('人 工 正 文'), '正文按 CJK 切分入库')
})
