/**
 * GET /api/workshop/channels/:id/terminals —— Channel 成员的 harness 终端会话列表。
 *
 * Agent lanes 控制面板的数据源:每个成员的 omp rpc-ui 终端镜像会话
 * (pid / 存活 / 回合·流式状态)。omp lazy spawn —— 未出现在列表中的成员
 * 表示其 harness 进程尚未启动(等待首个任务);前端用 agentId 寻址连接
 * WS,进程重启后自动落到新会话。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../../caller'
import { getWorkshopManager } from '../../../../plugins/workshop'
import { defineApiHandler } from '../../../../utils/response'
import { listTerminalSessions } from '../../../../services/workshop/agents/harness-terminal'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  manager.getChannelForUser(channelId, user.id)
  return listTerminalSessions(channelId)
})
