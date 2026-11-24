/** DELETE /api/workshop/agent-prefabs/[id] — 未发布草稿删除，已有版本的预制件归档。 */
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
  const service = createAgentPrefabService(getWorkshopManager().deps.db)
  return service.remove({ id: user.id, role: user.role }, id, body.expectedUpdatedAt)
})
