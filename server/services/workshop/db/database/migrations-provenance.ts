/**
 * 操作与数采全量追溯（批次 N，2026-11-26）。
 *
 * 目标：任意历史时刻都能回答「谁，在哪个产品/配方/版本/批次/任务下，把哪个参数
 * 从多少改到多少；依据/审批是什么；对应目标数采值前后如何；原始样本是否还在」。
 *
 * 纪律（与既有增量迁移一致）：
 *  - 只加列/建表/建索引，不改 `SCHEMA_SQL`（改模板会变契约指纹，存量库启动即 drift）；
 *  - 旧行上下文未知 → `context_source='unknown'`，不按时间猜产品/配方；
 *  - 快照表与原始样本保留期解耦（快照 365 天，可配）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { migrateAddColumn } from './migrations'

const EVIDENCE_DDL = [
  'CREATE TABLE IF NOT EXISTS operation_daq_evidence (',
  '  id               TEXT PRIMARY KEY,',
  '  intervention_id  TEXT NOT NULL UNIQUE,',
  '  attempt_id       TEXT NOT NULL DEFAULT \'\',',
  '  written_node_id  TEXT NOT NULL,',
  '  target_node_id   TEXT NOT NULL DEFAULT \'\',',
  '  line_id          TEXT NOT NULL DEFAULT \'\',',
  '  product_id       TEXT NOT NULL DEFAULT \'\',',
  '  recipe_id        TEXT NOT NULL DEFAULT \'\',',
  '  recipe_revision  TEXT NOT NULL DEFAULT \'\',',
  '  run_id           TEXT NOT NULL DEFAULT \'\',',
  '  event_ts         TEXT NOT NULL,',
  '  pre_from_ms      INTEGER NOT NULL,',
  '  pre_to_ms        INTEGER NOT NULL,',
  '  post_from_ms     INTEGER NOT NULL,',
  '  post_to_ms       INTEGER NOT NULL,',
  '  pre_stats_json   TEXT NOT NULL DEFAULT \'{}\',',
  '  post_stats_json  TEXT NOT NULL DEFAULT \'{}\',',
  '  series_json      TEXT NOT NULL DEFAULT \'[]\',',
  '  sample_count     INTEGER NOT NULL DEFAULT 0,',
  '  quality_json     TEXT NOT NULL DEFAULT \'{}\',',
  '  query_json       TEXT NOT NULL DEFAULT \'{}\',',
  '  join_quality     TEXT NOT NULL DEFAULT \'none\',',
  '  raw_available    INTEGER NOT NULL DEFAULT 0,',
  '  missing_reason   TEXT NOT NULL DEFAULT \'\',',
  '  captured_at      TEXT NOT NULL,',
  '  updated_at       TEXT NOT NULL',
  ')',
].join('\n')

const CLAIMS_DDL = [
  'CREATE TABLE IF NOT EXISTS experience_claims (',
  '  claim_id          TEXT PRIMARY KEY,',
  '  memory_id         TEXT NOT NULL DEFAULT \'\',',
  '  version_id        TEXT NOT NULL DEFAULT \'\',',
  '  event_id          TEXT NOT NULL DEFAULT \'\',',
  '  source_kind       TEXT NOT NULL DEFAULT \'intervention\',',
  '  domain            TEXT NOT NULL DEFAULT \'parameter\',',
  '  line_id           TEXT NOT NULL DEFAULT \'\',',
  '  product_id        TEXT NOT NULL DEFAULT \'\',',
  '  node_id           TEXT NOT NULL DEFAULT \'\',',
  '  node_name         TEXT NOT NULL DEFAULT \'\',',
  '  variable          TEXT NOT NULL DEFAULT \'\',',
  '  unit              TEXT NOT NULL DEFAULT \'\',',
  '  recipe_id         TEXT NOT NULL DEFAULT \'\',',
  '  recipe_revision   TEXT NOT NULL DEFAULT \'\',',
  '  from_value        REAL,',
  '  to_value          REAL,',
  '  direction         TEXT NOT NULL DEFAULT \'stable\',',
  '  target_node_id    TEXT NOT NULL DEFAULT \'\',',
  '  target_metric     TEXT NOT NULL DEFAULT \'\',',
  '  target_direction  TEXT NOT NULL DEFAULT \'unknown\',',
  '  effect            REAL,',
  '  ci_low            REAL,',
  '  ci_high           REAL,',
  '  mde               REAL,',
  '  verdict           TEXT NOT NULL DEFAULT \'unassessed\',',
  '  polarity          TEXT NOT NULL DEFAULT \'support\',',
  '  environment       TEXT NOT NULL DEFAULT \'unknown\',',
  '  observed_at       TEXT NOT NULL DEFAULT \'\',',
  '  claim_status      TEXT NOT NULL DEFAULT \'structured\',',
  '  intervention_id   TEXT NOT NULL DEFAULT \'\',',
  '  daq_evidence_id   TEXT NOT NULL DEFAULT \'\',',
  '  run_id            TEXT NOT NULL DEFAULT \'\',',
  '  task_id           TEXT NOT NULL DEFAULT \'\',',
  '  valid_from        TEXT,',
  '  valid_to          TEXT,',
  '  created_at        TEXT NOT NULL,',
  '  updated_at        TEXT NOT NULL',
  ')',
].join('\n')

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_intervention_product ON intervention_events(product_id, ts DESC)',
  'CREATE INDEX IF NOT EXISTS idx_intervention_recipe ON intervention_events(recipe_id, recipe_revision, ts DESC)',
  'CREATE INDEX IF NOT EXISTS idx_intervention_attempt ON intervention_events(attempt_id)',
  'CREATE INDEX IF NOT EXISTS idx_write_attempts_product ON dcw_write_attempts(product_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_write_attempts_run ON dcw_write_attempts(run_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_write_attempts_intervention ON dcw_write_attempts(intervention_id)',
  'CREATE INDEX IF NOT EXISTS idx_daq_evidence_scope ON operation_daq_evidence(line_id, product_id, event_ts DESC)',
  'CREATE INDEX IF NOT EXISTS idx_daq_evidence_run ON operation_daq_evidence(run_id, event_ts)',
  'CREATE INDEX IF NOT EXISTS idx_daq_evidence_target ON operation_daq_evidence(target_node_id, event_ts DESC)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_exp_claims_event ON experience_claims(event_id, memory_id)',
  'CREATE INDEX IF NOT EXISTS idx_exp_claims_scope ON experience_claims(line_id, product_id, node_id, recipe_revision, verdict)',
  'CREATE INDEX IF NOT EXISTS idx_exp_claims_valid ON experience_claims(valid_to)',
  'CREATE INDEX IF NOT EXISTS idx_exp_claims_intervention ON experience_claims(intervention_id)',
  'CREATE INDEX IF NOT EXISTS idx_exp_claims_memory ON experience_claims(memory_id)',
]

export function migrateOperationProvenance(db: DatabaseSync): void {
  // ---- 干预台账：上下文（accepted 操作主表）----
  migrateAddColumn(db, 'intervention_events', 'attempt_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'intervention_events', 'task_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'intervention_events', 'session_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'intervention_events', 'product_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'intervention_events', 'recipe_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'intervention_events', 'recipe_revision', 'TEXT NOT NULL DEFAULT \'\'')
  /** exact|run|time-window|unknown —— 上下文来源，读取面必须原样呈现 */
  migrateAddColumn(db, 'intervention_events', 'context_source', 'TEXT NOT NULL DEFAULT \'unknown\'')
  /** 参数建议归因（批次 M；可空） */
  migrateAddColumn(db, 'intervention_events', 'proposal_id', 'TEXT NOT NULL DEFAULT \'\'')

  // ---- 写尝试账本：拒绝/未知尝试也要能看到"当时想写什么值" ----
  migrateAddColumn(db, 'dcw_write_attempts', 'payload_json', 'TEXT NOT NULL DEFAULT \'{}\'')
  migrateAddColumn(db, 'dcw_write_attempts', 'product_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'dcw_write_attempts', 'recipe_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'dcw_write_attempts', 'recipe_revision', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'dcw_write_attempts', 'run_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'dcw_write_attempts', 'channel_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'dcw_write_attempts', 'agent_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'dcw_write_attempts', 'session_id', 'TEXT NOT NULL DEFAULT \'\'')
  migrateAddColumn(db, 'dcw_write_attempts', 'intervention_id', 'TEXT NOT NULL DEFAULT \'\'')

  db.prepare(EVIDENCE_DDL).run()
  db.prepare(CLAIMS_DDL).run()
  for (const sql of INDEXES) db.prepare(sql).run()
}
