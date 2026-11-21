/**
 * DELETE /api/system/skills/[id] — 删除受管 revision（仅 admin）。
 * 删除后已固定引用会失效（fail closed）；不触碰源目录。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { createSkillService } from '../../../services/workshop/skills/service'
import { recordOps } from '../../../services/workshop/ops/ops'

export default defineApiHandler((event) => {
  const user = requireRole(event, ['admin'])
  const id = getRouterParam(event, 'id') ?? ''
  const service = createSkillService()
  const revision = service.findManaged(id)
  service.remove(id)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'system.skills.remove',
    kind: 'system',
    targetKind: 'skill',
    targetId: revision.id,
    summary: `删除 Skill revision ${revision.name}@${revision.contentHash.slice(0, 12)}`,
  })
  return { ok: true, id: revision.id }
})
