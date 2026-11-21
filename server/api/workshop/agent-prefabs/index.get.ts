/**
 * GET /api/workshop/agent-prefabs — 当前用户可见的 AgentPrefab（私有本人 / public / admin 全量）。
 * 返回草稿解析结果；不含任何 secret。
 */
import { defineApiHandler } from '../../../utils/response'
import { resolveUser } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'
import { createAgentPrefabService } from '../../../services/workshop/agent-prefabs/service'

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
  const service = createAgentPrefabService(getWorkshopManager().deps.db)
  return {
    prefabs: service.list({ id: user.id, role: user.role }).map(row => ({ ...row, draft: draftOf(row) })),
  }
})
