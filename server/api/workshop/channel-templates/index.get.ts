/**
 * GET /api/workshop/channel-templates —— 可见性感知的 Channel 模板列表。
 * 普通用户:本人(任意可见性)+ 全部 public(含内置);admin:全量(附创建者名)。
 */
import { defineApiHandler } from '../../../utils/response'
import { resolveUser, withOwnerNames } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const templates = getWorkshopManager().listChannelTemplatesVisibleTo(user)
  return withOwnerNames(templates)
})
