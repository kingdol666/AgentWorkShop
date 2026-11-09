/**
 * POST /api/workshop/channels/:id/sessions —— 一键创建会话（克隆基础成员 + 复制绑定面）。
 * body: { title? }；返回 { sessionId, members }。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

const schema = z.object({ title: z.string().max(120).optional() })

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  // 空 body 合法(标题可缺省):把"未提供"收敛进 schema,而不是 catch 掉校验错误。
  // 旧写法 .catch(() => ({ title: undefined })) 会把 title>120 一并吞成"无标题",
  // 用户提交的超长标题被静默改名为随机默认标题。
  const body = await readValidatedBody(event, zValidator(schema.default({})))
  return getWorkshopManager().createChannelSession({
    channelId,
    actor: { id: user.id, role: user.role },
    title: body.title,
  })
})
