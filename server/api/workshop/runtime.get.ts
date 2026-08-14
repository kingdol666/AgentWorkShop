/**
 * GET /api/workshop/runtime —— 运行时装配状态(已装配 agent / 活跃 channel 数)。
 * 前端调试懒加载与内存回收用。
 */
import { defineApiHandler } from '../../utils/response'
import { getWorkshopManager } from '../../plugins/workshop'

export default defineApiHandler(async () => {
  return getWorkshopManager().runtimeStatus()
})
