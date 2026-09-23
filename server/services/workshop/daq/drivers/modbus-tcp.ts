/**
 * Modbus TCP 真实驱动(连接池按 host:port:unitId 复用)
 * (由 server/services/workshop/daq/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DaqDriver } from './shared'
import { reqNative } from './shared'

// ============================================================
// Modbus TCP 真实驱动(modbus-serial;连接池按 host:port:unitId 复用)
// ============================================================

/**
 * modbus-serial 客户端实例类型。
 *
 * 该包 index.d.ts 只写 `import { ModbusRTU } from "./ModbusRTU"` + `export default ModbusRTU`,
 * **没有**具名 re-export(运行时 module.exports = 构造器,并自挂 module.exports.default = 自己),
 * 因此 `import('modbus-serial').ModbusRTU` 在类型上并不存在 —— 从 default 导出取才与实际导出形态一致。
 */
export type ModbusRtuClient = InstanceType<typeof import('modbus-serial').default>

export interface ModbusConn {
  client: ModbusRtuClient
  lastUsed: number
  /** 连接级操作队列尾(采/控共用链路串行化:TCP 网关并发事务会协议错乱) */
  tail: Promise<unknown>
  /** 在队列中等待/执行中的操作数(0 = 链路空闲) */
  pending: number
  errors: number
}

export const modbusPool = new Map<string, ModbusConn>()
/** 空闲连接回收(10 分钟未用断开;采样周期最长 60s,足够保守) */
export const MODBUS_IDLE_MS = 600_000

export type ModbusTransport = 'tcp' | 'rtu-tcp'

/** 连续故障自愈:关闭并移除池内连接(下次操作重建) */
export function evictModbusConn(cfg: Record<string, unknown>, transport: ModbusTransport = 'tcp'): void {
  const key = modbusKey(cfg, transport)
  const conn = modbusPool.get(key)
  if (!conn) return
  try {
    void conn.client.close()
  }
  catch { /* 已断 */ }
  modbusPool.delete(key)
}

/**
 * 安全关闭:半开 socket(对端断电)时 modbus-serial close() 等待 FIN 永不返回,
 * 一律 500ms 超时保护(fire-and-forget 底层 close,调用方不阻塞)。
 */
export async function closeModbusSafely(client: ModbusRtuClient): Promise<void> {
  await Promise.race([
    Promise.resolve()
      .then(() => client.close())
      .catch(() => { /* 已断 */ }),
    new Promise(r => setTimeout(r, 500)),
  ])
}

/**
 * 连接级排队执行:操作串行入队,完成后链路归还。
 * 数控写入等当前采样读完成再执行(不再 409 快速失败);数采采样忙时仍跳帧让路防堆积。
 * per-request 3s 硬超时:半开连接(对端断电/SYN 黑洞)时底层请求永不 settle,
 * 超时后作废连接并重置 tail 链,防止单条死连接堵死该 host:port 的全部后续请求。
 */
export function withModbusConn<R>(conn: ModbusConn, fn: () => Promise<R>): Promise<R> {
  conn.pending++
  const run = conn.tail.then(() => fn(), () => fn())
  let timer: NodeJS.Timeout | undefined
  let dead = false
  const guarded: Promise<R> = Promise.race([
    run,
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        dead = true
        try {
          void conn.client.close()
        }
        catch { /* 已断 */ }
        rej(new Error('Modbus 响应超时(3s)——连接可能半开,已作废重连'))
      }, 3000)
    }),
  ])
  void guarded.catch(() => { /* 超时分支先 reject,防 unhandled */ })
  conn.tail = guarded.then(
    () => {
      clearTimeout(timer)
      conn.pending--
    },
    () => {
      clearTimeout(timer)
      conn.pending--
    },
  ).then(() => {
    if (dead) conn.tail = Promise.resolve()
  })
  return guarded
}

export function modbusKey(cfg: Record<string, unknown>, transport: ModbusTransport = 'tcp'): string {
  return `${transport}:${cfg.host}:${cfg.port ?? 502}:${cfg.unitId ?? 1}`
}

