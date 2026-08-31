/**
 * WS 连接管理:单条 WebSocket 复用订阅多 channel(sub/unsub),
 * 指数退避重连 + lastSeq 断线续传;连接态/seq 供状态条渲染。
 */
import { defineStore } from 'pinia'
import type { AepEnvelope } from '#shared/workshop-protocol'

export type WsState = 'connecting' | 'open' | 'closed'

/** 半死连接阈值:超过该时长无任何帧(pong/事件)→ 主动断开重连 */
const STALE_MS = 45_000

/**
 * 数据级失联阈值:pong 仍应答但长期无数据帧(服务端 HMR 后 hub 失联等)→ 主动重连恢复订阅。
 * 需与心跳周期(30s)联动:检测延迟最坏为阈值 + 一个心跳周期。阈值须显著大于
 * 空闲 channel 的正常静默(无活动即无数据帧),避免健康空闲连接被反复重连。
 */
const DATA_STALE_MS = 90_000

export const useWsConnectionStore = defineStore('workshop.connection', {
  state: () => ({
    state: 'closed' as WsState,
    /** 已订阅 channel → 最近 seq(断线续传游标) */
    cursors: {} as Record<string, number>,
    /** 最近一次数据帧到达时间(ms;0 = 尚无数据)——状态条"最后已知更新"依据(open-tag 规范:断连时不假装在线) */
    lastDataAt: 0,
    /** 断线期间是否有已订阅 channel 游标待对齐(重连后收到首帧清零) */
    pendingReplay: false,
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
  /** 每 channel 订阅引用计数:多组件(总览页/控制台/抽屉)共享同一订阅,最后一个引用释放才真正退订 */
  private refCounts = new Map<string, number>()
  /** 每 channel 最近 seq(重连续传游标;由事件回调 updateCursor 持续推进) */
  private lastSeqByChannel = new Map<string, number>()
  /** 最近收帧时间(半死连接检测基准) */
  private lastFrameAt = 0
  /** 最近收数据帧时间(pong 除外;数据级失联检测基准) */
  private lastDataAt = 0
  /** 用户 token(用户级隔离:sub 帧鉴权;由消费方注入) */
  userToken = ''

  constructor(
    private readonly onEvent: (e: AepEnvelope) => void,
    private readonly onStateChange: (s: WsState, retry: number) => void,
    private readonly onPendingReplay: () => void = () => {},
    private readonly onDataRecovered: () => void = () => {},
  ) {}

  /** 事件消费方推进游标(供重连 lastSeq 续传) */
  updateCursor(channelId: string, seq: number): void {
    if (Number.isFinite(seq)) this.lastSeqByChannel.set(channelId, seq)
  }

  private url(): string {
    // SSR 守卫:服务端无 location;仅在浏览器连接
    if (typeof location === 'undefined') return 'ws://localhost/api/workshop/ws'
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/api/workshop/ws${this.userToken ? `?token=${encodeURIComponent(this.userToken)}` : ''}`
  }

  private connect(): void {
    if (typeof window === 'undefined') return // SSR 不建连(客户端水合后订阅触发)
    this.onStateChange('connecting', this.retry)
    const ws = new WebSocket(this.url())
    this.ws = ws
    this.lastFrameAt = Date.now()
    this.lastDataAt = Date.now()
    ws.onopen = () => {
      this.retry = 0
      this.onStateChange('open', 0)
      // 重连后恢复全部订阅(带 lastSeq 续传,缓冲窗外由服务端 snapshot 对齐)
      for (const channelId of this.subscribed) this.sendSub(channelId, this.lastSeqByChannel.get(channelId))
    }
    ws.onmessage = (ev) => {
      this.lastFrameAt = Date.now()
      try {
        const e = JSON.parse(ev.data as string) as AepEnvelope
        if (e.type !== 'pong') {
          this.lastDataAt = Date.now()
          // 重连后首帧:断线期间的缺口已由服务端重放/快照对齐
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
      // 有订阅游标的断线:重连后需服务端重放对齐(状态条提示"同步中")
      if (this.subscribed.size > 0) this.onPendingReplay()
      // 指数退避:1s → 2s → 4s → … → 10s 封顶
      const delay = Math.min(1000 * 2 ** this.retry, 10_000)
      this.retry += 1
      setTimeout(() => {
        if (!this.closedByUser) this.connect()
      }, delay)
    }
    ws.onerror = () => { /* onclose 兜底重连 */ }
  }

  /** 半死连接检测(心跳窗口):无任何帧超阈值 → 主动断开;pong-only 无数据帧超阈值(HMR 后 hub 失联)→ 主动断开重连恢复订阅 */
  checkStale(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (Date.now() - this.lastFrameAt > STALE_MS) ws.close()
    else if (Date.now() - this.lastDataAt > DATA_STALE_MS) ws.close()
  }

  private sendSub(channelId: string, lastSeq?: number): void {
    const frame: Record<string, unknown> = { type: 'sub', channelId, token: this.userToken }
    if (typeof lastSeq === 'number') frame.lastSeq = lastSeq
    this.ws?.send(JSON.stringify(frame))
  }

  subscribe(channelId: string, lastSeq?: number): void {
    const prev = this.refCounts.get(channelId) ?? 0
    this.refCounts.set(channelId, prev + 1)
    // 已有持有者:会话已订阅,不再重发 sub(重复帧会触发服务端重放/快照,浪费且扰动 UI)
    if (prev > 0) return
    this.subscribed.add(channelId)
    if (typeof lastSeq === 'number') this.lastSeqByChannel.set(channelId, lastSeq)
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSub(channelId, this.lastSeqByChannel.get(channelId))
    else if (!this.ws) this.connect()
  }

  unsubscribe(channelId: string): void {
    const prev = this.refCounts.get(channelId) ?? 0
    // 引用计数归零才真正退订:页面切换时旧页卸载不得拆掉新页仍在用的订阅
    if (prev <= 1) {
      this.refCounts.delete(channelId)
      this.subscribed.delete(channelId)
      if (this.ws?.readyState === WebSocket.OPEN) this.ws?.send(JSON.stringify({ type: 'unsub', channelId }))
    }
    else {
      this.refCounts.set(channelId, prev - 1)
    }
  }

  /** 当前 channel 的订阅引用数(0 = 会话已不持有;消费方据此决定是否清本地缓冲) */
  refCount(channelId: string): number {
    return this.refCounts.get(channelId) ?? 0
  }

  ping(): void {
    try {
      this.ws?.send(JSON.stringify({ type: 'ping' }))
    }
    catch {
      // 半开连接:发送即失败 → 立即关闭触发 onclose→重连(不等 45s stale 检测)
      try {
        this.ws?.close()
      }
      catch {
        /* 已关闭 */
      }
    }
  }

  close(): void {
    this.closedByUser = true
    this.ws?.close()
  }
}
