/**
 * AML GC/保留策略(挂 24h 循环;防冗余堆积 —— 计划 §14.1):
 *  1. 无引用且超过 retentionDays 的数据集:删快照目录 + 注册表行;
 *  2. retired 模型工件超过 retiredKeepDays:删工件目录(注册表行保留,标 artifacts_pruned);
 *  3. 失败作业目录(无任何实验成功)超过 7 天:删目录(注册表行保留)。
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger'
import { amlSettings } from '../settings'
import { getAmlRuntime } from './runtime'

const log = createLogger('aml.retention')
const DAY_MS = 24 * 3600_000
const FAILED_JOB_KEEP_DAYS = 7

export function sweepAmlRetention(now = Date.now()): { datasets: number, models: number, jobs: number } {
  const rt = getAmlRuntime()
  const s = amlSettings()
  let removedDatasets = 0
  let removedModels = 0
  let removedJobs = 0

  // 1. 无引用数据集
  for (const ds of rt.repo.dataset.list({ limit: 500 })) {
    const age = now - Date.parse(ds.createdAt)
    if (age < s.dataset.retentionDays * DAY_MS) continue
    const refs = rt.repo.dataset.referenceCount(ds.id)
    if (refs.experiments > 0 || refs.models > 0) continue
    try {
      if (existsSync(ds.path)) rmSync(ds.path, { recursive: true, force: true })
      rt.repo.dataset.remove(ds.id)
      removedDatasets++
    }
    catch (err) {
      log.warn(`[aml-retention] 数据集 ${ds.id} 清理失败:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 2. retired 模型工件
  for (const m of rt.repo.model.list({ stage: 'retired', limit: 500 })) {
    if (m.artifactsPruned) continue
    const age = now - Date.parse(m.promotedAt ?? m.createdAt)
    if (age < s.model.retiredKeepDays * DAY_MS) continue
    try {
      if (existsSync(m.path)) rmSync(m.path, { recursive: true, force: true })
      rt.repo.model.markPruned(m.id)
      removedModels++
    }
    catch (err) {
      log.warn(`[aml-retention] 模型 ${m.id} 工件清理失败:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 3. 失败/取消且终态超过 7 天的作业目录
  for (const status of ['failed', 'cancelled', 'timeout', 'interrupted'] as const) {
    for (const j of rt.repo.job.list({ status, limit: 200 })) {
      if (!j.endedAt) continue
      if (now - Date.parse(j.endedAt) < FAILED_JOB_KEEP_DAYS * DAY_MS) continue
      const dir = join(rt.jobsDir, j.id)
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
        removedJobs++
      }
      catch (err) {
        log.warn(`[aml-retention] 作业 ${j.id} 目录清理失败:${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (removedDatasets || removedModels || removedJobs) {
    log.info(`[aml-retention] 清理完成:数据集 ${removedDatasets} / 模型工件 ${removedModels} / 作业目录 ${removedJobs}`)
  }
  return { datasets: removedDatasets, models: removedModels, jobs: removedJobs }
}

const g = globalThis as typeof globalThis & { __amlRetentionTimer?: ReturnType<typeof setInterval> }

/** 启动 24h 循环(unref;HMR 幂等) */
export function startAmlRetentionTimer(): void {
  if (g.__amlRetentionTimer) return
  g.__amlRetentionTimer = setInterval(() => {
    try {
      sweepAmlRetention()
    }
    catch (err) {
      log.warn(`[aml-retention] 扫描失败(不阻断):${err instanceof Error ? err.message : String(err)}`)
    }
  }, 24 * 3600_000)
  g.__amlRetentionTimer.unref()
}

export function stopAmlRetentionTimer(): void {
  if (g.__amlRetentionTimer) {
    clearInterval(g.__amlRetentionTimer)
    g.__amlRetentionTimer = undefined
  }
}
