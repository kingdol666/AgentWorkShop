/**
 * GET /api/workshop/memory/embedding/models —— 检索模型面板的单一读口。
 * 返回：注册表（含安装状态/体积）、当前生效 provider、向量层统计、下载任务进度。
 * 鉴权：登录用户可读（模型能力是产品级信息，不涉及他人记忆内容）。
 */
import { defineApiHandler } from '@/server/utils/response'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { LOCAL_EMBEDDING_MODELS, installedModel, totalModelBytes } from '@/server/services/workshop/memory/local-embedding/registry'
import { listDownloadJobs } from '@/server/services/workshop/memory/local-embedding/download'
import { embeddingProviderInfo } from '@/server/services/workshop/runtime/embedding-provider'

export default defineApiHandler(async (event) => {
  requireMemoryUser(event)
  const db = getAmlRuntime().db
  let vectorRows: number
  try {
    vectorRows = Number((db.prepare('SELECT COUNT(*) AS n FROM agent_memories_vec').get() as { n: number }).n)
  }
  catch { vectorRows = 0 }
  const provider = embeddingProviderInfo()
  const vecDims = provider.kind === 'local' ? provider.dims : null

  const models = LOCAL_EMBEDDING_MODELS.map((def) => {
    const info = installedModel(def.id)
    return {
      id: def.id,
      name: def.name,
      dims: def.dims,
      langs: def.langs,
      pooling: def.pooling,
      license: def.license,
      note: def.note,
      repo: def.repo,
      bytes: totalModelBytes(def),
      installed: info !== null,
      installedBytes: info?.bytes ?? 0,
      installedAt: info?.installedAt ?? null,
      active: provider.kind === 'local' && provider.model === def.id,
    }
  })

  let eligible: number
  try {
    eligible = Number((db.prepare(
      `SELECT COUNT(*) AS n FROM agent_memories WHERE deleted_at IS NULL AND COALESCE(status, 'active') != 'retired'`,
    ).get() as { n: number }).n)
  }
  catch { eligible = 0 }

  return {
    models,
    provider,
    vectors: { rows: vectorRows, dims: vecDims, eligible, pending: Math.max(0, eligible - vectorRows) },
    downloads: listDownloadJobs().slice(0, 12),
  }
})
