import { getRequestHeader, type H3Event } from 'h3'
import { defineApiHandler } from '../../../utils/response'
import { AppError } from '../../../utils/errors'
import { resolveBrowserSessionFromEvent, issueWsTicket } from '../../../services/auth/browser-session'
import { resolveUserByToken } from '../../../services/user.service'

/** POST /api/workshop/ws/ticket —— 短时一次性 WS ticket；不返回长期 Bearer。 */
export default defineApiHandler((event: H3Event) => {
  const auth = getRequestHeader(event, 'authorization')
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const user = bearer ? resolveUserByToken(bearer) : resolveBrowserSessionFromEvent(event)
  if (!user) throw new AppError(401, 'USER_UNAUTHORIZED', '需要有效的用户会话')
  return issueWsTicket(user.id)
})
