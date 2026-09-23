/**
 * 取消 / 重试 / 日志尾 / 重启恢复 / 关停 / 心跳定时器
 * (由 server/services/workshop/aml/job-orchestrator.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AmlJobRow } from '../aml.repo'
import { AppError } from '../../../../utils/errors'
import { existsSync, readFileSync } from 'node:fs'
import { getAmlRuntime } from '../runtime'
import { join } from 'node:path'
import { killHarnessProcess } from '../python-runtime'
import { killJobProcess } from './failure'
import { state } from './shared'
import { tick } from './tick'

export function cancelJob(id: string, by: { id: string, kind: 'user' | 'agent' }): boolean {
  const rt = getAmlRuntime()
  const st = state()
  const qi = st.queue.findIndex(j => j.id === id)
  if (qi >= 0) {
    st.queue.splice(qi, 1)
    rt.repo.job.fail(id, 'cancelled', `被 ${by.kind}:${by.id} 取消(排队中)`, new Date().toISOString())
    return true
  }
  const run = st.running.get(id)
  if (run) {
    run.killed = true
    void killJobProcess(run, 'cancelled')
    return true
  }
  const row = rt.repo.job.get(id)
  if (row && ['queued', 'provisioning', 'training', 'evaluating'].includes(row.status)) {
    rt.repo.job.fail(id, 'cancelled', `被 ${by.kind}:${by.id} 取消`, new Date().toISOString())
    return true
  }
  return false
}

export function retryJob(id: string): AmlJobRow {
  const rt = getAmlRuntime()
  const row = rt.repo.job.get(id)
  if (!row) throw new AppError(404, 'AML_JOB_MISSING', `作业 ${id} 不存在`)
  if (!['failed', 'timeout', 'interrupted', 'cancelled'].includes(row.status)) {
    throw new AppError(409, 'AML_JOB_NOT_RETRYABLE', `作业状态 ${row.status} 不可重试`)
  }
  if (row.retryCount >= 2) throw new AppError(429, 'AML_RETRY_EXHAUSTED', '重试次数已用尽(2)')
  rt.repo.job.requeue(id)
  const fresh = rt.repo.job.get(id)!
  state().queue.push(fresh)
  ensureTicker()
  return fresh
}

/** 日志尾随(内存环形;重启后为空属预期,完整日志在 run.log 文件) */
export function jobLogsTail(id: string, lines = 80): string[] {
  const run = state().running.get(id)
  if (run) return run.logLines.slice(-lines)
  const rt = getAmlRuntime()
  const p = join(rt.jobsDir, id, 'run.log')
  if (!existsSync(p)) return []
  const content = readFileSync(p, 'utf8')
  return content.split('\n').slice(-lines)
}

/** 启动恢复:活跃态置 interrupted(必须在任何 REST/工具访问前调用一次) */
export function recoverInterruptedJobs(): number {
  const rt = getAmlRuntime()
  return rt.repo.job.markActiveInterrupted(new Date().toISOString())
}

/** 关停:杀活树 + 停 ticker(nitro close 钩子) */
export function shutdownOrchestrator(): void {
  const st = state()
  if (st.ticker) {
    clearInterval(st.ticker)
    st.ticker = null
  }
  for (const run of st.running.values()) {
    run.killed = true
    if (run.child?.pid) void killHarnessProcess(run.child.pid)
  }
  st.running.clear()
  st.queue = []
}

// ---------- 内部 ----------

export function ensureTicker(): void {
  const st = state()
  if (st.ticker) return
  st.ticker = setInterval(() => {
    void tick()
  }, 1000)
  st.ticker.unref()
}
