/**
 * 原生派发器注册与默认派发
 * (由 server/services/workshop/agents/hitl-decision.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AepHitlQuestion } from '../../../../../shared/workshop-protocol'
import type { HitlActingUser, HitlDecisionPayload } from './shared'
import { AppError } from '@/server/utils/errors'
import { encodeHitlAnswers, resolveHitlRuntime } from '../hitl-registry'
import { getToolApprovals } from '../tool-approvals'
import { resolveAnswers } from './answers'
import { respondTerminalUi } from '../harness-terminal'

// ============================================================================
// 原生应答传导(可插拔:测试/嵌入场景替换;缺省走真实 adapter 面)
// ============================================================================

export interface HitlNativeDispatchContext {
  kind: string
  id: string
  requestType: 'question' | 'approval'
  channelId: string
  agentId: string
  /** 内存快照里的 pid(omp-dialog 终止对话框用) */
  pid?: number
  /** 问题列表(多问题答案按问题 id 对齐回传;来自持久化行,回落到内存快照) */
  questions: AepHitlQuestion[]
  decision: HitlDecisionPayload
  user: HitlActingUser
}

export type HitlNativeDispatcher = (ctx: HitlNativeDispatchContext) => Promise<unknown> | unknown

export const nativeDispatchers = new Map<string, HitlNativeDispatcher>()

/** 注册/覆盖某 providerKind 的原生应答传导(测试与嵌入装配用) */
export function registerHitlNativeDispatcher(kind: string, fn: HitlNativeDispatcher | null): void {
  if (fn) nativeDispatchers.set(kind, fn)
  else nativeDispatchers.delete(kind)
}

/** 默认传导:omp 对话框写 stdin;dcw 走工具审批服务;其余走 manager→adapter */
export async function defaultDispatch(ctx: HitlNativeDispatchContext): Promise<unknown> {
  const manager = resolveHitlRuntime()
  const { decision } = ctx
  if (ctx.kind === 'omp-dialog') {
    // 保持既有 410 SESSION_GONE 语义:pid 缺失/进程已退出 = 会话不可用(确定性失败)
    if (!ctx.pid) throw new AppError(410, 'SESSION_GONE', '对话框缺少 pid(进程已退出?)')
    try {
      respondTerminalUi(ctx.pid, {
        id: ctx.id,
        value: typeof decision.value === 'string' ? decision.value : undefined,
        confirmed: typeof decision.confirmed === 'boolean' ? decision.confirmed : undefined,
        cancelled: decision.cancelled === true,
      })
    }
    catch (err) {
      throw new AppError(410, 'SESSION_GONE', `omp 会话不可用: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { via: 'omp-terminal' }
  }
  if (ctx.kind === 'dcw-approval') {
    // dcw 工具审批:与 hitl/respond 同语义(缺省视为拒绝,approved 必须显式 confirmed===true)
    const approval = getToolApprovals().decide(
      ctx.id,
      decision.confirmed === true,
      String(decision.comment ?? ''),
      ctx.user.id,
      ctx.user.name ?? '',
    )
    return { via: 'tool-approvals', approval }
  }
  if (!manager) throw new AppError(409, 'NOT_RESPONDABLE', 'Workshop 运行时未装配,无法应答该 harness 请求')
  await manager.respondHarnessHitl(ctx.agentId, ctx.kind, ctx.id, {
    confirmed: typeof decision.confirmed === 'boolean' ? decision.confirmed : undefined,
    cancelled: decision.cancelled === true,
    value: encodeHitlAnswers(resolveAnswers(ctx.questions, decision), decision.value),
    response: typeof decision.response === 'string' ? decision.response : undefined,
    comment: typeof decision.comment === 'string' ? decision.comment : undefined,
  })
  return { via: 'harness', harness: ctx.kind }
}
