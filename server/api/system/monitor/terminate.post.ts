/**
 * POST /api/system/monitor/terminate —— 终止 harness 进程(防资源浪费;用户级隔离)。
 *  - { channelId, agentId }:终止对应 runtime 的进程;channel 须为本人或 admin。
 *  - { pid }:按 PID 终止;绑定 channel 的进程须本人/admin,未绑定孤儿进程仅 admin。
 * 需要用户 token(管理面)。
 */
import { readBody } from 'h3'
import { AppError } from '../../../utils/errors'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import { resolveUser } from '../../workshop/caller'
import { listHarnessProcesses } from '../../../services/workshop/agents/harness-process'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ channelId?: string, agentId?: string, pid?: number }>(event)
  const manager = getWorkshopManager()
  if (body?.agentId && body?.channelId) {
    const ch = manager.getChannelForUser(body.channelId, user.id)
    manager.requireWritable(ch.ownerUserId, user, 'channel')
    return manager.terminateRuntimeProcess(body.channelId, body.agentId)
  }
  if (typeof body?.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0) {
    // 进程归属判定:绑定的 channel 须本人/admin;未绑定(孤儿)仅 admin 可杀
    const entry = listHarnessProcesses().find(p => p.pid === body.pid)
    if (entry?.channelId) {
      const ch = manager.getChannelForUser(entry.channelId, user.id)
      manager.requireWritable(ch.ownerUserId, user, 'channel')
    }
    else if (user.role !== 'admin') {
      throw new AppError(403, 'ADMIN_REQUIRED', '孤儿进程终止需要管理员权限')
    }
    return manager.killHarnessProcessByPid(body.pid)
  }
  throw new AppError(400, 'BAD_REQUEST', '需要 { channelId, agentId } 或 { pid }')
})
