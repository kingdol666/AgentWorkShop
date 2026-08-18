/**
 * GET /api/workshop/mailbox/all —— (仅 lead)Channel 邮件全览:REST 作业面,与 MCP workshop.mail.list 同语义。
 * 返回全部 agent 间消息(含已消费/任务投递),按时间倒序;可选 agentId 过滤参与方。
 * - 需要 Bearer token(caller 由 token 决定);非 lead 调用 → 403 SCOPE_VIOLATION(manager 校验)
 */
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import { resolveCaller } from '../caller'

export default defineApiHandler(async (event) => {
  const caller = resolveCaller(event)
  const url = new URL(event.path, 'http://localhost')
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
  const agentId = url.searchParams.get('agentId') ?? undefined
  return getWorkshopManager().listChannelMail(caller.channelId, caller.id, {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
    agentId,
  })
})
