/**
 * Modbus RTU over TCP 写驱动(串口网关透传)
 * (由 server/services/workshop/dcw/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwWriteDriver, DcwWriteInput, DcwWriteResult } from './shared'
import { AppError } from '../../../../utils/errors'
import { classifyCommError, decodeRegisters, evictModbusConn, getModbusConn, registerOffset, withModbusConn } from '../../daq/drivers'
import { encodeWords, engToRaw, rawToEng, reqNative } from './shared'
import { modbusRead } from './modbus'

// ============================================================
// Modbus RTU over TCP 写驱动(串口网关透传;写保持寄存器 + 同址回读)
// ============================================================

export async function modbusRtuWrite(input: DcwWriteInput): Promise<DcwWriteResult> {
  const cfg = input.driverConfig
  if (!cfg.host) throw new AppError(400, 'BAD_REQUEST', '缺少网关地址 host')
  if (cfg.register == null) throw new AppError(400, 'BAD_REQUEST', '缺少写寄存器地址 register')
  const dataType = String(cfg.dataType ?? 'float32')
  const byteOrder = String(cfg.byteOrder ?? 'big')
  const raw = engToRaw(input.eng, input)
  const rounded = dataType === 'float32' ? raw : Math.round(raw)
  const words = encodeWords(rounded, dataType, byteOrder)
  const offset = registerOffset(Number(cfg.register ?? 0), 'holding')
  const conn = await getModbusConn(cfg, 'rtu-tcp')
  conn.lastUsed = Date.now()
  return withModbusConn(conn, async (): Promise<DcwWriteResult> => {
    try {
      await conn.client.writeRegisters(offset, words)
      const rb = await conn.client.readHoldingRegisters(offset, words.length)
      const rawBack = decodeRegisters(rb.data as number[], dataType, byteOrder)
      const engBack = rawToEng(rawBack, input)
      const ok = Math.abs(engBack - input.eng) <= input.tolerance
      conn.errors = 0
      return {
        ok,
        message: ok
          ? `写入并回读一致:${input.eng} → raw ${rounded},回读 ${Number(engBack.toFixed(4))}`
          : `回读偏差超容差:写 ${input.eng},回读 ${Number(engBack.toFixed(4))}(容差 ${input.tolerance})`,
        raw: rounded,
        readback: engBack,
      }
    }
    catch (err) {
      conn.errors++
      if (conn.errors >= 3) evictModbusConn(cfg, 'rtu-tcp')
      throw err
    }
  })
}

export const modbusRtuDcwDriver: DcwWriteDriver = {
  kind: 'modbus-rtu',
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
      return await modbusRtuWrite(input)
    }
    catch (err) {
      if (err instanceof AppError) throw err
      return { ok: false, message: `Modbus RTU 写入失败: ${classifyCommError(err)}`, raw: null, readback: null }
    }
  },
  async read(input) {
    try {
      return await modbusRead(input, 'rtu-tcp')
    }
    catch (err) {
      return { ok: false, message: `Modbus RTU 读取失败: ${classifyCommError(err)}`, eng: null, raw: null }
    }
  },
  async test(driverConfig) {
    const t0 = Date.now()
    try {
      if (!driverConfig.host) return { ok: false, message: '缺少网关地址 host' }
      if (driverConfig.register == null) return { ok: false, message: '缺少写寄存器地址 register' }
      const conn = await getModbusConn(driverConfig, 'rtu-tcp')
      await withModbusConn(conn, () => conn.client.readHoldingRegisters(registerOffset(Number(driverConfig.register ?? 0), 'holding'), 1))
      return { ok: true, message: `网关连接成功,写寄存器可访问(${Date.now() - t0}ms)` }
    }
    catch (err) {
      return { ok: false, message: classifyCommError(err) }
    }
  },
}
