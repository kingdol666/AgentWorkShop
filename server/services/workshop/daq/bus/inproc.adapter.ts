/**
 * InProcQueueAdapter —— mock 缺省队列:有界环形缓冲 + 单消费泵。
 * 与 MQTT 版同契约:生产端 publish 即刻入队不阻塞采集;消费泵按序拉取,
 * 拥塞时丢最旧并计数(暴露给 meta,诚实可见)。
 */
import type { DaqConsumer, DaqQueuePort, DaqSampleEnvelope } from './queue-port'

const QUEUE_CAP = 10_000
/** 消费泵节拍(ms):攒批交给下游(TSDB 批量写) */
const PUMP_INTERVAL = 250

export class InProcQueueAdapter implements DaqQueuePort {
  readonly backend = 'inproc' as const
  private queue: DaqSampleEnvelope[] = []
  private consumers = new Set<DaqConsumer>()
  private pump: NodeJS.Timeout | null = null
  /** 拥塞丢弃计数(观测用;正常远低于队列容量) */
  dropped = 0

  get lost(): number {
    return this.dropped
  }

  async init(): Promise<void> {
    if (this.pump) return
    this.pump = setInterval(() => this.drain(), PUMP_INTERVAL)
    this.pump.unref?.()
  }

  publish(env: DaqSampleEnvelope): void {
    if (this.queue.length >= QUEUE_CAP) {
      this.queue.shift()
      this.dropped++
    }
    this.queue.push(env)
  }

  consume(fn: DaqConsumer): () => void {
    this.consumers.add(fn)
    return () => {
      this.consumers.delete(fn)
    }
  }

  private drain(): void {
    if (this.queue.length === 0 || this.consumers.size === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    for (const env of batch) {
      for (const fn of this.consumers) {
        try {
          fn(env)
        }
        catch (err) {
          console.error('[daq-queue] 消费异常:', err instanceof Error ? err.message : err)
        }
      }
    }
  }
}
