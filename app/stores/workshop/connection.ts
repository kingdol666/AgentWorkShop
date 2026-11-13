import { defineStore } from 'pinia'
import type { AepEnvelope } from '#shared/workshop-protocol'

export type WsState = 'connecting' | 'open' | 'closed'
type TicketProvider = () => Promise<string | null>

const STALE_MS = 45_000
const DATA_STALE_MS = 90_000

export const useWsConnectionStore = defineStore('workshop.connection', {
  state: () => ({
    state: 'closed' as WsState,
    cursors: {} as Record<string, number>,
    lastDataAt: 0,
    pendingReplay: false,
    lastError: '' as string,
    retryCount: 0,
  }),
})

/** WS 会话对象：浏览器握手使用短时一次性 ticket，不把长期用户 token 放入 URL 或帧。 */
export class WorkshopWsSession {
  private ws: WebSocket | null = null
  private retry = 0
  private closedByUser = false
  private connecting = false
  private subscribed = new Set<string>()
  private refCounts = new Map<string, number>()
  private lastSeqByChannel = new Map<string, number>()
  private lastFrameAt = 0
  private lastDataAt = 0
  private ticketProvider: TicketProvider | null = null

  constructor(
    private readonly onEvent: (e: AepEnvelope) => void,
    private readonly onStateChange: (s: WsState, retry: number) => void,
    private readonly onPendingReplay: () => void = () => {},
    private readonly onDataRecovered: () => void = () => {},
  ) {}

  setTicketProvider(provider: TicketProvider): void {
    this.ticketProvider = provider
  }

  updateCursor(channelId: string, seq: number): void {
    if (Number.isFinite(seq)) this.lastSeqByChannel.set(channelId, seq)
  }

  private url(): string {
    if (typeof location === 'undefined') return 'ws://localhost/api/workshop/ws'
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/api/workshop/ws`
  }

  private async connect(): Promise<void> {
    if (typeof window === 'undefined' || this.ws || this.connecting || this.closedByUser) return
    this.connecting = true
    this.onStateChange('connecting', this.retry)
    let ticket: string | null = null
    try {
      ticket = await this.ticketProvider?.() ?? null
    }
    catch {
      ticket = null
    }
    if (!ticket || this.closedByUser) {
      this.connecting = false
      this.onStateChange('closed', this.retry)
      return
    }

    const ws = new WebSocket(this.url())
    this.ws = ws
    this.connecting = false
    this.lastFrameAt = Date.now()
    this.lastDataAt = Date.now()
    ws.onopen = () => {
      this.retry = 0
      this.onStateChange('open', 0)
      // auth 必须先于 sub；服务端按同一连接的消息顺序绑定 peer 身份。
      ws.send(JSON.stringify({ type: 'auth', ticket }))
      for (const channelId of this.subscribed) this.sendSub(channelId, this.lastSeqByChannel.get(channelId))
    }
    ws.onmessage = (ev) => {
      this.lastFrameAt = Date.now()
      try {
        const e = JSON.parse(ev.data as string) as AepEnvelope
        if (e.type !== 'pong') {
          this.lastDataAt = Date.now()
          this.onDataRecovered()
        }
        this.onEvent(e)
      }
      catch { /* 非 JSON 帧忽略 */ }
    }
    ws.onclose = () => {
      this.ws = null
      if (this.closedByUser) {
        this.onStateChange('closed', 0)
        return
      }
      this.onStateChange('closed', this.retry)
      if (this.subscribed.size > 0) this.onPendingReplay()
      const delay = Math.min(1000 * 2 ** this.retry, 10_000)
      this.retry += 1
      setTimeout(() => {
        if (!this.closedByUser) void this.connect()
      }, delay)
    }
    ws.onerror = () => { /* onclose 兜底重连 */ }
  }

  checkStale(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (Date.now() - this.lastFrameAt > STALE_MS) ws.close()
    else if (Date.now() - this.lastDataAt > DATA_STALE_MS) ws.close()
  }

  private sendSub(channelId: string, lastSeq?: number): void {
    const frame: Record<string, unknown> = { type: 'sub', channelId }
    if (typeof lastSeq === 'number') frame.lastSeq = lastSeq
    this.ws?.send(JSON.stringify(frame))
  }

  subscribe(channelId: string, lastSeq?: number): void {
    const prev = this.refCounts.get(channelId) ?? 0
    this.refCounts.set(channelId, prev + 1)
    if (prev > 0) return
    this.subscribed.add(channelId)
    if (typeof lastSeq === 'number') this.lastSeqByChannel.set(channelId, lastSeq)
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSub(channelId, this.lastSeqByChannel.get(channelId))
    else void this.connect()
  }

  ensureConnected(): void {
    if (typeof window === 'undefined') return
    void this.connect()
  }

  unsubscribe(channelId: string): void {
    const prev = this.refCounts.get(channelId) ?? 0
    if (prev <= 1) {
      this.refCounts.delete(channelId)
      this.subscribed.delete(channelId)
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'unsub', channelId }))
    }
    else {
      this.refCounts.set(channelId, prev - 1)
    }
  }

  refCount(channelId: string): number {
    return this.refCounts.get(channelId) ?? 0
  }

  ping(): void {
    try {
      this.ws?.send(JSON.stringify({ type: 'ping' }))
    }
    catch {
      try {
        this.ws?.close()
      }
      catch { /* 已关闭 */ }
    }
  }

  close(): void {
    this.closedByUser = true
    this.ws?.close()
  }

  reopen(): void {
    this.closedByUser = false
    void this.connect()
  }
}
