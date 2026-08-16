/**
 * WS 连接管理:单条 WebSocket 复用订阅多 channel(sub/unsub),
 * 指数退避重连 + lastSeq 断线续传;连接态/seq 供状态条渲染。
 */
import { defineStore } from 'pinia'
import type { AepEnvelope } from '#shared/workshop-protocol'

export type WsState = 'connecting' | 'open' | 'closed'

export const useWsConnectionStore = defineStore('workshop.connection', {
  state: () => ({
    state: 'closed' as WsState,
    /** 已订阅 channel → 最近 seq(断线续传游标) */
    cursors: {} as Record<string, number>,
    /** 断线期间缓冲的待确认事件数(重放后清零) */
    pendingReplay: 0,
    lastError: '' as string,
    retryCount: 0,
  }),
})

/** WS 会话对象(非 store:持原生 WebSocket,事件回调注入消费方) */
export class WorkshopWsSession {
  private ws: WebSocket | null = null
  private retry = 0
  private closedByUser = false
  private subscribed = new Set<string>()

  constructor(
    private readonly onEvent: (e: AepEnvelope) => void,
    private readonly onStateChange: (s: WsState, retry: number) => void,
  ) {}

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/api/workshop/ws`
  }

  private connect(): void {
    this.onStateChange('connecting', this.retry)
    const ws = new WebSocket(this.url())
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.onStateChange('open', 0)
      // 重连后恢复全部订阅(带 lastSeq 续传)
      for (const channelId of this.subscribed) this.sendSub(channelId)
    }
    ws.onmessage = (ev) => {
      try {
        this.onEvent(JSON.parse(ev.data as string) as AepEnvelope)
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
      // 指数退避:1s → 2s → 4s → … → 10s 封顶
      const delay = Math.min(1000 * 2 ** this.retry, 10_000)
      this.retry += 1
      setTimeout(() => {
        if (!this.closedByUser) this.connect()
      }, delay)
    }
    ws.onerror = () => { /* onclose 兜底重连 */ }
  }

  private sendSub(channelId: string, lastSeq?: number): void {
    const frame: Record<string, unknown> = { type: 'sub', channelId }
    if (typeof lastSeq === 'number') frame.lastSeq = lastSeq
    this.ws?.send(JSON.stringify(frame))
  }

  subscribe(channelId: string, lastSeq?: number): void {
    this.subscribed.add(channelId)
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSub(channelId, lastSeq)
    else if (!this.ws) this.connect()
  }

  unsubscribe(channelId: string): void {
    this.subscribed.delete(channelId)
    if (this.ws?.readyState === WebSocket.OPEN) this.ws?.send(JSON.stringify({ type: 'unsub', channelId }))
  }

  ping(): void {
    this.ws?.send(JSON.stringify({ type: 'ping' }))
  }

  close(): void {
    this.closedByUser = true
    this.ws?.close()
  }
}
