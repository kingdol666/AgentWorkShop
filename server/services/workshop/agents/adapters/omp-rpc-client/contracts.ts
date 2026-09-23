/**
 * OmpRpcClientContracts —— **跨层能力契约**。
 *
 * 拆成 6 层后,有 5 个方法只被"更早的层"调用;
 * 与其把层序排成拓扑序打散职责,不如显式声明为抽象签名,由实现它的层提供(编译期校验)。
 *
 * 契约成员:
 *   handleChunk  → 由 frames.ts 实现
 *   handleExit  → 由 frames.ts 实现
 *   handleHostToolCall  → 由 frames.ts 实现
 *   notifyError  → 由 frames.ts 实现
 *   onStdout  → 由 stdout.ts 实现
 */
import type { HostToolCallFrame, RpcChunkFrame } from './helpers'

export abstract class OmpRpcClientContracts {
  protected abstract handleChunk(frame: RpcChunkFrame): void
  protected abstract handleExit(code: number | null): void
  protected abstract handleHostToolCall(req: HostToolCallFrame): Promise<void>
  protected abstract notifyError(err: Error): void
  protected abstract onStdout(data: string): void
}
