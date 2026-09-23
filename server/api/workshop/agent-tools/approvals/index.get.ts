/**
 * GET /api/workshop/agent-tools/approvals?agentId=&scope=pending|history
 * —— 手动确认模式的执行审批列表(孪生侧栏审批面板轮询)。
 *
 * v17 安全修复(主计划 §13.2):此前 `resolveUser(event)` 的结果被**丢弃**,
 * 任何已登录用户都能看到全部 Channel 的待审批项(越权读取 + 越权裁决入口)。
 * 现在按 Channel 归属与审批资格过滤:
 *   ① 审批的 agentId → channelId(getWorkshopManager().findChannelAgentById);
 *   ② 该 Channel 必须在调用者可见范围内(listChannelsVisibleTo ∪ 遗留公共行),
 *      且调用者具备审批资格(owner_only → 仅 owner;any_member → 任意 active 成员;admin 全量);
 *   ③ 归属无法解析(Agent 已删除等)→ 仅 admin 可见(fail-closed)。
 * history 与 pending 用同一过滤口径,避免"历史里泄露、列表里看不到"的错配。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getToolApprovals } from '@/server/services/workshop/agents/tool-approvals'
import { canDecideHitlChannel, snapshotOfRow } from '@/server/services/workshop/agents/hitl-decision'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const agentId = typeof q.agentId === 'string' ? q.agentId : ''
  const scope = q.scope === 'history' ? 'history' : 'pending'

  const manager = getWorkshopManager()
  const acting = { id: user.id, name: user.name, role: user.role }

  /** 单条审批是否对当前用户可见/可裁决 */
  const visible = (approvalAgentId: string, approvalId: string): boolean => {
    // 审批的 Channel 归属:Agent 实例 → channelId
    const channelId = manager.findChannelAgentById(approvalAgentId)?.channelId
    if (!channelId) return user.role === 'admin'
    // dcw 审批的冻结策略(创建时快照);无持久化行则按当前 Channel 策略
    const row = manager.groupChat.hitl.find('dcw-approval', approvalId)
    const opts = row ? { policy: row.policy, snapshot: snapshotOfRow(row) } : {}
    return canDecideHitlChannel(channelId, acting, opts)
  }

  const all = scope === 'history' ? getToolApprovals().historyList() : getToolApprovals().listPending(agentId)
  return { approvals: all.filter(a => visible(a.agentId, a.id)) }
})
