/**
 * POST /api/workshop/channels/:id/chat/messages —— 群聊发言(唯一入站口)。
 *
 * 契约(主计划 §5):
 *   body: { text, mentions?, replyToId?, clientMessageId }
 *   返回: { message, deliveries: [{deliveryId, agentId, status}] }
 *
 * 鉴权:requireChannelMember + chatEnabled(非成员 403 / 未开启群聊 409)。
 * 服务端**重新解析**文本与 mentions,并确认目标属于当前 Channel(非法 → 400)。
 * 重复 clientMessageId → 返回原消息,不重复投递(duplicates=true)。
 *
 * Agent 执行次数严格等于去重后的 agent mention 数:
 * 无 @ 或仅 @用户 → 0 次(绝不用默认 Leader 兜底)。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { assertNotMojibake } from '@/server/utils/mojibake-guard'
import { getWorkshopManager } from '@/server/plugins/workshop'

const mentionSchema = z.object({
  type: z.enum(['user', 'agent']),
  id: z.string().min(1),
  label: z.string().max(120).optional(),
})

const sendChatSchema = z.object({
  text: z.string().min(1, 'text 必填').max(8000),
  /** 客户端意图提示;服务端逐个校验归属(非法 → 不投递,记入 unresolvedMentions) */
  mentions: z.array(mentionSchema).max(50).optional(),
  replyToId: z.string().min(1).nullable().optional(),
  /** 幂等键(客户端生成,建议 crypto.randomUUID());缺省由服务端生成 */
  clientMessageId: z.string().min(1).max(200).optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(sendChatSchema))
  assertNotMojibake(body.text, { source: '群聊文本' })
  const manager = getWorkshopManager()
  const result = manager.sendChatMessage(channelId, user, {
    text: body.text,
    mentions: body.mentions,
    replyToId: body.replyToId ?? null,
    clientMessageId: body.clientMessageId,
  })
  return result
})
