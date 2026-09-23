/**
 * TaskEngineContracts —— **跨层能力契约**。
 *
 * 拆成 5 层后,有 2 个方法只被"更早的层"调用;
 * 与其把层序排成拓扑序打散职责,不如显式声明为抽象签名,由实现它的层提供(编译期校验)。
 *
 * 契约成员:
 *   requireTask  → 由 lifecycle.ts 实现
 *   transition  → 由 transition.ts 实现
 */
import type { TaskState, WorkspaceTask } from '../../types/task'

export abstract class TaskEngineContracts {
  protected abstract requireTask(taskId: string): WorkspaceTask
  abstract transition(taskId: string, state: TaskState, by: string): WorkspaceTask
}
