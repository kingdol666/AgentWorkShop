/**
 * POST /api/workshop/channels/:id/agents/:agentId/rotate-token —— 轮换 Agent 实例 token(WP3)。
 *
 * 权限:channel 属主或 admin(requireWritable,与 Agent 实例管理面同口径)。
 * 语义:新 token 立即生效;旧 token 进入宽限窗(缺省 60s,env AW_TOKEN_GRACE_MS 可调),
 *      窗内四路调用点(桥 invoke / 桥 list / 面A Bearer / manager)双接受,桥进程自动重连过渡。
 * 响应:仅本次一次性返回全量新 token(与仪表盘 tokenTail 策略配套;全量不在列表/详情回显)。
 * 审计:agent.token.rotate(targetId=agentId,detail 不含 token 明文)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(ch.ownerUserId, user, 'channel')
  if (!agentId) throw new AppError(400, 'BAD_REQUEST', 'agentId 必填')
  const rotated = manager.rotateChannelAgentToken(channelId, agentId)
  recordOps({
    actor: user.id,
    actorName: user.name ?? '',
    actorKind: 'user',
    action: 'agent.token.rotate',
    kind: 'system',
    level: 'warn',
    targetKind: 'agent',
    targetId: agentId,
    summary: `轮换 Agent token(宽限至 ${rotated.prevTokenUntil})`,
    detail: { channelId, agentId, prevTokenUntil: rotated.prevTokenUntil },
  })
  return {
    agentId: rotated.agentId,
    channelId: rotated.channelId,
    token: rotated.token,
    prevTokenUntil: rotated.prevTokenUntil,
    note: '全量 token 仅此一次返回;旧 token 在 prevTokenUntil 前仍可用(桥进程重连过渡),之后彻底失效。',
  }
})
