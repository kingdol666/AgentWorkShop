/**
 * 数据目录单实例守卫(S16,2026-10-28)。
 *
 * `scripts/start.mjs`/`dev-guard.mjs` 已有 <configRoot>/.runtime/aw.lock,但直接
 * `node .output/server/index.mjs` 的启动路径绕过它 —— 两个进程共享同一份 JSON 仓储/
 * writeLocks 时会互相覆盖、绕过 60s/保持窗。本插件在配置根再取一把数据锁
 * (<configRoot>/.runtime/data.lock),覆盖所有启动方式:
 *   - 已存在且 PID 存活 → fail-fast(退出码 1);
 *   - PID 已死(崩溃残留) → 接管重写;
 *   - 进程退出/信号 → 释放。
 * 显式豁免:AW_SKIP_DATA_LOCK=1(仅测试/受控多实例编排,默认禁止)。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SKIP = process.env.AW_SKIP_DATA_LOCK === '1'
const ROOT = resolve(process.env.AW_HOME ?? process.cwd())
const DIR = join(ROOT, '.runtime')
const LOCK = join(DIR, 'data.lock')

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

export default async function instanceGuardPlugin(): Promise<void> {
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
  const existing = readLock()
  if (existing?.pid && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.error(`[instance-guard] 数据目录已被进程 ${existing.pid} 占用:${ROOT}。同一数据目录只允许一个写者;请先停止该实例,或设置 AW_HOME 指向独立目录。`)
    process.exit(1)
  }
  try {
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'w' })
  }
  catch (err) {
    console.error('[instance-guard] 无法写入数据锁:', err instanceof Error ? err.message : err)
    process.exit(1)
  }
  process.once('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      release()
      process.exit(0)
    })
  }
}
