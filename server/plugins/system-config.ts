/**
 * 系统配置启动插件。
 * Nitro 启动时:初始化 SystemConfigService(root=data 所在根) → 把 data/runtime-settings.json
 * 的运行时覆盖应用到 runtimeConfig → 挂载文件监听（CLI/手工外部写入自动热重载 + 广播）。
 * 与 workshop.ts 同风格:defineNitroPlugin 为恒等包装,default 直接导出普通函数。
 * 幂等:globalThis.__systemConfig 已存在则跳过（测试预置场景）。
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { getSystemConfigService } from '../services/system-config'

export default function systemConfigPlugin(nitroApp: {
  hooks: { hook(name: string, fn: (...args: unknown[]) => void | Promise<void>): void }
}): void {
  // 先检查已设置:避免重复装配覆盖既有单例
  if (globalThis.__systemConfig) return

  const root = resolve(process.cwd())
  // data/ 目录须存在（settings 文件落盘依赖目录）
  try {
    mkdirSync(resolve(root, 'data'), { recursive: true })
  }
  catch { /* 只读环境:init 内部会降级 */ }

  const service = getSystemConfigService(root)
  try {
    service.init()
    console.log(`[system-config] 运行时设置已加载 -> ${resolve(root, 'data', 'runtime-settings.json')}`)
  }
  catch (err) {
    // 初始化失败不阻断服务（设置系统降级为只读构建配置）
    console.warn('[system-config] 初始化失败(设置系统降级):', String(err?.message ?? err))
  }

  nitroApp.hooks.hook('close', () => {
    service.dispose()
  })
}
