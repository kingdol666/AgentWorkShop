/**
 * POST /api/workshop/memories/maintenance —— 手动触发记忆衰减清理(lead)。
 * - 需要 Bearer token;仅 lead 可触发(403 SCOPE_VIOLATION)
 * - 与定时器同一策略函数,返回 { deletedExpired, evicted, cleanedVec }
 */
import { AppError } from '../../../utils/errors'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import { resolveCaller } from '../caller'

export default defineApiHandler(async (event) => {
  const caller = resolveCaller(event)
  if (caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可触发记忆维护')
  return getWorkshopManager().runMemoryMaintenanceNow()
})
