/**
 * POST /api/workshop/channels/:id/sessions —— 一键创建会话（克隆基础成员 + 复制绑定面）。
 * body: { title?, memoryPolicy? }；返回 { sessionId, members }。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

const schema = z.object({
  title: z.string().max(120).optional(),
  /**
   * 会话记忆策略:session=只在本文会话语境内召回/写入(默认);
   * shared=允许该会话的 Agent 把经验写入 line/global(跨频道复用)。
   * 旧实现只接了消费端(写入门按策略判定),生产端从不传 → 永远 session,
   * 跨频道经验写入整条链路不可达。
   */
  memoryPolicy: z.enum(['session', 'shared']).optional(),
})

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
    memoryPolicy: body.memoryPolicy,
  })
})
