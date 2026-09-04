/**
 * GET /api/workshop/hitl/pending?channelId= —— 全局待人工处理快照。
 *
 * 统一视图:omp ask 对话框(hitl-registry 的 omp-dialog)+ dcw 工具审批
 * (dcw-approval)。WebUI 全局徽标与 TUI /hitl 命令共用;实时增量走 AEP
 * hitl.request/hitl.resolved 帧,本端点为快照对齐/恢复入口。
 *
 * 鉴权:用户 token;按 channel 所有权过滤(listChannelsForUser 同口径),
 * channelId 查询参数等价于单频道过滤。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getHitlRegistry } from '@/server/services/workshop/agents/hitl-registry'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const channelId = typeof q.channelId === 'string' ? q.channelId : ''

  const manager = getWorkshopManager()
  const visible = new Set(manager.listChannelsForUser(user.id).map(c => c.id))
  const items = getHitlRegistry()
    .snapshot(channelId || undefined)
    .filter(i => visible.has(i.channelId))
  return { items }
})
