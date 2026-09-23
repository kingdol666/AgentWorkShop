/**
 * DaqControllerContracts —— **跨层能力契约**。
 *
 * 拆成 9 层后,有 12 个方法只被"更早的层"调用;
 * 与其把层序排成拓扑序打散职责,不如显式声明为抽象签名,由实现它的层提供(编译期校验)。
 *
 * 契约成员:
 *   drainFrames  → 由 frames.ts 实现
 *   emitController  → 由 views.ts 实现
 *   emitNodeChanged  → 由 views.ts 实现
 *   evictFrames  → 由 frames.ts 实现
 *   flushTsdb  → 由 tsdb-twin.ts 实现
 *   handleAlarm  → 由 sweep-alarms.ts 实现
 *   handleAlarmRecover  → 由 sweep-alarms.ts 实现
 *   onSampleFromQueue  → 由 tsdb-twin.ts 实现
 *   pushFrame  → 由 frames.ts 实现
 *   sweep  → 由 sweep-alarms.ts 实现
 *   syncRuntimes  → 由 sweep-alarms.ts 实现
 *   writeBackTelemetry  → 由 tsdb-twin.ts 实现
 */
import type { AepDaqNodeChange } from '../../../../../shared/daq-protocol'
import type { DaqFrameRow } from '../storage/tsdb-port'
import type { DaqSampleEnvelope } from '../bus/queue-port'
import type { DaqNode } from '../daq-node'

export abstract class DaqControllerContracts {
  protected abstract drainFrames(): DaqFrameRow[]
  protected abstract emitController(): void
  protected abstract emitNodeChanged(op: AepDaqNodeChange['op'], node: DaqNode | null): void
  protected abstract evictFrames(keepLast: number): number
  protected abstract flushTsdb(): Promise<void>
  protected abstract handleAlarm(node: DaqNode, value: number, rule: 'lt-min' | 'gt-max', threshold: number, metricKey?: string): void
  protected abstract handleAlarmRecover(node: DaqNode, value: number): void
  protected abstract onSampleFromQueue(env: DaqSampleEnvelope): void
  protected abstract pushFrame(row: DaqFrameRow): void
  protected abstract sweep(): void
  protected abstract syncRuntimes(): void
  protected abstract writeBackTelemetry(node: DaqNode): void
}
