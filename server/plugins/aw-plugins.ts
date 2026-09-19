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
// 且 chunk 相对包根的层级随 nitro 版本变化(如 chunks/build/xxx.mjs 比源码布局深一层),
// 固定 2/3 级上溯在**全局安装布局**(node_modules/agentworkshop/)下探测不到包根,
// builtin 插件会全部失踪。改为从 chunk 目录逐级上溯(上限 8 级 ≫ 任何已知布局),
// 以「server/plugins-builtin 真实存在」为命中判据;最后兜底 cwd(源码运行)。
const candidates: string[] = []
for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 8; i++, dir = dirname(dir)) {
  candidates.push(dir)
}
candidates.push(process.cwd())
const packageRoot = candidates.find(r => existsSync(resolve(r, 'server', 'plugins-builtin'))) ?? process.cwd()

export default defineNitroPlugin((nitroApp) => {
  // host.mjs 是未类型化的 JS:TS 从 `{ cwd = process.cwd(), packageRoot } = {}` 推断形参类型时只保留了
  // 带默认值的 cwd,丢掉了没有默认值的 shorthand 属性 packageRoot(host.mjs 内部确实会解构并使用它,
  // 见 host.mjs 的 host.packageRoot / resolveRunMode({ cwd, packageRoot }))。按真实形参给局部变量
  // 加注解即可,调用本身逐字不变。
  const hostOptions: { cwd?: string, packageRoot?: string } = { cwd: process.cwd(), packageRoot }
  void initPluginHost(hostOptions).then((host) => {
    // 实际监听端口回填(nitro listen 后 ctx.api 自环 origin 才准确)。
    // nitro 的运行时 hook 类型 NitroRuntimeHooks 未声明 'listen'(nitro 2.13 的 node 预设运行时只派发
    // request/beforeResponse/afterResponse/render:*/error/close),故对一个只读视图做局部拓宽;
    // 注册行为与原代码逐字相同(有派发则回填端口,无派发则空转),运行时零变化。
    const hooks = nitroApp.hooks as typeof nitroApp.hooks & {
      hookOnce(name: 'listen', fn: (listener: { port?: number }) => void): unknown
    }
    hooks.hookOnce('listen', (listener) => {
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
