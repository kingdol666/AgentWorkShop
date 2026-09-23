/**
 * 渠道可见性 / 决策权断言 / 行快照
 * (由 server/services/workshop/agents/hitl-decision.ts 按职责拆出;内容逐行原文搬运)
 */
import type { HitlActingUser } from './shared'
import type { HitlPolicySnapshot } from '../../db/hitl-request.repo'
import type { HitlRequestRow } from '../../db/database'
import type { HitlRuntimePort } from '../hitl-registry'
import { AppError } from '@/server/utils/errors'
import { resolveHitlRuntime } from '../hitl-registry'

// ============================================================================
// 可见性 / 审批资格(单一事实源:列表与决策共用,避免"看得见却办不了"或反向越权)
// ============================================================================

/** 遗留 owner=NULL 公共 Channel 的可见性口径(与旧端点一致:任意登录用户可见,不可放宽管理面) */
export function visibleChannelIds(manager: HitlRuntimePort, user: HitlActingUser): Set<string> {
  const ids = new Set<string>()
  for (const c of manager.listChannelsVisibleTo(user)) ids.add(c.id)
  try {
    for (const c of manager.listChannelsForUser(user.id)) ids.add(c.id)
  }
  catch { /* 遗留口径不可用(降级):仅用 listChannelsVisibleTo */ }
  return ids
}

/**
 * 断言调用者可见且**可裁决**该 Channel 的 HITL。
 * - 可见性:listChannelsVisibleTo ∪ listChannelsForUser(遗留公共);admin 全量
 * - 审批资格:requireCanApprove(成员 + owner_only/any_member + 创建时资格快照 ∩ 当前资格)
 * - 遗留 owner=NULL Channel:决策不使用只读兼容的 getChannelForUser;无持久化快照时仅当前授权守卫可放行
 */
export function assertCanDecideHitlChannel(
  channelId: string,
  user: HitlActingUser,
  opts: { policy?: string, snapshot?: { eligibleUserIds?: string[], memberGenerations?: Record<string, number> } } = {},
): void {
  const manager = resolveHitlRuntime()
  if (!manager || !channelId) return
  if (user.role === 'admin') {
    manager.requireChannelMember(channelId, user)
    return
  }
  if (!visibleChannelIds(manager, user).has(channelId)) {
    throw new AppError(403, 'SCOPE_VIOLATION', '该待办所属 Channel 对当前用户不可见')
  }
  try {
    manager.requireCanApprove(channelId, user, opts)
  }
  catch (err) {
    // 遗留无主 Channel(owner=NULL):v17 之前旧端点只做 getChannelForUser,而
    // getChannelForUser 对 owner=NULL 放行**任意登录用户** —— 等于"任何登录用户都能
    // 批准一个无主 Channel 里的高危操作"。这属于 §13.2 要求收口的审批旁路。
    //
    // v17 收紧:遗留 Channel 的 HITL 仅 **admin** 可裁决(与 ws.ts 终端接入、
    // requireChannelMember 对遗留 Channel 的口径一致)。owner 需先显式认领
    // (写 owner_user_id)再审批 —— §13.7「owner=NULL 遗留 Channel 默认不可开放,
    // 必须显式认领并审计」。这是**收紧**而非放宽,不违反 §0.8 的兼容约束。
    if (err instanceof AppError && err.code === 'FORBIDDEN_LEGACY') {
      throw new AppError(403, 'FORBIDDEN_LEGACY_APPROVAL',
        '该 Channel 为遗留无归属数据(owner 缺失),HITL 审批仅管理员可执行;请先显式认领 Channel')
    }
    throw err
  }
}

/** 布尔判定(列表过滤用;不抛异常) */
export function canDecideHitlChannel(
  channelId: string,
  user: HitlActingUser,
  opts: { policy?: string, snapshot?: { eligibleUserIds?: string[], memberGenerations?: Record<string, number> } } = {},
): boolean {
  try {
    assertCanDecideHitlChannel(channelId, user, opts)
    return true
  }
  catch {
    return false
  }
}

/** 解析持久化行的策略快照(容错:历史行 JSON 坏 → 只有 policy 生效) */
export function snapshotOfRow(row: HitlRequestRow): { eligibleUserIds?: string[], memberGenerations?: Record<string, number> } {
  try {
    const raw = JSON.parse(row.policySnapshotJson || '{}') as Partial<HitlPolicySnapshot>
    return {
      eligibleUserIds: Array.isArray(raw.eligibleUserIds) ? raw.eligibleUserIds : undefined,
      memberGenerations: raw.memberGenerations && typeof raw.memberGenerations === 'object' ? raw.memberGenerations : undefined,
    }
  }
  catch {
    return {}
  }
}
