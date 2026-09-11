import { useAppStore } from '~/stores/app'

/**
 * 暗色模式同步插件（仅客户端）
 * 1. 将 Pinia 的 isDark 状态同步为 <html> 的 .dark class，
 *    供 UnoCSS / 自定义暗色样式（main.css、布局层）消费。
 *    antd 组件本身的暗色由 app.vue 的 ConfigProvider algorithm 驱动。
 * 2. 把偏好镜像进 aw-theme cookie —— SSR 阶段读不到 localStorage，
 *    没有这枚 cookie，服务端只能按 config.yml 渲浅色，客户端首帧再翻深色，
 *    antd cssinjs 不会为相同 hash 重注入样式（深色下部分组件会掉样式）。
 */
export default defineNuxtPlugin(() => {
  const store = useAppStore()
  const cookie = useCookie<'dark' | 'light'>('aw-theme', {
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    path: '/',
  })

  watchEffect(() => {
    document.documentElement.classList.toggle('dark', store.isDark)
    const next = store.isDark ? 'dark' : 'light'
    if (cookie.value !== next) cookie.value = next
  })
})
