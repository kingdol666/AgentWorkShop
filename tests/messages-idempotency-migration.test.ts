/**
 * 存量库升级回归：messages 的 client 幂等列/唯一索引必须走「补列→建索引」时序。
 *
 * 事故（2026-11-12）：SCHEMA_SQL 内联了 idx_messages_client_idempotency 的
 * CREATE UNIQUE INDEX，存量库升级时该脚本先于 migrateSessionContextColumns
 * 执行 —— messages 尚无 actor_user_id/client_message_id 列，启动即崩
 * （no such column: client_message_id）。新库单测测不出（建表即带列）。
 *
 * 修复：索引只由 ensureSessionIndexes（补列后、幂等）创建。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-msg-migration-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')

test('存量库缺幂等列时启动不崩：补列→重建索引→旧行保留→幂等可用', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'aw-msg-legacy-')), 'workshop.sqlite')
  // 1) 先用 openWorkshopDb 建出"新 schema"库并写入行，再人为退化成"存量旧 schema"
  {
    const db = openWorkshopDb(file)
    db.prepare(`INSERT INTO channels (id, name, created_at, updated_at) VALUES ('ch-legacy', '存量频道', ?, ?)`)
      .run(new Date().toISOString(), new Date().toISOString())
    db.prepare(
      `INSERT INTO messages (id, channel_id, role, parts_json, metadata_json, state, attempts, created_at)
       VALUES ('legacy-msg-1', 'ch-legacy', 'ROLE_USER', '[]', '{}', 'pending', 0, ?)`,
    ).run(new Date().toISOString())
    db.close()
  }
  {
    const db = new DatabaseSync(file)
    db.exec('DROP INDEX IF EXISTS idx_messages_client_idempotency')
    db.exec('ALTER TABLE messages DROP COLUMN actor_user_id')
    db.exec('ALTER TABLE messages DROP COLUMN client_message_id')
    db.close()
  }
  // 2) openWorkshopDb 触发完整迁移 —— 修复前在这里抛 no such column: client_message_id
  const db = openWorkshopDb(file)
  try {
    const cols = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(c => c.name)
    assert.ok(cols.includes('actor_user_id'), 'actor_user_id 必须由迁移补齐')
    assert.ok(cols.includes('client_message_id'), 'client_message_id 必须由迁移补齐')
    const indexes = (db.prepare('PRAGMA index_list(messages)').all() as Array<{ name: string }>).map(i => i.name)
    assert.ok(indexes.includes('idx_messages_client_idempotency'), '唯一索引必须由 ensureSessionIndexes 重建')
    const legacy = db.prepare(`SELECT id, state FROM messages WHERE id = 'legacy-msg-1'`).get() as { id: string, state: string } | undefined
    assert.ok(legacy, '迁移不得丢行')
    assert.equal(legacy.state, 'pending')
    // 3) 幂等入口在迁移后的库上可用：插入→冲突回读同一行
    const repo = createMessageRepo(db)
    const base = {
      channelId: 'ch-legacy',
      sessionId: 'sess-1',
      actorUserId: 'user-1',
      clientMessageId: 'cm-1',
      toAgentId: 'agent-1',
      role: 'ROLE_USER',
      parts: [{ text: 'hello' }],
    }
    const first = repo.createSessionIdempotent(base)
    assert.equal(first.inserted, true)
    const second = repo.createSessionIdempotent(base)
    assert.equal(second.inserted, false)
    assert.equal(second.row.id, first.row.id, '同幂等键必须回读同一行')
  }
  finally {
    db.close()
  }
})
