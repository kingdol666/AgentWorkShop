/**
 * 数据目录单实例守卫(S16,2026-10-28;2026-10-30 安全/鲁棒加固)。
 *
 * `scripts/start.mjs`/`dev-guard.mjs` 已有 <configRoot>/.runtime/aw.lock,但直接
 * `node .output/server/index.mjs` 的启动路径绕过它 —— 两个进程共享同一份 JSON 仓储/
 * writeLocks 时会互相覆盖、绕过 60s/保持窗。本插件在配置根再取一把数据锁
 * (<configRoot>/.runtime/data.lock),覆盖所有启动方式:
 *   - 独占创建(flag:'wx'):read-then-write 存在 TOCTOU 窗口,双实例冷启动会双双成为写者;
 *   - EEXIST 且 PID 存活 → fail-fast(退出码 1);PID 已死(崩溃残留)→ 接管;
 *   - 进程退出 → 释放;close 钩子再释放一次(幂等)。
 *
 * **信号语义(2026-10-30 P0-3)**:本插件不再在 SIGINT/SIGTERM 里 `process.exit(0)` ——
 * 那会抢在 nitro graceful shutdown 之前退出,使 close 钩子(杀 AML 训练树 / manager.shutdown /
 * db.close)全部成为死代码。现在只安排一个 10s 兜底强退定时器(不立刻退出),信号处理权交还 nitro。
 *
 * 显式豁免:AW_SKIP_DATA_LOCK=1(仅测试/受控多实例编排,默认禁止)。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SKIP = process.env.AW_SKIP_DATA_LOCK === '1'
const ROOT = resolve(process.env.AW_HOME ?? process.cwd())
const DIR = join(ROOT, '.runtime')
const LOCK = join(DIR, 'data.lock')
/** 优雅停机兜底:close 链卡死时也不让进程永不退出 */
const FORCE_EXIT_MS = 10_000

interface LockFile { pid?: number, at?: string }

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function readLock(): LockFile | null {
  try {
    return JSON.parse(readFileSync(LOCK, 'utf8')) as LockFile
  }
  catch {
    return null
  }
}

function release(): void {
  try {
    const cur = readLock()
    if (cur?.pid === process.pid && existsSync(LOCK)) rmSync(LOCK, { force: true })
  }
  catch { /* 退出路径尽力而为 */ }
}

function lockSelf(): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' })
      return
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
    }
    const existing = readLock()
    // 存活 → 拒绝(不猜、不强占);已死或内容损坏 → 清理后重试
    if (existing?.pid && existing.pid !== process.pid && pidAlive(existing.pid)) {
      console.error(`[instance-guard] 数据目录已被进程 ${existing.pid} 占用:${ROOT}。同一数据目录只允许一个写者;请先停止该实例,或设置 AW_HOME 指向独立目录。`)
      process.exit(1)
    }
    // 接管崩溃残留必须留痕:否则"谁在写这个数据目录"无从追溯
    console.warn(`[instance-guard] 接管崩溃残留的数据锁(pid=${existing?.pid ?? '未知'} 已不存在):${LOCK}`)
    try {
      rmSync(LOCK, { force: true })
    }
    catch { /* 竞态:下一轮 wx 会再判 */ }
  }
  throw new Error('无法取得数据目录锁(持续 EEXIST)')
}

export default async function instanceGuardPlugin(nitroApp?: {
  hooks?: { hook(name: string, fn: (...args: unknown[]) => void | Promise<void>): void }
}): Promise<void> {
  if (SKIP) {
    console.warn('[instance-guard] AW_SKIP_DATA_LOCK=1:已跳过数据目录单实例锁(仅限测试/受控编排)')
    return
  }
  try {
    mkdirSync(DIR, { recursive: true })
  }
  catch (err) {
    console.error('[instance-guard] 无法创建 .runtime 目录:', err instanceof Error ? err.message : err)
    process.exit(1)
  }
  try {
    lockSelf()
  }
  catch (err) {
    console.error('[instance-guard] 无法写入数据锁:', err instanceof Error ? err.message : err)
    process.exit(1)
  }
  process.once('exit', release)
  // close 钩子双保险(正常优雅停机路径)
  nitroApp?.hooks?.hook('close', () => release())
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      // 只安排兜底强退;不在此退出 —— 让 nitro 的 graceful shutdown 跑完 close 钩子
      const t = setTimeout(() => {
        console.warn('[instance-guard] 优雅停机超时,强制退出')
        release()
        process.exit(0)
      }, FORCE_EXIT_MS)
      t.unref?.()
    })
  }
}
