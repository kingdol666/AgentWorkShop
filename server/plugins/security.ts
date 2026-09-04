/**
 * 安全启动插件(S2,production-readiness-plan)。
 *
 * production 下以下任一情况 → 拒绝启动(带明确修复指引):
 *   1. sessionPassword 仍是仓库默认值/空串;
 *   2. 种子账号仍持发布默认密码(存量库升级场景;新库种子已是随机密码)。
 * dev/测试环境零影响;紧急豁免:AW_INSECURE_SEED=1(仅跳过第 2 项)。
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
  // 存量库种子账号默认密码检测(动态 import,避免影响插件加载顺序)
  if (process.env.AW_INSECURE_SEED !== '1') {
    try {
      const { anySeedUsingDefaultPassword } = await import('../repositories/user.repository')
      if (anySeedUsingDefaultPassword()) {
        throw new Error(
          '[security] 拒绝启动:种子账号仍使用发布默认密码(该密码随源码/npm 公开,等同于未设防)。'
          + '请先用旧密码登录并修改 admin 密码,或经管理面重置后重启;'
          + '无法登录时可删除 <配置根>/data/users.sqlite 重新初始化(会丢失本地账号)。'
          + '一次性紧急豁免:设置环境变量 AW_INSECURE_SEED=1(不推荐)。',
        )
      }
    }
    catch (err) {
      // 拒启错误原样上抛;仅吞"检查本身失败"(库损坏等),不阻断启动
      if (String((err as Error)?.message ?? '').includes('[security]')) throw err
      console.warn('[security] 种子密码检查失败(放行):', String((err as Error)?.message ?? err))
    }
  }
}
