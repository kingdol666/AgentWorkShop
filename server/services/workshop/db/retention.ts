/**
 * 增长治理保留策略(hardening GROW-1;配置驱动)。
 *
 * 为无保留机制的只增表做分批清理(每批 ≤5000,循环到 0,避免长事务持锁):
 *   messages          默认 30d   (retention.messages_days)
 *   audit_log         默认 90d   (retention.audit_days;合规观察期,从严保留)
 *   approval_history  默认 180d  (retention.approval_days;历史裁决主张不可变,放宽)
 * retention.disabled 整体逃生门(env AW_RETENTION_DISABLED / RETENTION_DISABLED 兼容别名)。
 * 覆盖链:config.yml < runtime-settings < env(AW_<键> 或历史别名)。时间列均为 TEXT ISO。
 * channel_events 与 daq_samples 已有各自保留机制,此处不重复覆盖。
 */
import { retentionSettings } from '../settings'

type DatabaseSyncLike = {
  prepare: (sql: string) => { run: (...args: unknown[]) => { changes: number | bigint } }
}

const DAY_MS = 86_400_000
const BATCH = 5000

const TARGETS = [
  { table: 'messages', column: 'created_at', days: 30, cfgKey: 'messages_days' },
  { table: 'audit_log', column: 'at', days: 90, cfgKey: 'audit_days' },
  { table: 'approval_history', column: 'created_at', days: 180, cfgKey: 'approval_days' },
] as const

export interface RetentionResult { table: string, removed: number, days: number }

/** 对单库执行一轮保留清理;返回各表删除行数(调用方负责 try/catch 与日志)。 */
export function runRetentionSweep(db: DatabaseSyncLike): RetentionResult[] {
  const retention = retentionSettings()
  if (retention.disabled) return []
  const out: RetentionResult[] = []
  for (const t of TARGETS) {
    const days = retention[t.cfgKey]
    const before = new Date(Date.now() - days * DAY_MS).toISOString()
    let removed = 0
    for (;;) {
      const res = db.prepare(
        `DELETE FROM ${t.table} WHERE rowid IN (SELECT rowid FROM ${t.table} WHERE ${t.column} < ? LIMIT ${BATCH})`,
      ).run(before)
      const n = Number(res.changes)
      removed += n
      if (n < BATCH) break
    }
    out.push({ table: t.table, removed, days })
  }
  return out
}
