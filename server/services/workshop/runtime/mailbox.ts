/**
 * Mailbox — 持久化 FIFO 队列(messages 表)。
 * 每个 Agent 一个实例;enqueue 落库 pending + 唤醒;dequeue 用 promise 门闩挂起等待。
 * at-least-once:dequeue 置 consuming;服务重启时上层调用 resetConsuming 重投。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T3。
 */
import type { A2AMessage, Part } from '../types/a2a'
import { parseJson } from '../db/database'
import type { MessageRow } from '../db/database'
import type { MessageRepo } from '../db/message.repo'

/** promise 门闩:resolve 后重建,供 dequeue 反复挂起 */
interface Gate {
  promise: Promise<void>
  resolve: () => void
}

function newGate(): Gate {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** MessageRow → A2AMessage(parts/metadata 反序列化) */
export function rowToMessage(row: MessageRow): A2AMessage {
  return {
    messageId: row.id,
    contextId: row.channelId,
    taskId: row.taskId ?? undefined,
    role: row.role as 'ROLE_USER' | 'ROLE_AGENT',
    parts: parseJson<Part[]>(row.partsJson, []),
    metadata: parseJson<Record<string, unknown>>(row.metadataJson, {}),
  }
}

export class Mailbox {
  readonly agentId: string
  readonly channelId: string
  private gate: Gate = newGate()
  private closed = false
  /** 外部通知回调(如唤醒调度循环);由 AgentRuntime/Manager 注入 */
  private onWake: () => void
  /** 到信回调注册(poll_messages 长轮询即时唤醒;注册方自带注销句柄) */
  private arrivalCbs = new Set<() => void>()

  constructor(
    private messageRepo: MessageRepo,
    channelId: string,
    agentId: string,
    wake: () => void,
  ) {
    this.channelId = channelId
    this.agentId = agentId
    this.onWake = wake
  }

  /** 投递:落库 pending + 唤醒 dequeue 门闩 + 到信回调 + 通知外部 */
  enqueue(message: A2AMessage): void {
    if (this.closed) return
    this.messageRepo.create({
      // 保留发送方 messageId 作为落库 id:API 返回的 messageId 才能与历史/状态一致关联
      id: message.messageId,
      channelId: message.contextId,
      taskId: message.taskId ?? null,
      fromAgentId: (message.metadata?.['x-aw-from-agent'] as string | undefined) ?? null,
      toAgentId: this.agentId,
      role: message.role,
      parts: message.parts,
      metadata: message.metadata,
    })
    this.wake()
    for (const cb of this.arrivalCbs) {
      try {
        cb()
      }
      catch { /* 回调异常不阻断投递 */ }
    }
    this.onWake()
  }

  /** 到信回调注册(即时唤醒阻塞等待方);返回注销函数 */
  onArrival(cb: () => void): () => void {
    this.arrivalCbs.add(cb)
    return () => {
      this.arrivalCbs.delete(cb)
    }
  }

  /** 取出下一条(FIFO);无消息时挂起等待;关闭后返回 null */
  async dequeue(): Promise<A2AMessage | null> {
    for (;;) {
      if (this.closed) return null
      // 先取门闩引用再查询:查询空档内 enqueue 的 releaseGate 才不会丢唤醒
      // (若查询后才取引用,新门闩替换旧门闩 → 挂在未触发的门闩上永久沉睡)
      const gate = this.gate
      const rows = this.messageRepo.listPendingByChannelAgent(this.channelId, this.agentId)
      const row = rows[0]
      if (row) {
        this.messageRepo.markConsuming(row.id)
        return rowToMessage(row)
      }
      // 门闩挂起 + 15s 兜底重查:任何唤醒丢失路径自愈(消息最多滞后 15s)
      await Promise.race([
        gate.promise,
        new Promise<void>(resolve => setTimeout(resolve, 15_000)),
      ])
    }
  }

  /** 只读查看未消费消息(不改变状态) */
  async peek(limit: number): Promise<A2AMessage[]> {
    const rows = this.messageRepo.listPendingByChannelAgent(this.channelId, this.agentId).slice(0, limit)
    return rows.map(rowToMessage)
  }

  /** 标记已消费 */
  markConsumed(messageId: string): void {
    this.messageRepo.markConsumed(messageId)
  }

  /** 回合失败重投(consuming → pending);返回是否实际重投 */
  requeue(messageId: string): boolean {
    return this.messageRepo.requeue(messageId)
  }

  /** 外部唤醒:解除 dequeue 挂起(供 manager 在 taskEngine 直接落库后唤醒) */
  wake(): void {
    this.releaseGate()
  }

  /** 关闭邮箱:解除 dequeue 挂起,后续 dequeue 返回 null(供 AgentRuntime.stop) */
  close(): void {
    this.closed = true
    this.releaseGate()
  }

  private releaseGate(): void {
    this.gate.resolve()
    this.gate = newGate()
  }
}
