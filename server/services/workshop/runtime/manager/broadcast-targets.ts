/**
 * 广播目标选择(会话隔离,2026-11-10 审计 C2)。
 *
 * 背景:一个频道下可以并存多个 active 会话,每个会话都有自己的 clone 成员
 * (`基础名·session·N`)。旧实现 broadcast_message 直接遍历 `listAgents()`,
 * 会把 A 会话内的广播扇出到 B/C 会话的 clone —— 既浪费回合,也可能把
 * 会话私有上下文泄漏给别的会话成员。
 *
 * 语义(与产品口径一致):
 *   - 发起者是基础成员(频道 lead / 未克隆成员)→ 频道级全量广播(保持既有行为);
 *   - 发起者是会话 clone → 基础成员 + **本会话**的 clone,不跨会话;
 *   - 发起者是 clone 但会话已关闭/未解析出成员表 → 只到基础成员(fail-closed:
 *     宁可少送,也不把会话内消息投给未知会话)。
 */
import { SESSION_MARKER } from '../../agents/session-clone'

const isSessionClone = (agent: { name: string }): boolean => String(agent.name ?? '').includes(SESSION_MARKER)

export function selectBroadcastTargets<T extends { id: string, name: string }>(
  all: readonly T[],
  senderAgentId: string,
  sessionMemberIds: ReadonlySet<string> | null,
): T[] {
  const others = all.filter(a => a.id !== senderAgentId)
  const sender = all.find(a => a.id === senderAgentId)
  if (!sender || !isSessionClone(sender)) return others
  if (!sessionMemberIds) return others.filter(a => !isSessionClone(a))
  return others.filter(a => !isSessionClone(a) || sessionMemberIds.has(a.id))
}
