/**
 * 模块头 / 领域类型 / 两个错误类 / 原生失败判别
 * (由 server/services/workshop/agents/hitl-decision.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AepHitlStatus } from '../../../../../shared/workshop-protocol'
import { AppError } from '@/server/utils/errors'
import { createLogger } from '../../logger'

/**
 * HITL 统一决策服务(§13.4)—— 所有 HITL 端点(respond/pending/approvals)的唯一裁决入口。
 *
 * 决策顺序(不可跳步,主计划 §8 审批流程 4→8):
 *   ① 载入持久化事实行(缺失 → 404/409,视调用口径)
 *   ② requireCanApprove(channelId, user, { policy, snapshot })   ← 创建时资格 ∩ 当前资格 → 403
 *   ③ claimPending(id, decisionId, userId)                       ← 原子抢占 pending→resolving
 *      失败 = 他人已抢占/已终态 → **409 ALREADY_RESOLVED**(带当前状态与处理人,供前端收敛)
 *   ④ 传导原生应答(adapter/terminal/tool-approvals)
 *   ⑤ 引擎确认成功 → finalize(终态, nativeConfirmed: true)
 *   ⑥ 引擎**明确**失败 → releaseClaim(可重试)或 finalize('failed')(不可重试)
 *   ⑦ 结果**未知** → markDeliveryUnknown(绝不重试、绝不标记成功,人工核对后再收敛)
 *   ⑧ 广播 hitl.resolved + 更新 hitl_resolved 定向通知
 *
 * decisionId 每次尝试都是新 uuid:抢占/审计/原生对账共用同一关联 ID(§13.6)。
 *
 * 重启语义:`reconcileHitlOnStartup()` 用 `failAllNonTerminalOnRestart()` 把**本进程启动前**创建的
 * 非终态条目置 failed(原生会话随上一进程消亡)—— **pending HITL 永不自动批准**;
 * 本模块在首次决策前惰性执行一次(幂等,globalThis 标记跨 HMR/多入口存活),
 * 只处理早于进程启动水位的条目,绝不误杀本进程内新建的 live 待办。
 *
 * 降级:无持久化层(旧测试脚手架在 :memory: 上不装群聊仓储)时可使用内存待办,
 * 但仍须校验当前 Channel 审批资格;缺少授权运行时或 Channel 信息时 fail-closed。
 */

export const log = createLogger('workshop.hitl-decision')

/** 权限主体(与路由层 ResolvedUser / manager.ActingUser 同构) */
export interface HitlActingUser {
  id: string
  name?: string
  role?: string
}

/** 决策载荷(端点 body 归一化后交给本服务;枚举非法一律 400,绝不静默降级为"允许") */
export interface HitlDecisionPayload {
  /** 单问题自由文本/选择答案,或多问题的合并文本 */
  value?: string
  /** 结构化多问题答案(id 缺省按下标对齐) */
  answers?: Array<{ id?: string, answer: string }>
  confirmed?: boolean
  cancelled?: boolean
  /** 引擎原生选项枚举(opencode permission: once|always|reject 等) */
  response?: string
  comment?: string
}

export interface HitlDecisionInput {
  kind: string
  id: string
  user: HitlActingUser
  decision: HitlDecisionPayload
}

export interface HitlDecisionResult {
  kind: string
  id: string
  status: AepHitlStatus
  outcome: 'answered' | 'cancelled' | 'expired'
  nativeConfirmed: boolean
  /** 是否走了持久化事实源(false = 降级旧口径) */
  persisted: boolean
  /** 决策关联 ID(审计/对账;§13.6) */
  decisionId: string
  /** dcw-approval 专属:工具审批裁决结果 */
  approval?: unknown
}

// ============================================================================
// 错误分类:决定状态机走向(明确失败 vs 结果未知)
// ============================================================================

/** 原生投递结果**未知**(超时/连接中断/无回执)→ delivery_unknown;绝不重试、绝不标记成功 */
export class HitlDeliveryUnknownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HitlDeliveryUnknownError'
  }
}

/** 原生调用明确失败但**条目仍在引擎侧 pending**(可安全让出抢占重试)→ 回落 pending */
export class HitlRetryableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HitlRetryableError'
  }
}

/** 引擎/条目层面的**确定性**失败(不可重试):409 NOT_RESPONDABLE、410 SESSION_GONE、404 NOT_FOUND 等 */
export function isDefiniteNativeFailure(err: unknown): boolean {
  if (err instanceof HitlRetryableError || err instanceof HitlDeliveryUnknownError) return false
  if (err instanceof AppError) {
    return ['NOT_FOUND', 'NOT_RESPONDABLE', 'SESSION_GONE', 'UNKNOWN_HARNESS', 'HARNESS_UNAVAILABLE', 'BAD_REQUEST', 'INVALID_RESPONSE', 'ALREADY_RESOLVED'].includes(err.code)
  }
  // adapter 的原生条目丢失(引擎侧已自行收敛):确定性失败,不得留在 pending 悬空
  const msg = err instanceof Error ? err.message : String(err)
  return /待办不存在或已处理|审批不存在或已处理|会话已关闭|session.*(closed|gone)/i.test(msg)
}
