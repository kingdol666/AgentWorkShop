/**
 * DAQ 采集驱动 —— 采样值的生产者抽象(工业协议接入点)。
 *
 * 契约(DaqDriver):
 *  - sample():控制器生产循环按节点周期调用,返回工程量读数;
 *  - test():连接测试(建连 + 读一次),前端"测试连接"按钮直达;
 *  - available():协议栈包是否已安装(node-opcua 体积大,动态探测)。
 *
 * 实现:
 *  - mock:内置模拟(正弦基线 + 随机游走 + 偶发越限;按 id 定相位);
 *  - modbus-tcp:modbus-serial 真实实现(连接池按 host:port:unitId 复用,
 *    保持/输入寄存器,int16~float32 解码,字节序/缩放);
 *  - opcua:node-opcua 真实实现(会话池按 endpoint 复用,NodeId 读取,
 *    安全策略/账号可选);
 *  - s7:预留(实现 nodes7 poll 后注册即可,链路零改动)。
 */
import { createLogger } from '../logger'
import { createRequire } from 'node:module'
import type { DaqDriverKind, DriverTestResult } from '../../../../shared/daq-protocol'

const log = createLogger('daq.drivers')

/** createRequire 加载原生/重型协议栈(nitro Windows 动态 import external 的 'd:' scheme 规避) */
const reqNative = createRequire(import.meta.url)

/** 采样上下文(controller 注入) */
export interface DaqSampleCtx {
  nodeId: string
  now: number
  ageMs: number
}

/** 驱动配置:模板域(采样波形/兜底量程)+ 协议连接参数(driverConfig) */
export interface DaqDriverInput {
  ctx: DaqSampleCtx
  config: { base: number, amp: number, min: number, max: number }
  /** 节点保存的协议连接参数(host/register/endpoint/nodeId...) */
  driverConfig: Record<string, unknown>
}

export interface DaqDriver {
  readonly kind: DaqDriverKind
  /** 协议栈是否可用(包缺失时 false,节点测试连接给出可行动提示) */
  available(): Promise<boolean>
  sample(input: DaqDriverInput): Promise<number | null> | number | null
  test(driverConfig: Record<string, unknown>): Promise<DriverTestResult>
}

// ============================================================
// mock 内置模拟源
// ============================================================

const hashPhase = (id: string): number => {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 628
  return h
}

interface MockState {
  phase: number
  value: number | null
  excursionLeft: number
  excursionDir: number
  excursionDepth: number
  lastAt: number
}

const g = globalThis as typeof globalThis & { __daqMockStates?: Map<string, MockState> }
function mockStates(): Map<string, MockState> {
  return g.__daqMockStates ??= new Map()
}

export const mockDaqDriver: DaqDriver = {
  kind: 'mock',
  async available() {
    return true
  },
  sample({ ctx, config }) {
    const states = mockStates()
    let st = states.get(ctx.nodeId)
    if (!st) {
      st = { phase: hashPhase(ctx.nodeId), value: null, excursionLeft: 0, excursionDir: 0, excursionDepth: 0, lastAt: ctx.now }
      states.set(ctx.nodeId, st)
    }
    const dt = Math.max(0, Math.min(ctx.now - st.lastAt, 60_000))
    st.lastAt = ctx.now
    if (st.excursionLeft <= 0 && Math.random() < 0.008 * Math.max(1, dt / 1000)) {
      st.excursionLeft = 6 + Math.floor(Math.random() * 9)
      st.excursionDir = Math.random() < 0.5 ? -1 : 1
      st.excursionDepth = (config.max - config.min) * (0.08 + Math.random() * 0.1)
    }
    const t = (ctx.ageMs + st.phase * 100) / 1000
    const sine = Math.sin(t * 0.35) * config.amp * 0.55 + Math.sin(t * 0.11 + 1.3) * config.amp * 0.3
    let v = config.base + sine
    if (st.value != null) v += (config.base - st.value) * 0.06 + (Math.random() - 0.5) * config.amp * 0.5
    if (st.excursionLeft > 0) {
      st.excursionLeft -= 1
      const ramp = Math.min(1, (10 - st.excursionLeft) / 4)
      v += st.excursionDir * st.excursionDepth * (0.4 + 0.6 * ramp)
      if (st.excursionLeft === 0) st.excursionDir = 0
    }
    v = Math.min(config.max + config.amp * 2.2, Math.max(config.min - config.amp * 2.2, v))
    st.value = v
    return v
  },
  async test() {
    return { ok: true, message: 'Mock 驱动无需连接,采样即模拟波形' }
  },
}

