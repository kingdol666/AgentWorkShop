import { userRepository } from '../../repositories/user.repository'
import { defineApiHandler } from '../../utils/response'

/** GET /api/users/setup-status —— 公开:系统是否处于初始化状态。
 * true = 无活跃管理员 → 登录门呈现"注册管理员"表单,首个注册账号自动成为 admin */
export default defineApiHandler(async () => {
  return { needsSetup: !userRepository.hasActiveAdmin() }
})
