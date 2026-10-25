/**
 * GET /api/workshop/process-model/specs —— ProcessModelSpec 列表(产线可见性过滤)。
 * POST —— 校验并登记 draft(不改已发布版本;修改 = 新版本)。
 */
import { readBody, getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { filterByLine, requireLineMode } from '@/server/services/workshop/permissions'
import { recordOps } from '@/server/services/workshop/ops/ops'
import { parseProcessModelSpec } from '@/server/services/workshop/process-model/spec'
import { getProcessModelSpecRepo, parseSpecRow } from '@/server/services/workshop/process-model/spec.repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const method = event.method?.toUpperCase() ?? 'GET'
  if (method === 'GET') {
    const q = getQuery(event)
    const lineId = typeof q.lineId === 'string' ? q.lineId : undefined
    const rows = getProcessModelSpecRepo().list({ lineId, status: typeof q.status === 'string' ? q.status : undefined, limit: 200 })
    const visible = filterByLine(user, rows, r => r.lineId)
    return { specs: visible.map(r => ({ ...r, spec: parseSpecRow(r) })) }
  }
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const spec = parseProcessModelSpec(body)
  requireLineMode(user, spec.lineId, 'readonly')
  const row = getProcessModelSpecRepo().insert(spec, { ownerUserId: user.id })
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'process_model.spec.create', kind: 'system',
    summary: `登记 ProcessModelSpec ${spec.id}@${spec.version}(trainer=${spec.trainer.ref})`,
    targetKind: 'process_model_spec', targetId: `${spec.id}@${spec.version}`, lineId: spec.lineId,
  })
  return { spec: row }
})
