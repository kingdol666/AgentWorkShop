/**
 * GET /api/workshop/project-blueprints —— 当前用户可见的蓝图模板清单（owner 私有 + admin 全量）。
 */
import { resolveUser } from '../caller'
import { defineApiHandler } from '../../../utils/response'
import { createProjectBlueprintRepo } from '../../../services/workshop/projects/blueprints.repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const repo = createProjectBlueprintRepo()
  const rows = repo.list(user.id, user.role)
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    ownerUserId: r.ownerUserId,
    channels: (r.blueprint.channels ?? []).map(c => c.key),
    objective: r.blueprint.objective,
    routingPolicy: r.blueprint.routingPolicy ?? 'technical',
    planApprovalRequired: r.blueprint.planApprovalRequired !== false,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
})
