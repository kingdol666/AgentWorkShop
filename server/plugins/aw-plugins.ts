/**
 * 插件宿主 nitro 装配点 —— 启动期装载 ~/.AgentWorkShop/plugins 与
 * <repo>/.AgentWorkShop/plugins 下的用户插件;服务关闭时发出 server:close。
 * 装载细节见 server/services/workshop/plugins/host.mjs(错误隔离:单插件失败不拖垮主服务)。
 */
import { initPluginHost, shutdownPluginHost } from '@/server/services/workshop/plugins/host.mjs'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// packageRoot = 本包根。nitro 打包后 import.meta.url 位于 .output/server/chunks/ 内,
// '..','..' 解析到 .output(不含源码);内置插件目录以「真实存在」为准逐级探测:
// 包根(源码运行)→ .output 上一级(repo 部署,源码同树)→ cwd。
const candidates = [
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  process.cwd(),
]
const packageRoot = candidates.find(r => existsSync(resolve(r, 'server', 'plugins-builtin'))) ?? process.cwd()

export default defineNitroPlugin((nitroApp) => {
  void initPluginHost({ cwd: process.cwd(), packageRoot }).then((host) => {
    // 实际监听端口回填(nitro listen 后 ctx.api 自环 origin 才准确)
    nitroApp.hooks.hookOnce('listen', (listener: { port?: number }) => {
      if (listener?.port)
        host.setSelfOrigin(listener.port)
    })
  }).catch((err: unknown) => {
    // 插件发现/装载失败不应成为 unhandled rejection(dev-stability-guard 会因此退进程)
    console.error('[aw-plugins] 插件宿主初始化失败(服务继续运行):', err instanceof Error ? err.message : err)
  })
  nitroApp.hooks.hookOnce('close', () => {
    void shutdownPluginHost()
  })
})
