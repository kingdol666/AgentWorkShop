/**
 * DELETE /api/workshop/channel-templates/:id —— 删除 Channel 模板(不影响已实例化的 channel)。
 * 权限:属主或 admin;内置模板任何人不可删除。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../caller'
import { AppError } from '../../../utils/errors'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const templateId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const tpl = manager.getChannelTemplate(templateId)
  if (!tpl) throw new AppError(404, 'NOT_FOUND', `Channel 模板不存在: ${templateId}`)
  manager.requireWritable(tpl.ownerUserId, user, 'Channel 模板')
  manager.removeChannelTemplate(templateId)
  return { removed: true, templateId }
})
