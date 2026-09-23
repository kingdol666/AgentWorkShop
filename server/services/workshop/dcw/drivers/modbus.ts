/**
 * Modbus 读原语(TCP/RTU 共用)与 Modbus TCP 写驱动
 * (由 server/services/workshop/dcw/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwReadInput, DcwReadResult, DcwWriteDriver, DcwWriteInput, DcwWriteResult } from './shared'
import { AppError } from '../../../../utils/errors'
import { classifyCommError, closeModbusSafely, decodeRegisters, evictModbusConn, getModbusConn, modbusKey, registerOffset, withModbusConn } from '../../daq/drivers'
import { encodeWords, engToRaw, rawToEng, reqNative } from './shared'

// ============================================================
// Modbus 读原语(TCP/RTU 共用;读保持寄存器 → 解码 → 工程量映射)
// ============================================================

export function wordsOf(dataType: string): number {
  return dataType === 'int16' || dataType === 'uint16' ? 1 : 2
}

export async function modbusRead(input: DcwReadInput, transport: 'tcp' | 'rtu-tcp'): Promise<DcwReadResult> {
  const cfg = input.driverConfig
  if (!cfg.host) throw new AppError(400, 'BAD_REQUEST', '缺少设备地址 host')
  if (cfg.register == null) throw new AppError(400, 'BAD_REQUEST', '缺少寄存器地址 register')
  const dataType = String(cfg.dataType ?? 'float32')
  const byteOrder = String(cfg.byteOrder ?? 'big')
  const offset = registerOffset(Number(cfg.register ?? 0), 'holding')
  const conn = await getModbusConn(cfg, transport)
  conn.lastUsed = Date.now()
  return withModbusConn(conn, async (): Promise<DcwReadResult> => {
    try {
      const rb = await conn.client.readHoldingRegisters(offset, wordsOf(dataType))
      const raw = decodeRegisters(rb.data as number[], dataType, byteOrder)
      // 原始值 → 工程量(与写链路同一映射;engToRaw/rawToEng 对称)
      const eng = rawToEng(raw, { eng: 0, tolerance: 0, domain: input.domain, driverConfig: cfg })
      conn.errors = 0
      return { ok: true, message: `读回 raw ${Number(raw.toFixed(4))} → eng ${Number(eng.toFixed(4))}`, eng, raw }
    }
    catch (err) {
      conn.errors++
      if (conn.errors >= 3) evictModbusConn(cfg, transport)
      throw err
    }
  })
}

// ============================================================
// Modbus TCP 写驱动(写保持寄存器 + 同址回读校验;连接池复用数采)
// ============================================================

export async function modbusWrite(input: DcwWriteInput): Promise<DcwWriteResult> {
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
  // 连接级排队:等当前数采读/其它事务完成后执行(采/控共用链路,写不再因忙被 409 拒绝)
  return withModbusConn(conn, async (): Promise<DcwWriteResult> => {
    try {
      await conn.client.writeRegisters(offset, words)
      // 回读校验:同址读回 → 解码 → 换算回工程量 → 容差比较
      const rb = area === 'holding'
        ? await conn.client.readHoldingRegisters(offset, words.length)
        : await conn.client.readInputRegisters(offset, words.length)
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
      // 与数采对称的自愈:连续故障主动断开,下次操作重建连接
      conn.errors++
      if (conn.errors >= 3) evictModbusConn(cfg)
      throw err
    }
  })
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
      return { ok: false, message: `Modbus 写入失败: ${classifyCommError(err)}`, raw: null, readback: null }
    }
  },
  async read(input) {
    try {
      return await modbusRead(input, 'tcp')
    }
    catch (err) {
      return { ok: false, message: `Modbus 读取失败: ${classifyCommError(err)}`, eng: null, raw: null }
    }
  },
  async test(driverConfig) {
    const t0 = Date.now()
    try {
      if (!driverConfig.host) return { ok: false, message: '缺少设备地址 host' }
      if (driverConfig.register == null) return { ok: false, message: '缺少写寄存器地址 register' }
      const conn = await getModbusConn(driverConfig)
      await withModbusConn(conn, () => conn.client.readHoldingRegisters(registerOffset(Number(driverConfig.register ?? 0), 'holding'), 1))
      return { ok: true, message: `连接成功,写寄存器可访问(offset=${registerOffset(Number(driverConfig.register ?? 0), 'holding')}), ${Date.now() - t0}ms` }
    }
    catch (err) {
      try {
        const key = modbusKey(driverConfig)
        const conn = await getModbusConn(driverConfig).catch(() => null)
        if (conn) await closeModbusSafely(conn.client)
        void key
      }
      catch { /* ignore */ }
      return { ok: false, message: classifyCommError(err) }
    }
  },
}
