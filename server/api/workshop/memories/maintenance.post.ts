/**
 * POST /api/workshop/memories/maintenance —— 手动触发记忆衰减清理。
 *
 * 2026-11-26（记忆中心批次 0）：本操作是**全局副作用**（遍历所有 agent / 所有 channel 的
 * 过期与容量淘汰），此前任意 channel 的 lead 用一个 agent token 就能触发，缺 channel 级隔离。
 * 收紧为**管理员用户会话**：Agent token 一律拒绝；非 admin 用户 403。
 * 定时器路径不受影响（仍是同一策略函数，由服务端自行调度）。
 */
import { AppError } from '../../../utils/errors'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import { resolveUser } from '../caller'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  if (user.role !== 'admin') {
    throw new AppError(403, 'ADMIN_REQUIRED', '全局记忆维护仅管理员可触发（该操作作用于所有 Channel）')
  }
  return getWorkshopManager().runMemoryMaintenanceNow()
})
