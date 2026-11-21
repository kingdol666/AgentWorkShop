/**
 * GET /api/system/skills — 受管 Skill revision 清单 + 发现根（admin/editor 只读）。
 * 不返回 Skill 正文或任何 secret；完整内容通过受控 file 端点按需读取。
 */
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { createSkillService } from '../../../services/workshop/skills/service'

export default defineApiHandler((event) => {
  requireRole(event, ['admin', 'editor'])
  const service = createSkillService()
  return { managed: service.listManaged(), roots: service.roots() }
})
