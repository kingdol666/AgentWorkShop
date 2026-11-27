/**
 * POST /api/workshop/memory/embedding/models/:id/download —— 下载本地向量模型（admin）。
 * 立即返回任务视图；进度轮询 GET /embedding/models。
 */
import { getRouterParam } from 'h3'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { findLocalEmbeddingModel } from '@/server/services/workshop/memory/local-embedding/registry'
import { startModelDownload } from '@/server/services/workshop/memory/local-embedding/download'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '仅管理员可下载检索模型')
  const id = getRouterParam(event, 'id')!
  if (!findLocalEmbeddingModel(id)) throw new AppError(404, 'NOT_FOUND', `未知模型: ${id}`)
  const job = startModelDownload(id)
  try {
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user',
      action: 'memory.embedding.download', kind: 'system', targetKind: 'system', targetId: id,
      summary: `开始下载本地检索模型 ${id}（任务 ${job.id}）`,
    })
  }
  catch { /* 审计失败不阻断下载 */ }
  return { job }
})
