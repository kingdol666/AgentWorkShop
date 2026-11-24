/**
 * POST /api/workshop/agent-prefabs — 创建 AgentPrefab 草稿（归当前用户）。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { resolveUser } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'
import { createAgentPrefabService } from '../../../services/workshop/agent-prefabs/service'
import { AppError } from '../../../utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = (await readBody<Record<string, unknown>>(event)) ?? {}
  if (!body.draft || typeof body.draft !== 'object') throw new AppError(400, 'VALIDATION_ERROR', 'draft 必填')
  const service = createAgentPrefabService(getWorkshopManager().deps.db)
  const row = service.create({ id: user.id, role: user.role }, body.draft)
  return { ...row, canEdit: true, draft: JSON.parse(row.draftJson) }
})
