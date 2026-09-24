/**
 * AgentRuntimeContracts —— **跨层能力契约**。
 *
 * 拆成 4 层后,有 5 个方法只被"更早的层"调用;
 * 与其把层序排成拓扑序打散职责,不如显式声明为抽象签名,由实现它的层提供(编译期校验)。
 *
 * 契约成员:
 *   consumeLoop  → 由 supervise.ts 实现
 *   maybePostSettle  → 由 message.ts 实现
 *   processMessage  → 由 message.ts 实现
 *   queueContext  → 由 message.ts 实现
 *   superviseController  → 由 lifecycle.ts 实现
 */
import type { A2AMessage } from '../../types/a2a'
import type { AgentContextStats, AgentStatusView } from '../../types/task'

export abstract class AgentRuntimeContracts {
  protected abstract consumeLoop(): Promise<void>
  protected abstract maybePostSettle(): void
  protected abstract processMessage(msg: A2AMessage): Promise<void>
  /** 状态重广播(由 lifecycle 层实现;supervise/任务突变后同步前端实体) */
  abstract refreshStatus(): void
  protected abstract queueContext(): Pick<AgentStatusView, 'currentTaskId' | 'currentTaskTitle' | 'currentTaskProgress' | 'queuedCount' | 'completedCount' | 'supervision' | 'continuity'> & { context?: AgentContextStats | null }
  protected abstract superviseController: AbortController | null
}
