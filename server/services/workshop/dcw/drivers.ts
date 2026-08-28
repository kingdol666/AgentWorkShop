/**
 * DCW 写控制驱动 —— 工艺参数写命令的生产者抽象(与数采读驱动对称)。
 *
 * 系统封装边界:用户只提供工程量(物理含义的真实值);驱动负责
 *   ① 工程量 → 原始值线性换算(节点元数据 engMin/engMax ↔ rawMin/rawMax)
 *   ② 原始值编码(数据类型 + 字节序)→ 写 PLC 寄存器/节点
 *   ③ 回读校验(同址读回 → 换算回工程量 → 死区容差比较)→ ACK
 * 连接层复用数采驱动池(同一 PLC 读写共用 TCP 连接/OPC UA 会话)。
 */
import { createRequire } from 'node:module'
import type { DcwDriverKind } from '../../../../shared/dcw-protocol'
import { AppError } from '../../../utils/errors'
import { decodeRegisters, getModbusConn, getOpcUaConn, modbusKey, registerOffset } from '../daq/drivers'

const reqNative = createRequire(import.meta.url)

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
}

const num = (v: unknown): number | undefined => {
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

// ============================================================
// Mock 写驱动(模拟 PLC:确定性 ACK + 回读)
// ============================================================

const mockState = globalThis as typeof globalThis & { __dcwMockPlc?: Map<string, number> }
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
  async test() {
    return { ok: true, message: 'Mock 驱动无需连接,写入即模拟 ACK' }
  },
}

// ============================================================
// Modbus TCP 写驱动(写保持寄存器 + 同址回读校验;连接池复用数采)
// ============================================================

async function modbusWrite(input: DcwWriteInput): Promise<DcwWriteResult> {
  const cfg = input.driverConfig
  if (!cfg.host) throw new AppError(400, 'BAD_REQUEST', '缺少设备地址 host')
  if (cfg.register == null) throw new AppError(400, 'BAD_REQUEST', '缺少写寄存器地址 register')
  const dataType = String(cfg.dataType ?? 'float32')
  const byteOrder = String(cfg.byteOrder ?? 'big')
  const raw = engToRaw(input.eng, input)
  const rounded = dataType === 'float32' ? raw : Math.round(raw)
  const words = encodeWords(rounded, dataType, byteOrder)
  const area = 'holding' // 写只支持保持寄存器(4x)
  const offset = registerOffset(Number(cfg.register ?? 0), area)
  const conn = await getModbusConn(cfg)
  conn.lastUsed = Date.now()
  if (conn.busy) throw new AppError(409, 'CONFLICT', '链路忙:上一读写未完成,请稍后重试')
  conn.busy = true
  try {
    await conn.client.writeRegisters(offset, words)
    // 回读校验:同址读回 → 解码 → 换算回工程量 → 容差比较
    const rb = area === 'holding'
      ? await conn.client.readHoldingRegisters(offset, words.length)
      : await conn.client.readInputRegisters(offset, words.length)
    const rawBack = decodeRegisters(rb.data as number[], dataType, byteOrder)
    const engBack = rawToEng(rawBack, input)
    const ok = Math.abs(engBack - input.eng) <= input.tolerance
    return {
      ok,
      message: ok
        ? `写入并回读一致:${input.eng} → raw ${rounded},回读 ${Number(engBack.toFixed(4))}`
        : `回读偏差超容差:写 ${input.eng},回读 ${Number(engBack.toFixed(4))}(容差 ${input.tolerance})`,
      raw: rounded,
      readback: engBack,
    }
  }
  finally {
    conn.busy = false
  }
}

