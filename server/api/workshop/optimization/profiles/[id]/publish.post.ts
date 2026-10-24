/**
 * POST /api/workshop/optimization/profiles/:id/publish?version= —— 发布并冻结 problemIrHash。
 * 归属:仅 owner 或 admin(D16 配置管理权;B 发布 A 的 draft → 403 + 拒绝审计)。
 */
import { getQuery, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { getProfileRepo, parseProfileRow } from '@/server/services/workshop/optimization/profile.repo'
import { assertOptimizationAccess, recordConfigAction } from '@/server/services/workshop/optimization/access'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { AppError } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const id = getRouterParam(event, 'id') ?? ''
  const q = getQuery(event)
  const row = getProfileRepo().get(id, typeof q.version === 'string' ? Number(q.version) : undefined)
  if (!row) throw createError({ statusCode: 404, statusMessage: `Profile ${id} 不存在` })
  assertOptimizationAccess(user, 'publish', { kind: 'profile', id, version: row.version })
  // D18 谱系门:legacy 数据集训练的模型不能发布进优化 Profile(solve 同门)
  const parsed = parseProfileRow(row)
  const legacy = checkModelLineage(parsed.modelRef.modelId)
  if (legacy) throw new AppError(422, 'LEGACY_MODEL_REQUIRES_RETRAIN', legacy)
  const published = getProfileRepo().publish(id, row.version, typeof q.problemIrHash === 'string' ? q.problemIrHash : undefined)
  recordConfigAction(user, 'optimizer.profile.publish', { kind: 'optimizer_profile', id: `${id}@${published.version}` },
    `发布 Optimizer Profile ${id}@${published.version}(irHash=${published.problemIrHash.slice(0, 12)})`,
    { problemIrHash: published.problemIrHash })
  return { profile: published }
})

function checkModelLineage(modelId: string): string | null {
  if (!modelId) return null
  const db = getAmlRuntime().db
  const model = db.prepare('SELECT dataset_id AS datasetId FROM aml_models WHERE id = ?').get(modelId) as { datasetId?: string | null } | undefined
  if (!model?.datasetId) return null
  const ds = db.prepare('SELECT lineage_verified AS v FROM aml_datasets WHERE id = ?').get(model.datasetId) as { v: number } | undefined
  if (ds && ds.v !== 1) {
    return `模型 ${modelId} 的训练数据集 ${model.datasetId} 谱系未核验(lineage_verified=0);请基于已确认工况段重建数据集并重训后再发布`
  }
  return null
}
