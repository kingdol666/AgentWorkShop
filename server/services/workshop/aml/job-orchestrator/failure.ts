/**
 * 失败与重试决策 / 实验失败 / 杀进程 / 收尾 / 日志与解析工具
 * (由 server/services/workshop/aml/job-orchestrator.ts 按职责拆出;内容逐行原文搬运)
 */
import type { RunningJob } from './shared'
import { amlSettings } from '../../settings'
import { appendFileSync, rmSync } from 'node:fs'
import { getAmlRuntime } from '../runtime'
import { join } from 'node:path'
import { killHarnessProcess } from '../python-runtime'
import { state } from './shared'

export function failPermanentOrRetry(run: RunningJob, msg: string, exitCode: number): void {
  const rt = getAmlRuntime()
  const retryable = exitCode === -1 && run.row.retryCount < 2 // 被杀才可重试;exit>0 是代码/契约问题
  if (retryable) {
    rt.repo.job.requeue(run.row.id)
    const fresh = rt.repo.job.get(run.row.id)
    if (fresh) state().queue.push(fresh)
  }
  else {
    rt.repo.job.fail(run.row.id, 'failed', msg, new Date().toISOString())
    experimentFail(run, msg)
  }
  finishRun(run)
}

export function experimentFail(run: RunningJob, reason: string): void {
  // 实验行由 model-registry 在 conclude 时建;失败路径只留作业侧错误(避免半态行)
  void run
  void reason
}

export async function killJobProcess(run: RunningJob, status: 'cancelled' | 'timeout' | 'failed'): Promise<void> {
  if (run.child?.pid) await killHarnessProcess(run.child.pid)
  run.child = null
  void status
}

export function finishRun(run: RunningJob): void {
  const st = state()
  // 落盘完整日志(run.log)
  try {
    appendFileSync(join(run.jobDir, 'run.log'), run.logLines.join('\n') + '\n')
    // GC:终态后清 workspace 中间产物(保留 run.log/metrics/artifacts/job.json)
    if (!process.env.AML_KEEP_WORKSPACE) {
      try {
        rmSync(join(run.jobDir, 'workspace'), { recursive: true, force: true })
      }
      catch { /* 已被外部清理 */ }
    }
  }
  catch { /* 日志落盘失败不阻断 */ }
  st.running.delete(run.row.id)
}

export function pushLog(run: RunningJob, line: string): void {
  run.logLines.push(`${new Date().toISOString()} ${line}`)
  if (run.logLines.length > amlSettings().job.logTailLines) run.logLines.splice(0, run.logLines.length - amlSettings().job.logTailLines)
}

export function safeParse(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>
    }
    catch { return {} }
  }
  return (v ?? {}) as Record<string, unknown>
}

export function lastErrLine(errTail: string): string {
  const lines = errTail.split('\n').map(l => l.trim()).filter(Boolean)
  return (lines[lines.length - 1] ?? `exit`).slice(0, 300)
}

// ---------- WS ----------
