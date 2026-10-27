/**
 * MQTT 真实驱动(broker 常驻连接池 + 订阅缓存 + 被动推送)
 *
 * 语义要点(2026-10-27 MQTT 审计修复):
 *  - **被动优先**:MQTT 是「连上 broker 后收报文」的推送协议。控制器优先调用
 *    subscribe() 建立常驻订阅,每条报文立刻进入采集管线(时间戳=到达时刻);
 *    只有驱动不支持 subscribe 或节点处于未开跑状态时才回落到 sample() 预览缓存。
 *  - 连接池按 broker+凭据键复用;断线不驱逐进程内 client,交由 mqtt.js 重连并重订阅
 *    (旧实现 error/close 即 end(true),一次抖动会让整个 broker 下所有节点静默停采)。
 *  - sample()/test() 仍保留(测试连接、一次性读),但首次无报文时快速失败,
 *    不再把最后一条冻值当新值反复入库。
 *  - TLS/凭据参数与 DCW 写侧同源(mqttConnectOpts)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { DaqDriver, DaqPushInput, DaqPushSample } from './shared'
import { reqNative } from './shared'
import { daqRuntimeSettings } from '../../settings'
import { createLogger } from '../../logger'
import { decodeMqttPayload, describeMqttPayload } from './mqtt-decode'
import type { DaqDecoded } from '../decoders'

const log = createLogger('daq.drivers.mqtt')

/** 单 topic 的订阅者(每个节点一个;同一 broker 多节点共享连接) */
export type MqttTopicConsumer = (raw: string, at: number, bytes: Buffer) => void

export interface MqttTopicEntry {
  /** 最新原始报文(解析按节点 jsonPath 在消费时进行) */
  raw: string
  /** 最新原始字节(binary 图像/自定义解码器用;与 raw 同一报文) */
  bytes: Buffer
  /** 最新报文到达时刻(epoch ms;0 = 尚未收到) */
  at: number
  /** 最新报文是否为 broker 保留消息(retain) */
  retained: boolean
  /** 本订阅周期内是否已消费过首条 retained(重连重放的 retained 不再入库) */
  seeded: boolean
  /** 首个 SUBSCRIBE 完成信号(并发首订阅共享;失败则整条 entry 移除) */
  ready: Promise<void>
  consumers: Set<MqttTopicConsumer>
}

export interface MqttConn {
  client: import('mqtt').MqttClient
  /** topic → 最新报文 + 订阅者 */
  topics: Map<string, MqttTopicEntry>
  /** 连接池键(诊断用) */
  key: string
  /** 当前是否已连上(断线重连期间 false) */
  connected: boolean
  /** 最近一次连接/报文错误(诊断用) */
  lastError: string | null
}

/** 陈值判定缺省窗:设备停发超过该时长即拒用冻值(节点 driverConfig.staleMs 可覆盖,0=关闭) */
export const MQTT_STALE_DEFAULT_MS = 300_000

export const mqttPool = new Map<string, MqttConn>()

/** 正在建连的 Key → Promise(并发首连去重,避免同 broker 建出多条连接) */
const mqttConnecting = new Map<string, Promise<MqttConn>>()

/** TLS 连接参数合并:节点 driverConfig 优先,缺省回落全局 daq.mqtt.*(runtime-settings/env) */
function tlsOpts(cfg: Record<string, unknown>): { secure: boolean, ca: string[] | undefined, rejectUnauthorized: boolean, caFile: string } {
  const bus = daqRuntimeSettings().mqtt
  const secure = Boolean(cfg.secure ?? cfg.tls ?? bus.secure)
  const caFile = String(cfg.caFile ?? bus.caFile ?? '')
  let ca: string[] | undefined
  if (caFile) {
    if (!existsSync(caFile)) throw new Error(`MQTT CA 证书文件不存在: ${caFile}`)
    ca = [readFileSync(caFile, 'utf8')]
  }
  const rejectUnauthorized = cfg.rejectUnauthorized != null ? Boolean(cfg.rejectUnauthorized) : bus.rejectUnauthorized
  return { secure, ca, rejectUnauthorized, caFile }
}

