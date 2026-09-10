/**
 * aw 插件客户端装载器 —— 前端增强入口(支持热注入/热卸载)。
 * - 启动期拉取 /api/plugins/manifest → 对启用且含 client 的插件动态 import 装载
 * - i18n:启动/热重载时拉取 /api/plugins/i18n(插件根目录 i18n.json 汇编),
 *   按 vue-i18n 命名空间 `plugin.<name>` 合并 → 插件设置标签/面板文案多语言;
 *   语言切换经 i18n:changed 钩子广播给全部客户端插件
 * - UI 注入:ctx.ui.registerPanel → usePluginPanels 注册表 → 页面 <PluginSlot> 渲染;
 *   ctx.t 为插件命名空间翻译
 * - 热通道双保险:WS `plugins.reloaded` 事件(TownBus 桥) + 15s 轮询 diff
 *   → 新启用插件即时注入;停用插件即时 dispose 卸载(面板/订阅全回收)
 * - 错误隔离:单插件装载失败仅告警,不影响应用与其他插件
 * 插件契约见 docs/plugins.md;信任模型与 aw commands 相同(仅装可信代码)。
 */
import { watch } from 'vue'
import { createClientContext, type ClientContext } from '@/sdk/client.mjs'
import { usePluginPanels } from '@/app/composables/workshop/usePluginPanels'
import type { TownBus } from '~/composables/workshop/useTownBus'

interface ManifestEntry { name: string, enabled?: boolean, hasClient?: boolean }
interface I18nBundle { i18n?: Record<string, Record<string, Record<string, string>>> }

export default defineNuxtPlugin(async (nuxtApp) => {
  if (!import.meta.client) return

  /** name → ctx(已装载客户端插件) */
  const loaded = new Map<string, ClientContext>()
  const { unregisterPlugin } = usePluginPanels()
  const panels = usePluginPanels()
  const i18n: { mergeLocaleMessage?: (locale: string, messages: Record<string, unknown>) => void, locale?: unknown } | null
    = (nuxtApp.$i18n as never) ?? null
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

  /** 插件消息树(locale → plugin → key 树);ctx.t 自解析,不依赖 vue-i18n 实例差异 */
  const messageTree: Record<string, Record<string, Record<string, string>>> = {}
  let currentLocale = ''

  function localeOf(): string {
    const loc = i18n?.locale as { value?: string } | string | undefined
    return typeof loc === 'string' ? loc : (loc?.value ?? 'zh-CN')
  }

  function resolveKey(locale: string, plugin: string, key: string): string {
    let cur: unknown = messageTree[locale]?.[plugin]
    for (const seg of key.split('.')) {
      if (!cur || typeof cur !== 'object') return ''
      cur = (cur as Record<string, unknown>)[seg]
    }
    return typeof cur === 'string' ? cur : ''
  }

  /** 拉取并合并插件 i18n 消息(命名空间 plugin.<name>;幂等) */
  async function syncI18n(): Promise<void> {
    try {
      const res = await fetch('/api/plugins/i18n', { headers: { accept: 'application/json' } })
      if (!res.ok) return
      const body = (await res.json().catch(() => null)) as I18nBundle | null
      for (const [plugin, locales] of Object.entries(body?.i18n ?? {})) {
        for (const [locale, messages] of Object.entries(locales)) {
          ;(messageTree[locale] ??= {})[plugin] = messages
          // 同时并入 vue-i18n(设置页等宿主组件经 t() 解析插件设置标签)
          i18n?.mergeLocaleMessage?.(locale, { plugin: { [plugin]: messages } })
        }
      }
      currentLocale = localeOf()
    }
    catch { /* i18n 包不可达:插件文案回落声明里的 label */ }
  }

  /** 翻译助手:插件命名空间自解析(messageTree;未命中回落声明键) */
  function translatorFor(name: string): (key: string, params?: Record<string, unknown>) => string {
    return (key, _params) => {
      const hit = resolveKey(localeOf(), name, key) || resolveKey(currentLocale, name, key)
      return hit || key
    }
  }

  async function loadOne(name: string): Promise<boolean> {
    try {
      const mod = await import(/* @vite-ignore */ `/api/plugins/client/${encodeURIComponent(name)}`)
      const setup = (mod as { setup?: unknown }).setup ?? (mod as { default?: { setup?: unknown } }).default?.setup
      if (typeof setup !== 'function') {
        console.warn(`[aw-plugins] ${name} 客户端入口缺少 setup(ctx)`)
        return false
      }
      const ctx = createClientContext({
        name,
        eventBridge: bridgeFactory(bus),
        ui: {
          slots: ['plugins.page', 'settings.plugins', 'dashboard.widgets'],
          registerPanel: entry => panels.registerPanel({ ...entry, plugin: name }),
        },
        t: translatorFor(name),
        getLocale: () => {
          const loc = i18n?.locale as { value?: string } | string | undefined
          return typeof loc === 'string' ? loc : loc?.value ?? ''
        },
      })
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
    unregisterPlugin(name) // 回收其注册的全部 UI 面板
    console.info(`[aw-plugins] 客户端插件已卸载: ${name}`)
  }

  /** 全量同步:启用的新插件注入;停用/移除的插件卸载;i18n 包随增量刷新 */
  async function syncPlugins(): Promise<void> {
    try {
      const res = await fetch('/api/plugins/manifest', { headers: { accept: 'application/json' } })
      if (!res.ok) return
      const body = await res.json().catch(() => null) as { plugins?: ManifestEntry[] } | null
      const list = body?.plugins ?? []
      let changed = false
      for (const p of list) {
        if (p.enabled !== false && p.hasClient && !loaded.has(p.name)) {
          await loadOne(p.name)
          changed = true
        }
      }
      for (const name of [...loaded.keys()]) {
        const p = list.find(x => x.name === name)
        if (!p || p.enabled === false || !p.hasClient) {
          unloadOne(name)
          changed = true
        }
      }
      if (changed) await syncI18n()
    }
    catch { /* 网络不可达:保留现状,下轮再试 */ }
  }

  // 首次装载(i18n 先行:面板/设置标签直接以正确语言渲染)
  await syncI18n()
  await syncPlugins()

  // 语言切换 → 广播 i18n:changed(插件面板据此重渲染)
  const localeRef = i18n?.locale as { value?: string } | undefined
  if (localeRef && typeof localeRef === 'object') {
    watch(localeRef, (loc) => {
      for (const { ctx } of loaded.values()) {
        try {
          ctx?.hooks?.emit('i18n:changed', { locale: loc })
        }
        catch { /* 单插件广播失败不阻断 */ }
      }
    })
  }

  // 页面切换广播(已装载插件均可感知;防御性隔离——单插件异常不影响路由)
  if (loaded.size) {
    nuxtApp.hooks.hook('page:finish', () => {
      let path = ''
      try {
        path = useRoute().path ?? ''
      }
      catch { /* 路由上下文不可用时静默 */ }
      for (const { ctx } of loaded.values()) {
        try {
          ctx?.hooks?.emit('page:change', { path })
        }
        catch { /* 单插件广播失败不阻断 */ }
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
