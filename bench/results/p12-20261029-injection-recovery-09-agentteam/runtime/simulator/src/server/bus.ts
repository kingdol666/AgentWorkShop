/**
 * WS 推送总线 —— 前端实时监视通道。单例 Set 订阅,JSON 文本帧。
 */
import type { WebSocket } from 'ws'
import type { SimWsFrame } from '../shared/types'

const clients = new Set<WebSocket>()

export function addClient(ws: WebSocket): void {
  clients.add(ws)
  ws.addEventListener('close', () => clients.delete(ws))
  ws.addEventListener('error', () => clients.delete(ws))
}

export function broadcast(frame: SimWsFrame): void {
  const text = JSON.stringify(frame)
  for (const ws of clients) {
    try {
      if (ws.readyState === 1) ws.send(text)
    }
    catch { clients.delete(ws) }
  }
}
