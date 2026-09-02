/**
 * aw 插件客户端装载器 —— 前端增强入口。
 * - 启动期拉取 /api/plugins/manifest → 对含 client 的插件动态 import 脚本
 * - 每个插件获得独立 ctx(sdk/client.mjs):事件订阅/Hooks/DOM 助手/私有挂载点
 * - 事件桥:useTownBus(AEP 信封,与 WS 同源) → ctx.hooks(event:<type> / '*')
 * - 错误隔离:单插件装载失败仅告警,不影响应用与其他插件
 * 插件契约见 docs/plugins.md;信任模型与 aw commands 相同(仅装可信代码)。
 */
import { createClientContext } from '@/sdk/client.mjs'
import type { TownBus } from '~/composables/workshop/useTownBus'

export default defineNuxtPlugin(async (nuxtApp) => {
  if (!import.meta.client) return

  const loaded: Array<{ name: string, ctx: ReturnType<typeof createClientContext> }> = []

  const bridgeFactory = (bus: TownBus | null) => (fn: (type: string, payload: unknown) => void) => {
    if (!bus) return () => {}
    return bus.subscribe((e) => {
      try {
        fn(e.type, e.payload)
      }
      catch (err) {
        console.warn(`[aw-plugins] 事件分发异常:`, err)
      }
    })
  }

  try {
    const res = await fetch('/api/plugins/manifest', { headers: { accept: 'application/json' } })
    if (!res.ok) return
    const body = await res.json().catch(() => null) as { plugins?: Array<{ name: string, hasClient?: boolean }> } | null
    const plugins = (body?.plugins ?? []).filter(p => p.hasClient)
    if (!plugins.length) return

    let bus: TownBus | null = null
    try {
      bus = useTownBus()
    }
    catch {
      bus = null // WS 总线不可用(离线)时插件仍可装载,只是无事件流
    }

    for (const p of plugins) {
      try {
        const mod = await import(/* @vite-ignore */ `/api/plugins/client/${encodeURIComponent(p.name)}`)
        const setup = (mod as { setup?: unknown }).setup ?? (mod as { default?: { setup?: unknown } }).default?.setup
        if (typeof setup !== 'function') {
          console.warn(`[aw-plugins] ${p.name} 客户端入口缺少 setup(ctx)`)
          continue
        }
        const ctx = createClientContext({
          name: p.name,
          eventBridge: bridgeFactory(bus),
        })
        await (setup as (ctx: unknown) => void | Promise<void>)(ctx)
        void ctx.hooks.emit('client:init', { name: p.name })
        loaded.push({ name: p.name, ctx })
        console.info(`[aw-plugins] ✔ 客户端插件已装载: ${p.name}`)
      }
      catch (err) {
        console.warn(`[aw-plugins] 客户端插件装载失败 ${p.name}:`, err)
      }
    }

    // 页面切换广播(page:change)
    if (loaded.length) {
      nuxtApp.hooks.hook('page:finish', () => {
        const route = useRoute()
        for (const { ctx } of loaded) {
          void ctx.hooks.emit('page:change', { path: route.path })
        }
      })
    }
  }
  catch {
    // 网络不可达/服务未就绪:静默(插件是增强层,绝不阻断应用)
  }
})
