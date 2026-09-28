/**
 * 模块头 / 写读输入输出类型 / 工程量↔原始值纯函数
 * (由 server/services/workshop/dcw/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwDriverKind } from '../../../../../shared/dcw-protocol'
import { createRequire } from 'node:module'

/**
 * DCW 写控制驱动 —— 工艺参数写命令的生产者抽象(与数采读驱动对称)。
 *
 * 系统封装边界:用户只提供工程量(物理含义的真实值);驱动负责
 *   ① 工程量 → 原始值线性换算(节点元数据 engMin/engMax ↔ rawMin/rawMax)
 *   ② 原始值编码(数据类型 + 字节序)→ 写 PLC 寄存器/节点
 *   ③ 回读校验(同址读回 → 换算回工程量 → 死区容差比较)→ ACK
 * 连接层复用数采驱动池(同一 PLC 读写共用 TCP 连接/OPC UA 会话)。
 *
 * 注意:本模块不得 import ./registry —— 驱动实现都从 ./shared 取换算纯函数,
 * 反向依赖会形成 registry→driver→shared→registry 环,entry=驱动文件时 TDZ 爆炸
 * (读能力判定 supportsDcwRead 因此放在 registry.ts)。
 */

export const reqNative = createRequire(import.meta.url)

export interface DcwWriteInput {
  /** 工程值(用户语义,已过工艺量程校验) */
  eng: number
  /** 回读容差(工程量;runtime 按量程/精度推导) */
  tolerance: number
  /** 节点工艺量程(换算缺省工程域) */
  domain: { min: number, max: number }
  driverConfig: Record<string, unknown>
}

export interface DcwWriteResult {
  ok: boolean
  message: string
  /** 原始值(换算后,PLC 语义) */
  raw: number | null
  /** 回读换算回的工程值 */
  readback: number | null
}

export interface DcwWriteDriver {
  readonly kind: DcwDriverKind
  available(): Promise<boolean>
  write(input: DcwWriteInput): Promise<DcwWriteResult>
  test(driverConfig: Record<string, unknown>): Promise<{ ok: boolean, message: string }>
  /** 读当前 PLC 值(可选原语;不支持读的驱动为 undefined,网关按 supportsRead 收敛) */
  read?(input: DcwReadInput): Promise<DcwReadResult>
}

export interface DcwReadInput {
  /** 节点工艺量程(原始值↔工程量映射缺省域) */
  domain: { min: number, max: number }
  driverConfig: Record<string, unknown>
}

export interface DcwReadResult {
  ok: boolean
  message: string
  /** 工程量(PLC 语义;寄存器驱动 = 原始值解码后映射,直写型驱动 = 节点值本身) */
  eng: number | null
  /** 原始值(寄存器解码;非寄存器驱动与 eng 同源) */
  raw: number | null
}

export const num = (v: unknown): number | undefined => {
  const n = Number(v)
  return v !== '' && v != null && Number.isFinite(n) ? n : undefined
}

/**
 * 工程量 → 原始值:线性映射 eng ∈ [engMin, engMax] ↔ raw ∈ [rawMin, rawMax]。
 * 未提供原始量程时 raw = eng(float32 直写;int 类型仍需映射,缺省按量程直传并取整)。
 */
export function engToRaw(eng: number, input: DcwWriteInput): number {
  const cfg = input.driverConfig
  const rawMin = num(cfg.rawMin)
  const rawMax = num(cfg.rawMax)
  if (rawMin === undefined || rawMax === undefined || rawMax === rawMin) return eng
  const engMin = num(cfg.engMin) ?? input.domain.min
  const engMax = num(cfg.engMax) ?? input.domain.max
  if (engMax === engMin) return eng
  return rawMin + ((eng - engMin) / (engMax - engMin)) * (rawMax - rawMin)
}

/** 原始值 → 工程量(回读换算;映射参数对称) */
export function rawToEng(raw: number, input: DcwWriteInput): number {
  const cfg = input.driverConfig
  const rawMin = num(cfg.rawMin)
  const rawMax = num(cfg.rawMax)
  if (rawMin === undefined || rawMax === undefined || rawMax === rawMin) return raw
  const engMin = num(cfg.engMin) ?? input.domain.min
  const engMax = num(cfg.engMax) ?? input.domain.max
  if (rawMax === rawMin) return engMin
  return engMin + ((raw - rawMin) / (rawMax - rawMin)) * (engMax - engMin)
}

/**
 * 同址回读判定与 ACK 拼装(写驱动共用出口):
 * ① ok 判据 = 回读值有限 且 |回读-设定| ≤ 容差 —— 网关与调控闭环只看本布尔;
 * ② 文案统一口径(一致 / 超容差含容差值),寄存器驱动经 rawNote 携带原始值标注。
 * 非有限回读(如 OPC UA 返回非数值)一律按未确认处理,readback 归一为 null。
 */
export function readbackAck(
  input: DcwWriteInput,
  back: number | null,
  opts: { raw: number | null, rawNote?: string },
): DcwWriteResult {
  const readback = typeof back === 'number' && Number.isFinite(back) ? back : null
  const ok = readback != null && Math.abs(readback - input.eng) <= input.tolerance
  const backTxt = readback != null ? String(Number(readback.toFixed(4))) : '非数值'
  const message = ok
    ? `写入并回读一致:${input.eng}${opts.rawNote ? ` → raw ${opts.rawNote}` : ''},回读 ${backTxt}`
    : `回读偏差超容差:写 ${input.eng},回读 ${backTxt}(容差 ${input.tolerance})`
  return { ok, message, raw: opts.raw, readback }
}

/** 原始值 → 寄存器字序(数据类型 + 字节序;与数采 decodeRegisters 互逆) */
export function encodeWords(raw: number, dataType: string, byteOrder: string): number[] {
  if (dataType === 'int16' || dataType === 'uint16') return [raw & 0xFFFF]
  const buf = Buffer.alloc(4)
  if (dataType === 'float32') buf.writeFloatBE(raw, 0)
  else if (dataType === 'uint32') buf.writeUInt32BE(raw, 0)
  else buf.writeInt32BE(raw, 0)
  const B = [buf[0]!, buf[1]!, buf[2]!, buf[3]!]
  const word = (hi: number, lo: number) => ((hi & 0xFF) << 8) | (lo & 0xFF)
  if (byteOrder === 'little') return [word(B[1]!, B[0]!), word(B[3]!, B[2]!)]
  if (byteOrder === 'wordSwap') return [word(B[2]!, B[3]!), word(B[0]!, B[1]!)]
  return [word(B[0]!, B[1]!), word(B[2]!, B[3]!)]
}