/** 有效凭据:节点显式配置优先,缺省回落全局 daq.mqtt.*(连接与池键必须同源) */
function effectiveCredentials(cfg: Record<string, unknown>): { username: string | undefined, password: string | undefined } {
  const bus = daqRuntimeSettings().mqtt
  return {
    username: cfg.username != null ? String(cfg.username) : (bus.username || undefined),
    password: cfg.password != null ? String(cfg.password) : (bus.password || undefined),
  }
}

/** 连接选项(采/控共用):TLS 与凭据语义同源,调用方补各自的重连策略 */
export function mqttConnectOpts(cfg: Record<string, unknown>): import('mqtt').IClientOptions {
  const { secure, ca, rejectUnauthorized } = tlsOpts(cfg)
  const { username, password } = effectiveCredentials(cfg)
  return {
    username,
    password,
    ...(secure ? { ca, rejectUnauthorized } : {}),
    connectTimeout: 4000,
    keepalive: 30,
    clean: true,
    resubscribe: true,
    reconnectPeriod: 5000,
  }
}

/** 连接池键:broker + TLS + 有效账号 + 密码指纹(不同凭据绝不复用同一连接) */
export function mqttKey(cfg: Record<string, unknown>): string {
  const { secure, caFile, rejectUnauthorized } = tlsOpts(cfg)
  const { username, password } = effectiveCredentials(cfg)
  const user = username ?? ''
  const pass = password
    ? createHash('sha256').update(password).digest('hex').slice(0, 12)
    : ''
  return `mqtt${secure ? 's' : ''}://${cfg.host}:${Number(cfg.port ?? 1883)}|u=${user}|p=${pass}|ca=${caFile}|ru=${rejectUnauthorized}`
}

/** 指纹专用安全键:CA 文件缺失/不可读不能让 sweep 定时器抛错(会被稳定性守卫判 fatal 退出进程)。
 *  这里把 TLS 配置错误编码进键,in：subscribe 阶段会以可读错误失败并重试。 */
function safeMqttKey(cfg: Record<string, unknown>): string {
  try {
    return mqttKey(cfg)
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `mqtt-invalid://${String(cfg.host)}:${Number(cfg.port ?? 1883)}|host=${String(cfg.host)}|topic=${String(cfg.topic ?? '')}|err=${msg.slice(0, 80)}`
  }
}

function brokerUrl(cfg: Record<string, unknown>): string {
  const { secure } = tlsOpts(cfg)
  return `mqtt${secure ? 's' : ''}://${String(cfg.host)}:${Number(cfg.port ?? 1883)}`
}

