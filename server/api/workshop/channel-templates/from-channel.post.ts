/**
 * POST /api/workshop/channel-templates/from-channel —— 从当前 Channel 实例捕获为模板。
 * 捕获:场景 prompt + 工作目录 + lead(内联快照)+ 成员(有模板引用则引用,否则内联快照)。
 * 权限:channel 属主或 admin。
 */
import { z } from 'zod'
import { resolveUser } from '../caller'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

const captureSchema = z.object({
  channelId: z.string().min(1, 'channelId 必填'),
  name: z.string().min(1, '模板名必填'),
  description: z.string().optional(),
  visibility: z.enum(['private', 'public']).optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(captureSchema))
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(body.channelId, user.id)
  manager.requireWritable(channel.ownerUserId, user, 'channel')
  return manager.createChannelTemplateFromChannel(body.channelId, {
    name: body.name,
    description: body.description,
    visibility: body.visibility,
  }, user.id)
})
