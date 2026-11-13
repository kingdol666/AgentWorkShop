/** 客户端启动时只恢复 HttpOnly 浏览器 session，不读取或写入任何 Bearer token。 */
import { useUserStore } from '../stores/workshop/user'

export default defineNuxtPlugin(async () => {
  const store = useUserStore()
  if (store.isLoggedIn) {
    store.sessionReady = true
    return
  }
  try {
    await Promise.race([
      store.restoreBrowserSession(),
      new Promise<void>(resolve => setTimeout(resolve, 5000)),
    ])
  }
  catch {
    store.$reset()
  }
  finally {
    // 首帧骨架 → 会话已定：admin 分支只在客户端恢复完成后渲染，避免 SSR/CSR 水合错位。
    store.sessionReady = true
  }
})
