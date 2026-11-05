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

function hasWorkItemColumn(db: DatabaseSync, column: string): boolean {
  const cols = db.prepare('PRAGMA table_info(project_work_items)').all() as Array<{ name: string }>
  return cols.some(c => c.name === column)
}

function hasAttemptColumn(db: DatabaseSync, column: string): boolean {
  const cols = db.prepare('PRAGMA table_info(project_work_item_attempts)').all() as Array<{ name: string }>
  return cols.some(c => c.name === column)
}

function hasResultColumn(db: DatabaseSync, column: string): boolean {
  const cols = db.prepare('PRAGMA table_info(project_results)').all() as Array<{ name: string }>
  return cols.some(c => c.name === column)
}

function hasDecisionColumn(db: DatabaseSync, column: string): boolean {
  const cols = db.prepare('PRAGMA table_info(project_decisions)').all() as Array<{ name: string }>
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
  // Router v3 P0：存量项目一律 legacy（上游终态即放行）；新项目由 API 写 technical。
  if (!hasProjectsColumn(db, 'routing_policy')) {
    db.exec('ALTER TABLE projects ADD COLUMN routing_policy TEXT NOT NULL DEFAULT \'legacy\'')
  }
  if (!hasWorkItemColumn(db, 'accepted_result_id')) {
    db.exec('ALTER TABLE project_work_items ADD COLUMN accepted_result_id TEXT')
  }
  if (!hasWorkItemColumn(db, 'last_result_status')) {
    db.exec('ALTER TABLE project_work_items ADD COLUMN last_result_status TEXT NOT NULL DEFAULT \'\'')
  }
  if (!hasWorkItemColumn(db, 'attempt_count')) {
    db.exec('ALTER TABLE project_work_items ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasWorkItemColumn(db, 'max_attempts')) {
    db.exec('ALTER TABLE project_work_items ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3')
  }
  if (!hasWorkItemColumn(db, 'deferred_until')) {
    db.exec('ALTER TABLE project_work_items ADD COLUMN deferred_until TEXT')
  }
  if (!hasAttemptColumn(db, 'failure_class')) {
    db.exec('ALTER TABLE project_work_item_attempts ADD COLUMN failure_class TEXT NOT NULL DEFAULT \'\'')
  }
  if (!hasAttemptColumn(db, 'retryable')) {
    db.exec('ALTER TABLE project_work_item_attempts ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasAttemptColumn(db, 'next_retry_at')) {
    db.exec('ALTER TABLE project_work_item_attempts ADD COLUMN next_retry_at TEXT')
  }
  if (!hasResultColumn(db, 'content_sha256')) {
    db.exec('ALTER TABLE project_results ADD COLUMN content_sha256 TEXT NOT NULL DEFAULT \'\'')
  }
  if (!hasResultColumn(db, 'evidence_verified_at')) {
    db.exec('ALTER TABLE project_results ADD COLUMN evidence_verified_at TEXT')
  }
  if (!hasResultColumn(db, 'criteria_check_json')) {
    db.exec('ALTER TABLE project_results ADD COLUMN criteria_check_json TEXT NOT NULL DEFAULT \'{}\'')
  }
  if (!hasResultColumn(db, 'technical_verdict_json')) {
    db.exec('ALTER TABLE project_results ADD COLUMN technical_verdict_json TEXT NOT NULL DEFAULT \'{}\'')
  }
  if (!hasResultColumn(db, 'rework_required')) {
    db.exec('ALTER TABLE project_results ADD COLUMN rework_required INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasResultColumn(db, 'submitted_at')) {
    db.exec('ALTER TABLE project_results ADD COLUMN submitted_at TEXT')
  }
  if (!hasDecisionColumn(db, 'actor_kind')) {
    db.exec('ALTER TABLE project_decisions ADD COLUMN actor_kind TEXT NOT NULL DEFAULT \'\'')
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