// ============================================================
// Modbus TCP 真实驱动(modbus-serial;连接池按 host:port:unitId 复用)
// ============================================================

export interface ModbusConn {
  client: import('modbus-serial').ModbusRTU
  lastUsed: number
  /** 连接级操作队列尾(采/控共用链路串行化:TCP 网关并发事务会协议错乱) */
  tail: Promise<unknown>
  /** 在队列中等待/执行中的操作数(0 = 链路空闲) */
  pending: number
  errors: number
}

const modbusPool = new Map<string, ModbusConn>()
/** 空闲连接回收(10 分钟未用断开;采样周期最长 60s,足够保守) */
const MODBUS_IDLE_MS = 600_000

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
 * 连接级排队执行:操作串行入队,完成后链路归还。
 * 数控写入等当前采样读完成再执行(不再 409 快速失败);数采采样忙时仍跳帧让路防堆积。
 */
export function withModbusConn<R>(conn: ModbusConn, fn: () => Promise<R>): Promise<R> {
  conn.pending++
  const run = conn.tail.then(() => fn(), () => fn())
  conn.tail = run.then(
    () => { conn.pending-- },
    () => { conn.pending-- },
  )
  return run
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
      await existing.client.close()
    }
    catch { /* 已断 */ }
    modbusPool.delete(key)
  }
  // CJS 互操作:require 形状可能是 { ModbusRTU } / default.ModbusRTU / 构造器本身
  const mod = reqNative('modbus-serial') as unknown as { ModbusRTU?: unknown, default?: { ModbusRTU?: unknown } | unknown }
  const ModbusRTU = (mod.ModbusRTU ?? (mod.default as { ModbusRTU?: unknown } | undefined)?.ModbusRTU ?? mod) as new () => import('modbus-serial').ModbusRTU
  const client = new ModbusRTU()
  client.setTimeout(3000)
  // tcp = Modbus TCP(MBAP 封装);rtu-tcp = RTU over TCP(串口网关透传,CRC16 帧,无 MBAP)
  if (transport === 'rtu-tcp')
    await client.connectTcpRTUBuffered(String(cfg.host), { port: Number(cfg.port ?? 502) })
  else
    await client.connectTCP(String(cfg.host), { port: Number(cfg.port ?? 502) })
  client.setID(Number(cfg.unitId ?? 1))
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

export const WORDS_OF: Record<string, number> = { int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2 }

