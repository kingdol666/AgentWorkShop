/**
 * 备份定时插件(S6,production-readiness-plan)。
 *
 * 对 data/ 下三库(workshop/users/daq-timeseries)每日 VACUUM INTO 快照到
 * data/backups/,按 BACKUP_KEEP(默认 7)轮转;调度模式复用 ws.ts 保留期清理的
 * setInterval + globalThis key 防 HMR 重复 + unref()。dev 与生产均生效
 * (备份无副作用,始终开启;BACKUP_DISABLED=1 可关)。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'

const g = globalThis as typeof globalThis & { __awBackupTimer?: NodeJS.Timeout, __awBackupLastAt?: string }

const DB_FILES = ['workshop.sqlite', 'users.sqlite', 'daq-timeseries.sqlite'] as const

function backupOnce(dataDir: string): void {
  const backupDir = resolve(dataDir, 'backups')
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  for (const file of DB_FILES) {
    const src = resolve(dataDir, file)
    if (!existsSync(src)) continue
    const target = resolve(backupDir, `${file}.${stamp}.bak`)
    try {
      const db = new DatabaseSync(src)
      try {
        // VACUUM INTO:在线一致性快照(WAL 下安全),不阻塞长事务
        db.exec(`VACUUM INTO '${target.replace(/\\/g, '/')}'`)
      }
      finally {
        db.close()
      }
    }
    catch (err) {
      console.error(`[backup] ${file} 快照失败:`, err instanceof Error ? err.message : err)
    }
  }
  // 轮转:每库仅保留最近 BACKUP_KEEP 份(按文件名内时间戳倒序)
  const keep = Math.max(1, Number(process.env.BACKUP_KEEP) || 7)
  for (const file of DB_FILES) {
    const own = readdirSync(backupDir)
      .filter(f => f.startsWith(`${file}.`) && f.endsWith('.bak'))
      .sort()
      .reverse()
    for (const stale of own.slice(keep)) {
      try {
        rmSync(resolve(backupDir, stale))
      }
      catch { /* 轮转失败不致命 */ }
    }
  }
  console.log('[backup] 快照完成 →', backupDir)
  // R4:记录最近一次成功备份时间,供 /api/metrics 观测
  g.__awBackupLastAt = new Date().toISOString()
}

export default function backupPlugin() {
  if (process.env.BACKUP_DISABLED === '1') return
  if (g.__awBackupTimer) return
  const dataDir = ensureDataDir()

  // 启动 30s 后首备(避开启动风暴),此后每 BACKUP_INTERVAL_HOURS(默认 24h)
  const first = setTimeout(() => {
    try {
      backupOnce(dataDir)
    }
    catch (err) {
      console.error('[backup] 首备失败:', err instanceof Error ? err.message : err)
    }
  }, 30_000)
  first.unref?.()
  const hours = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS) || 24)
  const timer = setInterval(() => {
    try {
      backupOnce(dataDir)
    }
    catch (err) {
      console.error('[backup] 定时备份失败:', err instanceof Error ? err.message : err)
    }
  }, hours * 3_600_000)
  timer.unref?.()
  g.__awBackupTimer = timer
}
