/**
 * locale cookie 参与 SSR 首帧(与 aw-theme cookie 同一范式)。
 *
 * 为什么必须有:strategy=no_prefix + detectBrowserLanguage=false 下 SSR 恒以 zh 渲染,
 * 客户端 locale 恢复(locale-restore 插件)是异步的 —— 若 setLocale 在水合前落地,
 * prod 水合不修正属性失配(文本会被修正,placeholder 这类 attr 不会),
 * 登录卡输入框曾在 EN 模式下残留中文占位符。cookie 服务端可读,两侧渲染一致,竞态消失。
 *
 * 键名与 localStorage 的 'aw.locale' 同名:header/settings 切换时双写,
 * 本中间件(SSR + 客户端首航都跑)据此在渲染前把 locale 定住。
 */
export default defineNuxtRouteMiddleware(async () => {
  const cookie = useCookie<string | undefined>('aw.locale')
  const saved = cookie.value
  if (saved !== 'en' && saved !== 'zh-CN') return
  const $i18n = (useNuxtApp() as unknown as {
    $i18n?: { locale: { value: string }, setLocale: (l: string) => Promise<unknown> }
  }).$i18n
  if (!$i18n) return
  // 必须 await:setLocale 未落地就开始渲染的话,SSR 仍是 zh,水合失配回归
  if (saved !== $i18n.locale.value) await $i18n.setLocale(saved)
})
