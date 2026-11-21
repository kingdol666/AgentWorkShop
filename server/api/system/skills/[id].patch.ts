/**
 * PATCH /api/system/skills/[id] — 启用/停用受管 revision（仅 admin）。
 * body: { enabled: boolean }；id 为 `name@hashPrefix`。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { AppError } from '../../../utils/errors'
import { createSkillService } from '../../../services/workshop/skills/service'
import { recordOps } from '../../../services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin'])
  const id = getRouterParam(event, 'id') ?? ''
  const body = (await readBody<Record<string, unknown>>(event)) ?? {}
  if (typeof body.enabled !== 'boolean') throw new AppError(400, 'VALIDATION_ERROR', 'enabled 必须是 boolean')
  const revision = createSkillService().setEnabled(id, body.enabled, user.id)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'system.skills.status',
    kind: 'system',
    targetKind: 'skill',
    targetId: revision.id,
    summary: `${body.enabled ? '启用' : '停用'} Skill revision ${revision.name}@${revision.contentHash.slice(0, 12)}`,
  })
  return revision
})
