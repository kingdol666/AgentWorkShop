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
import { AppError } from '../../../../../utils/errors'
import { getWorkshopManager } from '../../../../../plugins/workshop'
const sendMessageSchema = z.object({
  toAgentId: z.string().min(1, 'toAgentId 必填'),
  text: z.string().min(1, 'text 必填'),
  fromAgentId: z.string().optional(),
  priority: z.enum(['immediate', 'task']).default('task'),
  /** 触发器:要求接收方回执(执行结果 + 所需内容,in_reply_to 关联) */
  requireReply: z.boolean().optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, zValidator(sendMessageSchema))
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(channel.ownerUserId, user.id, 'channel')

  // 目标 agent 必须在本 channel
  const agents = await manager.listChannelAgents(channelId)
  const target = agents.find(a => a.id === body.toAgentId)
  if (!target) throw new AppError(404, 'NOT_FOUND', `目标 agent 不在本 channel: ${body.toAgentId}`)

  if (body.priority === 'immediate') {
    return manager.sendImmediateMessage({
      channelId,
      fromAgentId: body.fromAgentId,
      toAgentId: body.toAgentId,
      parts: [{ text: body.text }],
      requireReply: body.requireReply,
    })
  }
  // task 优先级:经 fromAgentId 身份走 sendA2A;无 fromAgentId 时用 immediate 通道(空闲即入队)
  if (body.fromAgentId) {
    return manager.sendA2A(channelId, body.fromAgentId, {
      toAgentId: body.toAgentId,
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
    toAgentId: body.toAgentId,
    parts: [{ text: body.text }],
    requireReply: body.requireReply,
  })
})
