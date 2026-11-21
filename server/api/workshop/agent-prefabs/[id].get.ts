/**
 * GET /api/workshop/agent-prefabs/[id] — 草稿 + 发布 revision 列表（可见性校验）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { resolveUser } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'
import { createAgentPrefabService } from '../../../services/workshop/agent-prefabs/service'

export default defineApiHandler((event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const service = createAgentPrefabService(getWorkshopManager().deps.db)
  const row = service.get({ id: user.id, role: user.role }, id)
  return {
    ...row,
    draft: JSON.parse(row.draftJson),
    revisions: service.repo.listRevisions(id).map(r => ({
      revision: r.revision,
      contentHash: r.contentHash,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
    })),
  }
})
