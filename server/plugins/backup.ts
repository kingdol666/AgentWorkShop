/**
 * 备份定时插件(S6,production-readiness-plan)。
 *
 * 对 data/ 下三库(workshop/users/daq-timeseries)每日 serialize 镜像快照到
 * data/backups/,按 BACKUP_KEEP(默认 7)轮转;调度模式复用 ws.ts 保留期清理的
 * setInterval + globalThis key 防 HMR 重复 + unref()。dev 与生产均生效
 * (备份无副作用,始终开启;BACKUP_DISABLED=1 可关)。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, cpSync, writeFileSync } from 'node:fs'
import { copyFile as copyFileAsync } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { backupSettings } from '../services/workshop/settings'
import { backupRegistry } from '../services/workshop/db/backup-registry'

const g = globalThis as typeof globalThis & { __awBackupTimer?: NodeJS.Timeout, __awBackupLastAt?: string }

const DB_FILES = ['workshop.sqlite', 'users.sqlite', 'daq-timeseries.sqlite'] as const

/** 目录树字节总量(快速 walk;仅 size 求和,用于备份上限判定) */
function dirBytes(dir: string): number {
  let total = 0
  let entries: Array<import('node:fs').Dirent>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return 0
  }
  for (const e of entries) {
    const p = resolve(dir, e.name)
    if (e.isDirectory()) total += dirBytes(p)
    else if (e.isFile()) {
      try {
        total += statSync(p).size
      }
      catch { /* 竞态:文件恰好消失,按 0 计 */ }
    }
  }
  return total
}

/**
 * 对象面备份(daq-objects 本地对象存储 + daq-exports 导出宽表)。
 * 2026-10-09 生产化扩围:此前只备三库 + JSON 面,图像帧对象/导出数据不在备份
 * 范围(真实产线丢单对象=丢检验证据)。带体量上限(AW_BACKUP_OBJECTS_MAX_MB,
 * 缺省 200MB):超限跳过并显式落日志/账,提示走 infra 级卷备份,不做半份拷贝。
 */
async function backupObjects(dataDir: string, backupDir: string, stamp: string, manifest: Record<string, unknown>): Promise<void> {
  const capMb = Math.max(0, Number(process.env.AW_BACKUP_OBJECTS_MAX_MB ?? 200))
  if (capMb === 0) {
    manifest.objects = { skipped: 'disabled(env AW_BACKUP_OBJECTS_MAX_MB=0)' }
    return
  }
  const bundleDir = resolve(backupDir, `objects-${stamp}`)
  const included: string[] = []
  const skipped: string[] = []
  mkdirSync(bundleDir, { recursive: true })
  for (const dirName of ['daq-objects', 'daq-exports']) {
    const src = resolve(dataDir, dirName)
    if (!existsSync(src)) continue
    const bytes = dirBytes(src)
    if (bytes > capMb * 1024 * 1024) {
      skipped.push(`${dirName}(${Math.round(bytes / 1024 / 1024)}MB > 上限 ${capMb}MB)`)
      continue
    }
    try {
      cpSync(src, resolve(bundleDir, dirName), { recursive: true })
      included.push(`${dirName}(${Math.round(bytes / 1024 / 1024)}MB)`)
    }
    catch (err) {
      skipped.push(`${dirName}(拷贝失败: ${err instanceof Error ? err.message : String(err)})`)
    }
  }
  manifest.objects = { bundle: `objects-${stamp}`, included, skipped }
  if (skipped.length) console.warn('[backup] 对象面部分跳过:', skipped.join('; '))
}

/** TIMESCALE/MINIO 卷说明(docker-compose 部署形态;文件级备份覆盖不到,RESTORE 文档写明) */
const INFRA_VOLUMES_NOTE = 'TimescaleDB/MinIO 卷不在文件备份范围(docker 部署用 pg_dump/mc mirror 或卷快照)'

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
  const done: string[] = []
  for (const file of DB_FILES) {
    const src = resolve(dataDir, file)
    if (!existsSync(src) || !backupRegistry.has(src)) continue
    const target = resolve(backupDir, `${file}.${stamp}.bak`)
    try {
      await backupOne(src, target)
      done.push(file)
      console.log('[backup]', file, '快照完成(serialize)')
    }
    catch (err) {
      console.error(`[backup] ${file} 快照失败:`, err instanceof Error ? err.message : err)
    }
  }
  // JSON 仓储 + 配置面快照(三库之外的可重建性半边)
  await backupFlatFiles(dataDir, backupDir, stamp)
  // 对象面(图像帧对象存储 + 导出宽表;带体量上限,超限显式跳过)+ MANIFEST
  const manifest: Record<string, unknown> = { stamp, dbs: done, infraNote: INFRA_VOLUMES_NOTE }
  await backupObjects(dataDir, backupDir, stamp, manifest)
  try {
    writeFileSync(resolve(backupDir, `manifest-${stamp}.json`), JSON.stringify(manifest, null, 2))
  }
  catch { /* 清单写失败不影响备份本体 */ }
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
  // files-<stamp>/ 与 objects-<stamp>/、manifest-*.json 同 keep 轮转
  for (const prefix of ['files-', 'objects-']) {
    const bundles = readdirSync(backupDir)
      .filter(f => f.startsWith(prefix) && !f.includes('.'))
      .sort()
      .reverse()
    for (const stale of bundles.slice(keep)) {
      try {
        rmSync(resolve(backupDir, stale), { recursive: true })
      }
      catch { /* 轮转失败不致命 */ }
    }
  }
  try {
    const mans = readdirSync(backupDir).filter(f => f.startsWith('manifest-') && f.endsWith('.json')).sort().reverse()
    for (const stale of mans.slice(keep)) {
      try {
        rmSync(resolve(backupDir, stale))
      }
      catch { /* ignore */ }
    }
  }
  catch { /* ignore */ }
  console.log('[backup] 快照完成 →', backupDir)
  // R4:记录最近一次成功备份时间,供 /api/metrics 观测
  g.__awBackupLastAt = new Date().toISOString()
  // 备份成败留痕(audit_log;动态导入避免插件装载期循环依赖)
  void import('../services/workshop/ops/ops').then(({ recordOps }) => {
    recordOps({
      actor: 'system', actorName: 'backup', actorKind: 'system',
      action: 'system.backup.run', kind: 'system',
      summary: `数据库快照完成(${done.length} 库 + JSON/配置 + 对象面)→ ${backupDir}`,
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
