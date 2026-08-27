export const useAppStore = defineStore('app', () => {
  // UI 偏好：由 pinia-plugin-persistedstate 持久化到 localStorage
  // （Nuxt 版默认 storage 是 cookies，这里用模块提供的 localStorage StorageLike 适配器，
  //   其内部有 import.meta.client 守卫，SSR 安全）
  // 默认暗色 = Digital Twin 控制室是产品首态(可切换亮色,选择被持久化)
  const isDark = ref(true)
  const sidebarCollapsed = ref(false)
  /**
   * 主题强调色(warm-editorial:默认墨色药丸;设置页可换 muted 预设,实时生效并持久化)。
   * null = 跟随 config.yml 默认(config.primaryColor 注入的 --color-primary)。
   */
  const accent = ref<string | null>(null)

  function toggleDark() {
    isDark.value = !isDark.value
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function setAccent(color: string | null) {
    accent.value = color
  }

  return { isDark, sidebarCollapsed, accent, toggleDark, toggleSidebar, setAccent }
}, {
  persist: {
    pick: ['isDark', 'sidebarCollapsed', 'accent'],
    storage: piniaPluginPersistedstate.localStorage(),
  },
})
