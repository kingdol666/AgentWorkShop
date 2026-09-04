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
import { classifyCommError, decodeRegisters, evictModbusConn, evictOpcUaConn, getModbusConn, getOpcUaConn, modbusKey, registerOffset, withModbusConn } from '../daq/drivers'

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

/** 读能力判定(网关调度周期读前先收敛,不支持读的驱动不空转) */
export function supportsDcwRead(kind: DcwDriverKind): boolean {
  return resolveDcwDriver(kind).read != null
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

// ============================================================
// Modbus 读原语(TCP/RTU 共用;读保持寄存器 → 解码 → 工程量映射)
// ============================================================

function wordsOf(dataType: string): number {
  return dataType === 'int16' || dataType === 'uint16' ? 1 : 2
}

async function modbusRead(input: DcwReadInput, transport: 'tcp' | 'rtu-tcp'): Promise<DcwReadResult> {
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
        if (conn) await conn.client.close()
        void key
      }
      catch { /* ignore */ }
      return { ok: false, message: classifyCommError(err) }
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
  // 会话死亡自愈:连续 3 次故障驱逐重建(与数采采样路径同策略)。此前纯写控节点
  // 会拿同一个死 session 反复失败,直到 10 分钟空闲 sweep 才可能重建。
  try {
    return await opcuaWriteOnce(conn, input)
  }
  catch (err) {
    conn.errors++
    if (conn.errors >= 3) void evictOpcUaConn(cfg)
    throw err
  }
}

async function opcuaWriteOnce(conn: { session: import('node-opcua').ClientSession, errors: number }, input: DcwWriteInput): Promise<DcwWriteResult> {
  const cfg = input.driverConfig
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
      return { ok: false, message: `OPC UA 写入失败: ${classifyCommError(err)}`, raw: null, readback: null }
    }
  },
  async read(input) {
    try {
      const cfg = input.driverConfig
      if (!cfg.endpoint) throw new AppError(400, 'BAD_REQUEST', '缺少端点 endpoint(opc.tcp://…)')
      if (!cfg.nodeId) throw new AppError(400, 'BAD_REQUEST', '缺少节点 ID nodeId(ns=…;s=…)')
      const conn = await getOpcUaConn(cfg)
      const opcua = reqNative('node-opcua') as typeof import('node-opcua')
      const dv = await conn.session.read({ nodeId: opcua.coerceNodeId(String(cfg.nodeId)), attributeId: opcua.AttributeIds.Value }) as unknown as { value?: { value?: unknown }, status?: { value?: number }, statusCode?: { value?: number } }
      const code = dv.status?.value ?? dv.statusCode?.value ?? 0
      if (code !== 0) return { ok: false, message: `节点读取状态异常: 0x${code.toString(16)}`, eng: null, raw: null }
      const v = Number(dv.value?.value)
      if (!Number.isFinite(v)) return { ok: false, message: '节点值为非数值', eng: null, raw: null }
      return { ok: true, message: `读回 ${Number(v.toFixed(4))}`, eng: v, raw: v }
    }
    catch (err) {
      return { ok: false, message: `OPC UA 读取失败: ${classifyCommError(err)}`, eng: null, raw: null }
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
      return { ok: false, message: classifyCommError(err) }
    }
  },
}

// ============================================================
// Modbus RTU over TCP 写驱动(串口网关透传;写保持寄存器 + 同址回读)
// ============================================================

