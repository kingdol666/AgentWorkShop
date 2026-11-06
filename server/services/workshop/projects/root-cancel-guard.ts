/**
 * PR16：项目来源 root 的取消护栏（纯函数，manager.cancelTask 与单测共用）。
 *
 * 语义：lead 对 source='project' 且无父任务的 root 调用取消 —— 一律拒绝：
 * 单方面放弃项目工作属 owner 决定（REST /projects/:id/work-items/:wid/cancel）；
 * lead 的失败语义走 refuse_task/FAILED。该护栏同时拦住监督回合硬中止
 * （hard timeout）的自动 cancel 收口，保证项目工作项持续推进。
 */
import { AppError } from '../../../utils/errors'

export interface CancelGuardTask {
  source?: string | null
  parentId?: string | null
  creatorId?: string | null
}

export function assertProjectRootCancelAllowed(
  task: CancelGuardTask,
  caller: { role: string, agentId: string },
): void {
  if (task.source === 'project' && !task.parentId && caller.role === 'lead') {
    throw new AppError(403, 'PROJECT_ROOT_CANCEL_FORBIDDEN', '项目来源任务不允许 lead 自行取消：请继续执行并用 report_progress 汇报进度，或用 refuse_task 说明无法完成；取消需由 owner 决定')
  }
}
