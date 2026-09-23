/**
 * S7 预留(未安装栈时的显式拒绝桩)
 * (由 server/services/workshop/daq/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DaqDriver } from './shared'
import type { DaqDriverKind, DriverTestResult } from '../../../../../shared/daq-protocol'

// ============================================================
// S7 预留
// ============================================================

export class PlannedProtocolStub implements DaqDriver {
  constructor(
    readonly kind: DaqDriverKind,
    private readonly hint: string,
  ) {}

  async available() {
    return false
  }

  async sample(): Promise<number | null> {
    throw new Error(`DRIVER_NOT_IMPLEMENTED: ${this.hint} 协议栈尚未安装(npm i nodes7 后在 REGISTRY 注册即可)`)
  }

  async test(): Promise<DriverTestResult> {
    return { ok: false, message: `${this.hint} 驱动尚未实现:安装 nodes7 并实现 poll 后开放` }
  }
}
