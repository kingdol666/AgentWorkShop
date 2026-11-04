/**
 * PR20 Route 自动派发器（plan v3.0 §2.2 的确定性落地）。
 *
 * Project 作为对 Channel 的上层 route 封装：计划批准后，由**确定性依赖解析**
 * （无 LLM）按 dependsOn 就绪顺序自动派发工作项 —— 「Channel root 终态 → 回调
 * （reconcile 收敛）→ 派发下一就绪项」循环，直到全部工作项终态。
 *
 * 边界（与 v3.0「V1 无第二调度器」一致）：
 *  - 不做 LLM 决策/重规划；就绪判定与手动派发的 DEPENDENCY 校验同语义；
 *  - 只选 DRAFT 且无 live attempt 的工作项；派发本身复用 dispatchWorkItem 的
 *    全部治理门（plan 版本/绑定/在飞唯一/attempt 事务）；
 *  - 排序 priority DESC → createdAt ASC，保证多就绪项的派发次序确定。
 */
import { parseJson } from '../db/database'
import type { ProjectWorkItemRow } from '../db/project.repo'

/** 依赖被视为「已让路」的终态集（与 service.dispatchWorkItem 的依赖校验一致）。 */
const DEP_SATISFIED_STATES = new Set(['COMPLETED', 'CANCELED', 'SUPERSEDED'])

/**
 * 从项目工作项全集选出本轮可自动派发的就绪项：
 *  - state=DRAFT 且无 live attempt（从未派发/派发失败已清指针）；
 *  - dependsOn 全部存在于本项目且处于让路终态（缺依赖的项视为未就绪，不放行）；
 *  - priority DESC、createdAt ASC 稳定排序。
 */
export function selectReadyWorkItems(items: ProjectWorkItemRow[]): ProjectWorkItemRow[] {
  const byId = new Map(items.map(w => [w.id, w]))
  return items
    .filter(w => w.state === 'DRAFT' && !w.currentAttemptId)
    .filter((w) => {
      const deps = parseJson<string[]>(w.dependsOnJson, [])
      return deps.every(depId => byId.get(depId) != null
        && DEP_SATISFIED_STATES.has(byId.get(depId)!.state))
    })
    .sort((a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0)
      || a.createdAt.localeCompare(b.createdAt))
}
