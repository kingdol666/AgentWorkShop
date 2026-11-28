/**
 * POST /api/workshop/memory/embedding/models/:id/download —— 下载本地向量模型（admin）。
 * 立即返回任务视图；进度轮询 GET /embedding/models。
 */
import { getRouterParam } from 'h3'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { findLocalEmbeddingModel, installedModel } from '@/server/services/workshop/memory/local-embedding/registry'
import { activeJobForModel, startModelDownload } from '@/server/services/workshop/memory/local-embedding/download'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '仅管理员可下载检索模型')
  const id = getRouterParam(event, 'id')!
  if (!findLocalEmbeddingModel(id)) throw new AppError(404, 'NOT_FOUND', `未知模型: ${id}`)
  // 已安装则拒绝重下（评审 P2，2026-11-28）：下载会在失败/取消时清理目标目录，
  // 对已启用模型发起"重下后取消"会把正在用的文件删掉。要换版本请先删除再下载。
  if (installedModel(id) && !activeJobForModel(id)) {
    throw new AppError(409, 'MODEL_ALREADY_INSTALLED', `模型已安装：${id}（如需重下请先删除）`)
  }
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
