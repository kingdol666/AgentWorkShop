/**
 * POST /api/workshop/memory/embedding/activate —— 启用/停用本地检索模型（admin）。
 * body: { id: string }   id 为空/缺省 → 停用本地模型（回落 HTTP 端点/纯 FTS）。
 *
 * 纪律：
 *  - 只启用"已安装且文件完整"的模型（installedModel 校验），绝不启用半截文件；
 *  - 写入 memory.embed_local_model（live 键）后立刻 invalidateEmbeddingProvider()，
 *    新 provider 对后续写入/检索即时生效，无需重启；
 *  - 维度变化由回填侧 vecReset 处理，本端点不改动向量表（避免"启用了但向量是旧空间"的
 *    静默错误由调用方用回填接口显式收口）。
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { zValidator } from '@/server/utils/validate'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { findLocalEmbeddingModel, installedModel } from '@/server/services/workshop/memory/local-embedding/registry'
import { resetLocalEmbeddingCache } from '@/server/services/workshop/memory/local-embedding/onnx'
import { getSystemConfigService } from '@/server/services/system-config'
import { invalidateEmbeddingProvider, embeddingProviderInfo } from '@/server/services/workshop/runtime/embedding-provider'
import { recordOps } from '@/server/services/workshop/ops/ops'

const bodySchema = z.object({ id: z.string().optional() })

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '仅管理员可切换检索模型')
  const body = await readValidatedBody(event, zValidator(bodySchema))
  const id = (body.id ?? '').trim()
  if (id) {
    if (!findLocalEmbeddingModel(id)) throw new AppError(404, 'NOT_FOUND', `未知模型: ${id}`)
    if (!installedModel(id)) throw new AppError(409, 'MODEL_NOT_INSTALLED', `模型尚未下载完成: ${id}`)
  }
  getSystemConfigService().patch({ 'memory.embed_local_model': id })
  if (!id) resetLocalEmbeddingCache()
  invalidateEmbeddingProvider()
  try {
    recordOps({
      actor: user.id, actorName: user.name, actorKind: 'user',
      action: 'memory.embedding.activate', kind: 'system', targetKind: 'system', targetId: id || '(none)',
      summary: id ? `启用本地检索模型 ${id}` : '停用本地检索模型',
    })
  }
  catch { /* 审计失败不阻断 */ }
  return { ok: true, active: id, provider: embeddingProviderInfo() }
})
