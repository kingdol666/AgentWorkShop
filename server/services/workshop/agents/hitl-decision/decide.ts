/**
 * 决策主流程 / 一次性对账 / 问题解析 / 结果通知
 * (由 server/services/workshop/agents/hitl-decision.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AepHitlQuestion } from '../../../../../shared/workshop-protocol'
import type { HitlActingUser, HitlDecisionInput, HitlDecisionPayload, HitlDecisionResult } from './shared'
import type { HitlKind, HitlRuntimePort } from '../hitl-registry'
import type { HitlNativeDispatchContext } from './dispatcher'
import type { HitlRequestRow } from '../../db/database'
import type { HitlStatus } from '../../db/hitl-request.repo'
import { AppError } from '@/server/utils/errors'
import { HitlRetryableError, isDefiniteNativeFailure, log } from './shared'
import { assertCanDecideHitlChannel, snapshotOfRow } from './visibility'
import { assertDecisionPayload, statusOfDecision } from './payload'
import { audit } from '../../ops/ops'
import { defaultDispatch, nativeDispatchers } from './dispatcher'
import { g, reconcileHitlOnStartup } from './reconcile'
import { getHitlRegistry, requestTypeOf, resolveHitlRuntime } from '../hitl-registry'
import { randomUUID } from 'node:crypto'
import { resolveAnswers } from './answers'

// ============================================================================
// 决策主流程
// ============================================================================

export const safeRepo = (manager: HitlRuntimePort | null) => {
  if (!manager) return null
  try {
    return manager.groupChat?.hitl ?? null
  }
  catch {
    return null
  }
}

/**
 * 统一决策入口(所有 HITL 端点唯一调用点)。
 * 抛错语义:
 *  - 404 NOT_FOUND            持久化行不存在(且无内存快照)
 *  - 409 ALREADY_RESOLVED     未登记 / 抢占失败(附当前状态与处理人)
 *  - 403 *                    非成员 / 审批策略或资格不通过
 *  - 400 INVALID_RESPONSE     未知 response 枚举
 *  - 410 SESSION_GONE         omp 会话不可用(保持旧语义)
 *  - 409 NOT_RESPONDABLE      该 harness 不支持程序化应答
 *  - 502 DELIVERY_UNKNOWN     原生结果未知 → 已标记待核对(**不是成功**)
 */
