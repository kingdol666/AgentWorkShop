/**
 * Python 进程:退出信息 / 运行与 spawn / 协议行处理
 * (由 server/services/workshop/aml/job-orchestrator.ts 按职责拆出;内容逐行原文搬运)
 */
import type { ChildProcess } from 'node:child_process'
import type { RunningJob } from './shared'
import { currentStage, currentStatus } from './stages'
import { getAmlRuntime } from '../runtime'
import { jobEnv } from '../python-runtime'
import { join } from 'node:path'
import { pushLog } from './failure'
import { spawnLineProcess } from '../../agents/adapters/line-spawn'
import { writeFileSync } from 'node:fs'
import { wsProgress } from './broadcast'

export interface ExitInfo { code: number, errTail: string }

export function runPython(run: RunningJob, vpy: string, args: string[], cwd: string): Promise<ExitInfo> {
  return new Promise((resolve) => {
    const rt = getAmlRuntime()
    const child = spawnPython(vpy, args, {
      cwd,
      env: jobEnv(rt, run.jobDir),
      cleanEnv: true,
    }, (line) => {
      handleProtocolLine(run, line)
    })
    run.child = child
    let errTail = ''
    // stdout/stderr 统一进入行回调(runner 内部已按行拆分)
    child.on('exit', (code) => {
      run.child = null
      resolve({ code: code ?? -1, errTail: errTail.slice(-800) })
    })
    child.stderr?.on('data', (d) => {
      errTail += String(d)
      if (errTail.length > 4000) errTail = errTail.slice(-2000)
      pushLog(run, `[stderr] ${String(d).trimEnd()}`)
    })
    // killHarnessProcess 场景下 exit 可能不触发 stdout end;此处仅兜底 error
    child.on('error', (e) => {
      errTail += String(e)
    })
    void rt
  })
}

export function spawnPython(
  vpy: string,
  args: string[],
  opts: { cwd: string, env: Record<string, string>, cleanEnv?: boolean },
  onLine: (line: string) => void,
): ChildProcess {
  const child = spawnLineProcess(vpy, args, opts)
  let buf = ''
  child.stdout?.on('data', (d) => {
    buf += String(d)
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.length > 65536) onLine(line.slice(0, 65536)) // 超长行截断(防日志炸内存)
      else onLine(line)
    }
    if (buf.length > 1_000_000) buf = ''
  })
  return child
}

export function handleProtocolLine(run: RunningJob, rawLine: string): void {
  pushLog(run, rawLine)
  const line = rawLine.trimEnd()
  // 停摆看门狗只认 ##AML 协议行:任意 stdout 噪声不得重置活性基线
  if (!line.startsWith('##AML ')) return
  run.lastProtocolAt = Date.now()
  let evt: { type?: string, stage?: string, progress?: number, note?: string, metrics?: unknown, message?: string }
  try {
    evt = JSON.parse(line.slice(6))
  }
  catch {
    run.protocolBadLines++
    return
  }
  const rt = getAmlRuntime()
  if (evt.type === 'progress' && typeof evt.progress === 'number') {
    const p = Math.max(0, Math.min(99, Math.round(evt.progress)))
    rt.repo.job.setState(run.row.id, currentStatus(run.row.id), currentStage(run.row.id), p)
    wsProgress(run.row, p, evt.note ?? '')
  }
  else if (evt.type === 'stage' && evt.stage) {
    const status = evt.stage === 'evaluate' ? 'evaluating' : evt.stage === 'train' ? 'training' : 'provisioning'
    rt.repo.job.markStarted(run.row.id, status, evt.stage, new Date().toISOString())
  }
  else if (evt.type === 'metrics' && evt.metrics && typeof evt.metrics === 'object') {
    writeFileSync(join(run.jobDir, 'metrics.protocol.json'), JSON.stringify(evt.metrics, null, 2))
  }
  else if (evt.type === 'error' && evt.message) {
    pushLog(run, `[error] ${evt.message}`)
  }
}
