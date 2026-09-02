/**
 * 插件宿主 nitro 装配点 —— 启动期装载 ~/.AgentWorkShop/plugins 与
 * <repo>/.AgentWorkShop/plugins 下的用户插件;服务关闭时发出 server:close。
 * 装载细节见 server/services/workshop/plugins/host.mjs(错误隔离:单插件失败不拖垮主服务)。
 */
import { initPluginHost, shutdownPluginHost } from '@/server/services/workshop/plugins/host.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// packageRoot = 本包根(nitro 打包后由运行 cwd 提供事实源,此处兜底)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export default defineNitroPlugin((nitroApp) => {
  void initPluginHost({ cwd: process.cwd(), packageRoot })
  nitroApp.hooks.hookOnce('close', () => {
    void shutdownPluginHost()
  })
})
