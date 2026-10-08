import { userRepository } from '../../repositories/user.repository'
import { settingOf } from '../../services/workshop/settings'
import { defineApiHandler } from '../../utils/response'

/** GET /api/users/setup-status —— 公开:登录门初始化探测。
 * needsSetup = true 表示无活跃管理员 → 登录门呈现"注册管理员"表单,首个注册账号自动成为 admin。
 * allowRegistration = false 表示自助注册已关(security.allowRegistration=false 且首管理员已就位)
 * → 登录门隐藏注册页签(与 register 端点的 403 闸门同一复合条件,前端呈现层对齐)。 */
export default defineApiHandler(async () => {
  const needsSetup = !userRepository.hasActiveAdmin()
  const allowRegistration = !(settingOf('security.allowRegistration') === false && !needsSetup)
  return { needsSetup, allowRegistration }
})
