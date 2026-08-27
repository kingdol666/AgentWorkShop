/**
 * MqttQueueAdapter —— 标准 MQTT broker 实现(DAQ_MQTT_URL=mqtt://host:1883)。
 *
 * - 生产者:publish 到 per-node 主题 aw/daq/<nodeId>/sample(QoS0,工业采集常用
 *   至多一次;QoS 需求可通过 DAQ_MQTT_QOS 提到 1);
 * - 消费者:通配订阅 aw/daq/+/sample,JSON 解析回 envelope;
 * - 重连由 mqtt.js 客户端内建;发布在断连期间的样本按丢弃计数(仪表可见)。
 */
import { createRequire } from 'node:module'
import type { MqttClient } from 'mqtt'

import type { DaqConsumer, DaqQueuePort, DaqSampleEnvelope } from './queue-port'

/** createRequire 加载:nitro Windows 下动态 import external 会产生 'd:' scheme 错误 */
const requireMqtt = createRequire(import.meta.url)

const TOPIC_ROOT = 'aw/daq'
const TOPIC_SAMPLE = (nodeId: string) => `${TOPIC_ROOT}/${nodeId}/sample`
const TOPIC_WILDCARD = `${TOPIC_ROOT}/+/sample`

export class MqttQueueAdapter implements DaqQueuePort {
  readonly backend = 'mqtt' as const
  private client: MqttClient | null = null
  private consumers = new Set<DaqConsumer>()
  published = 0
  received = 0

  constructor(private readonly url: string) {}

  async init(): Promise<void> {
    if (this.client) return
    // mqtt 包动态导入:未安装时不影响其余链路(工厂已兜底 inproc)
    const mod = requireMqtt('mqtt') as unknown as { connect: (url: string, opts?: Record<string, unknown>) => MqttClient }
    const qos = Number(process.env.DAQ_MQTT_QOS ?? 0)
    this.client = mod.connect(this.url, {
      clientId: `aw-daq-${process.pid}-${Math.random().toString(36).slice(2, 6)}`,
      reconnectPeriod: 2000,
      keepalive: 20,
    })
    this.client.on('connect', () => {
      this.client?.subscribe(TOPIC_WILDCARD, { qos })
      console.log('[daq-mqtt] 已连接', this.url, '· 订阅', TOPIC_WILDCARD)
    })
    this.client.on('message', (topic, payload) => {
      try {
        const env = JSON.parse(payload.toString()) as DaqSampleEnvelope
        this.received++
        for (const fn of this.consumers) fn(env)
      }
      catch (err) {
        console.error('[daq-mqtt] 坏帧:', topic, err instanceof Error ? err.message : err)
      }
    })
    this.client.on('error', err => console.error('[daq-mqtt]', err.message))
  }

  publish(env: DaqSampleEnvelope): void {
    if (!this.client || !this.client.connected) {
      return // 断连窗口:不阻塞采集;丢弃计数交由消费侧观测(inproc 为准的指标在 mqtt 模式下无意义)
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
