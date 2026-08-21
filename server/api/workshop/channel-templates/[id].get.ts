/**
 * GET /api/workshop/channel-templates/:id —— Channel 模板详情。
 * 可见性:属主 / public(含内置)/ admin;他人 private → 403。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../caller'
import { AppError } from '../../../utils/errors'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const templateId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const tpl = manager.getChannelTemplate(templateId)
  if (!tpl) throw new AppError(404, 'NOT_FOUND', `Channel 模板不存在: ${templateId}`)
  const user = resolveUser(event)
  manager.requireTemplateReadable(tpl, user, 'Channel 模板')
  return tpl
})
