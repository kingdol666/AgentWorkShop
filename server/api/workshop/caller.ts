/**
 * REST 作业面共享认证 — Bearer token → caller Agent。
 * 与 MCP 工具同一语义(manager.findByToken):Agent 经 REST 调用时,
 * 所有查询/通信按 caller 的 channelId 作用域过滤(跨 channel 一律 SCOPE_VIOLATION)。
 */
import { getRequestHeader } from 'h3'
import type { H3Event } from 'h3'
import { AppError } from '../../utils/errors'
import { getWorkshopManager } from '../../plugins/workshop'
import type { AgentInfo } from '../../services/workshop/agents/agent-interface'
import type { UserRow } from '../../services/workshop/db/database'

/** 从 Authorization: Bearer <token> 解析 caller;缺失/无效 → 401 */
export function resolveCaller(event: H3Event): AgentInfo {
  const auth = getRequestHeader(event, 'authorization')
  const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const caller = token ? getWorkshopManager().findByToken(token) : undefined
  if (!caller) {
    throw new AppError(401, 'UNAUTHORIZED', '需要有效的 Agent token(Authorization: Bearer <token>)')
  }
  return caller
}

/** 可选 caller:有有效 token 则返回,否则 undefined(管理面路径用) */
export function resolveCallerOrNull(event: H3Event): AgentInfo | null {
  try {
    return resolveCaller(event)
  }
  catch {
    return null
  }
}

/**
 * 用户面认证 — Bearer <用户 token> → UserRow。
 * 管理面(channels/agents/teams/tasks/messages/workspaces)强制用户身份:
 * Agent 实例 token 与用户 token 分属两个域,互不通用。
 */
export function resolveUser(event: H3Event): UserRow {
  const auth = getRequestHeader(event, 'authorization')
  const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const user = token ? getWorkshopManager().getUserByToken(token) : null
  if (!user) {
    throw new AppError(401, 'USER_UNAUTHORIZED', '需要有效的用户 token(Authorization: Bearer <用户token>;经 /users/register 获取)')
  }
  return user
}

/** 从事件提取用户 token(WS sub 等非 header 场景共用) */
export function extractUserToken(event: H3Event): string | null {
  const auth = getRequestHeader(event, 'authorization')
  return auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null
}
