/**
 * GET /api/workshop/agents —— 全部 Agent 定义(全局,跨 channel 复用)。
 */
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async () => {
  return getWorkshopManager().listAgents()
})