/** 订阅单 topic(SUBACK 等待;5s 超时;重连时由 connect 事件重放) */
async function subscribeTopic(conn: MqttConn, topic: string, qos: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`订阅确认超时(5s): ${topic}`)), 5000)
    timer.unref?.()
    try {
      conn.client.subscribe(topic, { qos: Math.min(2, Math.max(0, qos)) as 0 | 1 | 2 }, (err) => {
        clearTimeout(timer)
        if (err) reject(new Error(`订阅失败: ${err.message}`))
        else resolve()
      })
    }
    catch (err) {
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * 取/建 broker 连接。同一连接池键只建一条 mqtt client;
 * 断线由 mqtt.js 自动重连(reconnectPeriod 5s)+ 自动重订阅,调用方无需重建。
 */
export async function getMqttConn(cfg: Record<string, unknown>): Promise<MqttConn> {
  const key = mqttKey(cfg)
  const existing = mqttPool.get(key)
  if (existing) return existing
  const pending = mqttConnecting.get(key)
  if (pending) return pending

  const creating = (async (): Promise<MqttConn> => {
    const mqtt = reqNative('mqtt') as typeof import('mqtt')
    const client = mqtt.connect(brokerUrl(cfg), mqttConnectOpts(cfg))
    const conn: MqttConn = { client, topics: new Map(), key, connected: false, lastError: null }

    // 重连成功:重订阅全部 topic(clean session 下 broker 不保留订阅;resubscribe 亦会做,显式双保险)
    client.on('connect', () => {
      conn.connected = true
      conn.lastError = null
      for (const topic of conn.topics.keys()) {
        client.subscribe(topic, { qos: 1 }, (err) => {
          if (err) log.warn(`[mqtt] 重连后重订阅失败 ${topic}: ${err.message}`)
        })
      }
    })
    client.on('close', () => {
      conn.connected = false
      // 断线期间清空缓存:恢复后不能把断线前的旧报文当作新样本(陈值保护的第一道闸)
      for (const t of conn.topics.values()) {
        t.raw = ''
        t.bytes = Buffer.alloc(0)
        t.at = 0
        t.retained = false
      }
    })
    client.on('error', (err) => {
      conn.connected = client.connected
      conn.lastError = err.message
      // 运行期 error 不驱逐连接:mqtt.js 会继续重连,节点侧由控制器陈值看门狗如实报 offline
      log.warn(`[mqtt] ${brokerUrl(cfg)} 连接错误: ${err.message}(保持重连)`)
    })
    client.on('message', (topic, payload, packet) => {
      const entry = conn.topics.get(topic)
      if (!entry) return
      const at = Date.now()
      const retained = Boolean(packet?.retain)
      entry.raw = payload.toString()
      entry.bytes = Buffer.from(payload)
      entry.at = at
      entry.retained = retained
      // retained 语义:
      //  - 本订阅 entry 生命周期内首条 retained = 设备当前状态,作为**一次**种子样本入库;
      //  - 后续重复投递(断线重连重放)只刷新缓存,不再入库;
      //  - 若当前没有消费者(仅 sample()/readMqttValue 的只读订阅),不消耗种子 ——
      //    留给随后建立的推送绑定,避免"先测连接后建节点"导致首条状态丢失。
      if (retained) {
        if (entry.seeded) return
        if (entry.consumers.size === 0) return
        entry.seeded = true
      }
      for (const fn of [...entry.consumers]) {
        try {
          fn(entry.raw, at, entry.bytes)
        }
        catch (err) {
          conn.lastError = err instanceof Error ? err.message : String(err)
        }
      }
    })

    // 首次建连等待(4s connectTimeout + 2s 余量);失败即销毁本次 client,让下次重试重新建
    await new Promise<void>((resolve, reject) => {
      if (client.connected) return resolve()
      const timer = setTimeout(() => reject(new Error(`MQTT 连接超时(6s): ${brokerUrl(cfg)}`)), 6000)
      timer.unref?.()
      client.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      client.once('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`MQTT 连接失败: ${err.message}`))
      })
    }).catch((err) => {
      try {
        client.end(true)
      }
      catch { /* 未连上 */ }
      throw err
    })
    mqttPool.set(key, conn)
    return conn
  })()

  mqttConnecting.set(key, creating)
  try {
    return await creating
  }
  finally {
    mqttConnecting.delete(key)
  }
}

