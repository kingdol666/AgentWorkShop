/**
 * Curator 定时调度（收口旧计划调度卫生）。
 *  - 单飞：上一轮未结束不叠加；
 *  - stop() 清理 timer；
 *  - 启动/运行前回收 stale running run；
 *  - 间隔可配：AW_MEMORY_CURATOR_INTERVAL_MS（默认 30min，最小 5min）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { runCuratorSweep, type CuratorResult } from './index'

const DEFAULT_INTERVAL_MS = 30 * 60_000
const MIN_INTERVAL_MS = 5 * 60_000

export interface CuratorSchedulerConfig {
  intervalMs: number
  initialDelayMs: number
  sweepLimit: number
  useLlm: boolean
}

export function curatorSchedulerConfig(): CuratorSchedulerConfig {
  const raw = Number(process.env.AW_MEMORY_CURATOR_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
  const intervalMs = Number.isFinite(raw) ? Math.max(MIN_INTERVAL_MS, raw) : DEFAULT_INTERVAL_MS
  const rawDelay = Number(process.env.AW_MEMORY_CURATOR_INITIAL_DELAY_MS ?? 60_000)
  const initialDelayMs = Number.isFinite(rawDelay) ? Math.max(0, rawDelay) : 60_000
  const rawLimit = Number(process.env.AW_MEMORY_CURATOR_SWEEP_LIMIT ?? 2)
  const sweepLimit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(10, rawLimit)) : 2
  return {
    intervalMs,
    initialDelayMs,
    sweepLimit,
    useLlm: Boolean(process.env.AW_MEMORY_CURATOR_LLM_URL?.trim()),
  }
}

export function reconcileStaleCurationRuns(db: DatabaseSync, olderThanMs = 30 * 60_000): number {
  try {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString()
    const result = db.prepare(`UPDATE memory_curation_runs SET status = 'failed', error = 'stale_run', finished_at = ?
      WHERE status = 'running' AND started_at < ?`).run(new Date().toISOString(), cutoff)
    return Number(result.changes ?? 0)
  }
  catch {
    return 0
  }
}

export interface CuratorScheduler {
  stop(): void
  runOnce(): Promise<CuratorResult[]>
  readonly running: boolean
  readonly config: CuratorSchedulerConfig
}

export function startCuratorScheduler(db: DatabaseSync, opts: Partial<CuratorSchedulerConfig> = {}): CuratorScheduler | null {
  if (process.env.AW_MEMORY_CURATOR_DISABLED === '1') return null
  const config = { ...curatorSchedulerConfig(), ...opts }
  let timer: ReturnType<typeof setInterval> | null = null
  let initial: ReturnType<typeof setTimeout> | null = null
  let inFlight = false

  const runOnce = async (): Promise<CuratorResult[]> => {
    if (inFlight) return []
    inFlight = true
    try {
      reconcileStaleCurationRuns(db)
      return await runCuratorSweep(db, {
        limit: config.sweepLimit,
        useLlm: config.useLlm,
      })
    }
    catch {
      return []
    }
    finally {
      inFlight = false
    }
  }

  if (config.initialDelayMs > 0) {
    initial = setTimeout(() => {
      void runOnce()
    }, config.initialDelayMs)
    initial.unref?.()
  }
  timer = setInterval(() => {
    void runOnce()
  }, config.intervalMs)
  timer.unref?.()

  return {
    get running() { return inFlight },
    config,
    runOnce,
    stop() {
      if (timer) clearInterval(timer)
      if (initial) clearTimeout(initial)
      timer = null
      initial = null
    },
  }
}