async function modbusRead(conn: ModbusConn, cfg: Record<string, unknown>, transport: ModbusTransport = 'tcp'): Promise<number> {
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
          await conn.client.close()
          modbusPool.delete(key)
        }
      }
      catch { /* ignore */ }
      return { ok: false, message: `Modbus 连接失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// 空闲回收 sweep(挂 globalThis 防 HMR 重复)
const sweepGlobal = globalThis as typeof globalThis & { __daqModbusSweep?: NodeJS.Timeout }
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

// ============================================================
// OPC UA 真实驱动(node-opcua;会话池按 endpoint+账号 复用)
// ============================================================

export interface OpcUaConn {
  session: import('node-opcua').ClientSession
  client: import('node-opcua').OPCUAClient
  lastUsed: number
  errors: number
}

const opcuaPool = new Map<string, OpcUaConn>()

// OPC UA 会话空闲回收(对照 modbus 池 sweep;节点删除/端点弃用后不再有读取
// 路径触发 3 错误驱逐,无 sweep 会话与 TCP 连接会永久驻留)
const OPCUA_IDLE_MS = 600_000
const opcuaSweepGlobal = globalThis as typeof globalThis & { __daqOpcUaSweep?: NodeJS.Timeout }
if (!opcuaSweepGlobal.__daqOpcUaSweep) {
  opcuaSweepGlobal.__daqOpcUaSweep = setInterval(() => {
    const now = Date.now()
    for (const [key, conn] of opcuaPool) {
      if (now - conn.lastUsed > OPCUA_IDLE_MS) {
        try {
          void conn.session.close()
        }
        catch { /* ignore */ }
        try {
          void conn.client.disconnect()
        }
        catch { /* ignore */ }
        opcuaPool.delete(key)
      }
    }
  }, 120_000)
  opcuaSweepGlobal.__daqOpcUaSweep.unref?.()
}

export function opcuaKey(cfg: Record<string, unknown>): string {
  // S3:证书/安全模式必须纳入池 key——不同证书/安全策略绝不能复用同一连接
  return `${cfg.endpoint}|${cfg.username ?? ''}|${cfg.securityMode ?? 'None'}|${cfg.certificateFile ?? ''}|${cfg.privateKeyFile ?? ''}`
}

export async function getOpcUaConn(cfg: Record<string, unknown>): Promise<OpcUaConn> {
  const key = opcuaKey(cfg)
  const existing = opcuaPool.get(key)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing
  }
  const opcua = reqNative('node-opcua') as typeof import('node-opcua')
  const securityMode = (['None', 'Sign', 'SignAndEncrypt'] as const).includes(cfg.securityMode as 'None')
    ? (cfg.securityMode as 'None')
    : 'None'
  if (securityMode === 'None' && process.env.NODE_ENV === 'production') {
    log.warn(`[daq-opcua] WARN:节点 endpoint=${String(cfg.endpoint)} 使用 securityMode=None(匿名/明文),仅限测试环境;生产请配置 Sign/SignAndEncrypt + 证书`)
  }
  const clientOpts: Record<string, unknown> = {
    endpointMustExist: false,
    securityMode: opcua.MessageSecurityMode[securityMode],
    securityPolicy: securityMode === 'None' ? opcua.SecurityPolicy.None : opcua.SecurityPolicy.Basic256Sha256,
    connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 2000 },
    requestTimeout: 4000,
  }
  // S3:自签客户端证书/私钥(可选;driverConfig 透传,存储层 Record 无需改)
  const certFile = typeof cfg.certificateFile === 'string' && cfg.certificateFile ? cfg.certificateFile : ''
  const keyFile = typeof cfg.privateKeyFile === 'string' && cfg.privateKeyFile ? cfg.privateKeyFile : ''
  if (securityMode !== 'None') {
    if (certFile && keyFile) {
      const fs = reqNative('node:fs') as typeof import('node:fs')
      clientOpts.certificateFile = fs.readFileSync(certFile)
      clientOpts.privateKeyFile = keyFile
    }
    else {
      // 无证书时由 node-opcua 自动生成自签证书(仍加密,但身份不可信);生产建议显式证书
      log.warn(`[daq-opcua] WARN:securityMode=${securityMode} 但未配置 certificateFile/privateKeyFile,将使用自动生成自签证书`)
    }
  }
  const client = opcua.OPCUAClient.create(clientOpts as Parameters<typeof opcua.OPCUAClient.create>[0])
  await client.connect(String(cfg.endpoint))
  const session = cfg.username
    ? await client.createSession({ userName: String(cfg.username), password: String(cfg.password ?? '') })
    : await client.createSession()
  const conn: OpcUaConn = { session, client, lastUsed: Date.now(), errors: 0 }
  opcuaPool.set(key, conn)
  return conn
}

async function opcuaRead(conn: OpcUaConn, cfg: Record<string, unknown>): Promise<number> {
  const opcua = reqNative('node-opcua') as typeof import('node-opcua')
  const node = opcua.coerceNodeId(String(cfg.nodeId ?? ''))
  const dv = await conn.session.read({ nodeId: node, attributeId: opcua.AttributeIds.Value })
  if (dv.statusCode.value !== 0) {
    throw new Error(`NodeId 读取状态异常: 0x${dv.statusCode.value.toString(16)}(检查 ns 与标识)`)
  }
  const v = dv.value?.value
  const num = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(num)) throw new Error(`值类型不可数值化: ${typeof v}`)
  return num
}

export const opcUaDriver: DaqDriver = {
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
  async sample({ driverConfig }) {
    const conn = await getOpcUaConn(driverConfig)
    try {
      const v = await opcuaRead(conn, driverConfig)
      conn.errors = 0
      return v
    }
    catch (err) {
      conn.errors++
      if (conn.errors >= 3) {
        try {
          await conn.session.close()
        }
        catch { /* ignore */ }
        try {
          await conn.client.disconnect()
        }
        catch { /* ignore */ }
        opcuaPool.delete(opcuaKey(driverConfig))
      }
      throw err
    }
  },
  async test(driverConfig) {
    const t0 = Date.now()
    try {
      if (!driverConfig.endpoint) return { ok: false, message: '缺少端点 endpoint(opc.tcp://…)' }
      if (!driverConfig.nodeId) return { ok: false, message: '缺少节点 ID nodeId(ns=…;s=…)' }
      const conn = await getOpcUaConn(driverConfig)
      const v = await opcuaRead(conn, driverConfig)
      return {
        ok: true,
        message: `会话建立成功,读取 ${driverConfig.nodeId} = ${v}`,
        sampleValue: v,
        latencyMs: Date.now() - t0,
      }
    }
    catch (err) {
      return { ok: false, message: `OPC UA 连接失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

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
          await conn.client.close()
          modbusPool.delete(modbusKey(driverConfig, 'rtu-tcp'))
        }
      }
      catch { /* ignore */ }
      return { ok: false, message: `Modbus RTU 连接失败: ${err instanceof Error ? `${err.message}(${JSON.stringify({ ...(err as object), name: err.name })})` : String(err)}` }
    }
  },
}

