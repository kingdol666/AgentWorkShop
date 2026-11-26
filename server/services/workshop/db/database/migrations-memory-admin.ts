/**
 * 记忆中心（HITL 管理面）增量迁移 —— 只加列/加表，不重建任何既有表。
 *
 * 背景（plan §4.2）：
 *  - `agent_memories` 此前没有"谁写的 / 是否人工 / 版本号 / 软删 / 置顶"任何字段，
 *    导致人类无法覆写留痕、无法批注、无法软删恢复；
 *  - 共享区需要 owner 维度（`scope_kind='global'` 的跨 Channel 可见性以 owner 为界），
 *    复用 `channels.owner_user_id` 的 NULL=遗留公共 约定。
 *
 * 纪律：
 *  - **不修改 `SCHEMA_SQL`**（改模板会改契约指纹，存量库启动即 fingerprint drift）；
 *    因此本文件的列/表只能通过 ALTER/CREATE 建立，新库同样走这里。
 *  - 一次性数据修复（`experience active → candidate`）必须用 `aw_migration_ledger` 守卫：
 *    仓库里 `migrations-experience-versions.ts`（9002）没有读守卫、每次启动都跑，
 *    那是"幂等回填"范例，不能当作一次性迁移范例。
 */
import type { DatabaseSync } from 'node:sqlite'
import { migrateAddColumn } from './migrations'
import { ensureMigrationLedger, recordMigration } from './migration-ledger'
import { withTransaction } from '../transaction'

/** 9003：channel 档经验状态修复（active → candidate），只执行一次 */
const EXPERIENCE_STATUS_MIGRATION_VERSION = 9003

export function migrateMemoryAdminColumns(db: DatabaseSync): void {
  // 归属：NULL = 遗留公共（与 channels.owner_user_id 同约定）
  migrateAddColumn(db, 'agent_memories', 'owner_user_id', 'TEXT')
  // 作者：agent 自产 / human 人工 / system 治理动作
  migrateAddColumn(db, 'agent_memories', 'author_kind', 'TEXT NOT NULL DEFAULT \'agent\'')
  migrateAddColumn(db, 'agent_memories', 'author_id', 'TEXT NOT NULL DEFAULT \'\'')
  // 版本：人工覆写/回滚/证据合并都会 +1（审计在 memory_revisions）
  migrateAddColumn(db, 'agent_memories', 'revision', 'INTEGER NOT NULL DEFAULT 1')
  migrateAddColumn(db, 'agent_memories', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  migrateAddColumn(db, 'agent_memories', 'updated_at', 'TEXT NOT NULL DEFAULT \'\'')
  // 软删：默认 30 天后可硬删；检索/注入/统计一律排除
  migrateAddColumn(db, 'agent_memories', 'deleted_at', 'TEXT')
  migrateAddColumn(db, 'agent_memories', 'deleted_by', 'TEXT')
  migrateAddColumn(db, 'agent_memories', 'delete_reason', 'TEXT')
  // 来源深链（task/run/intervention/ontology 的 JSON 引用）
  migrateAddColumn(db, 'agent_memories', 'origin_ref', 'TEXT NOT NULL DEFAULT \'\'')

  // 回填：updated_at 缺省等于 created_at；owner 取所属 channel 的 owner（NULL 保持 NULL）
  db.exec(`UPDATE agent_memories SET updated_at = created_at WHERE updated_at = ''`)
  try {
    db.exec(`UPDATE agent_memories
                SET owner_user_id = (SELECT c.owner_user_id FROM channels c WHERE c.id = agent_memories.channel_id)
              WHERE owner_user_id IS NULL
                AND channel_id != ''
                AND EXISTS (SELECT 1 FROM channels c WHERE c.id = agent_memories.channel_id
                            AND c.owner_user_id IS NOT NULL)`)
  }
  catch {
    // channels 表缺失（极端半初始化库）：下一次 init 会再尝试
  }

  db.exec(`CREATE TABLE IF NOT EXISTS memory_revisions (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '',
    author_kind TEXT NOT NULL DEFAULT 'human',
    author_id TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(memory_id, revision)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS memory_annotations (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    body TEXT NOT NULL,
    author_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  )`)
  ensureMemoryAdminIndexes(db)
}

/** 索引必须在补列之后创建（缺列时建索引会中断初始化）。 */
export function ensureMemoryAdminIndexes(db: DatabaseSync): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_owner_scope ON agent_memories(owner_user_id, scope_kind, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_scope_kind_key ON agent_memories(scope_kind, scope_key, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_kind_status ON agent_memories(kind, status, updated_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_channel_deleted ON agent_memories(channel_id, deleted_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory ON memory_revisions(memory_id, revision DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_annotations_memory ON memory_annotations(memory_id, created_at DESC)')
}

/**
 * 一次性数据修复：channel 档经验此前被反射器写成 `status='active'`，
 * 而注入要求 validated、晋升要求 candidate —— 既不可晋升也不可注入（G1 死路）。
 *
 * 与 `reflector.ts` 的 producer 修复必须**同批上线**：否则批次边界会持续产生
 * 新的、永远不会被二次扫描的 active 行。
 */
export function migrateExperienceChannelStatus(db: DatabaseSync): number {
  ensureMigrationLedger(db)
  const applied = db.prepare('SELECT 1 AS ok FROM aw_migration_ledger WHERE version = ?')
    .get(EXPERIENCE_STATUS_MIGRATION_VERSION) as { ok?: number } | undefined
  if (applied?.ok) return 0
  return withTransaction(db, () => {
    const changed = Number(
      db.prepare(`UPDATE agent_memories SET status = 'candidate', updated_at = ?
                   WHERE kind = 'experience' AND status = 'active'`)
        .run(new Date().toISOString()).changes ?? 0,
    )
    recordMigration(db, {
      version: EXPERIENCE_STATUS_MIGRATION_VERSION,
      name: 'experience-channel-status',
      fingerprint: 'experience-channel-status:v1',
    })
    return changed
  })
}