export async function getModbusConn(cfg: Record<string, unknown>, transport: ModbusTransport = 'tcp'): Promise<ModbusConn> {
  const key = modbusKey(cfg, transport)
  const existing = modbusPool.get(key)
  if (existing && existing.client.isOpen) return existing
  if (existing) {
    try {
      await closeModbusSafely(existing.client)
    }
    catch { /* 已断 */ }
    modbusPool.delete(key)
  }
  // CJS 互操作:require 形状可能是 { ModbusRTU } / default.ModbusRTU / 构造器本身
  const mod = reqNative('modbus-serial') as unknown as { ModbusRTU?: unknown, default?: { ModbusRTU?: unknown } | unknown }
  const ModbusRTU = (mod.ModbusRTU ?? (mod.default as { ModbusRTU?: unknown } | undefined)?.ModbusRTU ?? mod) as new () => ModbusRtuClient
  const client = new ModbusRTU()
  client.setTimeout(3000)
  // tcp = Modbus TCP(MBAP 封装);rtu-tcp = RTU over TCP(串口网关透传,CRC16 帧,无 MBAP)
  // 连接硬超时(3s):connectTCP 无内建超时,PLC 离线/半开连接时 SYN 黑洞会悬挂调用方
  const connect = transport === 'rtu-tcp'
    ? client.connectTcpRTUBuffered(String(cfg.host), { port: Number(cfg.port ?? 502) })
    : client.connectTCP(String(cfg.host), { port: Number(cfg.port ?? 502) })
  await Promise.race([
    connect,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`连接超时(3s)——检查 PLC 电源/IP/端口与防火墙`)), 3000)),
  ]).catch((err) => {
    try {
      void client.close()
    }
    catch { /* 未连上 */ }
    throw err
  })
  client.setID(Number(cfg.unitId ?? 1))
  // 吸收底层 socket 错误(write-after-end / ECONNRESET 等):超时作废重连路径关闭 socket 后,
  // 队列中滞留的写入会触发 modbus-serial 内部 socket.write 异步错误 —— 若不挂 error 处理器,
  // 会以 unhandledRejection 打崩进程(stability-guard fatal)。池层已有 evict 自愈,这里只需静默。
  const sock = (client as unknown as { port?: { client?: { on?: (ev: string, cb: (e: Error) => void) => void } } }).port?.client
  sock?.on?.('error', () => {})
  // write-after-end 防线:evict/close 与在飞事务竞态时,modbus-serial 仍可能对已 end/destroy 的
  // socket 调 write —— 该错误的 emit 路径并不总走 'error' 事件(实测同步抛出打崩进程,
  // ERR_STREAM_WRITE_AFTER_END)。在 socket 层直接拦截:已终结即丢弃写入,让上层超时兜底。
  const sockWritable = sock as unknown as { writableEnded?: boolean, destroyed?: boolean, write?: (...a: unknown[]) => unknown } | null
  if (sockWritable?.write) {
    const rawWrite = sockWritable.write.bind(sock)
    sockWritable.write = (...a: unknown[]) => {
      if (sockWritable.writableEnded || sockWritable.destroyed) return false
      return rawWrite(...a)
    }
  }
  const conn: ModbusConn = { client, lastUsed: Date.now(), tail: Promise.resolve(), pending: 0, errors: 0 }
  modbusPool.set(key, conn)
  return conn
}

/** 寄存器值解码(1~2 word;字节序:big/little/wordSwap) */
export function decodeRegisters(data: number[], dataType: string, byteOrder: string): number {
  if (dataType === 'int16' || dataType === 'uint16') {
    const raw = data[0] ?? 0
    return dataType === 'int16' ? (raw << 16) >> 16 : raw
  }
  // 字节序约定(寄存器字 w0=[A B], w1=[C D],float32 内存字节序按 4 字节解):
  //   big = ABCD(w0 高字在前,w0/w1 各自大端) —— Modbus 标准大端,最常用
  //   little = DCBA(全小端:w1 字节反转在前)
  //   wordSwap = CDAB(字交换:每字内部仍大端,低字在前)
  const hi = (x: number) => (x >> 8) & 0xFF
  const lo = (x: number) => x & 0xFF
  let b: number[]
  if (byteOrder === 'little') b = [hi(data[1]!), lo(data[1]!), hi(data[0]!), lo(data[0]!)].reverse()
  else if (byteOrder === 'wordSwap') b = [hi(data[1]!), lo(data[1]!), hi(data[0]!), lo(data[0]!)]
  else b = [hi(data[0]!), lo(data[0]!), hi(data[1]!), lo(data[1]!)]
  const buf = Buffer.from(b)
  if (dataType === 'float32') return buf.readFloatBE(0)
  if (dataType === 'uint32') return buf.readUInt32BE(0)
  return buf.readInt32BE(0)
}

/** 4xxxx 保持寄存器 → 协议偏移(40001 → 0);3xxxx 输入寄存器同理 */
export function registerOffset(addr: number, area: string): number {
  if (area === 'input') return addr >= 30001 ? addr - 30001 : addr
  return addr >= 40001 ? addr - 40001 : addr
}

