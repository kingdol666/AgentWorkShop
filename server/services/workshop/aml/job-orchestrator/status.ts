/**
 * 运行时状态(Python 可用性等)
 * (由 server/services/workshop/aml/job-orchestrator.ts 按职责拆出;内容逐行原文搬运)
 */
import { getAmlRuntime } from '../runtime'
import { isVenvReady, probePython } from '../python-runtime'
import { state } from './shared'

export async function runtimeStatus(): Promise<{ python: { ok: boolean, version?: string, reason?: string }, venvReady: boolean, amlRoot: string, queued: number, running: number }> {
  const probe = await probePython()
  const rt = getAmlRuntime()
  const st = state()
  return {
    python: { ok: probe.ok, version: probe.version, reason: probe.reason },
    venvReady: probe.ok ? isVenvReady(rt) : false,
    amlRoot: rt.root,
    queued: st.queue.length + rt.repo.job.list({ status: 'queued' }).length,
    running: st.running.size,
  }
}
