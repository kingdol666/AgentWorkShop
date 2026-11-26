/**
 * 记忆中心（HITL 管理面）批次 0：
 *  - 迁移只加列/表，不动 SCHEMA_SQL 契约；
 *  - upsert 判别值（inserted/updated/protected/revived）与 human actor 覆写；
 *  - 软删在 检索/列表/直取 三处同时生效，同键重写复活；
 *  - experience active → candidate 的一次性修复只执行一次（ledger 守卫）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-memory-admin-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { migrateExperienceChannelStatus } = await import('../server/services/workshop/db/database/migrations-memory-admin')

const base = {
  channelId: 'ch-admin',
  agentId: 'agent-a',
  title: '人工可管的记忆',
  titleFts: '人 工 可 管 的 记 忆',
  content: '内容',
  importance: 0.7,
}

test('迁移：新增列与 memory_revisions/memory_annotations 表', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const cols = (db.prepare('PRAGMA table_info(agent_memories)').all() as Array<{ name: string }>).map(c => c.name)
    for (const c of ['owner_user_id', 'author_kind', 'author_id', 'revision', 'pinned', 'updated_at', 'deleted_at', 'deleted_by', 'delete_reason', 'origin_ref']) {
      assert.ok(cols.includes(c), `缺列 ${c}`)
    }
    for (const t of ['memory_revisions', 'memory_annotations']) {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t)
      assert.ok(row, `缺表 ${t}`)
    }
    // 契约版本不变（SCHEMA_SQL 未改）
    const ledger = db.prepare(`SELECT fingerprint FROM aw_migration_ledger WHERE version = 11`).get() as { fingerprint?: string } | undefined
    assert.ok(ledger?.fingerprint, '契约行仍存在')
  }
  finally {
    db.close()
  }
})

test('upsert 判别值：inserted → updated → protected（human 行）→ human actor 可覆写', () => {
  const db = openWorkshopDb(':memory:')
  const repo = createMemoryRepo(db)
  try {
    const first = repo.upsert({ ...base, kind: 'semantic', dedupKey: 'k1' })
    assert.equal(first.outcome, 'inserted')
    const second = repo.upsert({ ...base, kind: 'semantic', dedupKey: 'k1', content: '内容2' })
    assert.equal(second.outcome, 'updated')
    assert.equal(repo.getById(first.id)!.revision, 2)

    // 标记为人工行后，agent 重放不得覆盖
    db.prepare(`UPDATE agent_memories SET author_kind='human', author_id='u-1' WHERE id=?`).run(first.id)
    const protectedWrite = repo.upsert({ ...base, kind: 'semantic', dedupKey: 'k1', content: 'agent 覆写' })
    assert.equal(protectedWrite.outcome, 'protected')
    assert.equal(repo.getById(first.id)!.content, '内容2', '受保护行正文不得被覆盖')

    const humanWrite = repo.upsert({ ...base, kind: 'semantic', dedupKey: 'k1', content: '人工覆写' }, { kind: 'human', id: 'u-1' })
    assert.equal(humanWrite.outcome, 'updated')
    assert.equal(repo.getById(first.id)!.content, '人工覆写', 'human actor 可覆写')
    assert.equal(repo.getById(first.id)!.authorKind, 'human')
  }
  finally {
    db.close()
  }
})

test('软删：检索/列表/直取同时消失；同键重写复活', () => {
  const db = openWorkshopDb(':memory:')
  const repo = createMemoryRepo(db)
  try {
    const w = repo.upsert({ ...base, kind: 'semantic', dedupKey: 'k2' })
    assert.equal(repo.listByAgentChannel('ch-admin', 'agent-a', 10).length, 1)
    assert.ok(repo.getById(w.id))

    assert.equal(repo.softDelete(w.id, 'u-1', '误录'), true)
    assert.equal(repo.listByAgentChannel('ch-admin', 'agent-a', 10).length, 0)
    assert.equal(repo.getById(w.id), null)

    // 同键重写：唯一键必须复活，而不是被 tombstone 静默吞掉
    const again = repo.upsert({ ...base, kind: 'semantic', dedupKey: 'k2', content: '重写' })
    assert.equal(again.outcome, 'revived')
    assert.equal(again.id, w.id)
    const row = repo.getById(w.id)!
    assert.equal(row.content, '重写')
    assert.equal(row.deletedAt ?? null, null)
  }
  finally {
    db.close()
  }
})

test('软删：恢复路径 + 到期清理候选', () => {
  const db = openWorkshopDb(':memory:')
  const repo = createMemoryRepo(db)
  try {
    const w = repo.upsert({ ...base, kind: 'semantic', dedupKey: 'k3' })
    repo.softDelete(w.id, 'u-1', '过期观察')
    assert.equal(repo.restore(w.id), true)
    assert.ok(repo.getById(w.id))

    repo.softDelete(w.id, 'u-1', '再次删除')
    const due = repo.dueForPurge(new Date(Date.now() + 1000).toISOString(), 10)
    assert.ok(due.some(d => d.id === w.id))
    const purged = repo.purge(w.id)
    assert.equal(purged.ok, true)
    assert.equal(repo.getById(w.id), null)
  }
  finally {
    db.close()
  }
})

test('experience 默认 candidate；9003 一次性修复只跑一次', () => {
  const db = openWorkshopDb(':memory:')
  const repo = createMemoryRepo(db)
  try {
    const w = repo.upsertExperience({
      ...base,
      kind: 'experience',
      dedupKey: 'exp:k4',
      evidence: { taskIds: ['t-1'] },
      scopeKind: 'channel',
    })
    assert.equal(repo.getById(w.id)!.status, 'candidate', '默认 candidate')

    // 直接写一条历史形态的 active 行（模拟旧版本产物）
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO agent_memories
      (id, channel_id, agent_id, kind, title, title_fts, content, importance, dedup_key, created_at, status, scope_kind, updated_at, evidence_json)
      VALUES ('legacy-active','ch-admin','agent-a','experience','旧','旧','旧',0.5,'exp:legacy',?, 'active','channel',?,'{"taskIds":["t-9"]}')`)
      .run(now, now)

    // 初始化时 9003 已执行过（当时无 active 行）；清除 ledger 行模拟"首次运行"再验证守卫
    db.prepare('DELETE FROM aw_migration_ledger WHERE version = 9003').run()

    const first = migrateExperienceChannelStatus(db)
    assert.equal(first, 1, '首次修复 1 条')
    const second = migrateExperienceChannelStatus(db)
    assert.equal(second, 0, 'ledger 守卫：不重复执行')
    assert.equal(repo.getById('legacy-active')!.status, 'candidate')
  }
  finally {
    db.close()
  }
})
