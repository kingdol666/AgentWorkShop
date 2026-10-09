/**
 * MQTT 真实驱动(broker 连接池 + 订阅缓存)
 * (由 server/services/workshop/daq/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import { existsSync, readFileSync } from 'node:fs'
import type { DaqDriver } from './shared'
import { reqNative } from './shared'
import { daqRuntimeSettings } from '../../settings'

// ============================================================
// MQTT 真实驱动(mqtt 包;broker 连接池复用,订阅缓存 topic 最新报文)
// 2026-10-09 生产化:mqtts(TLS)+ 陈值保护 —— 此前 URL 硬编码 mqtt://,
// 且设备停发时 sample 恒回最后一条冻值(连接活着但数据是旧的,静默说谎)。
// ============================================================

export interface MqttConn {
  client: import('mqtt').MqttClient
  /** topic → 最新原始报文(解析按节点 jsonPath 在采样时进行) */
  topics: Map<string, { raw: string, at: number }>
}

/** 陈值判定缺省窗:设备停发超过该时长即拒用冻值(节点 driverConfig.staleMs 可覆盖,0=关闭) */
export const MQTT_STALE_DEFAULT_MS = 300_000

export const mqttPool = new Map<string, MqttConn>()

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

/** 连接选项(采/控共用):TLS 语义同源,调用方补各自的重连策略 */
export function mqttConnectOpts(cfg: Record<string, unknown>): import('mqtt').IClientOptions {
  const { secure, ca, rejectUnauthorized } = tlsOpts(cfg)
  return {
    username: cfg.username ? String(cfg.username) : undefined,
    password: cfg.password ? String(cfg.password) : undefined,
    ...(secure ? { ca, rejectUnauthorized } : {}),
    connectTimeout: 4000,
  }
}

export function mqttKey(cfg: Record<string, unknown>): string {
  const { secure, caFile } = tlsOpts(cfg)
  return `mqtt${secure ? 's' : ''}://${cfg.host}:${cfg.port ?? 1883}|${cfg.username ?? ''}|${caFile}`
}

export async function getMqttConn(cfg: Record<string, unknown>): Promise<MqttConn> {
  const key = mqttKey(cfg)
  const existing = mqttPool.get(key)
  // 池命中必须验证活性:一次 error 事件后 client.end(true) 的"死连接"若留在池里,
  // 该 broker 下所有节点会静默永久停采(空 raw → sample 全部 null 被当跳帧)
  if (existing) {
    if (existing.client.connected) return existing
    try {
      existing.client.end(true)
    }
    catch { /* 已死 */ }
    mqttPool.delete(key)
  }
  const mqtt = reqNative('mqtt') as typeof import('mqtt')
  const { secure } = tlsOpts(cfg)
  const url = `mqtt${secure ? 's' : ''}://${String(cfg.host)}:${Number(cfg.port ?? 1883)}`
  const client = await new Promise<import('mqtt').MqttClient>((resolve, reject) => {
    const c = mqtt.connect(url, { ...mqttConnectOpts(cfg), reconnectPeriod: 5000 })
    c.once('connect', () => resolve(c))
    c.once('error', (err) => {
      // 仅首次建连阶段的 error 走 reject;连接成功后的运行期 error 由下方 error 监听驱逐
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
  // 运行期错误/关闭:从池中驱逐并强制终止(含 mqtt.js 自动重连),下次采样自动重建。
  // 此前一次 error 即"永久打死整池"——死连接留在池里,该 broker 下全部节点静默停采。
  const evict = () => {
    if (mqttPool.get(key) === conn) {
      mqttPool.delete(key)
      try {
        client.end(true)
      }
      catch { /* 已死 */ }
    }
  }
  client.on('error', evict)
  client.on('close', evict)
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

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

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
    // 陈值保护:连接活着但设备停发时,缓存里只剩最后一条冻值 —— 如实报错让节点
    // 离线(lastError 可读、告警链可见),绝不把旧值当新值采进去。恢复发布即自愈。
    const staleMs = Number(driverConfig.staleMs ?? MQTT_STALE_DEFAULT_MS)
    if (staleMs > 0 && entry.at > 0 && Date.now() - entry.at > staleMs) {
      throw new Error(`MQTT 数据停发超过 ${Math.round((Date.now() - entry.at) / 1000)}s(陈值保护,拒用冻值;最近报文 ${new Date(entry.at).toISOString()})`)
    }
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
