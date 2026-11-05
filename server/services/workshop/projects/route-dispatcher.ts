/**
 * PR20 Route 自动派发器（plan v3.0 §2.2 的确定性落地）。
 *
 * Project 作为对 Channel 的上层 route 封装：计划批准后，由**确定性依赖解析**
 * （无 LLM）按 dependsOn 就绪顺序自动派发工作项 —— 「Channel root 终态 → 回调
 * （reconcile 收敛）→ 派发下一就绪项」循环，直到全部工作项终态。
 *
 * Router v3 P0：就绪判定统一收敛到 readiness.ts（手动/自动同谓词）。
 *  - legacy：上游工作项终态即放行（本文件旧行为）；
 *  - technical：上游成果技术验收后才放行。
 *
 * 排序 priority DESC → createdAt ASC，保证多就绪项的派发次序确定。
 */
import type { ProjectDeliverableRow, ProjectResultRow, ProjectWorkItemRow } from '../db/project.repo'
import { evaluateWorkItemReadiness, selectReadyWorkItemsWithContext, type ReadinessContext } from './readiness'

/**
 * 从项目工作项全集选出本轮可自动派发的就绪项（legacy 口径，兼容旧调用）。
 * 新代码请用 selectReadyWithContext（带成果/交付物/策略）。
 */
export function selectReadyWorkItems(items: ProjectWorkItemRow[]): ProjectWorkItemRow[] {
  const ctx: ReadinessContext = { items, results: [], deliverables: [], routingPolicy: 'legacy' }
  return selectReadyWorkItemsWithContext(ctx)
}

export function selectReadyWithContext(input: {
  items: ProjectWorkItemRow[]
  results: ProjectResultRow[]
  deliverables: ProjectDeliverableRow[]
  routingPolicy: string
  nowMs?: number
}): ProjectWorkItemRow[] {
  return selectReadyWorkItemsWithContext(input)
}

export { evaluateWorkItemReadiness }
export type { ReadinessContext, ReadinessVerdict, WaitingOn } from './readiness'
