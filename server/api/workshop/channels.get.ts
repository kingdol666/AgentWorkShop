/**
 * GET /api/workshop/channels —— channel 列表(设计文档 §6.2)。
 */
import { defineApiHandler } from '../../utils/response'
import { getWorkshopManager } from '../../plugins/workshop'

export default defineApiHandler(async () => {
  return getWorkshopManager().listChannels()
})
