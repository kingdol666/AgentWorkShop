/**
 * Mailbox — 持久化 FIFO 队列(messages 表)。
 * 每个 Agent 一个实例;enqueue 落库 pending + 唤醒;dequeue 用 promise 门闩挂起等待。
 * at-least-once:dequeue 置 consuming;服务重启时上层调用 resetConsuming 重投。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T3。
 */
import type { A2AMessage, Part } from '../types/a2a'
import { parseJson } from '../db/database'
import type { MessageRow } from '../db/database'
import type { MessageBlocked, MessageRepo } from '../db/message.repo'
import { AppError } from '../../../utils/errors'

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
  const parsedMetadata = parseJson<unknown>(row.metadataJson, {})
  const metadata: Record<string, unknown> = parsedMetadata !== null && typeof parsedMetadata === 'object' && !Array.isArray(parsedMetadata)
    ? parsedMetadata as Record<string, unknown>
    : {}
  // Session Context：session_id 是平台列，metadata 是消息契约；读取时补齐后者，
  // 保证从历史 mailbox 重放的旧行也能恢复到同一 session。
  if (row.sessionId && typeof metadata['x-aw-session-id'] !== 'string') {
    metadata['x-aw-session-id'] = row.sessionId
  }
  return {
    messageId: row.id,
    contextId: row.channelId,
    taskId: row.taskId ?? undefined,
    role: row.role as 'ROLE_USER' | 'ROLE_AGENT',
    parts: parseJson<Part[]>(row.partsJson, []),
    metadata,
  }
}

export class Mailbox {
  readonly agentId: string
  readonly channelId: string
  private gate: Gate = newGate()
  private closed = false
  /** Tokens, not message IDs, distinguish concurrent generations of a claim. */
  private readonly claimedMessages = new Map<string, string>()
  private readonly processingMessages = new Map<string, string>()
  private readonly deliveryTokens = new WeakMap<A2AMessage, string>()
  /** 外部通知回调(如唤醒调度循环);由 AgentRuntime/Manager 注入 */
  private onWake: () => void
  /** 到信回调注册(poll_messages 长轮询即时唤醒;注册方自带注销句柄) */
  private arrivalCbs = new Set<() => void>()

  constructor(
    private messageRepo: MessageRepo,
    channelId: string,
    agentId: string,
    wake: () => void,
    private readonly isBlocked?: MessageBlocked,
  ) {
    this.channelId = channelId
    this.agentId = agentId
    this.onWake = wake
  }

