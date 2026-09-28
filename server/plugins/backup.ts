/**
 * 备份定时插件(S6,production-readiness-plan)。
 *
 * 对 data/ 下三库(workshop/users/daq-timeseries)每日 serialize 镜像快照到
 * data/backups/,按 BACKUP_KEEP(默认 7)轮转;调度模式复用 ws.ts 保留期清理的
 * setInterval + globalThis key 防 HMR 重复 + unref()。dev 与生产均生效
 * (备份无副作用,始终开启;BACKUP_DISABLED=1 可关)。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { copyFile as copyFileAsync } from 'node:fs/promises'
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
  // 异步拷贝:daq-timeseries 可达数百 MB,copyFileSync 会同步冻结事件循环数秒
  // (期间 WS 扇出/采样 sweep/API 全部停摆)
  const tmp = `${target}.tmp`
  await copyFileAsync(src, tmp)
  try {
    renameSync(tmp, target)
  }
  catch {
    // rename 失败(目标被占用等):退回直写,可用性优先
    await copyFileAsync(src, target)
    try {
      rmSync(tmp)
    }
    catch { /* ignore */ }
  }
}

/** 数据目录内的 JSON 仓储/状态文件(kv、参数面、节点绑定、插件 kv 等)+ 上级配置根的 config.yml/runtime-settings.json */
async function backupFlatFiles(dataDir: string, backupDir: string, stamp: string): Promise<void> {
  const bundleDir = resolve(backupDir, `files-${stamp}`)
  mkdirSync(bundleDir, { recursive: true })
  const targets: Array<{ src: string, name: string }> = []
  // dataDir 下所有 .json(逐文件拷贝,目录型子树由各自仓储自轮转,不整树递归)
  try {
    for (const f of readdirSync(dataDir, { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith('.json')) targets.push({ src: resolve(dataDir, f.name), name: f.name })
    }
  }
  catch { /* 数据目录不可读时跳过 JSON 面 */ }
  // 配置根(config.yml + runtime-settings.json)——重建实例的"怎么做"半边
  try {
    const homeMod = await import('@/shared/config/home.mjs')
    const rm = homeMod.resolveRunMode({ cwd: process.cwd(), env: process.env })
    for (const cfg of ['config.yml', 'runtime-settings.json']) {
      const p = resolve(rm.configRoot, cfg)
      if (existsSync(p)) targets.push({ src: p, name: cfg })
    }
  }
  catch { /* 模式解析失败只降级 JSON 面 */ }
  for (const t of targets) {
    try {
      const tmp = resolve(bundleDir, `${t.name}.tmp`)
      await copyFileAsync(t.src, tmp)
      renameSync(tmp, resolve(bundleDir, t.name))
    }
    catch (err) {
      console.error(`[backup] ${t.name} 快照失败:`, err instanceof Error ? err.message : err)
    }
  }
}

export async function backupOnce(dataDir: string): Promise<void> {
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
  // JSON 仓储 + 配置面快照(三库之外的可重建性半边)
  await backupFlatFiles(dataDir, backupDir, stamp)
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
  // files-<stamp>/ 目录同 keep 轮转
  const fileBundles = readdirSync(backupDir)
    .filter(f => f.startsWith('files-') && !f.includes('.'))
    .sort()
    .reverse()
  for (const stale of fileBundles.slice(keep)) {
    try {
      rmSync(resolve(backupDir, stale), { recursive: true })
    }
    catch { /* 轮转失败不致命 */ }
  }
  console.log('[backup] 快照完成 →', backupDir)
  // R4:记录最近一次成功备份时间,供 /api/metrics 观测
  g.__awBackupLastAt = new Date().toISOString()
  // 备份成败留痕(audit_log;动态导入避免插件装载期循环依赖)
  void import('../services/workshop/ops/ops').then(({ recordOps }) => {
    recordOps({
      actor: 'system', actorName: 'backup', actorKind: 'system',
      action: 'system.backup.run', kind: 'system',
      summary: `数据库快照完成(${DB_FILES.length} 库 + JSON/配置)→ ${backupDir}`,
    })
  }).catch(() => {})
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
