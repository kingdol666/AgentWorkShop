<script setup lang="ts">
/**
 * 插件 UI 插槽 —— 页面在任意位置声明 <PluginSlot slot-name="..." /> 即接收
 * 插件 client 面板注入(注册表见 usePluginPanels)。
 * 生命周期:面板容器随面板清单 diff 挂载/卸载;mount 返回的清理函数在面板
 * 注销与插槽卸载时调用;单面板渲染异常被隔离(其余面板不受影响)。
 */
import { nextTick, onBeforeUnmount, watch } from 'vue'
import { usePluginPanels, type PluginPanelEntry } from '@/app/composables/workshop/usePluginPanels'

const props = defineProps<{ slotName: string }>()

const { panelsOf } = usePluginPanels()
const panels = panelsOf(props.slotName)

const { t } = useI18n()

/** 已挂载面板:plugin/name → { el, cleanup } */
const mounted = new Map<string, { el: HTMLElement, cleanup?: () => void }>()

function panelKey(p: PluginPanelEntry): string {
  return `${p.plugin}/${p.name}`
}

function titleOf(p: PluginPanelEntry): string {
  if (p.titleKey) {
    const key = p.titleKey.startsWith('plugin.') ? p.titleKey : `plugin.${p.plugin}.${p.titleKey}`
    const translated = t(key)
    if (translated !== key) return translated
  }
  return p.title ?? `${p.plugin}.${p.name}`
}

async function renderPanels(): Promise<void> {
  await nextTick()
  const host = hostRef.value
  if (!host) return
  const wanted = new Set(panels.value.map(panelKey))
  // 卸载消失的面板
  for (const [key, rec] of [...mounted.entries()]) {
    if (wanted.has(key)) continue
    try {
      rec.cleanup?.()
    }
    catch { /* 清理失败不阻断 */ }
    rec.el.remove()
    mounted.delete(key)
  }
  // 挂载新面板
  for (const p of panels.value) {
    const key = panelKey(p)
    if (mounted.has(key)) continue
    const el = host.querySelector<HTMLElement>(`[data-plugin-panel="${key}"]`)
    if (!el) continue
    try {
      const cleanup = await p.mount(el)
      mounted.set(key, { el, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
    }
    catch (err) {
      console.warn(`[plugin-slot] 面板渲染失败 ${key}:`, err)
    }
  }
}

const hostRef = ref<HTMLElement | null>(null)

watch(panels, () => void renderPanels(), { deep: true, immediate: true })

onBeforeUnmount(() => {
  for (const rec of mounted.values()) {
    try {
      rec.cleanup?.()
    }
    catch { /* 忽略 */ }
  }
  mounted.clear()
})
</script>

<template>
  <div
    ref="hostRef"
    class="plugin-slot"
    :data-plugin-slot="slotName"
  >
    <div
      v-for="p in panels"
      :key="panelKey(p)"
      class="plugin-slot-panel"
      :data-plugin-panel="panelKey(p)"
    >
      <div class="plugin-slot-title">
        {{ titleOf(p) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-slot {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.plugin-slot-panel:empty {
  display: none;
}
.plugin-slot-panel {
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 10px;
  padding: 12px 14px;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
}
.plugin-slot-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
  color: var(--ink-soft);
}
</style>
