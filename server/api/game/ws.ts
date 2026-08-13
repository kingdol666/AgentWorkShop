/**
 * WebSocket 端点: /api/game/ws
 *
 * 上行:JSON 消息 → CMDParser.parseUplink 权威校验 → gameSession.handleInput
 * 下行:gameSession.emit 广播指令(JSON,已由线类型保证形状)
 * 校验失败:回发协议 error 指令(BAD_MESSAGE / UNKNOWN_COMMAND / INVALID_PAYLOAD)
 */
import { defineWebSocketHandler } from 'h3'
import { CMDParser } from '../../../shared/game-protocol'
import { gameSession } from '../../services/game/session'

export default defineWebSocketHandler({
  open(peer) {
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
