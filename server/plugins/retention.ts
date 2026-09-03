/**
 * 保留期定时插件(hardening GROW-1)。
 *
 * 每 24h 对 workshop.sqlite 的 messages/audit_log/approval_history 做分批保留
 * 清理(策略见 db/retention.ts;RETENTION_DISABLED=1 可整体关闭)。
 * 调度模式同 backup.ts:setInterval + globalThis key 防 HMR 重复 + unref()。
 * 启动 90s 后首跑(避开启动风暴,且错峰于 backup 的 30s 首备)。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runRetentionSweep } from '@/server/services/workshop/db/retention'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { retentionSettings } from '../services/workshop/settings'

const g = globalThis as typeof globalThis & { __awRetentionTimer?: NodeJS.Timeout }

function sweepOnce(dataDir: string): void {
  const dbPath = resolve(dataDir, 'workshop.sqlite')
  if (!existsSync(dbPath)) return
  const db = new DatabaseSync(dbPath)
  try {
    const results = runRetentionSweep(db)
    for (const r of results) {
      if (r.removed > 0) console.log(`[retention] ${r.table} 清理 ${r.removed} 行(>${r.days}d)`)
    }
  }
  finally {
    db.close()
  }
}

export default function retentionPlugin() {
  // retention.disabled(env RETENTION_DISABLED / AW_RETENTION_DISABLED 兼容别名)
  if (retentionSettings().disabled) return
  if (g.__awRetentionTimer) return
  const dataDir = ensureDataDir()

  const first = setTimeout(() => {
    try {
      sweepOnce(dataDir)
    }
    catch (err) {
      console.error('[retention] 首轮清理失败:', err instanceof Error ? err.message : err)
    }
  }, 90_000)
  first.unref?.()

  const timer = setInterval(() => {
    try {
      sweepOnce(dataDir)
    }
    catch (err) {
      console.error('[retention] 定时清理失败:', err instanceof Error ? err.message : err)
    }
  }, 24 * 3_600_000)
  timer.unref?.()
  g.__awRetentionTimer = timer
}
