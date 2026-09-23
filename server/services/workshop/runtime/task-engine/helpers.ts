/**
 * TaskEngine 的模块级纯工具/常量(原 server/services/workshop/runtime/task-engine.ts 类外声明,含类体之后与类无关的部分)。
 */
import type { A2AArtifact, A2AMessage } from '../../types/a2a'
import type { TaskMetaRow } from '../../db/task.repo'
import type { TaskRow } from '../../db/database'
import type { TaskState, WorkspaceTask } from '../../types/task'
import { createLogger } from '../../logger'
import { parseJson } from '../../db/database'

export const log = createLogger('workshop.task-engine')

/** 状态机合法迁移表(§2.2);终态(COMPLETED/FAILED/CANCELED)不在表中 → 不可迁移
 *  例外:WAITING/SUBMITTED(父任务等待子任务合并)→ COMPLETED 属于正常闭环
 *  (触发条件=全部子任务终态;由 complete() 的 done-check 闸门兜底校验)。
 *  SUBMITTED → COMPLETED 修复 goal 父任务死锁:lead 派出子任务但从未显式开跑父任务时,
 *  子任务全部终态后父任务在 SUBMITTED 上永久悬挂(调度器 dispatch 规则要求无子任务、
 *  收口规则只认 WAITING/WORKING,三面都不接) */
export const TRANSITIONS: Record<TaskState, TaskState[]> = {
  SUBMITTED: ['WORKING', 'ASSIGNED', 'COMPLETED', 'CANCELED'],
  ASSIGNED: ['WORKING', 'CANCELED'],
  WORKING: ['WAITING', 'COMPLETED', 'FAILED', 'CANCELED'],
  WAITING: ['WORKING', 'COMPLETED', 'CANCELED'],
  FAILED: ['ASSIGNED', 'CANCELED'],
  COMPLETED: [],
  CANCELED: [],
}

/** 行 → 域对象:JSON 列展开(artifacts_json → artifacts,history_json → history) */
export function rowToTask(row: TaskRow): WorkspaceTask {
  return {
    id: row.id,
    channelId: row.channelId,
    parentId: row.parentId ?? undefined,
    assigneeId: row.assigneeId,
    creatorId: row.creatorId ?? '',
    title: row.title,
    description: row.description ?? undefined,
    state: row.state as TaskState,
    progress: row.progress,
    retryCount: row.retryCount,
    artifacts: parseJson<A2AArtifact[]>(row.artifactsJson, []),
    history: parseJson<A2AMessage[]>(row.historyJson, []),
    routeReason: row.routeReason || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** 元数据行 → 域对象:免 JSON 大列解析(artifacts/history 置空,仅供调度快照/队列视图消费) */
export function rowToTaskLite(row: TaskMetaRow): WorkspaceTask {
  return {
    id: row.id,
    channelId: row.channelId,
    parentId: row.parentId ?? undefined,
    assigneeId: row.assigneeId,
    creatorId: row.creatorId ?? '',
    title: row.title,
    description: row.description ?? undefined,
    state: row.state as TaskState,
    progress: row.progress,
    retryCount: row.retryCount,
    artifacts: [],
    history: [],
    routeReason: row.routeReason || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** 任务执行历史上限(applyEvent 整列重写模型下的写放大有界化) */
export const TASK_HISTORY_CAP = 200
