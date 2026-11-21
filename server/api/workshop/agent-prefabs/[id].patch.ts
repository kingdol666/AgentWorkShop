/**
 * PATCH /api/workshop/agent-prefabs/[id] — 更新草稿（owner/admin，expectedUpdatedAt CAS）。
 * 已发布 revision 不受影响。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { resolveUser } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'
import { createAgentPrefabService } from '../../../services/workshop/agent-prefabs/service'
import { AppError } from '../../../utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = (await readBody<Record<string, unknown>>(event)) ?? {}
  if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt) {
    throw new AppError(400, 'VALIDATION_ERROR', 'expectedUpdatedAt 必填（并发编辑保护）')
  }
  if (!body.draft || typeof body.draft !== 'object') throw new AppError(400, 'VALIDATION_ERROR', 'draft 必填')
  const service = createAgentPrefabService(getWorkshopManager().deps.db)
  const row = service.update({ id: user.id, role: user.role }, id, body.expectedUpdatedAt, body.draft)
  return { ...row, draft: JSON.parse(row.draftJson) }
})
