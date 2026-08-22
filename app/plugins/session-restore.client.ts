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
    await store.loginWithToken(token)
  }
  catch {
    /* token 已失效(吊销/用户删除):静默停留未登录态 */
  }
})
