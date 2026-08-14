/**
 * GET /api/workshop/mailbox —— 拉取 caller 自己的未消费消息(REST 作业面,与 MCP workshop.a2a.poll 同语义)。
 * - 需要 Bearer token;返回 mailbox 中 pending 消息(不改状态,消费由 AgentRuntime 循环完成)
 */
import { defineApiHandler } from '../../utils/response'
import { getWorkshopManager } from '../../plugins/workshop'
import { resolveCaller } from './caller'

export default defineApiHandler(async (event) => {
  const caller = resolveCaller(event)
  const url = new URL(event.path, 'http://localhost')
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10)
  return getWorkshopManager().pollMailbox(caller.channelId, caller.id, Number.isFinite(limit) && limit > 0 ? limit : 50)
})
