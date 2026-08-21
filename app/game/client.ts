/**
 * GameClient — 前端 WebSocket 客户端
 *
 * 职责:
 *  - 连接 /api/game/ws,3s 退避自动重连(重连后重新 session.join)
 *  - 上行:send(ClientToServer)
 *  - 下行:onCommand(ServerToClient) 分发(由外部注入路由)
 */
import { CMDParser } from './protocol'
import type { ClientToServer, ServerToClient } from './protocol'

export interface GameClientOptions {
  /** 命令路由:每条下行指令 */
  onCommand: (cmd: ServerToClient) => void
  /** 连接状态变化(供 HUD 指示) */
  onStatus?: (connected: boolean) => void
  url?: string
  reconnectDelayMs?: number
  /** 用户 token 获取器(连接鉴权 ?token=;重连时取最新值) */
  getToken?: () => string | undefined
}

export class GameClient {
  private ws: WebSocket | null = null
  private readonly url: string
  private readonly reconnectDelayMs: number
  private readonly onCommand: (cmd: ServerToClient) => void
  private readonly onStatus?: (connected: boolean) => void
  private disposed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private joined = false
  private readonly getToken?: () => string | undefined

  constructor(options: GameClientOptions) {
    this.url = options.url ?? '/api/game/ws'
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000
    this.onCommand = options.onCommand
    this.onStatus = options.onStatus
    this.getToken = options.getToken
  }

  connect(): void {
    if (this.disposed) {
      return
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = this.getToken?.()
    const authQuery = token ? `?token=${encodeURIComponent(token)}` : ''
    this.ws = new WebSocket(`${proto}//${location.host}${this.url}${authQuery}`)

    this.ws.onopen = () => {
      this.joined = false
      this.onStatus?.(true)
      this.send({ type: 'session.join', payload: {} })
    }
    this.ws.onmessage = (ev) => {
      const res = CMDParser.parseDownlink(ev.data as string)
      if (!res.ok) {
        // 线格式不符协议:转为 error 指令交给场景层展示(HUD/控制台)
        this.onCommand(CMDParser.toErrorCommand(res.error))
        return
      }
      if (res.value.type === 'session.ready') {
        this.joined = true
      }
      this.onCommand(res.value)
    }
    this.ws.onclose = () => {
      this.onStatus?.(false)
      if (!this.disposed) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelayMs)
      }
    }
    this.ws.onerror = () => {
      // onclose 会随之触发,重连逻辑统一在 onclose
    }
  }

  /** 上行消息(连接未就绪时静默丢弃,状态以服务端为准) */
  send(msg: ClientToServer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }
}
