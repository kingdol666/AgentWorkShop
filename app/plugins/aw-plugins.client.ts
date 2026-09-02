/**
 * aw 插件客户端装载器 —— 前端增强入口(支持热注入/热卸载)。
 * - 启动期拉取 /api/plugins/manifest → 对启用且含 client 的插件动态 import 装载
 * - 热通道双保险:WS `plugins.reloaded` 事件(TownBus 桥) + 15s 轮询 diff
 *   → 新启用插件即时注入;停用插件即时 dispose 卸载
 * - 错误隔离:单插件装载失败仅告警,不影响应用与其他插件
 * 插件契约见 docs/plugins.md;信任模型与 aw commands 相同(仅装可信代码)。
 */
import { createClientContext, type ClientContext } from '@/sdk/client.mjs'
import type { TownBus } from '~/composables/workshop/useTownBus'

interface ManifestEntry { name: string, enabled?: boolean, hasClient?: boolean }

export default defineNuxtPlugin(async (nuxtApp) => {
  if (!import.meta.client) return

  /** name → ctx(已装载客户端插件) */
  const loaded = new Map<string, ClientContext>()
  let bus: TownBus | null = null
  try {
    bus = useTownBus()
  }
  catch {
    bus = null // WS 总线不可用(离线)时插件仍可装载,只是无实时事件流
  }

  function bridgeFactory(fn: (type: string, payload: unknown) => void) {
    if (!bus) return () => {}
    return bus.subscribe((e) => {
      try {
        fn(e.type, e.payload)
      }
      catch (err) {
        console.warn('[aw-plugins] 事件分发异常:', err)
      }
    })
  }

  async function loadOne(name: string): Promise<boolean> {
    try {
      const mod = await import(/* @vite-ignore */ `/api/plugins/client/${encodeURIComponent(name)}`)
      const setup = (mod as { setup?: unknown }).setup ?? (mod as { default?: { setup?: unknown } }).default?.setup
      if (typeof setup !== 'function') {
        console.warn(`[aw-plugins] ${name} 客户端入口缺少 setup(ctx)`)
        return false
      }
      const ctx = createClientContext({ name, eventBridge: bridgeFactory(bus) })
      await (setup as (ctx: unknown) => void | Promise<void>)(ctx)
      void ctx.hooks.emit('client:init', { name })
      loaded.set(name, ctx)
      console.info(`[aw-plugins] ✔ 客户端插件已注入: ${name}`)
      return true
    }
    catch (err) {
      console.warn(`[aw-plugins] 客户端插件装载失败 ${name}:`, err)
      return false
    }
  }

  function unloadOne(name: string) {
    const ctx = loaded.get(name)
    if (!ctx) return
    ctx.dispose()
    loaded.delete(name)
    console.info(`[aw-plugins] 客户端插件已卸载: ${name}`)
  }

  /** 全量同步:启用的新插件注入;停用/移除的插件卸载 */
  async function syncPlugins(): Promise<void> {
    try {
      const res = await fetch('/api/plugins/manifest', { headers: { accept: 'application/json' } })
      if (!res.ok) return
      const body = await res.json().catch(() => null) as { plugins?: ManifestEntry[] } | null
      const list = body?.plugins ?? []
      for (const p of list) {
        if (p.enabled !== false && p.hasClient && !loaded.has(p.name))
          await loadOne(p.name)
      }
      for (const name of [...loaded.keys()]) {
        const p = list.find(x => x.name === name)
        if (!p || p.enabled === false || !p.hasClient)
          unloadOne(name)
      }
    }
    catch { /* 网络不可达:保留现状,下轮再试 */ }
  }

  // 首次装载
  await syncPlugins()

  // 页面切换广播(已装载插件均可感知)
  if (loaded.size) {
    nuxtApp.hooks.hook('page:finish', () => {
      const route = useRoute()
      for (const { ctx } of loaded.values()) {
        void ctx.hooks.emit('page:change', { path: route.path })
      }
    })
  }

  // 热通道 1:WS plugins.reloaded(服务端热重载后广播)
  if (bus) {
    bus.subscribe((e) => {
      if (e.type === 'plugins.reloaded')
        void syncPlugins()
    })
  }
  // 热通道 2:轮询兜底(无 WS 场景)
  setInterval(() => {
    void syncPlugins()
  }, 15_000)
})
