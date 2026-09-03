/**
 * 运行时配置客户端插件 —— 设置热重载落地层。
 * - 启动:拉取服务端设置快照 → 订阅 SSE（UI/CLI/文件任意写入实时同步）
 * - live 应用:标题、主题模式、主题色、默认语言随有效值变化即时生效
 *   · 主题模式/主题色仅当用户未在设置页手动覆盖时跟随（用户本地偏好优先）
 */
import { useRuntimeConfigStore } from '~/stores/runtime-config'
import { useAppStore } from '~/stores/app'

export default defineNuxtPlugin(() => {
  if (!import.meta.client) return
  const store = useRuntimeConfigStore()
  const appStore = useAppStore()

  let darkTouched = false
  let lastDarkFromRuntime: boolean | null = null

  // 用户手动切换过暗色后，禁止运行时主题覆盖（尊重本地偏好）
  watch(
    () => appStore.isDark,
    (v) => {
      if (lastDarkFromRuntime !== null && v !== lastDarkFromRuntime) darkTouched = true
    },
  )

  // 主题模式:runtime 默认 → 应用首次暗态（仅当用户未手动切换）
  watch(
    () => store.effective['theme.mode'],
    (v) => {
      if (v !== 'light' && v !== 'dark') return
      if (darkTouched) return
      const target = v === 'dark'
      lastDarkFromRuntime = target
      if (appStore.isDark !== target) appStore.isDark = target
    },
    { immediate: true },
  )

  // 标题:实时反映 app.title
  watch(
    () => store.effective['app.title'],
    (v, old) => {
      if (typeof v === 'string' && v && v !== old) document.title = v
    },
    { immediate: true },
  )

  // 主题色:app.vue 的 accentBase 优先读 store.accent 本地偏好，
  // 其次 runtime 有效主题色 —— 这里仅需保证 store 已填充即可（app.vue 计算属性实时跟随）
  void store.fetchAll().catch(() => {})
  store.startEvents()

  // i18n 默认语言:仅当用户未在本地选择过语言时跟随 runtime 默认
  const LOCAL_LOCALE_KEY = 'aw.locale'
  try {
    if (!window.localStorage.getItem(LOCAL_LOCALE_KEY)) {
      const locale = store.effective['i18n.defaultLocale']
      if (locale === 'zh-CN' || locale === 'en') {
        const { setLocale } = useI18n()
        void setLocale(locale)
      }
    }
  }
  catch { /* localStorage 不可用则跳过 */ }
})
