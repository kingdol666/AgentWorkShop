/**
 * MqttQueueAdapter —— 标准 MQTT broker 实现(DAQ_MQTT_URL=mqtt://host:1883)。
 *
 * - 生产者:publish 到 per-node 主题 aw/daq/<nodeId>/sample(QoS0,工业采集常用
 *   至多一次;QoS 需求可通过 DAQ_MQTT_QOS 提到 1);
 * - 消费者:通配订阅 aw/daq/+/sample,JSON 解析回 envelope;
 * - 重连由 mqtt.js 客户端内建;发布在断连期间的样本按丢弃计数(仪表可见)。
 */
import { createLogger } from '../../logger'
import { createRequire } from 'node:module'
import type { MqttClient } from 'mqtt'

import type { DaqConsumer, DaqQueuePort, DaqSampleEnvelope } from './queue-port'

const log = createLogger('daq.mqtt')

/** createRequire 加载:nitro Windows 下动态 import external 会产生 'd:' scheme 错误 */
const requireMqtt = createRequire(import.meta.url)

const TOPIC_ROOT = 'aw/daq'
const TOPIC_SAMPLE = (nodeId: string) => `${TOPIC_ROOT}/${nodeId}/sample`
const TOPIC_WILDCARD = `${TOPIC_ROOT}/+/sample`

/** 断连离线缓冲上限(满丢最旧;补发帧按消费侧乱序防御自然去重) */
const OFFLINE_CAP = 2000

export class MqttQueueAdapter implements DaqQueuePort {
  readonly backend = 'mqtt' as const
  private client: MqttClient | null = null
  private consumers = new Set<DaqConsumer>()
  published = 0
  received = 0
  /** 断连窗口未发布计数(仪表可见的队列层丢弃) */
  lostCount = 0
  /** 断连离线缓冲(重连后按原序补发;带上限防内存无限涨) */
  private offline: DaqSampleEnvelope[] = []

  constructor(private readonly url: string) {}

  get lost(): number {
    return this.lostCount
  }

  async init(): Promise<void> {
    if (this.client) return
    // mqtt 包动态导入:未安装时不影响其余链路(工厂已兜底 inproc)
    const mod = requireMqtt('mqtt') as unknown as { connect: (url: string, opts?: Record<string, unknown>) => MqttClient }
    const qos = Number(process.env.DAQ_MQTT_QOS ?? 0)
    // S1:凭据(env 优先)与 TLS(mqtts:// + 自签 CA;rejectUnauthorized 默认 true)
    const username = process.env.DAQ_MQTT_USERNAME
    const password = process.env.DAQ_MQTT_PASSWORD
    const caFile = process.env.DAQ_MQTT_CA_FILE
    const opts: Record<string, unknown> = {
      clientId: `aw-daq-${process.pid}-${Math.random().toString(36).slice(2, 6)}`,
      reconnectPeriod: 2000,
      keepalive: 20,
    }
    if (username) opts.username = username
    if (password) opts.password = password
    if (caFile) {
      const fs = requireMqtt('node:fs') as typeof import('node:fs')
      opts.ca = [fs.readFileSync(caFile)]
    }
    if (process.env.DAQ_MQTT_REJECT_UNAUTHORIZED === '0') opts.rejectUnauthorized = false
    if (this.url.startsWith('mqtts://') && !username && process.env.NODE_ENV === 'production') {
      log.warn('[daq-mqtt] WARN:生产环境 MQTT 连接未配置凭据(mqtts 仅加密传输,建议同时启用 username/password)')
    }
    this.client = mod.connect(this.url, opts)
    this.client.on('connect', () => {
      this.client?.subscribe(TOPIC_WILDCARD, { qos })
      log.info('[daq-mqtt] 已连接', this.url, '· 订阅', TOPIC_WILDCARD)
      // 断连窗口积压补发(消费侧 lastIngestAt 乱序防御兜底)
      if (this.offline.length > 0) {
        const backlog = this.offline.splice(0, this.offline.length)
        for (const env of backlog) this.publish(env)
        log.info('[daq-mqtt] 断连积压补发:', backlog.length)
      }
    })
    this.client.on('message', (topic, payload) => {
      try {
        const env = JSON.parse(payload.toString()) as DaqSampleEnvelope
        this.received++
        for (const fn of this.consumers) fn(env)
      }
      catch (err) {
        log.error('[daq-mqtt] 坏帧:', topic, err instanceof Error ? err.message : err)
      }
    })
    this.client.on('error', err => log.error('[daq-mqtt]', err.message))
  }

  publish(env: DaqSampleEnvelope): void {
    if (!this.client || !this.client.connected) {
      // 断连窗口:入离线缓冲(满丢最旧),lost 只计溢出部分
      if (this.offline.length >= OFFLINE_CAP) {
        this.offline.shift()
        this.lostCount++
      }
      this.offline.push(env)
      return
    }
    this.published++
    this.client.publish(TOPIC_SAMPLE(env.nodeId), JSON.stringify(env), { qos: Number(process.env.DAQ_MQTT_QOS ?? 0) })
  }

  consume(fn: DaqConsumer): () => void {
    this.consumers.add(fn)
    return () => {
      this.consumers.delete(fn)
    }
  }
}
