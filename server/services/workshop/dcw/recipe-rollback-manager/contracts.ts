/**
 * RecipeRollBackManagerContracts —— **跨层能力契约**。
 *
 * 拆成 7 层后,有 7 个方法只被"更早的层"调用;
 * 与其把层序排成拓扑序打散职责,不如显式声明为抽象签名,由实现它的层提供(编译期校验)。
 *
 * 契约成员:
 *   captureMetrics  → 由 views.ts 实现
 *   closeRecord  → 由 views.ts 实现
 *   emit  → 由 internal.ts 实现
 *   fillMetrics  → 由 views.ts 实现
 *   isStale  → 由 judge.ts 实现
 *   markGoodFromRecord  → 由 internal.ts 实现
 *   resolvePolicy  → 由 internal.ts 实现
 */
import type { OptimizationMetrics, OptimizationRecord } from '../../../../../shared/dcw-protocol'

export abstract class RecipeRollBackManagerContracts {
  protected abstract captureMetrics(nodeId: string, lineId: string, recipeId: string | null | undefined, fromMs: number, toMs: number): Promise<OptimizationMetrics>
  protected abstract closeRecord(record: OptimizationRecord, closedBy: NonNullable<OptimizationRecord['closedBy']>, judge?: OptimizationRecord['judge']): void
  protected abstract emit(event: 'opened' | 'judged' | 'closed' | 'rolled-back', record: OptimizationRecord): void
  protected abstract fillMetrics(record: OptimizationRecord, slot: 'baseline' | 'windowAgg', fromMs: number, toMs: number): Promise<void>
  abstract isStale(record: OptimizationRecord): boolean
  protected abstract markGoodFromRecord(record: OptimizationRecord): void
  protected abstract resolvePolicy(nodeId: string, actor: string): 'auto_rollback' | 'approve_rollback' | 'observe_only'
}
