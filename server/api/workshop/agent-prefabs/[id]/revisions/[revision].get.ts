/**
 * GET /api/workshop/agent-prefabs/[id]/revisions/[revision] — 读取指定不可变 revision 的快照。
 * 用于绑定历史 revision 前展示 prompt slots；可见性同 prefab。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { resolveUser } from '../../../caller'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { createAgentPrefabService } from '../../../../../services/workshop/agent-prefabs/service'
import { AppError } from '../../../../../utils/errors'

export default defineApiHandler((event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const revision = Number(getRouterParam(event, 'revision'))
  if (!Number.isInteger(revision) || revision < 1) throw new AppError(400, 'VALIDATION_ERROR', 'revision 非法')
  const service = createAgentPrefabService(getWorkshopManager().deps.db)
  service.get({ id: user.id, role: user.role }, id)
  const loaded = service.loadRevision(id, revision)
  if (!loaded) throw new AppError(404, 'NOT_FOUND', `AgentPrefab revision 不存在：${id}@${revision}`)
  return {
    prefabId: id,
    revision,
    contentHash: loaded.revision.contentHash,
    createdAt: loaded.revision.createdAt,
    createdBy: loaded.revision.createdBy,
    draft: loaded.draft,
  }
})
