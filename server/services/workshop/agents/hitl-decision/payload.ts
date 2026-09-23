/**
 * 决策载荷校验与状态映射
 * (由 server/services/workshop/agents/hitl-decision.ts 按职责拆出;内容逐行原文搬运)
 */
import type { HitlDecisionPayload } from './shared'
import type { HitlStatus } from '../../db/hitl-request.repo'
import { AppError } from '@/server/utils/errors'

// ============================================================================
// response 枚举白名单(未知枚举直接拒绝,不得默认允许 —— §13.5)
// ============================================================================

/** providerKind → 允许的 response 枚举 */
export const RESPONSE_ENUMS: Record<string, ReadonlySet<string>> = {
  'opencode-permission': new Set(['once', 'always', 'reject']),
  'codex-approval': new Set(['accept', 'decline', 'cancel']),
}

/** 校验决策载荷(未知枚举 → 400;不返回任何默认"允许") */
export function assertDecisionPayload(kind: string, decision: HitlDecisionPayload): void {
  const response = typeof decision.response === 'string' ? decision.response.trim() : ''
  if (!response) return
  const allowed = RESPONSE_ENUMS[kind]
  if (!allowed) {
    throw new AppError(400, 'INVALID_RESPONSE', `kind=${kind} 不接受 response 枚举(仅 ${Object.keys(RESPONSE_ENUMS).join('/')} 接受);请改用 confirmed/cancelled/value`)
  }
  if (!allowed.has(response)) {
    throw new AppError(400, 'INVALID_RESPONSE', `未知 response 枚举「${response}」(kind=${kind} 仅允许 ${[...allowed].join('|')});已拒绝,不会按默认值放行`)
  }
}

/** 决策 → 持久化终态映射(question 与 approval 分开建模,§8) */
export function statusOfDecision(
  requestType: 'question' | 'approval',
  decision: HitlDecisionPayload,
): { status: HitlStatus, outcome: 'answered' | 'cancelled' } {
  if (decision.cancelled === true) return { status: 'cancelled', outcome: 'cancelled' }
  if (decision.response === 'reject' || decision.response === 'decline') return { status: 'rejected', outcome: 'answered' }
  if (requestType === 'approval') {
    return decision.confirmed === true
      ? { status: 'approved', outcome: 'answered' }
      : { status: 'rejected', outcome: 'answered' }
  }
  return { status: 'answered', outcome: 'answered' }
}