export const modbusTcpDcwDriver: DcwWriteDriver = {
  kind: 'modbus-tcp',
  async available() {
    try {
      reqNative('modbus-serial')
      return true
    }
    catch {
      return false
    }
  },
  async write(input) {
    try {
      return await modbusWrite(input)
    }
    catch (err) {
      if (err instanceof AppError) throw err
      return { ok: false, message: `Modbus 写入失败: ${err instanceof Error ? err.message : String(err)}`, raw: null, readback: null }
    }
  },
  async test(driverConfig) {
    const t0 = Date.now()
    try {
      if (!driverConfig.host) return { ok: false, message: '缺少设备地址 host' }
      if (driverConfig.register == null) return { ok: false, message: '缺少写寄存器地址 register' }
      const conn = await getModbusConn(driverConfig)
      await conn.client.readHoldingRegisters(registerOffset(Number(driverConfig.register ?? 0), 'holding'), 1)
      return { ok: true, message: `连接成功,写寄存器可访问(offset=${registerOffset(Number(driverConfig.register ?? 0), 'holding')}), ${Date.now() - t0}ms` }
    }
    catch (err) {
      try {
        const key = modbusKey(driverConfig)
        const conn = await getModbusConn(driverConfig).catch(() => null)
        if (conn) await conn.client.close()
        void key
      }
      catch { /* ignore */ }
      return { ok: false, message: `Modbus 连接失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// ============================================================
// OPC UA 写驱动(写节点值 + 回读校验;会话池复用数采)
// ============================================================

async function opcuaWrite(input: DcwWriteInput): Promise<DcwWriteResult> {
  const cfg = input.driverConfig
  if (!cfg.endpoint) throw new AppError(400, 'BAD_REQUEST', '缺少端点 endpoint(opc.tcp://…)')
  if (!cfg.nodeId) throw new AppError(400, 'BAD_REQUEST', '缺少节点 ID nodeId(ns=…;s=…)')
  const conn = await getOpcUaConn(cfg)
  const opcua = reqNative('node-opcua') as typeof import('node-opcua')
  const node = opcua.coerceNodeId(String(cfg.nodeId))
  const writeResult = await conn.session.write({
    nodeId: node,
    attributeId: opcua.AttributeIds.Value,
    value: { value: { dataType: opcua.DataType.Double, value: input.eng } },
  }) as unknown as { statusCode?: { value: number } }
  const writeCode = writeResult.statusCode?.value ?? 0
  if (writeCode !== 0) {
    throw new Error(`写入状态异常: 0x${writeCode.toString(16)}`)
  }
  const dv = await conn.session.read({ nodeId: node, attributeId: opcua.AttributeIds.Value }) as unknown as { value?: { value?: number } }
  const back = typeof dv.value?.value === 'number' ? dv.value.value : Number(dv.value?.value)
  const ok = Number.isFinite(back) && Math.abs(back - input.eng) <= input.tolerance
  return {
    ok,
    message: ok
      ? `写入并回读一致:${input.eng},回读 ${Number(back.toFixed(4))}`
      : `回读偏差超容差:写 ${input.eng},回读 ${Number.isFinite(back) ? back.toFixed(4) : '非数值'}`,
    raw: input.eng,
    readback: Number.isFinite(back) ? back : null,
  }
}

export const opcUaDcwDriver: DcwWriteDriver = {
  kind: 'opcua',
  async available() {
    try {
      reqNative('node-opcua')
      return true
    }
    catch {
      return false
    }
  },
  async write(input) {
    try {
      return await opcuaWrite(input)
    }
    catch (err) {
      if (err instanceof AppError) throw err
      return { ok: false, message: `OPC UA 写入失败: ${err instanceof Error ? err.message : String(err)}`, raw: null, readback: null }
    }
  },
  async test(driverConfig) {
    try {
      if (!driverConfig.endpoint) return { ok: false, message: '缺少端点 endpoint(opc.tcp://…)' }
      if (!driverConfig.nodeId) return { ok: false, message: '缺少节点 ID nodeId(ns=…;s=…)' }
      const conn = await getOpcUaConn(driverConfig)
      const opcua = reqNative('node-opcua') as typeof import('node-opcua')
      const dv = await conn.session.read({ nodeId: opcua.coerceNodeId(String(driverConfig.nodeId)), attributeId: opcua.AttributeIds.Value }) as unknown as { status?: { value?: number }, statusCode?: { value?: number } }
      const code = dv.status?.value ?? dv.statusCode?.value ?? 0
      if (code !== 0) return { ok: false, message: `节点不可读: 0x${code.toString(16)}` }
      return { ok: true, message: `会话建立成功,写节点可访问(${String(driverConfig.nodeId)})` }
    }
    catch (err) {
      return { ok: false, message: `OPC UA 连接失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// ============================================================
// 注册表 + 解析
// ============================================================

const REGISTRY: Record<DcwDriverKind, DcwWriteDriver> = {
  'mock': mockDcwDriver,
  'modbus-tcp': modbusTcpDcwDriver,
  'opcua': opcUaDcwDriver,
}

export function normalizeDcwDriverKind(kind: string): DcwDriverKind {
  if (kind === 'modbus') return 'modbus-tcp'
  return (kind in REGISTRY ? kind : 'mock') as DcwDriverKind
}

export function resolveDcwDriver(kind: DcwDriverKind): DcwWriteDriver {
  return REGISTRY[kind] ?? mockDcwDriver
}
