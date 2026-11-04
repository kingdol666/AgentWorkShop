/**
 * PR19-P1 派生进度（derived progress）。
 *
 * 评价修正项：`tasks.progress` 是 Agent 自报（report_progress 钳位后原值直写，无派生），
 * "78% 但零产物"缺少参照系。本模块从子任务树**派生**一个参照进度：
 *  - 叶子任务（无子任务）：progressDerived = null（不适用；自报值即唯一口径）
 *  - 父任务：等权聚合子任务 —— child value = COMPLETED:100 / FAILED·CANCELED:0 /
 *    在飞取 child 的派生值（递归）或自报值。终态为锚、在飞参考自报。
 * 只增不改：不写库、不影响调度/停滞检测的自报口径，仅在读取面（REST list/detail）
 * 并列展示，给"自报 78%"一个可对照的数字。
 */
import type { WorkspaceTask } from '../../types/task'

type Derivable = Pick<WorkspaceTask, 'id' | 'parentId' | 'state' | 'progress'>

export function deriveProgressMap<T extends Derivable>(tasks: T[]): Map<string, number | null> {
  const byParent = new Map<string, T[]>()
  const byId = new Map<string, T>()
  for (const t of tasks) {
    byId.set(t.id, t)
    if (t.parentId) {
      const list = byParent.get(t.parentId)
      if (list) list.push(t)
      else byParent.set(t.parentId, [t])
    }
  }
  const memo = new Map<string, number | null>()
  const valueOf = (id: string): number => {
    const derived = memo.get(id)
    if (derived !== undefined && derived !== null) return derived
    const t = byId.get(id)
    if (!t) return 0
    if (t.state === 'COMPLETED') return 100
    if (t.state === 'FAILED' || t.state === 'CANCELED') return 0
    const children = byParent.get(id) ?? []
    if (children.length > 0) {
      const sum = children.reduce((acc, c) => acc + valueOf(c.id), 0)
      const v = Math.round(sum / children.length)
      memo.set(id, v)
      return v
    }
    return t.progress ?? 0
  }
  const out = new Map<string, number | null>()
  for (const t of tasks) {
    const isParent = (byParent.get(t.id) ?? []).length > 0
    out.set(t.id, isParent ? valueOf(t.id) : null)
  }
  return out
}