/**
 * 通信故障分类(数采/数控共用):底层异常 → 可操作的中文诊断 + 处理提示。
 * 前端/Agent/写历史直接透出该文案,运维按提示即可定位问题层级。
 */
export function classifyCommError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const m = raw.toLowerCase()
  if (/econnrefused|connection refused|connect etimedout/.test(m) || /port connection failed/.test(m))
    return `无法建立连接——检查 PLC 电源/IP/端口与防火墙(${raw})`
  if (/etimedout|timed out|timeout/.test(m))
    return `PLC 响应超时——网络抖动或从站负载高,稍后自动重连(${raw})`
  if (/ehostunreach|enetunreach|network unreachable/.test(m))
    return `网络不可达——检查本机与 PLC 的路由/网段(${raw})`
  if (/enotfound|eai_again/.test(m))
    return `主机名无法解析——检查 host 配置(${raw})`
  if (/crc/.test(m))
    return `CRC 校验失败——串口线路干扰或波特率/校验位不匹配(${raw})`
  if (/illegal|exception|function code/.test(m))
    return `PLC 拒绝该操作——功能码或寄存器地址不被支持,检查地址区配置(${raw})`
  if (/protocol/.test(m))
    return `协议响应异常——数据长度/帧格式不符,检查寄存器数量与从站型号(${raw})`
  if (/not connected|socket|closed|econnreset/.test(m))
    return `连接已断开——将自动重建连接,若持续失败请检查线缆(${raw})`
  return raw
}

/** 4xxxx 保持寄存器 → 协议偏移(40001 → 0);3xxxx 输入寄存器同理 */
export const WORDS_OF: Record<string, number> = { int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2 }

export async function modbusRead(conn: ModbusConn, cfg: Record<string, unknown>, transport: ModbusTransport = 'tcp'): Promise<number> {
  const area = String(cfg.registerType ?? 'holding')
  const offset = registerOffset(Number(cfg.register ?? 0), area)
  const dataType = String(cfg.dataType ?? 'float32')
  const words = WORDS_OF[dataType] ?? 2
  const res = area === 'input'
    ? await conn.client.readInputRegisters(offset, words)
    : await conn.client.readHoldingRegisters(offset, words)
  const raw = decodeRegisters(res.data as number[], dataType, String(cfg.byteOrder ?? 'big'))
  const scale = Number(cfg.scale ?? 1)
  void transport
  return raw * (Number.isFinite(scale) ? scale : 1)
}

export const modbusTcpDriver: DaqDriver = {
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
  async sample({ driverConfig }) {
    const conn = await getModbusConn(driverConfig)
    // 连接级串行队列:读 ~20ms、采样周期 >=120ms,正常排队深度 1~2;仅当队列深积
    // (PLC 慢/离线,单读逼近超时)时跳帧保护,阈值 pending>8 防雪崩。
    // (不用 busy>0 一票跳帧:同链路多节点同节拍会互相跳帧,新节点长期出不了首值)
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
        // 连续故障 → 主动断开,下次采样重建(自愈)
        if (conn.errors >= 3) evictModbusConn(driverConfig)
        throw err
      }
    })
  },
  async test(driverConfig) {
    const t0 = Date.now()
    try {
      if (!driverConfig.host) return { ok: false, message: '缺少设备地址 host' }
      if (driverConfig.register == null) return { ok: false, message: '缺少寄存器地址 register' }
      const conn = await getModbusConn(driverConfig)
      const v = await withModbusConn(conn, () => modbusRead(conn, driverConfig))
      return {
        ok: true,
        message: `连接成功,读取 ${driverConfig.register} = ${v}`,
        sampleValue: v,
        latencyMs: Date.now() - t0,
      }
    }
    catch (err) {
      try {
        const key = modbusKey(driverConfig)
        const conn = modbusPool.get(key)
        if (conn) {
          await closeModbusSafely(conn.client)
          modbusPool.delete(key)
        }
      }
      catch { /* ignore */ }
      return { ok: false, message: `Modbus 连接失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// 空闲回收 sweep(挂 globalThis 防 HMR 重复)
export const sweepGlobal = globalThis as typeof globalThis & { __daqModbusSweep?: NodeJS.Timeout }
if (!sweepGlobal.__daqModbusSweep) {
  sweepGlobal.__daqModbusSweep = setInterval(() => {
    const now = Date.now()
    for (const [key, conn] of modbusPool) {
      if (now - conn.lastUsed > MODBUS_IDLE_MS && conn.pending === 0) {
        try {
          void conn.client.close()
        }
        catch { /* ignore */ }
        modbusPool.delete(key)
      }
    }
  }, 120_000)
  sweepGlobal.__daqModbusSweep.unref?.()
}
