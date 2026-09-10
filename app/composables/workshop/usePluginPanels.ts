/**
 * 插件 UI 面板注册表(客户端单例)。
 *
 * 插件 client 脚本经 ctx.ui.registerPanel({ slot, name, title?, titleKey?, order?, mount })
 * 向命名插槽注入自渲染面板;宿主页面在对应位置放 <PluginSlot slot-name="..." /> 即接收注入。
 * 生命周期:注册随插件 ctx.dispose 自动回收(unregisterPlugin);插槽组件卸载时逐面板
 * 调用 mount 返回的清理函数 —— 全生命周期无残留。
 */
import { computed, reactive } from 'vue'

export interface PluginPanelEntry {
  /** 注入目标插槽名(如 'plugins.page' / 'settings.plugins' / 'dashboard.widgets') */
  slot: string
  /** 宿主插件名(自动填充) */
  plugin: string
  /** 面板名(同插件内唯一) */
  name: string
  /** 静态标题(titleKey 优先) */
  title?: string
  /** i18n 键(命名空间 plugin.<plugin> 下) */
  titleKey?: string
  /** 排序权重(小者在前;缺省 100) */
  order?: number
  /**
   * 渲染函数:把面板内容挂到给定容器(纯 DOM 或自带框架)。
   * 可返回清理函数(卸载时调用);抛错由插槽隔离,不影响其他面板。
   */
  mount: (el: HTMLElement) => undefined | (() => void) | Promise<void> | Promise<undefined | (() => void)>
}

const state = reactive({
  /** slot → entries(按 order 升序) */
  slots: {} as Record<string, PluginPanelEntry[]>,
})

function sortedInsert(list: PluginPanelEntry[], entry: PluginPanelEntry): void {
  const idx = list.findIndex(e => e.plugin === entry.plugin && e.name === entry.name)
  if (idx >= 0) list.splice(idx, 1)
  list.push(entry)
  list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name))
}

export function usePluginPanels() {
  function registerPanel(entry: PluginPanelEntry): () => void {
    const slot = entry.slot || 'plugins.page'
    const list = (state.slots[slot] ??= [])
    sortedInsert(list, { ...entry, slot })
    return () => unregisterPanel(slot, entry.plugin, entry.name)
  }

  function unregisterPanel(slot: string, plugin: string, name: string): void {
    const list = state.slots[slot]
    if (!list) return
    const idx = list.findIndex(e => e.plugin === plugin && e.name === name)
    if (idx >= 0) list.splice(idx, 1)
  }

  /** 插件卸载:回收其注册的全部面板(热重载/停用路径) */
  function unregisterPlugin(plugin: string): void {
    for (const list of Object.values(state.slots)) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]!.plugin === plugin) list.splice(i, 1)
      }
    }
  }

  function panelsOf(slot: string) {
    return computed(() => state.slots[slot] ?? [])
  }

  return { registerPanel, unregisterPanel, unregisterPlugin, panelsOf }
}
