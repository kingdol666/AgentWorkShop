/**
 * POST /api/workshop/agent-tools/invoke —— 工具调用 HTTP 桥。
 * 全量 host tool 分发(协作/任务/记忆/工业全族,与 omp set_host_tools 同源):
 * manager.invokeHostTool → impl.dispatchHostTool(共享 host-tool-bridge)。
 *
 * 鉴权(双通道,**两条都必须自证身份**):
 *  - agent 自证:x-aw-agent-token 头(channel_agents.token)→ 该 token 必须属于
 *    body.agentId 本身,否则 401(与 list.get.ts 同口径);
 *  - 仪表盘用户:authorization Bearer(resolveUser)→ 必须能访问该 agent 所属 channel
 *    (channel 属主,或 admin),否则 403。
 * 早先用户路径只做 resolveUser 就把 body.agentId 透传给 manager.invokeHostTool,
 * 而 manager 的 token 校验是 `input.token !== undefined` 才生效 —— 不带 agent token 时
 * 校验被整段跳过,于是**任意登录用户可冒用任意 agent 调工具**(继承其节点绑定与 channel)。
 * body: { agentId, tool, args }
 */
import { readBody, getHeader } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const agentToken = getHeader(event, 'x-aw-agent-token')
  // 用户路径:必须校验「该用户可支配该 agent」(桥路径由 token 自证兜底)
  let user = null
  if (!agentToken) user = resolveUser(event)
  const body = await readBody<{ agentId?: string, tool?: string, args?: Record<string, unknown> }>(event) ?? {}
  const agentId = String(body.agentId ?? '')
  const tool = String(body.tool ?? '')
  const args = body.args ?? {}
  if (!agentId) throw createError({ statusCode: 400, statusMessage: 'agentId required' })
  if (!tool) throw createError({ statusCode: 400, statusMessage: 'tool required' })
  const manager = getWorkshopManager()
  if (agentToken) {
    const resolved = manager.resolveAgentByToken(String(agentToken))
    if (!resolved || resolved.agentId !== agentId) {
      throw new AppError(401, 'UNAUTHORIZED', 'agent token 校验失败(与 agentId 不匹配)')
    }
  }
  else if (user) {
    const row = manager.deps.repos.channelAgents.findById(agentId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `agent 不存在: ${agentId}`)
    if (user.role !== 'admin') {
      const channel = manager.deps.repos.channels.findById(row.channelId)
      if (!channel || channel.ownerUserId !== user.id) {
        throw new AppError(403, 'SCOPE_VIOLATION', '该 agent 不属于当前用户,无权代为调用其工具')
      }
    }
  }
  const result = await manager.invokeHostTool({ agentId, tool, args, token: agentToken || undefined })
  return { result }
})
