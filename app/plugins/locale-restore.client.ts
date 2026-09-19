/**
 * 语言恢复(detectBrowserLanguage 关闭):客户端启动时读取持久化选择。
 * AppHeader/settings 切换时写入 localStorage + cookie 并强刷(保证 setup 期词条整体切换)。
 * 注意:插件上下文不能调 useI18n()(要求 setup),必须走 nuxtApp.$i18n。
 *
 * cookie 镜像(locale-cookie.global.ts 消费):老用户偏好只存在于 localStorage,
 * 首次加载时镜像进 cookie 并强刷一次,让 SSR 首帧即以偏好语言渲染
 * (否则 SSR 恒 zh,客户端异步切换在水合竞态下会留下中文 attr 残留)。
 * sessionStorage 守卫防 cookie 写入被挡时的刷新循环。
 */
export default defineNuxtPlugin((nuxtApp) => {
  const saved = localStorage.getItem('aw.locale')
  const cookie = useCookie<string | undefined>('aw.locale', { maxAge: 60 * 60 * 24 * 365 })
  if (!saved) return
  if (cookie.value !== saved) {
    const mirrored = sessionStorage.getItem('aw.locale.mirrored')
    if (mirrored !== saved) {
      sessionStorage.setItem('aw.locale.mirrored', saved)
      cookie.value = saved
      window.location.reload()
      return
    }
  }
  const $i18n = (nuxtApp as unknown as { $i18n?: { locale: { value?: string } | string, setLocale: (l: string) => Promise<unknown> } }).$i18n
  if (!$i18n) return
  const current = typeof $i18n.locale === 'string' ? $i18n.locale : $i18n.locale?.value
  if (saved !== current) void $i18n.setLocale(saved)
})
