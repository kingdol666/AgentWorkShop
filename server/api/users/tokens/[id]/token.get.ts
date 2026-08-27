import { getRouterParam } from 'h3'
import { extractBearerToken } from '../../../../utils/auth'
import { userService } from '../../../../services/user.service'
import { defineApiHandler } from '../../../../utils/response'

/** GET /api/users/tokens/:id/token —— 查看当前用户某 token 的存档明文（随时可查，配合前端掩码/眼睛切换） */
export default defineApiHandler((event) => {
  const token = extractBearerToken(event)
  const id = getRouterParam(event, 'id') ?? ''
  return { token: userService.revealToken(userService.me(token).id, id) }
})
