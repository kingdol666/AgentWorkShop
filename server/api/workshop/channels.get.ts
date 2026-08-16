/**
 * GET /api/workshop/channels —— channel 列表(设计文档 §6.2)。
 */
import { defineApiHandler } from '../../utils/response'
import { resolveUser } from './caller'
import { getWorkshopManager } from '../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getWorkshopManager().listChannelsForUser(user.id)
})
