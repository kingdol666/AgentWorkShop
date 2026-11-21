/**
 * GET /api/system/skills/[id]/file?path=references/x.md — 受控读取受管 revision 内文本资源。
 * 仅 admin/editor；路径穿越/symlink/二进制/超限一律拒绝。
 */
import { getQuery, getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { requireRole } from '../../../workshop/caller'
import { AppError } from '../../../../utils/errors'
import { createSkillService } from '../../../../services/workshop/skills/service'

export default defineApiHandler((event) => {
  requireRole(event, ['admin', 'editor'])
  const id = getRouterParam(event, 'id') ?? ''
  const query = getQuery(event)
  const relativePath = typeof query.path === 'string' ? query.path.trim() : ''
  if (!relativePath) throw new AppError(400, 'VALIDATION_ERROR', 'path 必填')
  return { path: relativePath, text: createSkillService().readFile(id, relativePath) }
})
