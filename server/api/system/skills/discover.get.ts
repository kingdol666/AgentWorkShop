/**
 * GET /api/system/skills/discover — 只读扫描内置/全局/配置根（admin/editor）。
 * 发现结果只含元数据与诊断，不执行任何 Skill 内容。
 */
import { defineApiHandler } from '../../../utils/response'
import { requireRole } from '../../workshop/caller'
import { createSkillService } from '../../../services/workshop/skills/service'

export default defineApiHandler(async (event) => {
  requireRole(event, ['admin', 'editor'])
  const service = createSkillService()
  return { discovered: await service.discover() }
})
