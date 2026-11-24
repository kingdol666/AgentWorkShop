/**
 * GET /api/workshop/agent-prefabs — 当前用户可见的 AgentPrefab（私有本人 / public / admin 全量）。
 * 返回草稿解析结果；不含任何 secret。
 */
import { defineApiHandler } from '../../../utils/response'
import { resolveUser } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'
import { canEditAgentPrefab, createAgentPrefabService } from '../../../services/workshop/agent-prefabs/service'

function draftOf(row: { draftJson: string }): unknown {
  try {
    return JSON.parse(row.draftJson)
  }
  catch {
    return null
  }
}

export default defineApiHandler((event) => {
  const user = resolveUser(event)
  const actor = { id: user.id, role: user.role }
  const service = createAgentPrefabService(getWorkshopManager().deps.db)
  return {
    prefabs: service.list(actor).map(row => ({ ...row, canEdit: canEditAgentPrefab(row, actor), draft: draftOf(row) })),
  }
})
