/**
 * DcwControllerContracts —— **跨层能力契约**。
 *
 * 拆成 10 层后,有 2 个方法只被"更早的层"调用;
 * 与其把层序排成拓扑序打散职责,不如显式声明为抽象签名,由实现它的层提供(编译期校验)。
 *
 * 契约成员:
 *   executeRead  → 由 actuation.ts 实现
 *   executeWrite  → 由 actuation.ts 实现
 */
import type { DcwNode } from '../dcw-node'

export abstract class DcwControllerContracts {
  protected abstract executeRead(node: DcwNode): Promise<{ ok: boolean, value: number | null, raw: number | null, message: string, at: string }>
  protected abstract executeWrite(node: DcwNode, eng: number, tolerance: number, recipeRunId: string | null): Promise<{ ok: boolean, message: string, raw: number | null, readback: number | null }>
}
