/**
 * mock 内置 PLC 模拟写驱动(确定性 ACK + 回读)
 * (由 server/services/workshop/dcw/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwWriteDriver } from './shared'
import { engToRaw } from './shared'

// ============================================================
// Mock 写驱动(模拟 PLC:确定性 ACK + 回读)
// ============================================================

export const mockState = globalThis as typeof globalThis & { __dcwMockPlc?: Map<string, number> }
if (!mockState.__dcwMockPlc) mockState.__dcwMockPlc = new Map()

export const mockDcwDriver: DcwWriteDriver = {
  kind: 'mock',
  async available() {
    return true
  },
  async write(input) {
    const key = `${input.driverConfig.key ?? 'default'}`
    const raw = engToRaw(input.eng, input)
    mockState.__dcwMockPlc!.set(key, input.eng)
    // 模拟 PLC 写入 + 回读时延
    await new Promise(r => setTimeout(r, 60 + Math.random() * 80))
    return {
      ok: true,
      message: `Mock PLC 写入成功:${input.eng} → raw ${Number(raw.toFixed(4))},回读一致`,
      raw,
      readback: input.eng,
    }
  },
  async read(input) {
    const key = `${input.driverConfig.key ?? 'default'}`
    const has = mockState.__dcwMockPlc!.has(key)
    const eng = mockState.__dcwMockPlc!.get(key) ?? null
    return has
      ? { ok: true, message: `Mock PLC 读回:${eng}`, eng, raw: eng }
      : { ok: false, message: `Mock PLC 无设定记录(${key};从未写入)`, eng: null, raw: null }
  },
  async test() {
    return { ok: true, message: 'Mock 驱动无需连接,写入即模拟 ACK' }
  },
}
