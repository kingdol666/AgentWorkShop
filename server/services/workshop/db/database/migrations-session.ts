/**
 * Session Context（2026-11-07）增量迁移。
 *
 * 只做加列/加索引，不重建任何表：
 *  - tasks/messages/chat_messages/chat_deliveries/agent_memories 增加 session_id；
 *  - channel_sessions 增加 brief/summary/last_active_at/generation；
 *  - project_work_item_attempts 增加 session_id（attempt → session 溯源）。
 *
 * 时序要求：本函数必须在 tasks 的 legacy 重建之前执行；两处 tasks_new 的
 * INSERT ... SELECT 列清单已同步带 session_id，避免重建时丢列。
 */
import type { DatabaseSync } from 'node:sqlite'
import { migrateAddColumn } from './migrations'

export function migrateSessionContextColumns(db: DatabaseSync): void {
  migrateAddColumn(db, 'channel_sessions', 'summary', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'channel_sessions', 'brief_json', 'TEXT NOT NULL DEFAULT \'{}\'')
  migrateAddColumn(db, 'channel_sessions', 'last_active_at', 'TEXT')
  migrateAddColumn(db, 'channel_sessions', 'generation', 'INTEGER NOT NULL DEFAULT 0')
  migrateAddColumn(db, 'tasks', 'session_id', 'TEXT')
  migrateAddColumn(db, 'messages', 'session_id', 'TEXT')
  // Session endpoint retries use a durable channel-scoped key; legacy mailbox rows remain NULL.
  migrateAddColumn(db, 'messages', 'client_message_id', 'TEXT')
  migrateAddColumn(db, 'chat_messages', 'session_id', 'TEXT')
  migrateAddColumn(db, 'chat_deliveries', 'session_id', 'TEXT')
  migrateAddColumn(db, 'agent_memories', 'session_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'project_work_item_attempts', 'session_id', 'TEXT')
}

/** 索引必须在 tasks 重建之后创建（rebuild 会丢索引）。 */
export function ensureSessionIndexes(db: DatabaseSync): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_channel_sessions_active ON channel_sessions(channel_id, status, created_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_channel_sessions_project ON channel_sessions(project_id, project_work_item_id, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(channel_id, session_id, state, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at)')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_idempotency ON messages(channel_id, session_id, client_message_id) WHERE session_id IS NOT NULL AND client_message_id IS NOT NULL')
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_deliveries_session ON chat_deliveries(session_id, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_session ON agent_memories(session_id, agent_id, created_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_project_attempt_session ON project_work_item_attempts(session_id)')
}