// ============================================================
// MQTT 真实驱动(mqtt 包;broker 连接池复用,订阅缓存 topic 最新报文)
// ============================================================

export interface MqttConn {
  client: import('mqtt').MqttClient
  /** topic → 最新原始报文(解析按节点 jsonPath 在采样时进行) */
  topics: Map<string, { raw: string, at: number }>
}

const mqttPool = new Map<string, MqttConn>()

function mqttKey(cfg: Record<string, unknown>): string {
  return `mqtt://${cfg.host}:${cfg.port ?? 1883}|${cfg.username ?? ''}`
}

async function getMqttConn(cfg: Record<string, unknown>): Promise<MqttConn> {
  const key = mqttKey(cfg)
  const existing = mqttPool.get(key)
  if (existing) return existing
  const mqtt = reqNative('mqtt') as typeof import('mqtt')
  const url = `mqtt://${String(cfg.host)}:${Number(cfg.port ?? 1883)}`
  const client = await new Promise<import('mqtt').MqttClient>((resolve, reject) => {
    const c = mqtt.connect(url, {
      username: cfg.username ? String(cfg.username) : undefined,
      password: cfg.password ? String(cfg.password) : undefined,
      connectTimeout: 4000,
      reconnectPeriod: 5000,
    })
    c.once('connect', () => resolve(c))
    c.once('error', (err) => {
      try {
        c.end(true)
      }
      catch { /* 未连上 */ }
      reject(new Error(`MQTT 连接失败: ${err.message}`))
    })
  })
  const conn: MqttConn = { client, topics: new Map() }
  client.on('message', (topic, payload) => {
    const t = conn.topics.get(topic)
    if (t) {
      t.raw = payload.toString()
      t.at = Date.now()
    }
  })
  client.on('close', () => {
    // 断线期间清空缓存,避免恢复后消费陈旧值
    for (const t of conn.topics.values()) {
      t.raw = ''
      t.at = 0
    }
  })
  mqttPool.set(key, conn)
  return conn
}

/** 从报文提取数值:纯数字直取;JSON 按路径(jsonPath,点分隔含数组下标)取 */
export function extractNumeric(text: string, jsonPath?: string): number {
  const trimmed = text.trim()
  const direct = Number(trimmed)
  if (Number.isFinite(direct) && trimmed !== '') return direct
  const parsed: unknown = JSON.parse(trimmed)
  const target = jsonPath
    ? jsonPath.split('.').reduce<unknown>((acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]), parsed)
    : parsed
  const num = typeof target === 'number' ? target : Number(target)
  if (!Number.isFinite(num)) throw new Error(`无法提取数值(jsonPath=${jsonPath || '未配置'};报文 ${trimmed.slice(0, 60)})`)
  return num
}

