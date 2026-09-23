/**
 * 队列推进:tick 取下一个待跑作业
 * (由 server/services/workshop/aml/job-orchestrator.ts 按职责拆出;内容逐行原文搬运)
 */
import { amlSettings } from '../../settings'
import { finishRun, killJobProcess } from './failure'
import { getAmlRuntime } from '../runtime'
import { log, state } from './shared'
import { startJob } from './start-job'

export async function tick(): Promise<void> {
  const rt = getAmlRuntime()
  const st = state()
  const s = amlSettings()

  // 停摆看门狗:无协议输出超时 → 杀
  for (const run of st.running.values()) {
    if (Date.now() - run.lastProtocolAt > s.job.stallMs) {
      log.warn(`[aml-job] ${run.row.id} 停摆(${Math.round(s.job.stallMs / 1000)}s 无协议输出)→ 终止`)
      run.killed = true
      rt.repo.job.fail(run.row.id, 'failed', `作业停摆(${Math.round(s.job.stallMs / 1000)}s 无进度输出)被终止`, new Date().toISOString())
      await killJobProcess(run, 'failed')
      finishRun(run)
      continue
    }
    if (Date.now() - run.startedAt > s.job.timeoutMs && !run.killed) {
      run.killed = true
      rt.repo.job.fail(run.row.id, 'timeout', `墙钟超时(${Math.round(s.job.timeoutMs / 60000)}min)`, new Date().toISOString())
      await killJobProcess(run, 'timeout')
      finishRun(run)
    }
  }

  if (st.running.size >= Math.max(1, s.job.maxConcurrent)) return
  const next = st.queue.shift()
  if (next) await startJob(next)
}
