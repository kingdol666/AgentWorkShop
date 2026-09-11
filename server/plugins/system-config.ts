/**
 * 系统配置启动插件。
 * Nitro 启动时:初始化 SystemConfigService(root=启动 cwd) → 服务内部经 resolveRunMode
 * 统一解析配置根(启动目录的 ./.AgentWorkShop 优先,否则 ~/.AgentWorkShop 兜底)
 * → 把 <配置根>/runtime-settings.json 的运行时覆盖应用到 runtimeConfig → 挂载文件监听
 * （CLI/手工外部写入自动热重载 + 广播）。
 * 与 workshop.ts 同风格:defineNitroPlugin 为恒等包装,default 直接导出普通函数。
 * 幂等:globalThis.__systemConfig 已存在则跳过（测试预置场景）。
 */
import { resolve } from 'node:path'
import { resolveRunMode } from '@/shared/config/home.mjs'
import { getSystemConfigService } from '../services/system-config'

export default function systemConfigPlugin(nitroApp: {
  hooks: { hook(name: string, fn: (...args: unknown[]) => void | Promise<void>): void }
}): void {
  // 先检查已设置:避免重复装配覆盖既有单例
  if (globalThis.__systemConfig) return

  // 与启动器(start.mjs/dev-guard.mjs)同一解析入口:cwd 相同 → 配置根必然相同
  const rm = resolveRunMode({ cwd: resolve(process.cwd()), packageRoot: process.env.AW_PACKAGE_ROOT, env: process.env })

  const service = getSystemConfigService(resolve(process.cwd()))
  try {
    service.init()
    // 打印真实生效路径(此前写死 <cwd>/data/runtime-settings.json,与实际落盘位置不符,排障误导)
    console.log(`[system-config] 运行时设置已加载 -> ${service.effectiveSettingsPath}(配置根 ${rm.configRoot},模式 ${rm.mode})`)
  }
  catch (err) {
    // 初始化失败不阻断服务（设置系统降级为只读构建配置）
    console.warn('[system-config] 初始化失败(设置系统降级):', String(err?.message ?? err))
  }

  nitroApp.hooks.hook('close', () => {
    service.dispose()
  })
}
