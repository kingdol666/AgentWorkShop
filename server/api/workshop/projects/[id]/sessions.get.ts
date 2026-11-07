/**
 * GET /api/workshop/projects/:id/sessions —— Project 的 project/task session 目录。
 * 只返回 brief 预览/状态，不返回成员 Channel 原始 transcript。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getProjectService } from '@/server/services/workshop/projects/service'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const projectId = getRouterParam(event, 'id')!
  // 项目读权限（owner/member/admin）由 ProjectService 统一裁决。
  getProjectService().get(projectId, user)
  return getWorkshopManager().listProjectSessionCatalog(projectId)
})
