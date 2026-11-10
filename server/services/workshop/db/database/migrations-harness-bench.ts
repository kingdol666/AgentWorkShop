/**
 * Harness 配对评测台账（2026-11-10 审计:RSI bench 门 provenance）。
 *
 * 现场问题:promote 端点直接接受客户端自报的 `bench {pValue, primaryDelta, costDelta}`,
 * 与任何 harness-ab 运行没有绑定 —— 同一份数字可以喂给任意 profile 并双双过门,
 * "shadow→active 的统计防污染"实际信任度为零。
 *
 * 本表把一次配对评测落成**可追溯的记录**:服务端用 perSeed 复算汇总值,记录
 * artifact 摘要与创建人,并作为 promote→active 的唯一证据来源。
 * 只建表 / 只补列,幂等。
 */
import type { DatabaseSync } from 'node:sqlite'
import { migrateAddColumn } from './migrations'

const DDL: string[] = [
  'CREATE TABLE IF NOT EXISTS harness_bench_runs ('
  + ' id TEXT PRIMARY KEY,'
  + ' channel_id TEXT NOT NULL,'
  + ' profile_id TEXT NOT NULL,'
  + ' baseline_profile_id TEXT NOT NULL DEFAULT \'\','
  + ' kind TEXT NOT NULL DEFAULT \'harness-ab-paired\','
  + ' status TEXT NOT NULL DEFAULT \'completed\','
  + ' p_value REAL,'
  + ' primary_delta REAL NOT NULL,'
  + ' cost_delta REAL NOT NULL,'
  + ' pairs INTEGER NOT NULL,'
  + ' excluded INTEGER NOT NULL DEFAULT 0,'
  + ' seeds_json TEXT NOT NULL DEFAULT \'[]\','
  + ' per_seed_json TEXT NOT NULL DEFAULT \'[]\','
  + ' artifact_sha256 TEXT NOT NULL DEFAULT \'\','
  + ' created_by TEXT NOT NULL DEFAULT \'\','
  + ' created_at TEXT NOT NULL,'
  + ' completed_at TEXT,'
  + ' UNIQUE(profile_id, artifact_sha256))',
  'CREATE INDEX IF NOT EXISTS idx_harness_bench_channel ON harness_bench_runs(channel_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_harness_bench_profile ON harness_bench_runs(channel_id, profile_id, created_at DESC)',
]

export function migrateHarnessBenchRuns(db: DatabaseSync): void {
  for (const sql of DDL) db.prepare(sql).run()
  // 采纳哪一次评测:profile 上只存"被采纳的 run id",历史全在台账表
  migrateAddColumn(db, 'channel_harness_profiles', 'bench_run_id', 'TEXT')
  migrateAddColumn(db, 'channel_harness_profiles', 'promoted_at', 'TEXT')
}
