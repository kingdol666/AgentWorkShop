/**
 * GET /api/workshop/agent-tools/list?agentId= —— 工具面 schema(stdio MCP 桥 tools/list 源)。
 * 按 agent 角色装配(host-tools.json + 插件工具),与 omp set_host_tools 注入面同源。
 * 鉴权:agent token(x-aw-agent-token)自证;仪表盘用户路径必须可读该 Agent 所属 Channel
 * (admin / owner / 成员),与 invoke 的授权口径对齐 —— 登录不等于可读取任意 Agent 的
 * 绑定节点/配方描述(C15 提权泄漏修复)。
 *
 * WP6:响应带 ETag(工具面签名)。桥轮询带 If-None-Match 时命中 → 304 空体,
 * 无变更时不再传输整张工具面(含 per-agent 绑定描述)。
 */
import { createHash } from 'node:crypto'
import { getQuery, getHeader, setHeader, setResponseStatus, defineEventHandler } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { getWorkshopManager } from '@/server/plugins/workshop'

/** 稳定序列化(键排序;数组保序)+ 弱 ETag */
function weakEtagOf(tools: unknown): string {
  const stable = JSON.stringify(tools, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map(k => [k, (v as Record<string, unknown>)[k]]))
    }
    return v
  })
  return `W/"${createHash('sha256').update(stable).digest('hex').slice(0, 32)}"`
}

export default defineEventHandler(async (event) => {
  try {
    const agentToken = getHeader(event, 'x-aw-agent-token')
    const user = agentToken ? null : resolveUser(event)
    const q = getQuery(event)
    const agentId = String(q.agentId ?? '')
    if (!agentId) throw new AppError(400, 'BAD_REQUEST', 'agentId required')
    const manager = getWorkshopManager()
    if (agentToken) {
      const resolved = manager.resolveAgentByToken(String(agentToken))
      if (!resolved || resolved.agentId !== agentId) {
        throw new AppError(401, 'UNAUTHORIZED', 'agent token 校验失败')
      }
    }
    else if (user) {
      const row = manager.deps.repos.channelAgents.findById(agentId)
      if (!row) throw new AppError(404, 'NOT_FOUND', `agent 不存在: ${agentId}`)
      const permissions = manager.channelPermissionsOf(row.channelId, user)
      if (!permissions.isAdmin && !permissions.isMember) {
        throw new AppError(403, 'SCOPE_VIOLATION', '该 Agent 所属 Channel 对你不可见,无权读取其工具面')
      }
    }
    const tools = manager.hostToolDefsFor(agentId)
    const etag = weakEtagOf(tools)
    setHeader(event, 'ETag', etag)
    setHeader(event, 'Cache-Control', 'no-cache')
    const inm = String(getHeader(event, 'if-none-match') ?? '')
    if (inm && inm.split(',').map(s => s.trim()).includes(etag)) {
      setResponseStatus(event, 304)
      return null
    }
    return { code: 0, message: 'ok', data: { tools } }
  }
  catch (error) {
    if (error instanceof AppError) {
      setResponseStatus(event, error.status)
      return { code: error.code, message: error.message, data: null }
    }
    const status = Number((error as { statusCode?: number })?.statusCode ?? 500)
    setResponseStatus(event, status)
    return { code: status === 401 ? 'UNAUTHORIZED' : 'REQUEST_ERROR', message: (error as Error)?.message ?? '请求失败', data: null }
  }
})
