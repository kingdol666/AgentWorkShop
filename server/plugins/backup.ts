/**
 * 备份定时插件(S6,production-readiness-plan)。
 *
 * 对 data/ 下三库(workshop/users/daq-timeseries)每日 serialize 镜像快照到
 * data/backups/,按 BACKUP_KEEP(默认 7)轮转;调度模式复用 ws.ts 保留期清理的
 * setInterval + globalThis key 防 HMR 重复 + unref()。dev 与生产均生效
 * (备份无副作用,始终开启;BACKUP_DISABLED=1 可关)。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { backupSettings } from '../services/workshop/settings'
import { backupRegistry } from '../services/workshop/db/backup-registry'

const g = globalThis as typeof globalThis & { __awBackupTimer?: NodeJS.Timeout, __awBackupLastAt?: string }

const DB_FILES = ['workshop.sqlite', 'users.sqlite', 'daq-timeseries.sqlite'] as const

/**
 * 单库在线快照(hardening ST-2 终版:零侵入文件拷贝)。
 *
 * 真实事故两连(Windows + node:sqlite):
 *  1) 对活库开第二连接 serialize/close → 主连接 prepared statements 全部失效;
 *  2) 对主连接 serialize() → 该连接上全部语句被 finalize(20 分钟后 Mailbox 一用即炸)。
 * 结论:node:sqlite 上 serialize 路线对常驻服务不可行。终版:PASSIVE checkpoint
 * (尽力把 WAL 并回主文件,失败不影响服务)→ 拷贝主文件。得到的是「最后一次
 * checkpoint 时刻」的有效 SQLite 镜像;备份语义为日级韧性的兜底,允许略旧。
 */
async function backupOne(src: string, target: string): Promise<void> {
  const db = backupRegistry.get(src)
  if (db) {
    try {
      db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    }
    catch { /* 忙时跳过 checkpoint,拷出的镜像退回上次 checkpoint 点,仍有效 */ }
  }
  // 原子落盘:快照写一半被杀会留下截断 .bak(轮转后还被当作有效备份)
  const tmp = `${target}.tmp`
  copyFileSync(src, tmp)
  try {
    renameSync(tmp, target)
  }
  catch {
    // rename 失败(目标被占用等):退回直写,可用性优先
    copyFileSync(src, target)
    try {
      rmSync(tmp)
    }
    catch { /* ignore */ }
  }
}

async function backupOnce(dataDir: string): Promise<void> {
  const backupDir = resolve(dataDir, 'backups')
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  for (const file of DB_FILES) {
    const src = resolve(dataDir, file)
    if (!existsSync(src) || !backupRegistry.has(src)) continue
    const target = resolve(backupDir, `${file}.${stamp}.bak`)
    try {
      await backupOne(src, target)
      console.log('[backup]', file, '快照完成(serialize)')
    }
    catch (err) {
      console.error(`[backup] ${file} 快照失败:`, err instanceof Error ? err.message : err)
    }
  }
  // 轮转:每库仅保留最近 backup.keep 份(按文件名内时间戳倒序;env BACKUP_KEEP 兼容)
  const keep = Math.max(1, backupSettings().keep)
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
  const backupCfg = backupSettings()
  if (backupCfg.disabled) return
  if (g.__awBackupTimer) return
  const dataDir = ensureDataDir()

  // 启动 30s 后首备(避开启动风暴),此后每 backup.interval_hours(默认 24h)
  const first = setTimeout(() => {
    try {
      // backupOnce 是 async:同步 try/catch 接不住内部 rejection(会变成 unhandled
      // rejection 触发 dev-stability-guard 退进程),必须显式 .catch
      backupOnce(dataDir).catch((err: unknown) => {
        console.error('[backup] 首备失败:', err instanceof Error ? err.message : err)
      })
    }
    catch (err) {
      console.error('[backup] 首备失败:', err instanceof Error ? err.message : err)
    }
  }, 30_000)
  first.unref?.()
  const hours = Math.max(1, backupCfg.interval_hours)
  const timer = setInterval(() => {
    backupOnce(dataDir).catch((err: unknown) => {
      console.error('[backup] 定时备份失败:', err instanceof Error ? err.message : err)
    })
  }, hours * 3_600_000)
  timer.unref?.()
  g.__awBackupTimer = timer
}
