import { getRequestHeader } from 'h3'
import type { H3Event } from 'h3'
import { AppError } from './errors'

/** 从 Authorization: Bearer <token> 提取 token；缺失 → 401 */
export function extractBearerToken(event: H3Event): string {
  const auth = getRequestHeader(event, 'authorization')
  const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!token) {
    throw new AppError(401, 'UNAUTHORIZED', '需要有效的 token(Authorization: Bearer <token>)')
  }
  return token
}
