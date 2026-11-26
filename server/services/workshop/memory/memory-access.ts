/**
 * 记忆中心 REST 访问控制：用户会话 → 归属校验（owner / admin）。
 *
 * 规则：记忆可写 = admin ∪ 所属 Channel 的 owner ∪ 记忆行 owner_user_id。
 * 读：登录用户；列表按 owner/channel 裁剪（见路由）。
 */
import type { H3Event } from 'h3'
import { resolveUser, type ResolvedUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import type { MemoryActor } from '../db/memory.repo'
import { getAmlRuntime } from '../aml/runtime'

export function requireMemoryUser(event: H3Event): { user: ResolvedUser, actor: MemoryActor } {
  const user = resolveUser(event)
  return { user, actor: { kind: 'human', id: user.id } }
}

export function assertMemoryWritable(user: ResolvedUser, memoryId: string): { channelId: string, ownerUserId: string | null } {
  const db = getAmlRuntime().db
  const row = db.prepare(
    `SELECT m.channel_id AS channelId, m.owner_user_id AS ownerUserId, c.owner_user_id AS channelOwner
       FROM agent_memories m LEFT JOIN channels c ON c.id = m.channel_id
      WHERE m.id = ?`,
  ).get(memoryId) as { channelId?: string, ownerUserId?: string | null, channelOwner?: string | null } | undefined
  if (!row) throw new AppError(404, 'NOT_FOUND', '记忆不存在')
  if (user.role === 'admin') return { channelId: String(row.channelId), ownerUserId: row.ownerUserId ?? null }
  const allowed = (row.ownerUserId && row.ownerUserId === user.id)
    || (row.channelOwner && row.channelOwner === user.id)
  if (!allowed) throw new AppError(403, 'FORBIDDEN', '仅记忆归属人 / 频道 owner / 管理员可操作')
  return { channelId: String(row.channelId), ownerUserId: row.ownerUserId ?? null }
}

/** 读可见性：admin 全部；其他用户仅自己 owner 的记忆（列表查询条件也用它） */
export function memoryOwnerFilter(user: ResolvedUser): { ownerUserId?: string | null } {
  return user.role === 'admin' ? {} : { ownerUserId: user.id }
}