async function modbusRtuWrite(input: DcwWriteInput): Promise<DcwWriteResult> {
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

// ============================================================
// MQTT 写驱动(publish 设定值到 Broker;fire-and-forget,无回读)
// ============================================================

export const mqttDcwDriver: DcwWriteDriver = {
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
  async write(input) {
    try {
      const cfg = input.driverConfig
      if (!cfg.host) throw new AppError(400, 'BAD_REQUEST', '缺少 Broker 地址 host')
      if (!cfg.topic) throw new AppError(400, 'BAD_REQUEST', '缺少下发主题 topic')
      const mqtt = reqNative('mqtt') as typeof import('mqtt')
      const url = `mqtt://${String(cfg.host)}:${Number(cfg.port ?? 1883)}`
      const payload = cfg.jsonKey
        ? JSON.stringify({ [String(cfg.jsonKey)]: input.eng })
        : String(input.eng)
      // 控制发布用一次性连接(低频关键动作,不复用采样的长连接;发布即断,资源可控)
      const client = await new Promise<import('mqtt').MqttClient>((resolve, reject) => {
        const c = mqtt.connect(url, {
          username: cfg.username ? String(cfg.username) : undefined,
          password: cfg.password ? String(cfg.password) : undefined,
          connectTimeout: 4000,
          // 一次性连接:发布即断,绝不能让 mqtt.js 默认的 1s 无限重连在后台空转
          reconnectPeriod: 0,
        })
        c.once('connect', () => resolve(c))
        c.once('error', (err) => {
          try {
            c.end(true)
          }
          catch { /* 未连上 */ }
          reject(new Error(err.message))
        })
      })
      const qos = Math.min(2, Math.max(0, Number(cfg.qos ?? 1))) as 0 | 1 | 2
      try {
        await new Promise<void>((resolve, reject) => {
          client.publish(String(cfg.topic), payload, { qos }, (err) => {
            if (err)
              reject(new Error(err.message))
            else
              resolve()
          })
          // 发布确认超时(QoS1 等 puback):8s 未确认按失败收敛,不悬挂工具调用
          const timer = setTimeout(() => reject(new Error('发布确认超时(8s)')), 8000)
          timer.unref?.()
        })
      }
      finally {
        // 失败/超时路径同样关闭连接(此前只在成功后 end,超时会泄漏 client +
        // broker session),已关闭的 client 重复 end 幂等安全
        await new Promise<void>((resolve) => {
          client.end(false, {}, resolve)
        })
      }
      return {
        ok: true,
        message: `已发布 ${input.eng} → ${String(cfg.topic)}(QoS ${Number(cfg.qos ?? 1)};MQTT 无回读,建议以同主题数采节点验证)`,
        raw: input.eng,
        readback: null,
      }
    }
    catch (err) {
      if (err instanceof AppError) throw err
      return { ok: false, message: `MQTT 发布失败: ${err instanceof Error ? err.message : String(err)}`, raw: null, readback: null }
    }
  },
  async test(driverConfig) {
    try {
      if (!driverConfig.host) return { ok: false, message: '缺少 Broker 地址 host' }
      if (!driverConfig.topic) return { ok: false, message: '缺少下发主题 topic' }
      const mqtt = reqNative('mqtt') as typeof import('mqtt')
      await new Promise<import('mqtt').MqttClient>((resolve, reject) => {
        const c = mqtt.connect(`mqtt://${String(driverConfig.host)}:${Number(driverConfig.port ?? 1883)}`, {
          username: driverConfig.username ? String(driverConfig.username) : undefined,
          password: driverConfig.password ? String(driverConfig.password) : undefined,
          connectTimeout: 4000,
        })
        c.once('connect', () => resolve(c))
        c.once('error', err => reject(new Error(err.message)))
      }).then(c => new Promise<void>(r => c.end(false, {}, r)))
      return { ok: true, message: `Broker 连接成功(${String(driverConfig.host)}:${Number(driverConfig.port ?? 1883)});未执行发布,避免误触发真实设备动作` }
    }
    catch (err) {
      return { ok: false, message: `MQTT 连接失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// ============================================================
// HTTP/REST 写驱动(POST JSON 设定值;2xx 视为受理)
// ============================================================

export const httpDcwDriver: DcwWriteDriver = {
  kind: 'http',
  async available() {
    return true
  },
  async write(input) {
    try {
      const cfg = input.driverConfig
      if (!cfg.url) throw new AppError(400, 'BAD_REQUEST', '缺少写接口地址 url')
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (cfg.headersJSON) {
        const parsed: unknown = JSON.parse(String(cfg.headersJSON))
        if (typeof parsed === 'object' && parsed != null && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) headers[k] = String(v)
        }
      }
      const body = cfg.bodyKey ? JSON.stringify({ [String(cfg.bodyKey)]: input.eng }) : JSON.stringify({ value: input.eng })
      const res = await fetch(String(cfg.url), { method: 'POST', headers, body, signal: AbortSignal.timeout(6000) })
      if (!res.ok) return { ok: false, message: `接口返回 HTTP ${res.status},设定未受理`, raw: null, readback: null }
      let readback: number | null = null
      try {
        const j: unknown = await res.json()
        const target = cfg.bodyKey
          ? (j as Record<string, unknown>)?.[String(cfg.bodyKey)]
          : (j as Record<string, unknown>)?.value
        const n = Number(target)
        if (Number.isFinite(n)) readback = n
      }
      catch { /* 非 JSON 响应忽略回读 */ }
      return {
        ok: true,
        message: readback != null
          ? `POST 成功(HTTP ${res.status}),接口回读 ${readback}`
          : `POST 成功(HTTP ${res.status};接口未回传数值)`,
        raw: input.eng,
        readback,
      }
    }
    catch (err) {
      if (err instanceof AppError) throw err
      return { ok: false, message: `HTTP 写入失败: ${err instanceof Error ? err.message : String(err)}`, raw: null, readback: null }
    }
  },
  async test(driverConfig) {
    try {
      if (!driverConfig.url) return { ok: false, message: '缺少写接口地址 url' }
      // 安全语义:仅探测端点可达性(GET),不执行 POST,避免误触发真实设备动作
      const res = await fetch(String(driverConfig.url), { method: 'GET', signal: AbortSignal.timeout(5000) })
      return { ok: true, message: `端点可达(GET → HTTP ${res.status};未执行写入测试,避免误触发真实命令)` }
    }
    catch (err) {
      return { ok: false, message: `HTTP 端点不可达: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

// ============================================================
// 注册表 + 解析
// ============================================================

const REGISTRY: Record<DcwDriverKind, DcwWriteDriver> = {
  'mock': mockDcwDriver,
  'modbus-tcp': modbusTcpDcwDriver,
  'modbus-rtu': modbusRtuDcwDriver,
  'opcua': opcUaDcwDriver,
  'mqtt': mqttDcwDriver,
  'http': httpDcwDriver,
}

export function normalizeDcwDriverKind(kind: string): DcwDriverKind {
  if (kind === 'modbus') return 'modbus-tcp'
  if (kind === 'rtu' || kind === 'modbus-rtu-tcp') return 'modbus-rtu'
  return (kind in REGISTRY ? kind : 'mock') as DcwDriverKind
}

export function resolveDcwDriver(kind: DcwDriverKind): DcwWriteDriver {
  return REGISTRY[kind] ?? mockDcwDriver
}
