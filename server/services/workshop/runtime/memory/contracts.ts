/**
 * AgentMemoryContracts —— **跨层能力契约**。
 *
 * 拆成 5 层后,有 3 个方法只被"更早的层"调用;
 * 与其把层序排成拓扑序打散职责,不如显式声明为抽象签名,由实现它的层提供(编译期校验)。
 *
 * 契约成员:
 *   formatLine  → 由 score.ts 实现
 *   score  → 由 score.ts 实现
 *   updateBrief  → 由 governance.ts 实现
 */
import type { MemoryRow } from '../../db/database'

export abstract class AgentMemoryContracts {
  protected abstract formatLine(row: MemoryRow): string
  protected abstract score(row: MemoryRow, relevance: number): number
  abstract updateBrief(): Promise<void>
}
