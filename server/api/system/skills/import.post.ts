/**
 * POST /api/system/skills/import — 从发现目录导入不可变受管 revision（仅 admin）。
 * body: { catalogId: string }；不接受客户端文件系统路径。
 * 导入默认未启用；启用走 PATCH。
 */
import { readBody } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { AppError } from '../../../utils/errors'
import { createSkillService } from '../../../services/workshop/skills/service'
import { recordOps } from '../../../services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin'])
  const body = (await readBody<Record<string, unknown>>(event)) ?? {}
  const catalogId = typeof body.catalogId === 'string' ? body.catalogId.trim() : ''
  if (!catalogId) throw new AppError(400, 'VALIDATION_ERROR', 'catalogId 必填')
  const result = await createSkillService().importFromCatalog(catalogId, user.id)
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'system.skills.import',
    kind: 'system',
    targetKind: 'skill',
    targetId: result.revision.id,
    summary: `导入 Skill revision ${result.revision.name}@${result.revision.contentHash.slice(0, 12)}${result.existing ? '（已存在）' : ''}`,
  })
  return result
})
