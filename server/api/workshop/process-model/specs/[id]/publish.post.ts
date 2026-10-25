/**
 * POST /api/workshop/process-model/specs/:id/publish?version= —— 发布(不可变)。
 * 归属:产线可见性(readonly grant);拒绝走统一审计(D16)。
 */
import { getQuery, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { getProcessModelSpecRepo, parseSpecRow } from '@/server/services/workshop/process-model/spec.repo'
import { assertOptimizationAccess, recordConfigAction } from '@/server/services/workshop/optimization/access'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const id = getRouterParam(event, 'id') ?? ''
  const q = getQuery(event)
  const row = getProcessModelSpecRepo().get(id, typeof q.version === 'string' ? Number(q.version) : undefined)
  if (!row) throw createError({ statusCode: 404, statusMessage: `ProcessModelSpec ${id} 不存在` })
  assertOptimizationAccess(user, 'publish', { kind: 'spec', id, version: row.version })
  const published = getProcessModelSpecRepo().publish(id, row.version)
  recordConfigAction(user, 'process_model.spec.publish', { kind: 'process_model_spec', id: `${id}@${published.version}` },
    `发布 ProcessModelSpec ${id}@${published.version}`, { lineId: row.lineId, contentHash: row.contentHash }, row.lineId)
  return { spec: published, parsed: parseSpecRow(published), by: user.id }
})
