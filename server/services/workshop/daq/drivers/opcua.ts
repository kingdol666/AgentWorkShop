/**
 * OPC UA 真实驱动(会话池按 endpoint+账号 复用)
 * (由 server/services/workshop/daq/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DaqDriver } from './shared'
import { log, reqNative } from './shared'

// ============================================================
// OPC UA 真实驱动(node-opcua;会话池按 endpoint+账号 复用)
// ============================================================

export interface OpcUaConn {
  session: import('node-opcua').ClientSession
  client: import('node-opcua').OPCUAClient
  lastUsed: number
  errors: number
}

export const opcuaPool = new Map<string, OpcUaConn>()

/**
 * 在飞建连去重表（同池 key → 尚未 settle 的建连任务）。
 *
 * 修复动因(实测事故):同端点**并发首连**此前无去重——两条采样/写控请求同时进入时
 * 各建一条 OPCUAClient,而后一条的 `opcuaPool.set` 会**覆盖**前一条:
 * 被覆盖的 session 与 TCP 连接从此无人持有,空闲 sweep 也扫不到 → **永久泄漏**;
 * 重连 churn(断链演练/反复建节点)下还会触发 node-opcua 内部
 * `_internal_create_secure_channel failed, this._secureChannel is supposed to be null`。
 */
export const opcuaInflight = new Map<string, Promise<OpcUaConn>>()

// OPC UA 会话空闲回收(对照 modbus 池 sweep;节点删除/端点弃用后不再有读取
// 路径触发 3 错误驱逐,无 sweep 会话与 TCP 连接会永久驻留)
export const OPCUA_IDLE_MS = 600_000
export const opcuaSweepGlobal = globalThis as typeof globalThis & { __daqOpcUaSweep?: NodeJS.Timeout }
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

/** 已告警过的 OPC UA 端点(进程内,按 `类别|安全模式|endpoint` 键;同端点重连风暴只告警一次)。
 *  与 logger 的同指纹限流互补:Set 管「同端点反复重连」,限流器管「大量不同端点」的同形文本。 */
export const gOpcUaSecWarned = globalThis as typeof globalThis & { __daqOpcUaSecWarned?: Set<string> }
export function opcUaSecWarned(): Set<string> {
  return gOpcUaSecWarned.__daqOpcUaSecWarned ??= new Set()
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
  // 在飞去重:同 key 并发首连复用同一条建连任务(否则后写覆盖 pool → 前一条 session/socket 永久泄漏)
  const pending = opcuaInflight.get(key)
  if (pending) return pending
  const task = createOpcUaConn(cfg, key)
  opcuaInflight.set(key, task)
  try {
    return await task
  }
  finally {
    opcuaInflight.delete(key)
  }
}

export async function createOpcUaConn(cfg: Record<string, unknown>, key: string): Promise<OpcUaConn> {
  const opcua = reqNative('node-opcua') as typeof import('node-opcua')
  const securityMode = (['None', 'Sign', 'SignAndEncrypt'] as const).includes(cfg.securityMode as 'None')
    ? (cfg.securityMode as 'None')
    : 'None'
  if (securityMode === 'None' && process.env.NODE_ENV === 'production') {
    // P0:该告警原先每次建连都写一行(实测把生产日志灌到 18MB 且全是同一句)。
    // 去重键 = endpoint:同端点反复重连只告警一次;warnThrottled 再兜一层同形文本洪水。
    const noneKey = `none|${String(cfg.endpoint)}`
    if (!opcUaSecWarned().has(noneKey)) {
      opcUaSecWarned().add(noneKey)
      log.warnThrottled(`[daq-opcua] WARN:节点 endpoint=${String(cfg.endpoint)} 使用 securityMode=None(匿名/明文),仅限测试环境;生产请配置 Sign/SignAndEncrypt + 证书`)
    }
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
      // 同端点同模式只告警一次(重连不再重复);限流器兜同形文本洪水
      const noCertKey = `nocert|${securityMode}|${String(cfg.endpoint)}`
      if (!opcUaSecWarned().has(noCertKey)) {
        opcUaSecWarned().add(noCertKey)
        log.warnThrottled(`[daq-opcua] WARN:securityMode=${securityMode} 但未配置 certificateFile/privateKeyFile,将使用自动生成自签证书`)
      }
    }
  }
  const client = opcua.OPCUAClient.create(clientOpts as Parameters<typeof opcua.OPCUAClient.create>[0])
  await client.connect(String(cfg.endpoint))
  // type 是 node-opcua 的 UserIdentityInfo 判别式(node-opcua-client createUserIdentityToken →
  // coerceUserIdentityInfo:userName 存在时正是补成 UserTokenType.UserName 走同一分支),
  // 显式写出既满足协议类型,也免去"字段漏写、等库回填"的隐式依赖;两个分支都返回 Promise<ClientSession>。
  const session = cfg.username
    ? await client.createSession({ type: opcua.UserTokenType.UserName, userName: String(cfg.username), password: String(cfg.password ?? '') })
    : await client.createSession()
  const conn: OpcUaConn = { session, client, lastUsed: Date.now(), errors: 0 }
  // 竞态二次校验:建连期间若已有连接入池(并发首连的另一方完成),关闭本次新建并复用既有,
  // 避免 opcuaPool.set 覆盖导致 session/socket 永久泄漏。
  const raced = opcuaPool.get(key)
  if (raced) {
    try {
      await session.close()
    }
    catch { /* 清理失败不覆盖原始错误 */ }
    try {
      await client.disconnect()
    }
    catch { /* 清理失败不覆盖原始错误 */ }
    return raced
  }
  opcuaPool.set(key, conn)
  return conn
}

/** 驱逐 OPC UA 连接(采样/写控共享池;连续故障后触发,下次调用重建)。
 *  只作用于**已入池**的连接:在飞建连本身就是新建的,交由竞态二次校验处理。 */
export async function evictOpcUaConn(cfg: Record<string, unknown>): Promise<void> {
  const key = opcuaKey(cfg)
  const conn = opcuaPool.get(key)
  if (!conn) return
  opcuaPool.delete(key)
  try {
    await conn.session.close()
  }
  catch { /* ignore */ }
  try {
    await conn.client.disconnect()
  }
  catch { /* ignore */ }
}

export async function opcuaRead(conn: OpcUaConn, cfg: Record<string, unknown>): Promise<number> {
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
      if (conn.errors >= 3) await evictOpcUaConn(driverConfig)
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
