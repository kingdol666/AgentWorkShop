/**
 * 安全启动插件(S2,production-readiness-plan)。
 *
 * production 下 sessionPassword 仍是仓库默认值 → 拒绝启动(带明确修复指引):
 * dev/测试环境零影响;经反向代理终止 TLS 的部署基线见 config.yml 注释与 README。
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

export default function securityPlugin() {
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
