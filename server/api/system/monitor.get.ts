/**
 * GET /api/system/monitor —— 运行时资源监控快照。
 * 返回已装配的 ChannelRuntime / AgentRuntime + 全部已启动的 harness 进程(含孤儿),
 * 以及服务端进程 pid/uptime。需要用户 token(管理面)。
 */
import { defineApiHandler } from '../../utils/response'
import { resolveUser } from '../workshop/caller'
import { getWorkshopManager } from '../../plugins/workshop'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  return getWorkshopManager().monitorRuntime()
})
