/**
 * R3:高危管理操作双人复核闸门(maker-checker)。
 *
 * approvalGate 关闭(config.yml security.approvalGate,默认关)→ 直接放行,零开销;
 * 开启后:首次调用创建待审记录(pending)返回 { pending: true },
 * 另一 admin 经 POST /api/workshop/approvals/:id/decide 批准(申请人≠批核人硬校验),
 * 申请人再携 approvalId 重放原请求 → 校验匹配且未消费 → 一次性核销放行。
 * 全程经 audit() 留痕(与 R1 统一审计视图)。
 */
import { randomUUID } from 'node:crypto'
import { AppError } from './errors'
import { audit, getOps } from '../services/workshop/ops/ops'
import type { ResolvedUser } from '../api/workshop/caller'

/** 闸门主体:动作 + 目标(与 approval_requests 表的 action/target_id 对齐) */
export interface GateSubject {
  action: string
  targetId: string
  summary: string
}

export type GateVerdict = { pending: true, requestId: string } | { pending: false }

/** 高危操作闸门:返回 pending = true 时端点应 202 短路返回;否则继续执行原逻辑 */
export function gateDangerous(
  approvalGate: boolean,
  user: ResolvedUser,
  subject: GateSubject,
  approvalId?: string,
): GateVerdict {
  const repo = getOps()?.approvalRequests
  if (!approvalGate || !repo) return { pending: false }

  // 重放路径:携批准记录放行
  if (approvalId) {
    const req = repo.get(approvalId)
    if (!req || req.action !== subject.action || req.targetId !== subject.targetId) {
      throw new AppError(400, 'APPROVAL_INVALID', '复核记录不存在或与本次操作不匹配')
    }
    if (req.status !== 'approved') {
      throw new AppError(403, 'APPROVAL_NOT_APPROVED', '复核尚未批准(或已被拒绝)')
    }
    if (req.requestedBy !== user.id) {
      throw new AppError(403, 'APPROVAL_REQUESTER_MISMATCH', '仅申请人本人可携批准记录重放操作')
    }
    if (!repo.consume(approvalId)) {
      throw new AppError(409, 'APPROVAL_CONSUMED', '该批准记录已被使用(一次性核销)')
    }
    audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: `${subject.action}.approved-exec`, targetKind: 'approval-request', targetId: approvalId, detail: { targetId: subject.targetId } })
    return { pending: false }
  }

  // 首次路径:创建待审记录
  const id = `ar-${randomUUID().slice(0, 8)}`
  repo.request({
    id,
    action: subject.action,
    targetId: subject.targetId,
    payload: {},
    summary: subject.summary,
    byUserId: user.id,
    byName: user.name,
    at: new Date().toISOString(),
  })
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: `${subject.action}.request`, targetKind: 'approval-request', targetId: id, detail: { targetId: subject.targetId } })
  return { pending: true, requestId: id }
}