  /** 投递:落库 pending + 唤醒 dequeue 门闩 + 到信回调 + 通知外部。
   *  返回 false = 信箱已关闭(停机窗口):消息**未落库**,调用方不得上报"已送达"
   *  (2026-10-28 审查 C-P1-1:闭箱静默吞消息 + route 照常计入 delivered = 假送达)。 */
  enqueue(message: A2AMessage): boolean {
    if (this.closed) return false
    const sessionId = typeof message.metadata?.['x-aw-session-id'] === 'string'
      ? message.metadata['x-aw-session-id']
      : null
    const actorUserId = typeof message.metadata?.['x-aw-from-user-id'] === 'string'
      ? message.metadata['x-aw-from-user-id']
      : null
    const clientMessageId = typeof message.metadata?.['x-aw-client-message-id'] === 'string'
      ? message.metadata['x-aw-client-message-id']
      : null
    const input = {
      // 保留发送方 messageId 作为落库 id:API 返回的 messageId 才能与历史/状态一致关联
      id: message.messageId,
      channelId: message.contextId,
      taskId: message.taskId ?? null,
      sessionId,
      actorUserId,
      clientMessageId,
      fromAgentId: (message.metadata?.['x-aw-from-agent'] as string | undefined) ?? null,
      toAgentId: this.agentId,
      role: message.role,
      parts: message.parts,
      metadata: message.metadata,
    }
    const result = sessionId && actorUserId && clientMessageId
      ? this.messageRepo.createSessionIdempotent(input)
      : { row: this.messageRepo.create(input), inserted: true }
    if (!result.inserted) {
      if (!this.messageRepo.sameSessionPayload(result.row, input)) {
        throw new AppError(409, 'SESSION_MESSAGE_IDEMPOTENCY_CONFLICT', 'clientMessageId 已被同一 actor 用于不同 payload')
      }
      // 两个并发请求各自生成了 messageId；返回/后续回执必须使用数据库赢家的 id。
      message.messageId = result.row.id
    }
    this.wake()
    this.onWake()
    return true
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
      const row = this.messageRepo.firstPendingByChannelAgent(this.channelId, this.agentId, this.isBlocked)
      if (row) {
        // 原子认领:认领失败 = 消息已被 steer 注入或 poll_messages 读即取
        // (唯一所有权),让路重查下一条——消费循环绝不重复处理他人消息
        const token = this.claim(row.id)
        if (!token) continue
        const message = rowToMessage(row)
        this.deliveryTokens.set(message, token)
        return message
      }
      // 门闩挂起 + 15s 兜底重查:任何唤醒丢失路径自愈(消息最多滞后 15s)
      await Promise.race([
        gate.promise,
        new Promise<void>(resolve => setTimeout(resolve, 15_000)),
      ])
    }
  }

  /** Get the private token associated with this exact dequeued delivery. */
  claimToken(message: A2AMessage): string | undefined {
    return this.deliveryTokens.get(message)
  }

  /** Atomically claim a message; callers must retain the returned token. */
  claim(messageId: string): string | null {
    const token = this.messageRepo.claim(messageId, this.isBlocked)
    if (token) this.claimedMessages.set(token, messageId)
    return token
  }

  /** Release either an unstarted or a completed processing claim. */
  releaseClaim(messageId: string, token: string): boolean {
    if (!this.hasLocalClaim(messageId, token)) return false
    const released = this.messageRepo.releaseClaim(messageId, token)
    this.forgetClaim(messageId, token)
    if (released) this.wake()
    return released
  }

  /** Return all claims that have not entered processing, preserving retry budget. */
  releaseOwnedClaims(): number {
    let released = 0
    for (const [token, messageId] of this.claimedMessages) {
      if (this.messageRepo.releaseClaim(messageId, token)) released += 1
    }
    this.claimedMessages.clear()
    if (released > 0) this.wake()
    return released
  }

  /** Mark an exact current claim as processing. */
  beginProcessing(messageId: string, token: string): boolean {
    if (this.claimedMessages.get(token) !== messageId) return false
    if (!this.messageRepo.ownsClaim(messageId, token)) {
      this.claimedMessages.delete(token)
      return false
    }
    if (this.isBlocked && this.messageRepo.isClaimBlocked(messageId, token, this.isBlocked)) {
      this.releaseClaim(messageId, token)
      return false
    }
    this.claimedMessages.delete(token)
    this.processingMessages.set(token, messageId)
    return true
  }

  private hasLocalClaim(messageId: string, token: string): boolean {
    return typeof token === 'string' && token.length > 0
      && (this.claimedMessages.get(token) === messageId || this.processingMessages.get(token) === messageId)
  }

  private forgetClaim(messageId: string, token: string): void {
    if (this.claimedMessages.get(token) === messageId) this.claimedMessages.delete(token)
    if (this.processingMessages.get(token) === messageId) this.processingMessages.delete(token)
  }

  /** 只读查看未消费消息(不改变状态) */
  async peek(limit: number): Promise<A2AMessage[]> {
    return this.messageRepo.listPendingByChannelAgent(this.channelId, this.agentId, limit, this.isBlocked).map(rowToMessage)
  }

  /** Settle only the exact claim held by this mailbox. */
  markConsumed(messageId: string, token: string): boolean {
    if (!this.hasLocalClaim(messageId, token)) return false
    const consumed = this.messageRepo.markConsumed(messageId, token)
    this.forgetClaim(messageId, token)
    return consumed
  }

  /** Quarantine a locally held recovery claim without disturbing a newer claim. */
  deadLetterLegacyRecoveryClaim(messageId: string, token: string): boolean {
    if (!this.hasLocalClaim(messageId, token)) return false
    const dead = this.messageRepo.deadLetterLegacyRecoveryClaim(messageId, token)
    if (dead || !this.messageRepo.ownsClaim(messageId, token)) this.forgetClaim(messageId, token)
    return dead
  }

  /** Recheck the persisted row under this exact claim, failing closed on lost ownership. */
  isClaimBlocked(messageId: string, token: string): boolean {
    if (!this.hasLocalClaim(messageId, token)) return true
    return this.isBlocked
      ? this.messageRepo.isClaimBlocked(messageId, token, this.isBlocked)
      : !this.messageRepo.ownsClaim(messageId, token)
  }

  /** Whether this exact claim is still owned by this mailbox. */
  ownsClaim(messageId: string, token: string): boolean {
    return this.hasLocalClaim(messageId, token) && this.messageRepo.ownsClaim(messageId, token)
  }

  /** 回合失败重投(consuming → pending);返回是否实际重投 */
  requeue(messageId: string, token: string): boolean {
    if (!this.hasLocalClaim(messageId, token)) return false
    const requeued = this.messageRepo.requeue(messageId, token)
    this.forgetClaim(messageId, token)
    return requeued
  }

  /** Recheck queue and long-poll waiters after delivery or eligibility changes. */
  wake(): void {
    this.releaseGate()
    for (const cb of this.arrivalCbs) {
      try {
        cb()
      }
      catch { /* A waiter must not block other notifications. */ }
    }
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
