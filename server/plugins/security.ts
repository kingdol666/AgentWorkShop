/**
 * 安全启动插件(S2,production-readiness-plan)。
 *
 * 用户系统为"首启自注册"设计(users.sqlite 初始零用户,登录页注册的第一个
 * 账号自动成为管理员,见 user.service.register):不存在种子账号,无默认密码
 * 可泄露,故不再做种子密码拦截。
 *
 * 本插件现在只做两件事:
 *   1. 启动时输出管理员初始化状态提示(dev/prod 都生效,不阻断);
 *   2. production 下 sessionPassword 为空/仓库默认值 → 拒绝启动(带修复指引;
 *      密钥走 gitignored .env 经 start.mjs 注入,正常部署不会命中)。
 *
 * 与 workshop.ts 同风格:defineNitroPlugin 为恒等包装,default 直接导出普通函数。
 */
import { useRuntimeConfig } from '#imports'

/** 仓库默认密钥(泄漏在 config.yml/git 历史,绝不可用于生产) */
const KNOWN_DEFAULT_PASSWORDS = new Set([
  'awshop-dev-secret-change-me-0123456789',
  'awshop-dev-secret-change-me',
  'change-me',
])

export default async function securityPlugin() {
  // 管理员初始化状态提示(动态 import,避免影响插件加载顺序;检查失败不阻断)
  try {
    const { userRepository } = await import('../repositories/user.repository')
    if (!userRepository.hasActiveAdmin()) {
      console.log('[security] 尚无管理员账号:系统处于初始化状态——在登录页注册的第一个账号将成为管理员。')
    }
  }
  catch (err) {
    console.warn('[security] 管理员状态检查失败(放行):', String((err as Error)?.message ?? err))
  }

  if (process.env.NODE_ENV !== 'production') return
  const password = (useRuntimeConfig() as { session?: { password?: string } }).session?.password ?? ''
  // 空串同样拒绝:NUXT_SESSION_PASSWORD="" 会把烘焙配置覆盖为空值,不能放行
  if (!password || KNOWN_DEFAULT_PASSWORDS.has(password)) {
    throw new Error(
      '[security] 拒绝启动:production 模式下 sessionPassword 为空或仍是仓库默认值。'
      + '请在 config.yml 的 security.sessionPassword 设置强随机密钥(≥32 位)后重启。'
      + 'TLS/WSS 部署基线见 README「部署」一节(建议由 caddy/nginx 反向代理终止)。',
    )
  }
}
