/**
 * 监督回合中止 → 调度决策的纯映射(H4,2026-11-03)。
 *
 * 抽出的动机:abortTurn 是 omp RPC 客户端闭包里的内联分支,单元测试无法构造
 * 完整 client 栈;把「什么原因算中止」「中止后如何收口在办任务」收敛成纯函数,
 * 决策语义可以脱离进程/网络单独验证,避免再次出现 FL-7 那种「回合被中止、
 * 任务滞留 WORKING 等人工取消」的回归。
 *
 * 契约:
 *  - 只有显式外部取消(external cancel)与硬超时(hard timeout)算「中止」;
 *    watchdog 只是信号,不产生 cancel 决策(避免把慢回合误杀);
 *  - 没有在办任务 → 无决策(空数组语义由调用方表达);
 *  - 在办任务 → 一条 cancel 决策,带可读原因,任务可重新派发。
 */
import type { SupervisionDecision } from '../agent-interface'

export interface AbortDecisionInput {
  /** abortTurn 收到的原因文本(external cancel / hard timeout(…ms) / …) */
  reason: string
  /** 当前监督回合的根任务 id(无在办任务时为空) */
  activeTaskId?: string | null
}

/** 唯一的 cancel 决策形态(与 SupervisionDecision 联合的 cancel 分支同构) */
export type AbortCancelDecision = Extract<SupervisionDecision, { kind: 'cancel' }>

/** 中止原因是否属于「必须收口在办任务」的硬中止 */
export function isHardAbortReason(reason: string): boolean {
  const r = String(reason ?? '').trim()
  return r === 'external cancel' || r.startsWith('hard timeout')
}

/**
 * 中止 → 决策:
 *  - 非硬中止 / 无在办任务 → null(调用方按「本轮无动作」返回空决策);
 *  - 硬中止 + 在办任务 → cancel 决策(reason 完整保留中止原因)。
 */
export function abortToCancelDecision(input: AbortDecisionInput): AbortCancelDecision | null {
  const reason = String(input.reason ?? '').trim()
  if (!isHardAbortReason(reason)) return null
  const taskId = String(input.activeTaskId ?? '').trim()
  if (!taskId) return null
  return {
    kind: 'cancel',
    taskId,
    reason: `调度回合被中止(${reason}),任务自动收口;需要继续时请重新派发`,
  }
}
