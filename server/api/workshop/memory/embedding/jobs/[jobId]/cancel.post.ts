/**
 * POST /api/workshop/memory/embedding/jobs/:jobId/cancel —— 取消运行中的模型下载（admin）。
 *
 * 为什么需要（2026-11-28 实机验收补正）：下载 24MB 主模型在慢链路上要数分钟，
 * 之前只有"开始"没有"停止"——用户误点/换源/断网后只能等超时。取消走
 * AbortController：传输立即中断，`.part` 与已完成文件一并清掉（半套文件不可用），
 * 任务状态转 canceled 供面板轮询。
 */
import { getRouterParam } from 'h3'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { cancelDownloadJob, listDownloadJobs } from '@/server/services/workshop/memory/local-embedding/download'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '仅管理员可取消检索模型下载')
  const jobId = getRouterParam(event, 'jobId')!
  const job = listDownloadJobs().find(j => j.id === jobId)
  if (!job) throw new AppError(404, 'JOB_NOT_FOUND', `下载任务不存在: ${jobId}`)
  if (job.status !== 'running') {
    throw new AppError(409, 'JOB_NOT_RUNNING', `任务已结束（status=${job.status}），无需取消`)
  }
  const signaled = cancelDownloadJob(jobId)
  if (!signaled) throw new AppError(409, 'JOB_NOT_CANCELABLE', '任务控制器已释放（可能刚好完成），请刷新查看')
  // 取消与"刚好下完"存在竞态（评审 P2）：abort 可能落在最后一个文件之后，任务仍会变 done。
  // 短等终止态后按**实际**状态回报，避免 UI 谎称"已取消"却留下了完整安装。
  for (let i = 0; i < 20 && job.status === 'running'; i++) {
    await new Promise(r => setTimeout(r, 100))
  }
  // 重新取一次（不要把上面的窄化当成终态）：
  const finalStatus: string = listDownloadJobs().find(j => j.id === jobId)?.status ?? job.status
  try {
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user',
      action: 'memory.embedding.cancel', kind: 'system', targetKind: 'system', targetId: job.modelId,
      summary: `取消本地检索模型下载 ${job.modelId}（任务 ${jobId}，结果 ${finalStatus}）`,
    })
  }
  catch { /* 审计失败不阻断 */ }
  return { ok: true, canceled: finalStatus === 'canceled', status: finalStatus, jobId, modelId: job.modelId }
})