export async function decideHitlRequest(input: HitlDecisionInput): Promise<HitlDecisionResult> {
  ensureReconciledOnce()
  const { kind, id, user } = input
  const decision: HitlDecisionPayload = { ...input.decision }
  assertDecisionPayload(kind, decision)

  const manager = resolveHitlRuntime()
  const repo = safeRepo(manager)
  const item = getHitlRegistry().find(kind as HitlKind, id)
  const row = repo?.find(kind, id) ?? undefined

  if (!item && !row) {
    // 保持旧语义:未登记/已落定 → 409(respond.post 也依赖该口径)
    throw new AppError(409, 'ALREADY_RESOLVED', `待办已处理或不存在: ${id}`)
  }

  const channelId = row?.channelId || item?.channelId || ''
  const agentId = row?.agentId || item?.agentId || ''
  const requestType = requestTypeOf({
    kind,
    requestType: (row?.requestType as 'question' | 'approval' | undefined) ?? item?.requestType,
    method: item?.method,
  })

  // ② 审批资格(创建时资格 ∩ 当前资格)
  if (row) {
    assertCanDecideHitlChannel(channelId, user, { policy: row.policy, snapshot: snapshotOfRow(row) })
  }
  else {
    // 无持久化快照时只按当前审批资格裁决;旧 getChannelForUser 会对 owner=NULL 放行任意登录用户。
    if (!manager || !channelId) {
      throw new AppError(503, 'HITL_AUTH_UNAVAILABLE', '待办无持久化授权快照且当前 Channel 授权不可用,已拒绝决策')
    }
    assertCanDecideHitlChannel(channelId, user)
  }

  const decisionId = randomUUID()

  // ③ 原子抢占:并发审批只允许一个成功
  if (row && repo) {
    if (!repo.claimPending(row.id, decisionId, user.id)) {
      const cur = repo.findById(row.id)
      const responder = cur?.responderUserId ? `,处理人=${cur.responderUserId}` : ''
      throw new AppError(
        409,
        'ALREADY_RESOLVED',
        `该待办已被他人处理(当前状态=${cur?.status ?? 'unknown'}${responder}),请刷新后重试`,
      )
    }
  }

  const questions = row?.questionsJson && row.questionsJson !== '[]'
    ? safeParseQuestions(row.questionsJson)
    : (item?.questions ?? [])
  const ctx: HitlNativeDispatchContext = {
    kind,
    id,
    requestType,
    channelId,
    agentId,
    pid: item?.pid,
    decision,
    user,
    questions,
  }

  const registry = getHitlRegistry()
  registry.beginDecision(kind as HitlKind, id)
  try {
    // ④ 传导原生应答
    const custom = nativeDispatchers.get(kind)
    const native = custom ? await custom(ctx) : await defaultDispatch(ctx)

    // ⑤ 引擎确认成功才落终态(§8 步骤 7)
    const { status, outcome } = statusOfDecision(requestType, decision)
    if (row && repo) {
      repo.finalize(row.id, status, {
        decision: {
          decisionId,
          by: user.id,
          byName: user.name ?? '',
          requestType,
          confirmed: decision.confirmed,
          cancelled: decision.cancelled,
          response: decision.response,
          value: decision.value,
          answers: resolveAnswers(questions, decision),
          comment: decision.comment,
        },
        nativeConfirmed: true,
      })
    }
    getHitlRegistry().settle(kind as HitlKind, id, { outcome, by: user.id, status, nativeConfirmed: true, channelId, agentId })
    const approval = (native as { approval?: unknown } | undefined)?.approval
    // 审计:操作者 / 策略 / 原生请求 ID / 原始决策 / 引擎确认结果(§8 审计要求)
    audit({
      actor: user.id,
      actorName: user.name ?? '',
      actorKind: 'user',
      action: status === 'approved' ? 'approval.approve' : status === 'rejected' ? 'approval.reject' : 'hitl.respond',
      targetKind: kind,
      targetId: id,
      detail: {
        decisionId,
        channelId,
        agentId,
        requestType,
        policy: row?.policy,
        approvalPolicyVersion: row?.policyVersion,
        nativeRequestId: row?.nativeRequestId ?? '',
        status,
        nativeConfirmed: true,
        cancelled: decision.cancelled === true,
        confirmed: decision.confirmed === true,
        response: decision.response,
      },
    })
    notifyResolved(manager, kind, id, channelId, row, status, user, true, decisionId)
    return {
      kind,
      id,
      status,
      outcome,
      nativeConfirmed: true,
      persisted: !!row,
      decisionId,
      approval,
    }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 持久化层可用但行缺失(降级登记的旧条目)时不得写状态机,故统一判 row && repo
    if (err instanceof HitlRetryableError) {
      // ⑥ 明确失败且条目仍在引擎侧 pending → 让出抢占(可重试)
      if (row && repo) repo.releaseClaim(row.id, msg)
      audit({ actor: user.id, actorName: user.name ?? '', actorKind: 'user', action: 'hitl.respond', targetKind: kind, targetId: id, detail: { decisionId, channelId, agentId, result: 'retryable', error: msg } })
      throw err
    }
    if (isDefiniteNativeFailure(err)) {
      // ⑥ 确定性失败:条目不可再应答 → failed(nativeConfirmed=false)
      if (row && repo) repo.finalize(row.id, 'failed', { decision: { decisionId, by: user.id }, nativeConfirmed: false, error: msg })
      getHitlRegistry().settle(kind as HitlKind, id, { outcome: 'cancelled', by: user.id, status: 'failed', nativeConfirmed: false, channelId, agentId })
      notifyResolved(manager, kind, id, channelId, row, 'failed', user, false, decisionId)
      audit({ actor: user.id, actorName: user.name ?? '', actorKind: 'user', action: 'hitl.respond', targetKind: kind, targetId: id, detail: { decisionId, channelId, agentId, result: 'failed', error: msg } })
      if (err instanceof AppError) throw err
      throw new AppError(409, 'NATIVE_REJECTED', `原生应答失败(条目已置 failed):${msg}`)
    }
    // ⑦ 结果未知:绝不重试、绝不标记成功(§13.4 delivery_unknown)
    if (row && repo) repo.markDeliveryUnknown(row.id, msg)
    // outcome 只是三值旧投影(answered/cancelled/expired);真实状态在 status 字段
    getHitlRegistry().settle(kind as HitlKind, id, { outcome: 'cancelled', by: user.id, status: 'delivery_unknown', nativeConfirmed: false, channelId, agentId })
    notifyResolved(manager, kind, id, channelId, row, 'delivery_unknown', user, false, decisionId)
    audit({ actor: user.id, actorName: user.name ?? '', actorKind: 'user', action: 'hitl.respond', targetKind: kind, targetId: id, detail: { decisionId, channelId, agentId, result: 'delivery_unknown', error: msg } })
    log.error(`[hitl] 原生应答结果未知(${kind}:${id}):`, msg)
    throw new AppError(502, 'DELIVERY_UNKNOWN', `引擎应答结果未知,已标记待人工核对(不会重试、不视为成功):${msg}`)
  }
  finally {
    // 决策上下文必须退出:否则后续同 id 的适配器 resolve() 会被静默吞掉广播
    registry.endDecision(kind as HitlKind, id)
  }
}

