/**
 * POST /api/game/brain?pause=true|false — 暂停/恢复自主 brain tick
 *
 * Agent harness 接管控制权时暂停自主决策(Agent 直驱),释放时恢复。
 * 开发/测试用:让下行指令渲染验证摆脱模拟 brain 的自发对话干扰。
 */
import { getQuery } from 'h3'
import { defineApiHandler } from '../../utils/response'
import { gameSession } from '../../services/game/session'
import { resolveUser } from '../workshop/caller'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const pause = q.pause === 'true' || q.pause === '1'
  if (pause) {
    gameSession.pauseBrain()
  }
  else {
    gameSession.resumeBrain()
  }
  return { paused: pause }
})
