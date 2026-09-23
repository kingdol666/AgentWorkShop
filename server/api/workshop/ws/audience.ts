/**
 * HITL 受众与管理员集合解析
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AgentChannelManager } from '../../../services/workshop/runtime/manager'
import { internalsOf } from './hub'
import { log } from './shared'
import { userRepository } from '../../../repositories/user.repository'

export function hitlAudience(manager: AgentChannelManager, channelId: string): Set<string> {
  const out = new Set<string>()
  const internal = internalsOf(manager)
  const channel = internal.deps.repos.channels.findById(channelId)
  if (channel?.ownerUserId) out.add(channel.ownerUserId)
  const policy = channel?.approvalPolicy ?? 'owner_only'
  if (policy === 'any_member') {
    try {
      for (const m of manager.groupChat.members.listActiveByChannel(channelId)) out.add(m.userId)
    }
    catch (err) {
      // 成员查询失败会**静默缩小**通知受众 —— 必须留痕,否则表现为"某些成员收不到提示"而无人察觉
      log.warn(`[workshop-ws] HITL 受众查询成员失败(channel=${channelId.slice(0, 8)}),退化为 owner+admin:`, err)
    }
  }
  for (const id of adminUserIds()) out.add(id)
  return out
}

/**
 * admin 用户 id 集合(60s 缓存)。
 *
 * 修复两处真实缺陷:
 *  1. 原实现用 `userRepository.list({page:1,pageSize:500})` —— **分页截断**会让第 501 个
 *     之后的 admin 静默消失(收不到 HITL 通知,但仍可裁决 → UI 与 API 不一致)。
 *     改用按 role 的定向查询,不设上限。
 *  2. 原实现在失败时把**空集**写入缓存 60s 且不打日志 —— 一次瞬时故障会让全体 admin
 *     静默收不到通知一分钟。现在失败不写缓存、记警告(下次事件即刻重试)。
 *
 * 只回 id 且集合极小(admin 数量级为个位数),故按事件调用可接受;缓存进一步摊薄。
 */
/** admin id 缓存(模块私有:拆分前就没有导出,拆段时不要顺手导出可变绑定) */
let adminIdsCache: { ids: string[], at: number } | null = null
export function adminUserIds(): string[] {
  if (adminIdsCache && Date.now() - adminIdsCache.at < 60_000) return adminIdsCache.ids
  try {
    const ids = userRepository.listIdsByRole('admin')
    adminIdsCache = { ids, at: Date.now() }
    return ids
  }
  catch (err) {
    log.warn('[workshop-ws] admin 名单查询失败(不缓存失败结果,本次仅 owner/成员可见):', err)
    return []
  }
}

/** 自愈:stream 已订阅的总线 ≠ 管理器当前总线(空闲卸载销毁/重建)或 manager 更替 → 重订 */
