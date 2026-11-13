import { getRequestHeader, type H3Event } from 'h3'
import { resolveBrowserSessionFromEvent } from '../services/auth/browser-session'
import { resolveUserByToken } from '../services/user.service'
import { AppError } from './errors'

export function resolveUserPrincipal(event: H3Event) {
  const auth = getRequestHeader(event, 'authorization')
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const user = bearer ? resolveUserByToken(bearer) : resolveBrowserSessionFromEvent(event)
  if (!user) throw new AppError(401, 'USER_UNAUTHORIZED', '需要有效的用户会话或 Bearer token')
  return { user, bearer }
}
