import { useAppStore } from '~/stores/app'

/**
 * 暗色模式同步插件（仅客户端）
 * 将 Pinia 的 isDark 状态同步为 <html> 的 .dark class，
 * 供 UnoCSS / 自定义暗色样式（main.css、布局层）消费。
 * antd 组件本身的暗色由 app.vue 的 ConfigProvider algorithm 驱动。
 */
export default defineNuxtPlugin(() => {
  const store = useAppStore()

  watchEffect(() => {
    document.documentElement.classList.toggle('dark', store.isDark)
  })
})