/** 首次决策/首次快照前执行一次启动对账(重启不自动批准) */
export function ensureReconciledOnce(): void {
  if (g.__hitlReconciledAt) return
  reconcileHitlOnStartup()
}

/**
 * 惰性启动对账入口(供 HITL 端点调用):
 * 进程重启后第一次触碰 HITL 面(pending 快照 / 决策)即收敛上一进程遗留的待办,
 * 无需依赖插件改动(插件若调用 `reconcileHitlOnStartup()` 更早,也完全等价,幂等)。
 */
export function ensureHitlReconciled(): void {
  ensureReconciledOnce()
}

export function safeParseQuestions(json: string): AepHitlQuestion[] {
  try {
    const raw = JSON.parse(json) as unknown
    return Array.isArray(raw) ? raw as AepHitlQuestion[] : []
  }
  catch {
    return []
  }
}

/** 落定通知:定向给处理人 + 当前 active 成员(退出者不再打扰;eventId 幂等) */
export function notifyResolved(
  manager: HitlRuntimePort | null,
  kind: string,
  id: string,
  channelId: string,
  row: HitlRequestRow | undefined,
  status: HitlStatus,
  user: HitlActingUser,
  nativeConfirmed: boolean,
  decisionId: string,
): void {
  if (!manager || !channelId) return
  try {
    const recipients = new Set<string>([user.id])
    if (row?.responderUserId) recipients.add(row.responderUserId)
    for (const m of manager.groupChat.members.listActiveByChannel(channelId)) recipients.add(m.userId)
    for (const recipientUserId of recipients) {
      manager.notifyUser({
        recipientUserId,
        channelId,
        type: 'hitl_resolved',
        eventId: `hitl_resolved:${kind}:${id}`,
        title: status === 'approved' ? '审批已通过' : status === 'rejected' ? '审批已拒绝' : '待办已处理',
        body: `处理人=${user.name || user.id};状态=${status}`,
        hitlKind: kind,
        hitlId: id,
        payload: { status, nativeConfirmed, by: user.id, decisionId },
      })
    }
  }
  catch (err) {
    log.warn('[hitl] 落定通知投递失败(不影响决策):', err instanceof Error ? err.message : err)
  }
}
