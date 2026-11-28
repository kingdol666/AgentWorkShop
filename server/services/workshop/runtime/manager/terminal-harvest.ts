/**
 * 失败/取消终态的记忆沉淀辅助(纯判定 + 运行时解析)。
 *
 * 背景:worker 回合被中断(cancel / watchdog abort / reassign)时,processMessage
 * 的沉淀面整体被跳过;任务树取消、ROOT_TIMEOUT、成员裁撤收口则根本不经过回合路径
 * —— 这些终态此前一条记忆都不留,RSI 闭环里「失败教训」这一环缺失。
 *
 * 入口:TaskEngine 的统一迁移钩子 onTaskChange(manager/state.ts),所有终态迁移
 * (transition/applyEvent error/cancel/timeoutTree)都汇聚于此,一处补齐即可全覆盖。
 */
import type { TaskState, WorkspaceTask } from '../../types/task'

/** 终态沉淀判定:FAILED 一律沉淀;CANCELED 仅沉淀真正开工过的(history 非空)——
 * 整树取消会按成员批量产生无内容行,只会污染整理源。 */
export function shouldHarvestTerminalTaskMemory(state: TaskState | undefined, task: Pick<WorkspaceTask, 'history'>): boolean {
  if (state === 'FAILED') return true
  if (state === 'CANCELED') return task.history.length > 0
  return false
}

export type TerminalHarvestRuntime = {
  agentId: string
  role: string
  recordTaskMemory?: (task: WorkspaceTask) => Promise<void>
}

/**
 * 解析沉淀主体并触发 harvest:优先 assignee 的运行时(与 worker 回合落定路径同
 * 主体),成员运行时已卸载(裁撤/停机窗口)时回退 lead。异常与缺失一律静默 ——
 * 沉淀是尽力而为的旁路,不得阻断任务状态机。
 */
export function harvestTerminalTaskMemory(
  agents: readonly TerminalHarvestRuntime[] | undefined,
  task: WorkspaceTask,
  state: TaskState | undefined,
): void {
  if (!shouldHarvestTerminalTaskMemory(state, task)) return
  try {
    const runtime = agents?.find(a => a.agentId === task.assigneeId) ?? agents?.find(a => a.role === 'lead')
    if (runtime?.recordTaskMemory) void runtime.recordTaskMemory(task).catch(() => {})
  }
  catch { /* 沉淀失败不阻断任务状态机 */ }
}
