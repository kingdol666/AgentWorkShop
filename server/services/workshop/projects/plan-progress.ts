/**
 * Project 计划进度投影与待批冲突(Task 9)。
 *
 * 真问题:计划卡只存在于项目审批面,observability.plan 为 null,前端/自动化无法解释
 * 「等批准 / 已物化 / 为何不能建项」;待批窗口里手工建项会与即将物化的计划重复。
 * 这里给出唯一投影 + 确定性冲突键(标题/dedupeKey/表述不确定即拒绝并说明)。
 */
import type { ProjectApprovalRow } from '../db/project.repo'

export type PlanProgressState = 'none' | 'pending_approval' | 'applied' | 'rejected' | 'attention_required'

export interface PlanProgress {
  state: PlanProgressState
  pendingApprovalId: string | null
  proposedAt: string | null
  decidedAt: string | null
  materializedAt: string | null
  approvedVersion: number | null
  /** 兼容旧字段:前端仍在读 plan.status 的地方不应报错 */
  legacyPlanStatus: string | null
}

interface PlanLike {
  deliverables?: Array<{ key?: string, name?: string }>
  work_items?: Array<{ key?: string, title?: string, dedupeKey?: string, deliverableKey?: string }>
  workItems?: Array<{ key?: string, title?: string, dedupeKey?: string, deliverableKey?: string }>
}

const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * 从计划 payload 提取确定性冲突键:工作项标题与 dedupeKey。
 * 只用于「已知冲突」判定;无法解析 payload 时返回 null(调用方按不确定处理 → 拒绝建项并说明)。
 */
export function plannedConflictKeys(payloadJson: string): Set<string> | null {
  let plan: PlanLike
  try {
    plan = JSON.parse(payloadJson) as PlanLike
  }
  catch { return null }
  const items = Array.isArray(plan.work_items) ? plan.work_items : Array.isArray(plan.workItems) ? plan.workItems : []
  if (!Array.isArray(plan.deliverables) && items.length === 0) return new Set()
  const keys = new Set<string>()
  for (const item of items) {
    if (item.title) keys.add(`title:${normalize(item.title)}`)
    if (item.dedupeKey) keys.add(`dedupe:${item.dedupeKey}`)
  }
  return keys
}

export function findPendingPlanApproval(approvals: readonly ProjectApprovalRow[]): ProjectApprovalRow | null {
  return approvals.find(a => a.kind === 'plan_approval' && a.status === 'pending') ?? null
}

/**
 * 待批期间的建项冲突判定。
 * - 有明确冲突键命中 → 冲突;
 * - payload 无法解析 → 无法证明不冲突 → 冲突(拒绝并说明);
 * - 无待批计划 → 不冲突(保留正常手工路径)。
 */
export function conflictsWithPendingPlan(
  approvals: readonly ProjectApprovalRow[],
  candidate: { title: string, dedupeKey?: string },
): { conflict: boolean, reason: string, approvalId: string | null } {
  const pending = findPendingPlanApproval(approvals)
  if (!pending) return { conflict: false, reason: 'NO_PENDING_PLAN', approvalId: null }
  const keys = plannedConflictKeys(pending.payloadJson)
  if (keys === null) return { conflict: true, reason: 'PLAN_PAYLOAD_UNPARSEABLE', approvalId: pending.id }
  const titleKey = `title:${normalize(candidate.title)}`
  const dedupeKey = candidate.dedupeKey ? `dedupe:${candidate.dedupeKey}` : null
  if (keys.has(titleKey) || (dedupeKey && keys.has(dedupeKey))) {
    return { conflict: true, reason: 'PLAN_CHANGE_PENDING', approvalId: pending.id }
  }
  return { conflict: false, reason: 'NO_CONFLICT', approvalId: pending.id }
}

export function derivePlanProgress(input: {
  planVersion: number
  approvals: readonly ProjectApprovalRow[]
  /** plan.applied 事件时间(有则视为已物化) */
  materializedAt?: string | null
  /** 最近一次计划裁决(拒绝时用于解释) */
  lastDecision?: { status: string, decidedAt: string } | null
}): PlanProgress {
  const pending = findPendingPlanApproval(input.approvals)
  if (pending) {
    return {
      state: 'pending_approval',
      pendingApprovalId: pending.id,
      proposedAt: pending.createdAt,
      decidedAt: null,
      materializedAt: input.materializedAt ?? null,
      approvedVersion: input.planVersion > 0 ? input.planVersion : null,
      legacyPlanStatus: 'pending_approval',
    }
  }
  if (input.lastDecision && input.lastDecision.status === 'rejected') {
    return {
      state: 'rejected',
      pendingApprovalId: null,
      proposedAt: null,
      decidedAt: input.lastDecision.decidedAt,
      materializedAt: input.materializedAt ?? null,
      approvedVersion: input.planVersion > 0 ? input.planVersion : null,
      legacyPlanStatus: 'rejected',
    }
  }
  if (input.planVersion > 0) {
    return {
      state: 'applied',
      pendingApprovalId: null,
      proposedAt: null,
      decidedAt: input.lastDecision?.decidedAt ?? null,
      materializedAt: input.materializedAt ?? null,
      approvedVersion: input.planVersion,
      legacyPlanStatus: 'applied',
    }
  }
  const attention = input.approvals.find(a => a.kind === 'plan_approval' && a.status === 'failed')
  if (attention) {
    return {
      state: 'attention_required',
      pendingApprovalId: attention.id,
      proposedAt: attention.createdAt,
      decidedAt: attention.decidedAt ?? null,
      materializedAt: input.materializedAt ?? null,
      approvedVersion: null,
      legacyPlanStatus: 'failed',
    }
  }
  return {
    state: 'none',
    pendingApprovalId: null,
    proposedAt: null,
    decidedAt: null,
    materializedAt: input.materializedAt ?? null,
    approvedVersion: null,
    legacyPlanStatus: null,
  }
}
