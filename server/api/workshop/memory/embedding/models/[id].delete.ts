/**
 * DELETE /api/workshop/memory/embedding/models/:id —— 删除已下载模型（admin）。
 * 若该模型正是当前启用项 → 同时清空 memory.embed_local_model（回落 HTTP 端点/纯 FTS），
 * 并提示向量层需要重新回填（旧向量空间已不可用，由调用方决定是否回填新模型）。
 */
import { getRouterParam } from 'h3'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { findLocalEmbeddingModel, installedModel } from '@/server/services/workshop/memory/local-embedding/registry'
import { removeLocalModel } from '@/server/services/workshop/memory/local-embedding/download'
import { memorySettings } from '@/server/services/workshop/settings'
import { getSystemConfigService } from '@/server/services/system-config'
import { invalidateEmbeddingProvider } from '@/server/services/workshop/runtime/embedding-provider'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '仅管理员可删除检索模型')
  const id = getRouterParam(event, 'id')!
  if (!findLocalEmbeddingModel(id)) throw new AppError(404, 'NOT_FOUND', `未知模型: ${id}`)
  if (!installedModel(id)) throw new AppError(404, 'NOT_FOUND', `模型未安装: ${id}`)
  const wasActive = (memorySettings().embed_local_model ?? '').trim() === id
  const removed = removeLocalModel(id)
  if (wasActive) {
    getSystemConfigService().patch({ 'memory.embed_local_model': '' })
    invalidateEmbeddingProvider()
  }
  try {
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user',
      action: 'memory.embedding.delete', kind: 'system', targetKind: 'system', targetId: id,
      summary: `删除本地检索模型 ${id}${wasActive ? '（同时停用）' : ''}`,
    })
  }
  catch { /* 审计失败不阻断 */ }
  return { ok: true, removed, deactivated: wasActive }
})
