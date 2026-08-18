/**
 * POST /api/system/monitor/terminate —— 终止 harness 进程(防资源浪费)。
 *  - { channelId, agentId }:终止对应 runtime 的进程,且该 AgentRuntime 随之 stop/卸载。
 *  - { pid }:按 PID 终止(孤儿进程;未绑定任何 runtime)。
 * 需要用户 token(管理面)。
 */
import { readBody } from 'h3'
import { AppError } from '../../../utils/errors'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import { resolveUser } from '../../workshop/caller'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const body = await readBody<{ channelId?: string, agentId?: string, pid?: number }>(event)
  if (body?.agentId && body?.channelId) {
    return getWorkshopManager().terminateRuntimeProcess(body.channelId, body.agentId)
  }
  if (typeof body?.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0) {
    return getWorkshopManager().killHarnessProcessByPid(body.pid)
  }
  throw new AppError(400, 'BAD_REQUEST', '需要 { channelId, agentId } 或 { pid }')
})
