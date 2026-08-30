/**
 * 语言恢复(detectBrowserLanguage 关闭):客户端启动时读取持久化选择。
 * AppHeader/settings 切换时写入 localStorage 并强刷(保证 setup 期词条整体切换)。
 * 注意:插件上下文不能调 useI18n()(要求 setup),必须走 nuxtApp.$i18n。
 */
export default defineNuxtPlugin((nuxtApp) => {
  const saved = localStorage.getItem('aw.locale')
  if (!saved) return
  const $i18n = (nuxtApp as unknown as { $i18n?: { locale: { value?: string } | string, setLocale: (l: string) => Promise<unknown> } }).$i18n
  if (!$i18n) return
  const current = typeof $i18n.locale === 'string' ? $i18n.locale : $i18n.locale?.value
  if (saved !== current) void $i18n.setLocale(saved)
})