/** 关闭全部连接(测试/进程退出;幂等) */
export async function closeMqttPool(): Promise<void> {
  for (const conn of mqttPool.values()) {
    try {
      await new Promise<void>((resolve) => conn.client.end(false, {}, () => resolve()))
    }
    catch { /* 已断 */ }
  }
  mqttPool.clear()
  mqttConnecting.clear()
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

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 取/建 topic entry(不等待 SUBACK;ready 由首个调用者触发,后续调用共享) */
function topicEntry(conn: MqttConn, topic: string, qos: number): MqttTopicEntry {
  const existing = conn.topics.get(topic)
  if (existing) return existing
  const entry: MqttTopicEntry = { raw: '', bytes: Buffer.alloc(0), at: 0, retained: false, seeded: false, consumers: new Set(), ready: Promise.resolve() }
  conn.topics.set(topic, entry)
  entry.ready = subscribeTopic(conn, topic, qos).catch((err) => {
    // 订阅失败且无人等待消费:移除 entry,允许下次重试(有消费者时保留,由调用方清理)
    if (entry.consumers.size === 0 && conn.topics.get(topic) === entry) conn.topics.delete(topic)
    throw err
  })
  return entry
}

/** 确保 topic 已在池内并完成订阅(共享连接;已有订阅者不重复 SUBSCRIBE) */
async function ensureTopic(conn: MqttConn, topic: string, qos: number): Promise<MqttTopicEntry> {
  const entry = topicEntry(conn, topic, qos)
  await entry.ready
  return entry
}

/**
 * 一次性回读(写后验证/状态主题):等待**本次调用之后**到达的新报文(含订阅时 broker
 * 推送的 retained 消息),超时返回 null —— 绝不把订阅缓存里的旧报文当当前值。
 * allowCachedMs > 0 时:缓存本身在该时限内可直接复用(周期读场景,避免每次阻塞 2.5s
 * 占住读锁导致手动读 409);写后验证前会 invalidateMqttTopic 清缓存,因此不会拿到写前旧值。
 * 与采集共用 broker 连接,不额外建连。
 */
export async function readMqttValue(
  cfg: Record<string, unknown>,
  topic: string,
  jsonPath?: string,
  timeoutMs = 2500,
  opts: { allowCachedMs?: number } = {},
): Promise<{ value: number, atMs: number } | null> {
  const conn = await getMqttConn(cfg)
  if (!conn.connected) throw new Error(`MQTT 未连接(重连中): ${conn.lastError ?? brokerUrl(cfg)}`)
  const qos = Math.min(2, Math.max(0, Number(cfg.qos ?? 1)))
  // 该 topic 此前是否已订阅:已订阅则只认本次调用之后的新报文(缓存是旧值);
  // 本次新订阅时,broker 的 retained 报文(到达时刻=订阅后)可作为当前状态。
  const existed = conn.topics.has(topic)
  const entry = await ensureTopic(conn, topic, qos)
  const acceptFrom = existed ? Date.now() : 0
  const startAt = Date.now()
  const allowCachedMs = Math.max(0, Number(opts.allowCachedMs ?? 0))
  for (;;) {
    if (entry.raw && entry.at >= acceptFrom) {
      return { value: extractNumeric(entry.raw, jsonPath), atMs: entry.at }
    }
    // 周期读:缓存足够新即复用(MQTT 状态主题按设备周期刷新;停发超过时限则继续等待/超时)
    if (allowCachedMs > 0 && entry.raw && entry.at > 0 && Date.now() - entry.at <= allowCachedMs) {
      return { value: extractNumeric(entry.raw, jsonPath), atMs: entry.at }
    }
    if (Date.now() - startAt >= timeoutMs) return null
    await sleep(100)
  }
}

/** 清空某 topic 的订阅缓存(写后验证前调用:迫使回读等待**写后**的新报文,不认写前旧值) */
export function invalidateMqttTopic(cfg: Record<string, unknown>, topic: string): void {
  const conn = mqttPool.get(mqttKey(cfg))
  const entry = conn?.topics.get(topic)
  if (!entry) return
  entry.raw = ''
  entry.bytes = Buffer.alloc(0)
  entry.at = 0
  entry.retained = false
}

function toPushSample(decoded: DaqDecoded, atMs: number): DaqPushSample {
  if (decoded.kind === 'scalar') return { value: decoded.value, atMs }
  if (decoded.kind === 'vector') {
    return { frame: { kind: 'vector', points: decoded.points, metrics: decoded.metrics }, atMs }
  }
  return {
    frame: { kind: 'image', blob: decoded.blob, mime: decoded.mime, width: decoded.width ?? 0, height: decoded.height ?? 0, metrics: decoded.metrics },
    atMs,
  }
}

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

  /**
   * 被动订阅(控制器主路径):连上 broker → 订阅 topic → 每条报文解码后回调 onSample。
   * 解码由节点模板 signalKind + driverConfig 决定(标量/数组/图片;或插件自定义 decoder);
   * 解析失败走 onError(节点 lastError 可见),不影响后续报文。
   */
  async subscribe(input: DaqPushInput) {
    const cfg = input.driverConfig
    const topic = String(cfg.topic ?? '')
    if (!topic) throw new Error('缺少主题 topic')
    const conn = await getMqttConn(cfg)
    if (!conn.connected) throw new Error(`MQTT 未连接(重连中): ${conn.lastError ?? brokerUrl(cfg)}`)
    const qos = Math.min(2, Math.max(0, Number(cfg.qos ?? 1)))
    const signalKind = input.signalKind ?? 'scalar'
    // delivered:本消费者是否已通过 message 事件收到过报文。用于在 subscribe 完成后
    // 补发缓存里的 retained(只读订阅/快速重启重用 entry 时,broker 不会重发 retained)。
    let delivered = false
    const consumer: MqttTopicConsumer = (raw, at, bytes) => {
      delivered = true
      try {
        const decoded = decodeMqttPayload({ raw, bytes, json: null, config: cfg, signalKind, nodeId: input.ctx.nodeId })
        input.onSample(toPushSample(decoded, at))
      }
      catch (err) {
        input.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
    // 先挂消费者再等 SUBACK:SUBACK 与消息到达的窗口内不丢报文
    const entry = topicEntry(conn, topic, qos)
    entry.consumers.add(consumer)
    try {
      await entry.ready
    }
    catch (err) {
      entry.consumers.delete(consumer)
      // 订阅失败的 entry 不能留(否则后续订阅会复用已 reject 的 ready)
      if (entry.consumers.size === 0 && conn.topics.get(topic) === entry) conn.topics.delete(topic)
      throw err
    }
    // 缓存里已有 retained 且本消费者尚未收到任何报文:补发一次当前状态。
    // 覆盖三种场景:①只读订阅(test/readMqttValue)先拿到 retained;②快速停用/启用
    // 在 5s 退订窗口内重用 entry;③同 topic 的第二个节点后加入。
    // 断线重连不会走到这里(消费者已在 entry 上,subscribe() 不会被再次调用)。
    if (entry.retained && entry.raw && !delivered) {
      entry.seeded = true
      consumer(entry.raw, entry.at || Date.now(), entry.bytes)
    }
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      entry.consumers.delete(consumer)
      // 最后一个消费者离开:延迟 5s 再退订/移除缓存。
      // 不能立刻 UNSUBSCRIBE —— 换 topic/停用后立即启用会在同一 tick 重建订阅,
      // 迟到的 UNSUBSCRIBE 会把新订阅一起取消(新 entry 收不到任何消息)。
      if (entry.consumers.size === 0) {
        const timer = setTimeout(() => {
          if (entry.consumers.size > 0 || conn.topics.get(topic) !== entry) return
          conn.topics.delete(topic)
          try {
            conn.client.unsubscribe(topic, () => { /* 已断/已退订 */ })
          }
          catch { /* 连接已关闭 */ }
        }, 5000)
        timer.unref?.()
      }
    }
  },

  /** 订阅参数指纹:凭据/TLS/主题/QoS + 全部解码配置(改解析路径/decoder 必须重建订阅,绝不因 CA 配置错误抛错) */
  fingerprint(driverConfig) {
    const c = driverConfig
    const decodeKeys = ['jsonPath', 'valuePath', 'pointsPath', 'metricsPath', 'imageFormat', 'payloadFormat', 'imagePath', 'imageMime', 'mimePath', 'imageWidthPath', 'imageHeightPath', 'decoder', 'imageMaxBytes']
    const decode = decodeKeys.map(k => `${k}=${String(c[k] ?? '')}`).join('|')
    return `${safeMqttKey(c)}|topic=${String(c.topic ?? '')}|qos=${Number(c.qos ?? 1)}|${decode}`
  },

  async sample({ driverConfig, signalKind, ctx }) {
    const topic = String(driverConfig.topic ?? '')
    if (!topic) throw new Error('缺少主题 topic')
    const conn = await getMqttConn(driverConfig)
    // 未连上时快速失败(重连期间不能拿缓存冒充读数)
    if (!conn.connected) throw new Error(`MQTT 未连接(重连中): ${conn.lastError ?? brokerUrl(driverConfig)}`)
    const qos = Math.min(2, Math.max(0, Number(driverConfig.qos ?? 1)))
    const entry = await ensureTopic(conn, topic, qos)
    // 首帧等待(最多 3s):之后由 message 事件持续刷新缓存
    const t0 = Date.now()
    while (!entry.raw && Date.now() - t0 < 3000) await sleep(100)
    if (!entry.raw) return null
    // 陈值保护:连接活着但设备停发时,缓存里只剩最后一条冻值 —— 如实报错让节点
    // 离线(lastError 可读、告警链可见),绝不把旧值当新值采进去。恢复发布即自愈。
    const staleMs = Number(driverConfig.staleMs ?? MQTT_STALE_DEFAULT_MS)
    if (staleMs > 0 && entry.at > 0 && Date.now() - entry.at > staleMs) {
      throw new Error(`MQTT 数据停发超过 ${Math.round((Date.now() - entry.at) / 1000)}s(陈值保护,拒用冻值;最近报文 ${new Date(entry.at).toISOString()})`)
    }
    const decoded = decodeMqttPayload({
      raw: entry.raw,
      bytes: entry.bytes,
      json: null,
      config: driverConfig,
      signalKind: signalKind ?? 'scalar',
      nodeId: ctx.nodeId,
    })
    if (decoded.kind === 'scalar') return decoded.value
    if (decoded.kind === 'vector') return { frame: { kind: 'vector', points: decoded.points, metrics: decoded.metrics } }
    return { frame: { kind: 'image', blob: decoded.blob, mime: decoded.mime, width: decoded.width ?? 0, height: decoded.height ?? 0, metrics: decoded.metrics } }
  },

  async test(driverConfig, signalKind) {
    const t0 = Date.now()
    try {
      if (!driverConfig.host) return { ok: false, message: '缺少 Broker 地址 host' }
      if (!driverConfig.topic) return { ok: false, message: '缺少主题 topic' }
      const conn = await getMqttConn(driverConfig)
      if (!conn.connected) return { ok: false, message: `Broker 未连接(重连中): ${conn.lastError ?? brokerUrl(driverConfig)}` }
      const topic = String(driverConfig.topic)
      const qos = Math.min(2, Math.max(0, Number(driverConfig.qos ?? 1)))
      const entry = await ensureTopic(conn, topic, qos)
      const t1 = Date.now()
      while (!entry.raw && Date.now() - t1 < 4000) await sleep(100)
      if (entry.raw) {
        if (signalKind) {
          try {
            const decoded = decodeMqttPayload({ raw: entry.raw, bytes: entry.bytes, json: null, config: driverConfig, signalKind, nodeId: 'test' })
            if (decoded.kind === 'scalar') {
              return { ok: true, message: `Broker 连接成功,${topic} → scalar ${decoded.value}(被动订阅:收到报文即入库)`, sampleValue: decoded.value, latencyMs: Date.now() - t0 }
            }
            if (decoded.kind === 'vector') {
              return { ok: true, message: `Broker 连接成功,${topic} → vector ${decoded.points.length} 点(被动订阅:收到报文即入库)`, latencyMs: Date.now() - t0 }
            }
            return { ok: true, message: `Broker 连接成功,${topic} → image ${decoded.mime} ${decoded.blob.length}B(被动订阅:收到报文即入库)`, latencyMs: Date.now() - t0 }
          }
          catch (err) {
            // 链路已通、是解析失败:不要把原因误报成"连接失败"
            return { ok: false, message: `Broker 连接成功但载荷解码失败: ${err instanceof Error ? err.message : String(err)}`, latencyMs: Date.now() - t0 }
          }
        }
        const auto = describeMqttPayload(entry.raw, entry.bytes, driverConfig)
        const scalarText = auto.summary.startsWith('scalar ') ? auto.summary.slice(7).split('(')[0] : ''
        const sampleValue = Number(scalarText)
        return {
          ok: true,
          message: `Broker 连接成功,${topic} → ${auto.summary}(被动订阅:收到报文即入库)`,
          ...(auto.kind === 'scalar' && Number.isFinite(sampleValue) ? { sampleValue } : {}),
          latencyMs: Date.now() - t0,
        }
      }
      return {
        ok: true,
        message: `Broker 已连接并订阅 ${topic}(4s 内未收到消息;设备发布后由订阅回调直接入库)`,
        latencyMs: Date.now() - t0,
      }
    }
    catch (err) {
      return { ok: false, message: `MQTT 连接失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}