/** HTTP 请求头解析(headersJSON → Record;非法输入给可读错误) */
export function parseHeaders(headersJSON: unknown): Record<string, string> {
  if (!headersJSON || !String(headersJSON).trim()) return {}
  const parsed: unknown = JSON.parse(String(headersJSON))
  if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) throw new Error('headersJSON 必须是 JSON 对象')
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) out[k] = String(v)
  return out
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export const mqttDaqDriver: DaqDriver = {
  kind: 'mqtt',
  async available() {
    try {
      reqNative('mqtt')
      return true
    }
    catch {
      return false
    }
  },
  async sample({ driverConfig }) {
    const topic = String(driverConfig.topic ?? '')
    if (!topic) throw new Error('缺少主题 topic')
    const conn = await getMqttConn(driverConfig)
    if (!conn.topics.has(topic)) {
      conn.topics.set(topic, { raw: '', at: 0 })
      await new Promise<void>((resolve, reject) => {
        conn.client.subscribe(topic, (err) => {
          if (err)
            reject(new Error(`订阅失败: ${err.message}`))
          else
            resolve()
        })
      })
    }
    // 首帧等待(最多 3s):之后由消息事件持续刷新缓存
    const entry = conn.topics.get(topic)!
    const t0 = Date.now()
    while (!entry.raw && Date.now() - t0 < 3000) await sleep(100)
    if (!entry.raw) return null
    return extractNumeric(entry.raw, driverConfig.jsonPath ? String(driverConfig.jsonPath) : undefined)
  },
  async test(driverConfig) {
    const t0 = Date.now()
    try {
      if (!driverConfig.host) return { ok: false, message: '缺少 Broker 地址 host' }
      if (!driverConfig.topic) return { ok: false, message: '缺少主题 topic' }
      const conn = await getMqttConn(driverConfig)
      const topic = String(driverConfig.topic)
      if (!conn.topics.has(topic)) {
        conn.topics.set(topic, { raw: '', at: 0 })
        await new Promise<void>((resolve, reject) => {
          conn.client.subscribe(topic, (err) => {
            if (err)
              reject(new Error(`订阅失败: ${err.message}`))
            else
              resolve()
          })
        })
      }
      const entry = conn.topics.get(topic)!
      const t1 = Date.now()
      while (!entry.raw && Date.now() - t1 < 4000) await sleep(100)
      if (entry.raw) {
        const v = extractNumeric(entry.raw, driverConfig.jsonPath ? String(driverConfig.jsonPath) : undefined)
        return { ok: true, message: `Broker 连接成功,收到 ${topic} = ${v}`, sampleValue: v, latencyMs: Date.now() - t0 }
      }
      return {
        ok: true,
        message: `Broker 已连接并订阅 ${topic}(4s 内未收到消息;设备发布后采样即开始)`,
        latencyMs: Date.now() - t0,
      }
    }
    catch (err) {
      return { ok: false, message: `MQTT 连接失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// ============================================================
// HTTP/REST 轮询真实驱动(无状态 GET;JSON 路径或纯文本取值)
// ============================================================

export const httpDaqDriver: DaqDriver = {
  kind: 'http',
  async available() {
    return true
  },
  async sample({ driverConfig }) {
    if (!driverConfig.url) throw new Error('缺少接口地址 url')
    const headers = parseHeaders(driverConfig.headersJSON)
    const res = await fetch(String(driverConfig.url), { headers, signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    return extractNumeric(text, driverConfig.jsonPath ? String(driverConfig.jsonPath) : undefined)
  },
  async test(driverConfig) {
    const t0 = Date.now()
    try {
      if (!driverConfig.url) return { ok: false, message: '缺少接口地址 url' }
      const headers = parseHeaders(driverConfig.headersJSON)
      const res = await fetch(String(driverConfig.url), { headers, signal: AbortSignal.timeout(5000) })
      if (!res.ok) return { ok: false, message: `接口返回 HTTP ${res.status}` }
      const text = await res.text()
      const v = extractNumeric(text, driverConfig.jsonPath ? String(driverConfig.jsonPath) : undefined)
      return { ok: true, message: `接口可达,取值 = ${v}`, sampleValue: v, latencyMs: Date.now() - t0 }
    }
    catch (err) {
      return { ok: false, message: `HTTP 请求失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// ============================================================
// S7 预留
// ============================================================

class PlannedProtocolStub implements DaqDriver {
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

// ============================================================
// 注册表 + 解析(旧命名归一)
// ============================================================

const REGISTRY: Record<DaqDriverKind, DaqDriver> = {
  'mock': mockDaqDriver,
  'modbus-tcp': modbusTcpDriver,
  'modbus-rtu': modbusRtuDriver,
  'opcua': opcUaDriver,
  'mqtt': mqttDaqDriver,
  'http': httpDaqDriver,
  's7': new PlannedProtocolStub('s7', 'S7comm'),
}

export function normalizeDriverKind(kind: string): DaqDriverKind {
  if (kind === 'modbus') return 'modbus-tcp'
  if (kind === 'rtu' || kind === 'modbus-rtu-tcp') return 'modbus-rtu'
  return (kind in REGISTRY ? kind : 'mock') as DaqDriverKind
}

export function resolveDaqDriver(kind: DaqDriverKind): DaqDriver {
  return REGISTRY[kind] ?? mockDaqDriver
}

/** 驱动可用性探测(meta 报告:包缺失时 UI 显示"未安装"而非硬失败) */
export async function probeDriverAvailability(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {}
  for (const [kind, drv] of Object.entries(REGISTRY)) {
    try {
      out[kind] = await drv.available()
    }
    catch {
      out[kind] = false
    }
  }
  return out
}
