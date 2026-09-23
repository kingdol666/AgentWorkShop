/**
 * POST /api/workshop/agent-tools/approvals/:id/decide —— 批准/拒绝一次工具执行。
 * body: { approved: boolean, comment?: string }(备注随 tool result 返回给 Agent)
 *
 * v17 安全修复(主计划 §13.2):
 *  ① `approved` 必须是**显式布尔值**:旧实现 `body.approved !== false` 让字段缺失
 *     (=客户端漏传/构造请求)自动变成"批准" —— 高危数控下发的静默放行,现已 400 拒绝;
 *  ② 决策前先做 Channel 归属 + 可见性 + 审批资格校验(与列表端点同口径),
 *     越权/跨 Channel 一律 403;
 *  ③ decide() 的"审批不存在或已处理"从裸 Error(→500)映射为 **409 ALREADY_RESOLVED**,
 *     与 hitl/respond 的并发语义一致。
 */
import { readBody, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getToolApprovals } from '@/server/services/workshop/agents/tool-approvals'
import { assertCanDecideHitlChannel, snapshotOfRow } from '@/server/services/workshop/agents/hitl-decision'
import { audit } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ approved?: unknown, comment?: string }>(event) ?? {}

  // ① 显式布尔:禁止"缺省即批准"
  if (typeof body.approved !== 'boolean') {
    throw new AppError(400, 'BAD_REQUEST', 'body.approved 必须是显式布尔值(true=批准 / false=拒绝);字段缺失不再默认为批准')
  }
  const approved = body.approved
  const comment = String(body.comment ?? '')

  const manager = getWorkshopManager()
  const acting = { id: user.id, name: user.name, role: user.role }
  const row = manager.groupChat.hitl.findById(id)
  const pending = getToolApprovals().listPending().find(a => a.id === id)
  const agentId = row?.agentId || pending?.agentId || ''

  if (agentId) {
    const channelId = manager.findChannelAgentById(agentId)?.channelId
    if (channelId) {
      // ② 与列表端点同口径:可见性 + 审批策略 + 创建时资格快照
      assertCanDecideHitlChannel(channelId, acting, row ? { policy: row.policy, snapshot: snapshotOfRow(row) } : {})
    }
    else if (user.role !== 'admin') {
      // 归属无法解析(Agent 已删除/未落库):非管理员不放行
      throw new AppError(403, 'SCOPE_VIOLATION', '该审批的 Agent 已不属于任何 Channel,仅管理员可处理')
    }
  }
  else if (pending && user.role !== 'admin') {
    throw new AppError(403, 'SCOPE_VIOLATION', '无法确定审批归属的 Channel,仅管理员可处理')
  }

  let approval
  try {
    approval = getToolApprovals().decide(id, approved, comment, user.id, user.name)
  }
  catch (err) {
    // ③ 非 pending(已被他人处理/超时/被取消)→ 409(不再 500)
    throw new AppError(409, 'ALREADY_RESOLVED', err instanceof Error ? err.message : String(err))
  }

  // R1:HITL 裁决审计(闭环中的人为决策留痕)
  audit({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: approved ? 'approval.approve' : 'approval.reject',
    targetKind: 'tool-approval',
    targetId: id,
    detail: { comment, via: 'agent-tools/decide', agentId, channelId: manager.findChannelAgentById(agentId)?.channelId ?? '' },
  })
  return { approval }
})
