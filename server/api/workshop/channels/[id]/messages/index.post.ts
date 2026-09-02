/**
 * POST /api/workshop/channels/:id/messages —— 发送消息到 channel 内 agent。
 * 两种优先级:
 *  - immediate:目标 agent 忙碌时实时注入运行中的 omp 会话(steer)
 *  - task(默认):进入目标 agent 的 mailbox 队列,等当前任务结束消费
 * - 可带 fromAgentId(模拟某个 agent 发送);缺省为系统消息
 */
import { z } from 'zod'

import { resolveUser } from '../../../caller'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../utils/validate'
import { defineApiHandler } from '../../../../../utils/response'

import { getWorkshopManager } from '../../../../../plugins/workshop'

const sendMessageSchema = z.object({
  toAgentId: z.string().min(1, 'toAgentId 必填').optional(),
  text: z.string().min(1, 'text 必填'),
  fromAgentId: z.string().optional(),
  /** 人类发送者显示名(时间线 a2a.message 的发送者归属 → x-aw-from-label) */
  fromLabel: z.string().max(120).optional(),
  priority: z.enum(['immediate', 'task']).default('task'),
  /** 触发器:要求接收方回执(执行结果 + 所需内容,in_reply_to 关联) */
  requireReply: z.boolean().optional(),
  /**
   * 跨 Channel 通信(仅 lead):指定目标 channel(id 或名字)→ 消息直投其 lead mailbox。
   * 与 toAgentId 二选一;fromAgentId 必填且必须是本 channel 的 lead(worker 拒绝)。
   */
  toChannelId: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(sendMessageSchema))
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(channel.ownerUserId, user.id, 'channel')

  // 跨 Channel 分支:lead 专属;目标解析(id/名字)与投递在 manager 内完成
  if (body.toChannelId) {
    if (body.toAgentId) {
      throw new AppError(400, 'BAD_REQUEST', 'toChannelId 与 toAgentId 二选一,不可同时指定')
    }
    if (!body.fromAgentId) {
      throw new AppError(403, 'ROLE_FORBIDDEN', '跨 Channel 通信必须以本 channel Leader 身份发送(fromAgentId 必填)')
    }
    const fromAgentId = manager.resolveChannelMember(channelId, body.fromAgentId).id
    return manager.sendCrossChannelMessage(channelId, fromAgentId, {
      toChannelId: body.toChannelId,
      parts: [{ text: body.text }],
      requireReply: body.requireReply,
    })
  }

  if (!body.toAgentId) {
    throw new AppError(400, 'BAD_REQUEST', 'toAgentId 必填(跨 Channel 请改用 toChannelId)')
  }

  // 目标寻址(容错:精确实例 id / 模板 id / 名字 / 唯一名字前缀)
  const target = manager.resolveChannelMember(channelId, body.toAgentId)
  // 发送方身份校验:显式 fromAgentId 必须可解析到本 channel 成员 ——
  // 伪造/已移除成员不再静默降级为人类消息(调用方意图是 agent 身份,降级会造成归属欺骗)
  let fromAgentId = body.fromAgentId
  if (fromAgentId) {
    fromAgentId = manager.resolveChannelMember(channelId, fromAgentId).id
  }

  if (body.priority === 'immediate') {
    return manager.sendImmediateMessage({
      channelId,
      fromAgentId: fromAgentId,
      toAgentId: target.id,
      parts: [{ text: body.text }],
      requireReply: body.requireReply,
      // 无主消息拦截 + 发送人语义:人类消息缺省发送人=登录用户名(时间线"用户章")
      fromLabel: body.fromLabel ?? user.name,
    })
  }
  // task 优先级:经 fromAgentId 身份走 sendA2A;无 fromAgentId 时用 immediate 通道(空闲即入队)
  if (fromAgentId) {
    return manager.sendA2A(channelId, fromAgentId, {
      toAgentId: target.id,
      parts: [{ text: body.text }],
      metadata: {
        'x-aw-msg-priority': 'task',
        ...(body.requireReply ? { 'x-aw-require-reply': 'true' } : {}),
      },
    })
  }
  return manager.sendImmediateMessage({
    channelId,
    fromAgentId: '',
    toAgentId: target.id,
    parts: [{ text: body.text }],
    requireReply: body.requireReply,
    fromLabel: body.fromLabel ?? user.name,
  })
})
