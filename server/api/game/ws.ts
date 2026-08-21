/**
 * WebSocket 端点: /api/game/ws
 *
 * 上行:JSON 消息 → CMDParser.parseUplink 权威校验 → gameSession.handleInput
 * 下行:gameSession.emit 广播指令(JSON,已由线类型保证形状)
 * 校验失败:回发协议 error 指令(BAD_MESSAGE / UNKNOWN_COMMAND / INVALID_PAYLOAD)
 *
 * 鉴权(业务面统一口径):连接需携带用户 token(?token= 查询参数);
 * 缺失/无效 → 回发 error 指令并关闭(与 workshop/ws 的 USER_UNAUTHORIZED 同语义)。
 */
import { defineWebSocketHandler } from 'h3'
import type { Peer } from 'crossws'
import { CMDParser } from '../../../shared/game-protocol'
import { gameSession } from '../../services/game/session'
import { resolveUserByToken } from '../../services/user.service'

type WsPeer = Peer

function resolveQueryParam(peer: WsPeer, name: string): string | undefined {
  const req = (peer as unknown as { request?: Request }).request
  if (!req) return undefined
  return new URL(req.url).searchParams.get(name) ?? undefined
}

function sendErrorAndClose(peer: WsPeer, message: string): void {
  try {
    peer.send(JSON.stringify(CMDParser.toErrorCommand({ code: 'USER_UNAUTHORIZED', message })))
  }
  catch {
    // 死连接静默
  }
  peer.close(4401, 'unauthorized')
}

export default defineWebSocketHandler({
  open(peer) {
    const token = resolveQueryParam(peer, 'token')
    if (!token) {
      sendErrorAndClose(peer, 'WS 连接需要用户 token(?token= 查询参数)')
      return
    }
    const user = resolveUserByToken(token)
    if (!user) {
      sendErrorAndClose(peer, '用户 token 无效或已吊销')
      return
    }
    gameSession.connect(peer)
  },

  message(peer, message) {
    const raw = message.text()
    if (!raw) {
      return
    }
    const res = CMDParser.parseUplink(raw)
    if (!res.ok) {
      peer.send(JSON.stringify(CMDParser.toErrorCommand(res.error)))
      return
    }
    gameSession.handleInput(res.value)
  },

  close() {
    gameSession.disconnect()
  },

  error(peer, error) {
    console.error('[game-ws] connection error:', error)
    gameSession.disconnect()
  },
})
