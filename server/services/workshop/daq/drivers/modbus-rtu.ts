/**
 * Modbus RTU over TCP 真实驱动(串口网关透传)
 * (由 server/services/workshop/daq/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DaqDriver } from './shared'
import { closeModbusSafely, evictModbusConn, getModbusConn, modbusKey, modbusPool, modbusRead, withModbusConn } from './modbus-tcp'
import { reqNative } from './shared'

// ============================================================
// Modbus RTU over TCP 真实驱动(串口网关透传;connectTcpRTUBuffered,CRC16 帧)
// ============================================================

export const modbusRtuDriver: DaqDriver = {
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
  async sample({ driverConfig }) {
    const conn = await getModbusConn(driverConfig, 'rtu-tcp')
    if (conn.pending > 8) return null
    conn.lastUsed = Date.now()
    return withModbusConn(conn, async () => {
      try {
        const v = await modbusRead(conn, driverConfig)
        conn.errors = 0
        return v
      }
      catch (err) {
        conn.errors++
        if (conn.errors >= 3) evictModbusConn(driverConfig, 'rtu-tcp')
        throw err
      }
    })
  },
  async test(driverConfig) {
    const t0 = Date.now()
    try {
      if (!driverConfig.host) return { ok: false, message: '缺少网关地址 host' }
      if (driverConfig.register == null) return { ok: false, message: '缺少寄存器地址 register' }
      const conn = await getModbusConn(driverConfig, 'rtu-tcp')
      const v = await withModbusConn(conn, () => modbusRead(conn, driverConfig))
      return {
        ok: true,
        message: `网关连接成功,读取 ${driverConfig.register} = ${v}`,
        sampleValue: v,
        latencyMs: Date.now() - t0,
      }
    }
    catch (err) {
      try {
        const conn = modbusPool.get(modbusKey(driverConfig, 'rtu-tcp'))
        if (conn) {
          await closeModbusSafely(conn.client)
          modbusPool.delete(modbusKey(driverConfig, 'rtu-tcp'))
        }
      }
      catch { /* ignore */ }
      return { ok: false, message: `Modbus RTU 连接失败: ${err instanceof Error ? `${err.message}(${JSON.stringify({ ...(err as object), name: err.name })})` : String(err)}` }
    }
  },
}
