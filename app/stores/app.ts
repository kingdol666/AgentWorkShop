export const useAppStore = defineStore('app', () => {
  // UI 偏好：由 pinia-plugin-persistedstate 持久化到 localStorage
  // （Nuxt 版默认 storage 是 cookies，这里用模块提供的 localStorage StorageLike 适配器，
  //   其内部有 import.meta.client 守卫，SSR 安全）
  const isDark = ref(false)
  const sidebarCollapsed = ref(false)

  function toggleDark() {
    isDark.value = !isDark.value
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  return { isDark, sidebarCollapsed, toggleDark, toggleSidebar }
}, {
  persist: {
    pick: ['isDark', 'sidebarCollapsed'],
    storage: piniaPluginPersistedstate.localStorage(),
  },
})
