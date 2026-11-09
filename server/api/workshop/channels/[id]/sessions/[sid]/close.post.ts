/**
 * POST /api/workshop/channels/:id/sessions/:sid/close —— 关闭会话（级联终结）。
 * body: { reason? }。语义：会话克隆实例的在飞任务按树取消 + 实例停用（runtime 卸载）
 * + 会话 closed（终态）。基础成员与其它会话不受影响。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

const schema = z.object({ reason: z.string().max(300).optional() })

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  // 空 body 合法:同 sessions/index.post.ts,不用 catch 吞掉 reason>300 的校验错误
  const body = await readValidatedBody(event, zValidator(schema.default({})))
  return getWorkshopManager().closeChannelSession({
    channelId,
    sessionId,
    actor: { id: user.id, role: user.role },
    reason: body.reason,
  })
})
