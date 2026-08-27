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
import { createRequire } from 'node:module'
import type { DaqDriverKind, DriverTestResult } from '../../../../shared/daq-protocol'

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

interface ModbusConn {
  client: import('modbus-serial').ModbusRTU
  lastUsed: number
  busy: boolean
  errors: number
}

const modbusPool = new Map<string, ModbusConn>()
/** 空闲连接回收(10 分钟未用断开;采样周期最长 60s,足够保守) */
const MODBUS_IDLE_MS = 600_000

function modbusKey(cfg: Record<string, unknown>): string {
  return `${cfg.host}:${cfg.port ?? 502}:${cfg.unitId ?? 1}`
}

async function getModbusConn(cfg: Record<string, unknown>): Promise<ModbusConn> {
  const key = modbusKey(cfg)
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
  await client.connectTCP(String(cfg.host), { port: Number(cfg.port ?? 502) })
  client.setID(Number(cfg.unitId ?? 1))
  const conn: ModbusConn = { client, lastUsed: Date.now(), busy: false, errors: 0 }
  modbusPool.set(key, conn)
  return conn
}

/** 寄存器值解码(1~2 word;字节序:big/little/wordSwap) */
function decodeRegisters(data: number[], dataType: string, byteOrder: string): number {
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
function registerOffset(addr: number, area: string): number {
  if (area === 'input') return addr >= 30001 ? addr - 30001 : addr
  return addr >= 40001 ? addr - 40001 : addr
}

const WORDS_OF: Record<string, number> = { int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2 }

async function modbusRead(conn: ModbusConn, cfg: Record<string, unknown>): Promise<number> {
  const area = String(cfg.registerType ?? 'holding')
  const offset = registerOffset(Number(cfg.register ?? 0), area)
  const dataType = String(cfg.dataType ?? 'float32')
  const words = WORDS_OF[dataType] ?? 2
  const res = area === 'input'
    ? await conn.client.readInputRegisters(offset, words)
    : await conn.client.readHoldingRegisters(offset, words)
  const raw = decodeRegisters(res.data as number[], dataType, String(cfg.byteOrder ?? 'big'))
  const scale = Number(cfg.scale ?? 1)
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
    conn.lastUsed = Date.now()
    try {
      const v = await modbusRead(conn, driverConfig)
      conn.errors = 0
      return v
    }
    catch (err) {
      conn.errors++
      // 连续故障 → 主动断开,下次采样重建(自愈)
      if (conn.errors >= 3) {
        try {
          await conn.client.close()
        }
        catch { /* ignore */ }
        modbusPool.delete(modbusKey(driverConfig))
      }
      throw err
    }
  },
  async test(driverConfig) {
    const t0 = Date.now()
    try {
      if (!driverConfig.host) return { ok: false, message: '缺少设备地址 host' }
      if (driverConfig.register == null) return { ok: false, message: '缺少寄存器地址 register' }
      const conn = await getModbusConn(driverConfig)
      const v = await modbusRead(conn, driverConfig)
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
      if (now - conn.lastUsed > MODBUS_IDLE_MS && !conn.busy) {
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

interface OpcUaConn {
  session: import('node-opcua').ClientSession
  client: import('node-opcua').OPCUAClient
  lastUsed: number
  errors: number
}

const opcuaPool = new Map<string, OpcUaConn>()

function opcuaKey(cfg: Record<string, unknown>): string {
  return `${cfg.endpoint}|${cfg.username ?? ''}`
}

async function getOpcUaConn(cfg: Record<string, unknown>): Promise<OpcUaConn> {
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
  const client = opcua.OPCUAClient.create({
    endpointMustExist: false,
    securityMode: opcua.MessageSecurityMode[securityMode],
    securityPolicy: securityMode === 'None' ? opcua.SecurityPolicy.None : opcua.SecurityPolicy.Basic256Sha256,
    connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 2000 },
    requestTimeout: 4000,
  })
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
  'opcua': opcUaDriver,
  's7': new PlannedProtocolStub('s7', 'S7comm'),
}

export function normalizeDriverKind(kind: string): DaqDriverKind {
  if (kind === 'modbus') return 'modbus-tcp'
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
