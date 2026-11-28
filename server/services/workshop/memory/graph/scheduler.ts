/**
 * Memory Graph scheduler —— 定时整理（进程内单飞）。
 *
 * 纪律（修正 Curator timer 的历史问题）：
 *  - 单飞：上一轮未结束不叠加；
 *  - stop() 清理 timer，manager 关闭时调用；
 *  - 启动先回收 stale running run；
 *  - 首轮延迟（默认 60s），避免启动即重负载；
 *  - 间隔/开关可由 env 配置，默认 30min。
 */
import type { DatabaseSync } from 'node:sqlite'
import { runMemoryGraphSweep, type ConsolidationOptions, type ConsolidationResult } from './agent'
import { createMemoryGraphRepo } from './repo'

const DEFAULT_INTERVAL_MS = 30 * 60_000
const MIN_INTERVAL_MS = 60_000

export interface MemoryGraphSchedulerConfig {
  intervalMs: number
  initialDelayMs: number
  sweepLimit: number
  useLlm: boolean
}

export function memoryGraphSchedulerConfig(): MemoryGraphSchedulerConfig {
  const rawInterval = Number(process.env.AW_MEMORY_GRAPH_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
  const intervalMs = Number.isFinite(rawInterval) ? Math.max(MIN_INTERVAL_MS, rawInterval) : DEFAULT_INTERVAL_MS
  const rawDelay = Number(process.env.AW_MEMORY_GRAPH_INITIAL_DELAY_MS ?? 60_000)
  const initialDelayMs = Number.isFinite(rawDelay) ? Math.max(0, rawDelay) : 60_000
  const rawLimit = Number(process.env.AW_MEMORY_GRAPH_SWEEP_LIMIT ?? 2)
  const sweepLimit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(10, rawLimit)) : 2
  const useLlm = Boolean(
    process.env.AW_MEMORY_GRAPH_LLM_URL?.trim() || process.env.AW_MEMORY_CURATOR_LLM_URL?.trim(),
  )
  return { intervalMs, initialDelayMs, sweepLimit, useLlm }
}

export interface MemoryGraphScheduler {
  stop(): void
  runOnce(): Promise<ConsolidationResult[]>
  readonly running: boolean
  readonly config: MemoryGraphSchedulerConfig
}

export function startMemoryGraphScheduler(
  db: DatabaseSync,
  opts: Partial<MemoryGraphSchedulerConfig> & ConsolidationOptions = {},
): MemoryGraphScheduler | null {
  if (process.env.AW_MEMORY_GRAPH_DISABLED === '1') return null
  const config = { ...memoryGraphSchedulerConfig(), ...opts }
  let timer: ReturnType<typeof setInterval> | null = null
  let initial: ReturnType<typeof setTimeout> | null = null
  let inFlight = false

  const runOnce = async (): Promise<ConsolidationResult[]> => {
    if (inFlight) return []
    inFlight = true
    try {
      const repo = createMemoryGraphRepo(db)
      if (!repo.available) return []
      try {
        repo.reconcileStaleRuns()
      }
      catch { /* stale 回收失败不阻断本轮 */ }
      return await runMemoryGraphSweep(db, {
        limit: config.sweepLimit,
        useLlm: config.useLlm,
        ...(opts.llm !== undefined ? { llm: opts.llm } : {}),
        ...(opts.maxSources !== undefined ? { maxSources: opts.maxSources } : {}),
        ...(opts.force !== undefined ? { force: opts.force } : {}),
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
