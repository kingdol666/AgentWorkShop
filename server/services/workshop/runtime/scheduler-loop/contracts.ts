/**
 * SchedulerLoopContracts —— **跨层能力契约**。
 *
 * 拆成 5 层后,有 8 个方法只被"更早的层"调用;
 * 与其把层序排成拓扑序打散职责,不如显式声明为抽象签名,由实现它的层提供(编译期校验)。
 *
 * 契约成员:
 *   checkLoopCompletion  → 由 execute.ts 实现
 *   collectSnapshot  → 由 snapshot.ts 实现
 *   decide  → 由 snapshot.ts 实现
 *   execute  → 由 execute.ts 实现
 *   pickWorker  → 由 execute.ts 实现
 *   refreshIdle  → 由 execute.ts 实现
 *   ruleEngine  → 由 rules.ts 实现
 *   runRound  → 由 tick.ts 实现
 */
import type { SchedulerDecision } from './types'
import type { SupervisionSnapshot } from '../../agents/agent-interface'

export abstract class SchedulerLoopContracts {
  protected abstract checkLoopCompletion(snapshot: SupervisionSnapshot): void
  protected abstract collectSnapshot(): SupervisionSnapshot
  protected abstract decide(snapshot: SupervisionSnapshot): Promise<SchedulerDecision[]>
  protected abstract execute(decision: SchedulerDecision): void
  protected abstract pickWorker(pool: SupervisionSnapshot['members'], now: number, exclude?: string): SupervisionSnapshot['members'][number] | undefined
  protected abstract refreshIdle(members: SupervisionSnapshot['members'], now: number): void
  protected abstract ruleEngine(snapshot: SupervisionSnapshot): SchedulerDecision[]
  protected abstract runRound(): Promise<void>
}
