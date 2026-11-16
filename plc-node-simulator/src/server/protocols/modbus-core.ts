/**
 * Modbus 共享核心 —— 寄存器空间 + 映射读写 + 外部写回灌。
 * TCP 从站(modbus-serial ServerTCP)与 RTU-over-TCP 从站(手写帧)共用。
 *
 * 读语义:映射地址动态取信号 runtime.value 编码(tick 后读请求拿最新值);未映射取影子。
 * 写语义:外部写(FC06/FC16)落影子 + 同步回灌信号(first-order 改 sp,其余覆写 value)
 *        —— DCW 写 SP 后同址回读立即一致,主项目写链路校验依赖此语义。
 */
import type { DeviceNode, RegisterMap } from '../../shared/types'
import { encodeRegisters, decodeRegisters, registerOffset, WORDS_OF } from '../engine/registers'
import { applyWriteback } from '../engine/signals'
import { broadcast } from '../bus'
import { saveConfig } from '../store'

export interface RegisterSpace {
  /** 读一个 word(area=holding/input,offset 协议偏移) */
  readWord: (area: string, offset: number) => number
  /** 读连续 words */
  readWords: (area: string, offset: number, count: number) => number[]
  /** 写连续 words(FC06 单 = count 1;同步回灌) */
  writeWords: (area: string, offset: number, values: number[]) => void
  readCoils: (offset: number, count: number) => boolean[]
  writeCoil: (offset: number, value: boolean) => void
}

export function createRegisterSpace(node: DeviceNode): RegisterSpace {
  const maps = node.config.registerMaps ?? []
  const shadow = new Map<number, number>()
  const coils = new Array<boolean>(1024).fill(false)

  // 映射索引:word0(起点)/word1(起点+1,仅多 word 类型)
  const startByOffset = new Map<number, RegisterMap>()
  const contByOffset = new Map<number, RegisterMap>()
  for (const m of maps) {
    const off = registerOffset(m.address, m.area)
    const words = WORDS_OF[m.dataType] ?? 2
    startByOffset.set(off, m)
    if (words > 1) contByOffset.set(off + 1, m)
  }

  const sigOf = (m: RegisterMap) => (node.signals ?? []).find(s => s.id === m.signalId)

  const readWord = (area: string, offset: number): number => {
    const start = startByOffset.get(offset)
    if (start) {
      const sig = sigOf(start)
      const v = sig?.runtime?.value ?? 0
      return encodeRegisters(v, start.dataType, start.byteOrder)[0] ?? 0
    }
    const cont = contByOffset.get(offset)
    if (cont) {
      const sig = sigOf(cont)
      const v = sig?.runtime?.value ?? 0
      return encodeRegisters(v, cont.dataType, cont.byteOrder)[1] ?? 0
    }
    return shadow.get(offset) ?? 0
  }

  /** 外部写回灌:命中映射起点 → 解码 raw → 标定 → 更新信号(±联动目标 first-order.sp) */
  const writebackAt = (offset: number): void => {
    const m = startByOffset.get(offset)
    if (!m) return
    const sig = sigOf(m)
    if (!sig) return
    const words = WORDS_OF[m.dataType] ?? 2
    const pair = words === 1 ? [shadow.get(offset) ?? 0] : [shadow.get(offset) ?? 0, shadow.get(offset + 1) ?? 0]
    const raw = decodeRegisters(pair, m.dataType, m.byteOrder)
    const out = raw * (sig.scale ?? 1) + (sig.offset ?? 0)
    applyWriteback(sig, out)
    // Persist externally written setpoints; runtime-only PV ticks remain in-memory.
    saveConfig()
    // SP→PV 联动:写 SP 地址同步更新目标回路的过程目标(真实 PLC 控制语义)
    if (m.writebackTarget) {
      const target = (node.signals ?? []).find(s => s.id === m.writebackTarget)
      if (target?.runtime && target.strategy.kind === 'first-order') target.strategy.sp = out
    }
    broadcast({ type: 'signal.update', payload: { nodeId: node.id, signals: [{ id: sig.id, name: sig.name, value: sig.runtime?.value ?? 0, unit: sig.unit, written: true }], at: Date.now() } })
  }

  const writeWords = (area: string, offset: number, values: number[]): void => {
    for (let i = 0; i < values.length; i++) shadow.set(offset + i, values[i] & 0xFFFF)
    writebackAt(offset)
    writebackAt(offset - 1) // 首字可能是某 word 对的低位字
  }

  return {
    readWord,
    readWords: (area, offset, count) => {
      const out: number[] = []
      for (let i = 0; i < count; i++) out.push(readWord(area, offset + i))
      return out
    },
    writeWords,
    readCoils: (offset, count) => coils.slice(offset, offset + count),
    writeCoil: (offset, value) => { coils[offset] = value },
  }
}

/** vector 形状(modbus-serial ServerTCP) → RegisterSpace 转发 */
export function vectorOf(space: RegisterSpace) {
  return {
    getHoldingRegister: (addr: number) => space.readWord('holding', addr),
    getMultipleHoldingRegisters: (addr: number, length: number) => space.readWords('holding', addr, length),
    getInputRegister: (addr: number) => space.readWord('input', addr),
    readInputRegisters: (addr: number, length: number) => space.readWords('input', addr, length),
    setRegister: (addr: number, value: number) => space.writeWords('holding', addr, [value]),
    setMultipleRegisters: (addr: number, values: number[]) => space.writeWords('holding', addr, values),
    readCoils: () => space.readCoils(0, 16),
    readDiscreteInputs: () => new Array(16).fill(false),
    writeCoil: (addr: number, value: boolean) => space.writeCoil(addr, value),
    writeMultipleCoils: () => {},
  }
}
