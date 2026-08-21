/**
 * REST 作业面共享认证 — Bearer token → caller Agent。
 * 与 MCP 工具同一语义(manager.findByToken):Agent 经 REST 调用时,
 * 所有查询/通信按 caller 的 channelId 作用域过滤(跨 channel 一律 SCOPE_VIOLATION)。
 * v10:用户面透传 role,提供 admin 守卫与模板归属名注入(权限系统)。
 */
import { getRequestHeader } from 'h3'
import type { H3Event } from 'h3'
import { AppError } from '../../utils/errors'
import { getWorkshopManager } from '../../plugins/workshop'
import { resolveUserByToken } from '../../services/user.service'
import { userRepository } from '../../repositories/user.repository'
import type { AgentInfo } from '../../services/workshop/agents/agent-interface'

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

/** 用户面认证解析结果（全局用户档案子集,供所有权/统计/权限消费） */
export interface ResolvedUser {
  id: string
  name: string
  /** 全局角色:'admin' | 'editor' | 'user'(权限系统;admin 拥有最高管理权限) */
  role: string
  createdAt: string
}

/**
 * 用户面认证 — Bearer <用户 token> → 全局用户（data/users.sqlite 的 user_tokens）。
 * 管理面(channels/agents/teams/tasks/messages/workspaces)强制用户身份:
 * Agent 实例 token 与用户 token 分属两个域,互不通用。
 * 每用户多 token 均有效;token 经 /api/users/register|/login|/tokens 签发。
 */
export function resolveUser(event: H3Event): ResolvedUser {
  const auth = getRequestHeader(event, 'authorization')
  const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const user = token ? resolveUserByToken(token) : null
  if (!user) {
    throw new AppError(401, 'USER_UNAUTHORIZED', '需要有效的用户 token(Authorization: Bearer <用户token>;经 /api/users/register 或 /api/users/login 获取)')
  }
  return { id: user.id, name: user.name, role: user.role, createdAt: user.createdAt }
}

/** admin 守卫:非 admin → 403(用户管理/越权管理面) */
export function requireAdmin(event: H3Event): ResolvedUser {
  const user = resolveUser(event)
  if (user.role !== 'admin') {
    throw new AppError(403, 'ADMIN_REQUIRED', '该操作需要管理员权限')
  }
  return user
}

/** admin 判定(仅角色检查,不做认证;认证由 resolveUser 先行) */
export function isAdmin(user: { role: string }): boolean {
  return user.role === 'admin'
}

/** 模板/资源列表归属名注入:ownerUserId → ownerName(内置 NULL → 'system');就地补齐供前端呈现创建者 */
export function withOwnerNames<T extends { ownerUserId: string | null, isBuiltin?: boolean }>(items: T[]): Array<T & { ownerName: string | null }> {
  const cache = new Map<string, string | null>()
  const resolveOne = (id: string): string | null => {
    if (!cache.has(id)) {
      cache.set(id, resolveUserNameById(id))
    }
    return cache.get(id) ?? null
  }
  return items.map((item) => {
    const ownerName = item.ownerUserId === null
      ? 'system'
      : resolveOne(item.ownerUserId)
    return { ...item, ownerName }
  })
}

/** 按用户 id 解析用户名(60s 轻量缓存;users.sqlite 查询,解析失败回 null) */
const nameCache = new Map<string, { name: string | null, at: number }>()
function resolveUserNameById(userId: string): string | null {
  const hit = nameCache.get(userId)
  if (hit && Date.now() - hit.at < 60_000) return hit.name
  let name: string | null
  try {
    name = userRepository.findById(userId)?.name ?? null
  }
  catch {
    name = null
  }
  nameCache.set(userId, { name, at: Date.now() })
  return name
}

/** 从事件提取用户 token(WS sub 等非 header 场景共用) */
export function extractUserToken(event: H3Event): string | null {
  const auth = getRequestHeader(event, 'authorization')
  return auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null
}
