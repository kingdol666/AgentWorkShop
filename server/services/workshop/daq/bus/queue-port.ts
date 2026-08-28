/**
 * DaqQueuePort —— 数采消息队列端口(生产者/消费者解耦的 seam)。
 *
 * 工业语义:
 *   生产者(采集侧)按主题发布读数帧 →  队列 →  消费者订阅后落时序库 / 广播 WS。
 * 主题约定:aw/daq/<nodeId>/sample(JSON,载荷 = AepDaqReading 同构)。
 *
 * 实现:
 *  - mqtt.adapter   —— 标准 MQTT 3.1.1/5 broker(DAQ_MQTT_URL=mqtt://…),生产者
 *    发布 per-node 主题;消费者以通配 `aw/daq/+/sample` 订阅。接入真实 broker
 *    后即具备跨进程/跨系统消费能力。
 *  - inproc.adapter —— 无 broker 的 mock 缺省:有界环形队列 + 单消费泵,
 *    保持"发→排队→拉取"同构语义(mock 环境)。
 */

export interface DaqSampleEnvelope {
  nodeId: string
  templateRef: string
  value: number
  state: string
  /** ISO 时间 */
  at: string
}

export type DaqConsumer = (env: DaqSampleEnvelope) => void

export interface DaqQueuePort {
  readonly backend: 'mqtt' | 'inproc'
  /** 队列层真实丢弃计数(inproc 拥塞丢最旧 / mqtt 断连窗口未发布) */
  readonly lost: number
  init(): Promise<void>
  /** 生产者:发布一条样本帧 */
  publish(env: DaqSampleEnvelope): void
  /** 消费者:注册处理函数;返回退订 */
  consume(fn: DaqConsumer): () => void
}
