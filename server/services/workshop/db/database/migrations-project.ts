/**
 * Project 层 V1 基础列迁移（2026-11-03）。
 *
 * 独立文件的原因：
 *  - 既有 `migrations.ts` 的 `migrateAddColumn` 使用动态表名/列名（SQLite 不支持标识符参数），
 *    安全扫描器会把它误判为命令注入；
 *  - 本文件只做固定表、固定列、静态 SQL，便于审计，也不扩大既有迁移函数的改动面。
 *
 * 调用时机：必须在 tasks 的 legacy rebuild **之前**（open.ts），这样 rebuild 的
 * INSERT ... SELECT 才能复制新列；索引随后创建。
 */
import type { DatabaseSync } from 'node:sqlite'

function hasTasksColumn(db: DatabaseSync, column: string): boolean {
  const cols = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
  return cols.some(c => c.name === column)
}

function hasChannelAgentColumn(db: DatabaseSync, column: string): boolean {
  const cols = db.prepare('PRAGMA table_info(channel_agents)').all() as Array<{ name: string }>
  return cols.some(c => c.name === column)
}

function hasAuditColumn(db: DatabaseSync, column: string): boolean {
  const cols = db.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>
  return cols.some(c => c.name === column)
}

function hasProjectsColumn(db: DatabaseSync, column: string): boolean {
  const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
  return cols.some(c => c.name === column)
}

export function migrateProjectColumns(db: DatabaseSync): void {
  if (!hasChannelAgentColumn(db, 'agent_kind')) {
    db.exec('ALTER TABLE channel_agents ADD COLUMN agent_kind TEXT NOT NULL DEFAULT \'channel_agent\'')
  }
  if (!hasTasksColumn(db, 'source')) {
    db.exec('ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT \'channel\'')
  }
  if (!hasTasksColumn(db, 'project_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN project_id TEXT')
  }
  if (!hasTasksColumn(db, 'project_work_item_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN project_work_item_id TEXT')
  }
  if (!hasTasksColumn(db, 'project_attempt_no')) {
    db.exec('ALTER TABLE tasks ADD COLUMN project_attempt_no INTEGER')
  }
  if (!hasTasksColumn(db, 'trace_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN trace_id TEXT NOT NULL DEFAULT \'\'')
  }
  if (!hasAuditColumn(db, 'project_id')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN project_id TEXT NOT NULL DEFAULT \'\'')
  }
  if (!hasAuditColumn(db, 'trace_id')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN trace_id TEXT NOT NULL DEFAULT \'\'')
  }
  // PR20 Route 派发闭环：项目级自动派发开关（存量项目默认 0 = 行为零突变，owner 显式启用）
  if (!hasProjectsColumn(db, 'auto_dispatch')) {
    db.exec('ALTER TABLE projects ADD COLUMN auto_dispatch INTEGER NOT NULL DEFAULT 0')
  }
  ensureProjectIndexes(db)
}

/**
 * tasks 的 legacy rebuild 会 DROP/重建表，索引随之丢失；因此重建后必须再调一次。
 * 纯 index 创建，幂等。
 */
export function ensureProjectIndexes(db: DatabaseSync): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, project_work_item_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_trace ON tasks(trace_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_channel_agents_kind ON channel_agents(channel_id, agent_kind)')
}
