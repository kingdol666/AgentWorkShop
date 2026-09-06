/**
 * 会话恢复(客户端):页面加载时从 'token' cookie 恢复登录态。
 *
 * user store 的 token cookie 仅用于 $http 拦截器注入请求头;Pinia 内存态在
 * 全页刷新/直达 URL 后为空——无恢复逻辑时 isLoggedIn=false,控制台等守卫页
 * 一律弹回登录门(cookie 明明长效)。此处启动即校验恢复;token 失效则停留
 * 未登录态(登录门自然呈现,不清 cookie,下次登录覆盖)。
 */
import { useCookie } from '#imports'
import { useUserStore } from '../stores/workshop/user'

export default defineNuxtPlugin(async () => {
  const store = useUserStore()
  if (store.isLoggedIn) return
  const cookie = useCookie<string | null>('token')
  const token = cookie.value
  if (!token) return
  try {
    // 超时竞速:慢 auth API 不应阻塞整站首绘
    await Promise.race([
      store.loginWithToken(token),
      new Promise(r => setTimeout(r, 5000)),
    ])
  }
  catch {
    // token 已失效(吊销/用户删除/过期):清死 cookie,避免每次刷新重复必然失败的校验
    useCookie<string | null>('token').value = null
  }
})
