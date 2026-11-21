/**
 * POST /api/workshop/agent-prefabs/[id]/publish — 发布不可变 revision（owner/admin，expectedHead CAS）。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { resolveUser } from '../../caller'
import { getWorkshopManager } from '../../../../plugins/workshop'
import { createAgentPrefabService } from '../../../../services/workshop/agent-prefabs/service'
import { AppError } from '../../../../utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = (await readBody<Record<string, unknown>>(event)) ?? {}
  if (!Number.isInteger(body.expectedHead) || (body.expectedHead as number) < 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'expectedHead 必填（并发发布保护）')
  }
  const service = createAgentPrefabService(getWorkshopManager().deps.db)
  const revision = service.publish({ id: user.id, role: user.role }, id, body.expectedHead as number)
  return {
    prefabId: revision.prefabId,
    revision: revision.revision,
    contentHash: revision.contentHash,
    createdAt: revision.createdAt,
    createdBy: revision.createdBy,
  }
})
